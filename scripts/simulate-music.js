/**
 * Offline smoke test for Johnny Music. It never logs in and never touches the network.
 * Run after `npm install` with: npm run simulate
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'johnny-music-sim-'));
process.env.DATA_FILE = path.join(tmp, 'yapper.json');
process.env.BAFF_DATA_FILE = path.join(tmp, 'baff.json');

const [{ BaffAdapter }, { attachPrefix }, { scopeBot }, { withStore, load }, music, { blockCommandSync }] = await Promise.all([
  import('../src/baff-adapter.js'),
  import('../src/router.js'),
  import('../src/platform-scope.js'),
  import('../src/store.js'),
  import('../src/commands/music.js'),
  import('../src/no-slash.js'),
]);
const commands = music.default;
let passed = 0;
const check = (ok, label) => { assert.ok(ok, label); passed++; console.log(`✓ ${label}`); };

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: 'music-bot-id', username: 'johnny-music' };
    this.sent = [];
    const channel = { id: 'channel-1', name: 'general', type: 0, serverId: 'server-1', send: async (payload) => { this.sent.push(payload); return { id: 'm1', channelId: 'channel-1', content: payload?.content ?? '' }; }, messages: { fetch: async () => new Map() } };
    const server = { id: 'server-1', name: 'Test server', ownerId: 'owner-1', channels: { cache: new Map([['channel-1', channel]]) }, roles: { cache: new Map() }, members: { fetch: async () => new Map() } };
    this.servers = { cache: new Map([['server-1', server]]), fetch: async () => server };
    this.channels = { fetch: async () => channel };
  }
  requireApplication() { throw new Error('Johnny Music must never touch slash commands'); }
}

await load('baff');
const client = new FakeClient();
check(commands.length === 16 && commands.every((c) => c.category === 'Music'), 'the music bot loads exactly the 16 music commands and nothing else');

const adapter = scopeBot(new BaffAdapter(client, 'test-token', { apiRoot: 'https://baff.gg/api' }), 'baff');
attachPrefix(adapter, commands);
withStore('baff', () => music.attachMusic(adapter));
await withStore('baff', async () => {
  await adapter.emit('message', { id: 's1', channel_id: 'channel-1', server_id: 'server-1', author_id: 'user-1', username: 'tester', author_bot: false, content: ',queue' });
  await adapter.emit('message', { id: 's2', channel_id: 'channel-1', server_id: 'server-1', author_id: 'user-1', username: 'tester', author_bot: false, content: ',ping' });
});
check(client.sent.length === 1, ',queue is answered by the music player and ,ping (a main-bot command) is ignored');
check(client.listeners('interactionCreate').length === 1, 'only the player-button listener is attached (no slash-command handler, no /myid)');

// Yaper: the SDK's startup PUT /commands must never reach the network.
const calls = [];
const fakeYaper = { api: async (method, path) => { calls.push(`${method} ${path}`); return {}; } };
blockCommandSync(fakeYaper);
await fakeYaper.api('PUT', '/commands', { commands: [] });
await fakeYaper.api('GET', '/me');
check(calls.length === 1 && calls[0] === 'GET /me', 'Yaper command sync (PUT /commands) is blocked so the main bot\'s slash commands are never overwritten');
console.log(`\nMusic simulation passed (${passed} checks). No token, network or voice call was used.`);
