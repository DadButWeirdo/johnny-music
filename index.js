import './src/env.js'; // Loads .env before the rest of the application reads process.env.
import path from 'node:path';
import { Bot } from './yapper.js';
import { load, flush, withStore } from './src/store.js';
import { attachPrefix } from './src/router.js';
import { blockCommandSync } from './src/no-slash.js';
import { BaffAdapter } from './src/baff-adapter.js';
import { scopeBot } from './src/platform-scope.js';
import musicCommands, { attachMusic } from './src/commands/music.js';
import { theme } from './src/theme.js';
import { wrapApi } from './src/errors.js';

// Johnny Music: the music half of Johnny, running on its own machine (for example a phone in Termux).
// It logs in with the SAME bot token as the main Johnny bot, so users see one Johnny.
// Music is prefix-only (,play ...). This process never registers slash commands, so it cannot overwrite
// the main bot's command list, and it has its own data folder.

const validToken = (value) => Boolean(value && !/paste_your_token_here|your_token_here/i.test(value));
const yapperToken = process.env.YAPPER_BOT_TOKEN;
const baffToken = process.env.BAFF_BOT_TOKEN;
const hasYapper = validToken(yapperToken);
const hasBaff = validToken(baffToken);

if (!hasYapper && !hasBaff) {
  console.error('No bot token configured. Put Johnny\'s YAPPER_BOT_TOKEN and/or BAFF_BOT_TOKEN in the .env file.');
  process.exit(1);
}
if (hasYapper && hasBaff && process.env.BAFF_APP_ID) {
  const yapperDataFile = path.resolve(process.env.DATA_FILE ?? 'data/servers.json');
  const baffDataFile = path.resolve(process.env.BAFF_DATA_FILE ?? 'data/baff/servers.json');
  if (yapperDataFile === baffDataFile) {
    console.error('Yaper and baff.gg data files resolve to the same path. Set BAFF_DATA_FILE to a separate file.');
    process.exit(1);
  }
}
if (hasBaff && !process.env.BAFF_APP_ID) {
  console.error('BAFF_BOT_TOKEN is set, but BAFF_APP_ID is missing. Add Johnny\'s Application ID from the baff.gg Developer Portal.');
  if (!hasYapper) process.exit(1);
}

const commands = musicCommands;
const attachers = [attachMusic];

function attachFeatureModules(bot, scope) {
  scopeBot(bot, scope);
  withStore(scope, () => { for (const attachFeature of attachers) attachFeature(bot); });
}

const running = [];
let shuttingDown = false;

if (hasYapper) {
  await load('yapper');
  const yaperBot = scopeBot(new Bot(yapperToken, { ignoreBots: true }), 'yapper');
  yaperBot.platformKey = 'yapper';
  blockCommandSync(yaperBot);
  wrapApi(yaperBot);
  attachPrefix(yaperBot, commands); // prefix only: no bot.command(), so no slash registration
  attachFeatureModules(yaperBot, 'yapper');
  running.push(yaperBot);
  yaperBot.start().catch((error) => console.error('[yapper startup]', error));
  console.log(`[music] Yaper adapter enabled · ${commands.length} music commands loaded`);
}

if (hasBaff && process.env.BAFF_APP_ID) {
  await load('baff');
  let client;
  let watchdog = null;
  let reconnecting = false;
  let Client;
  let baffBot;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const createClient = () => new Client({ token: baffToken, applicationId: process.env.BAFF_APP_ID });

  const reconnectBaff = async () => {
    if (reconnecting || shuttingDown) return;
    reconnecting = true;
    let retryDelay = 5_000;
    try {
      try { await client?.destroy?.(); } catch { /* replace a stale client */ }
      while (!shuttingDown) {
        try {
          const nextClient = createClient();
          client = nextClient;
          baffBot.setClient(nextClient);
          await nextClient.login();
          return;
        } catch {
          try { await client?.destroy?.(); } catch { /* retry with a fresh client */ }
          await wait(retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60_000);
        }
      }
    } finally {
      reconnecting = false;
    }
  };

  try {
    ({ Client } = await import('baff.js'));
    client = createClient();
    baffBot = new BaffAdapter(client, baffToken);
    attachPrefix(baffBot, commands); // prefix only: no slash handlers, no /myid
    attachFeatureModules(baffBot, 'baff');
    await client.login();

    watchdog = setInterval(() => {
      if (!shuttingDown && !reconnecting && Date.now() - baffBot.lastGatewayPacketAt > 180_000) {
        void reconnectBaff();
      }
    }, 30_000);
    watchdog.unref?.();

    running.push({ stop: async () => {
      if (watchdog) clearInterval(watchdog);
      await client?.destroy?.();
    } });
    console.log(`[music] baff.gg adapter enabled · ${commands.length} music commands loaded`);
  } catch (error) {
    if (watchdog) clearInterval(watchdog);
    try { await client?.destroy?.(); } catch { /* best-effort cleanup after failed startup */ }
    console.error('[baff startup] Could not start baff.js:', error?.message ?? error);
    if (!hasYapper) process.exitCode = 1;
  }
}

console.log(`[music] online startup complete · style: ${theme.style} · platforms: ${[hasYapper ? 'Yaper' : null, hasBaff && process.env.BAFF_APP_ID ? 'baff.gg' : null].filter(Boolean).join(' + ')}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[music] ${signal} received; leaving voice and saving data…`);
    try {
      for (const bot of running) {
        try { bot.stop?.(); } catch (error) { console.error('[shutdown]', error?.message ?? error); }
      }
      await Promise.all([
        ...(hasYapper ? [flush('yapper')] : []),
        ...(hasBaff && process.env.BAFF_APP_ID ? [flush('baff')] : []),
      ]);
    } finally { process.exit(0); }
  });
}
