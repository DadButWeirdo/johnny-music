import { ctxOf, send, can } from './adapter.js';
import { getConfig } from './store.js';
import { ui } from './ui.js';
import { fmtDuration, idOf } from './util.js';
import { PROTECTED } from './protected.js';
import { cleanApiError } from './errors.js';
import { runCustom } from './commands/custom.js';
import { withTyping } from './typing.js';

const cooldowns = new Map();
export const SLASH_LIMIT = 100;
export const SLASH_ORDER = ['General', 'Moderation', 'Community', 'Utility', 'Fun', 'Settings'];
const LOW_PRIORITY = new Set(['emojify', 'owo', 'clap', 'mock', 'reverse', 'encode', 'decode', 'neverhaveiever', 'compliment', 'unremind', 'unreactionmute', 'unimagemute', 'notes', 'whoami']);

export function rankCommands(commands) {
  const priority = (cmd) => {
    if (LOW_PRIORITY.has(cmd.name)) return 100;
    const index = SLASH_ORDER.indexOf(cmd.category);
    return index < 0 ? 99 : index;
  };
  return commands.map((cmd, index) => ({ cmd, index }))
    .sort((a, b) => priority(a.cmd) - priority(b.cmd) || a.index - b.index)
    .map(({ cmd }) => cmd);
}

// Shared command execution path for both Yaper's command callbacks and baff.gg interactions.
export function createCommandRunner(bot, commands) {
  const platform = bot.platformKey ?? 'yapper';
  const activeCommands = commands.filter((cmd) => !cmd.platforms || cmd.platforms.includes(platform));
  const lookup = new Map();
  for (const cmd of activeCommands) {
    lookup.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) lookup.set(alias, cmd);
  }

  async function run(raw, cmd, args = [], body = '', replyOverride) {
    const c = ctxOf(raw);
    if (!c.serverId || !c.authorId) return { replied: false };
    const cfg = getConfig(c.serverId);
    Object.assign(c, {
      bot, cfg, args, body, commands: activeCommands, lookup, prefix: cfg.prefix,
      rest: args.join(' '),
      memberPermissions: raw.memberPermissions ?? raw.member_permissions,
      reply: replyOverride ?? ((payload) => send(bot, c.channelId, payload, c.id)),
    });

    try {
      const guarded = !PROTECTED.has(cmd.name);
      if (guarded && (cfg.disabled ?? []).includes(cmd.name)) {
        await c.reply(ui.error({ title: 'Command disabled', description: `An admin turned \`${cmd.name}\` off on this server.` }, cfg));
        return { replied: true };
      }
      const allowed = cfg.cmdChannels ?? [];
      if (guarded && allowed.length && !allowed.includes(c.channelId) && !(await can(bot, c, 'mod'))) {
        const sent = await c.reply(ui.notice({ title: 'Wrong channel', description: `Use commands in ${allowed.map((id) => `<#${id}>`).join(' ')}.` }, cfg));
        const id = idOf(sent);
        if (id) setTimeout(() => bot.delete(c.channelId, id).catch(() => {}), 6000);
        return { replied: true };
      }
      if (cmd.perm && !(await can(bot, c, cmd.perm))) {
        await c.reply(ui.error({
          title: 'Not allowed',
          description: { admin: 'Only server admins can use this command.', owner: 'Only the bot owner can use this command.' }[cmd.perm] ?? 'You need moderator permissions to use this command.',
        }, cfg));
        return { replied: true };
      }
      if (cmd.needsSetup && !cfg.logChannelId) {
        await c.reply(ui.notice({
          title: 'Setup required',
          description: `Moderation needs a log channel first.\nAn admin can run \`${cfg.prefix}setup\` to create one.`,
        }, cfg));
        return { replied: true };
      }
      if (cmd.cooldown) {
        const key = `${bot.platformKey ?? 'yapper'}:${c.serverId}:${c.authorId}:${cmd.name}`;
        const wait = (cooldowns.get(key) ?? 0) + cmd.cooldown * 1000 - Date.now();
        if (wait > 0) {
          await c.reply(ui.error({ title: 'Slow down', description: `Try again in ${fmtDuration(wait)}.` }, cfg));
          return { replied: true };
        }
        cooldowns.set(key, Date.now());
      }
      // Show "<bot> is typing…" while the command works. Baff slash commands already show Baff's own
      // "thinking" state via deferReply, so only prefix / Yaper-slash runs (no replyOverride) need it.
      const result = replyOverride ? await cmd.run(c) : await withTyping(bot, c.channelId, () => cmd.run(c));
      return { replied: false, result };
    } catch (err) {
      console.error(`[${bot.platformKey ?? 'yapper'} command: ${cmd.name}]`, err);
      try {
        await c.reply(ui.error({ title: 'Something went wrong', description: cleanApiError(err).message.slice(0, 300) }, cfg));
        return { replied: true, error: err };
      } catch { return { replied: false, error: err }; }
    }
  }

  return { lookup, run };
}

export function attachPrefix(bot, commands) {
  const { lookup, run } = createCommandRunner(bot, commands);
  bot.on('message', async (raw) => {
    try {
      if (process.env.DEBUG) console.log('[message]', JSON.stringify(raw));
      if (raw.command || raw.author_bot) return;
      const c = ctxOf(raw);
      if (!c.serverId) return;
      const cfg = getConfig(c.serverId);
      if (!c.content.startsWith(cfg.prefix)) return;
      const body = c.content.slice(cfg.prefix.length).trim();
      const name = body.split(/\s+/)[0]?.toLowerCase();
      const rest = body.replace(/^\S+\s*/, '');
      const cmd = lookup.get(name) ?? lookup.get(cfg.aliases?.[name]);
      if (cmd) return await run(raw, cmd, rest ? rest.split(/\s+/) : [], rest);
      if (cfg.customCommands?.[name]) await runCustom(bot, raw, cfg, cfg.customCommands[name], rest);
    } catch (err) { console.error('[router]', err); }
  });
  return { lookup, run };
}

export function attach(bot, commands) {
  const { lookup, run } = attachPrefix(bot, commands);
  const ranked = rankCommands(commands.filter((cmd) => !cmd.platforms || cmd.platforms.includes(bot.platformKey ?? 'yapper')));
  let registered = 0;
  const prefixOnly = [];
  for (const cmd of ranked) {
    if (cmd.slash === false || registered >= SLASH_LIMIT) { prefixOnly.push(cmd.name); continue; }
    try {
      bot.command(cmd.name, (cmd.desc ?? cmd.name).slice(0, 100), (msg) => run(msg, cmd, msg.argv ?? [], msg.args ?? ''));
      cmd.slashOk = true;
      cmd.slashOkByPlatform = { ...(cmd.slashOkByPlatform ?? {}), yapper: true };
      registered++;
    } catch { prefixOnly.push(cmd.name); }
  }
  for (const cmd of ranked) if (cmd.slashOkByPlatform?.yapper === undefined) cmd.slashOkByPlatform = { ...(cmd.slashOkByPlatform ?? {}), yapper: false };
  if (prefixOnly.length) console.log(`[yapper slash] ${registered} registered. Prefix only: ${prefixOnly.join(', ')}`);

}
