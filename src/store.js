import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_PREFIX = (process.env.MUSIC_PREFIX ?? ',').trim() || ',';
const context = new AsyncLocalStorage();
const stores = new Map();

const defaults = () => ({
  prefix: DEFAULT_PREFIX, color: null,
  logChannelId: null, jailChannelId: null,
  roles: {}, jailed: {}, muted: { image: {}, reaction: {} }, aliases: {},
  warns: {}, cases: [], caseCount: 0, staffRoles: [], adminRoles: [], automod: {},
  welcome: {}, goodbye: {}, autoroleId: null, afk: {}, reminders: [],
  levels: {}, levelCfg: {}, reactionRoles: [], starboard: {}, suggestions: {}, tickets: {}, music247: null,
});

function fileFor(scope) {
  if (scope === 'baff') return path.resolve(process.env.BAFF_DATA_FILE ?? 'data/baff/servers.json');
  return path.resolve(process.env.DATA_FILE ?? 'data/servers.json');
}

function stateFor(scope = context.getStore() ?? 'yapper') {
  if (!stores.has(scope)) stores.set(scope, { scope, file: fileFor(scope), db: {}, queue: Promise.resolve(), timer: null });
  return stores.get(scope);
}

export const getStoreScope = () => context.getStore() ?? 'yapper';
export const withStore = (scope, fn) => context.run(scope, fn);

export async function load(scope = getStoreScope()) {
  const state = stateFor(scope);
  try { state.db = JSON.parse(await fs.readFile(state.file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state.db = {}; }
}

async function save(state) {
  await fs.mkdir(path.dirname(state.file), { recursive: true });
  const tmp = `${state.file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state.db, null, 2));
  await fs.rename(tmp, state.file);
}

function schedule(state) {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.queue = state.queue.then(() => save(state)).catch((error) => console.error(`[store:${state.scope}]`, error));
  }, 1500);
  state.timer.unref?.();
}

export async function flush(scope = getStoreScope()) {
  const state = stateFor(scope);
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  state.queue = state.queue.then(() => save(state)).catch((error) => console.error(`[store:${scope}]`, error));
  await state.queue;
}

export const serverIds = () => Object.keys(stateFor().db);
export const getConfig = (serverId) => ({ ...defaults(), ...(stateFor().db[serverId] ?? {}) });

export function setConfig(serverId, patch) {
  const state = stateFor();
  state.db[serverId] = { ...(state.db[serverId] ?? {}), ...patch };
  schedule(state);
  return getConfig(serverId);
}

export function update(serverId, fn) {
  const state = stateFor();
  fn((state.db[serverId] ??= {}));
  schedule(state);
}
