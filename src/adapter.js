const ADMIN_IDS = new Set((process.env.ADMIN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pick = (obj, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => a?.[k], obj);
    if (v !== undefined && v !== null) return v;
  }
};

// ───────── messages ─────────
// Normalise a raw message event. Run `npm run debug` to print the real shape.
export const ctxOf = (raw) => ({
  raw,
  id: pick(raw, 'id', 'message_id', 'messageId'),
  content: String(pick(raw, 'content', 'text') ?? ''),
  channelId: pick(raw, 'channel_id', 'channelId', 'channel.id'),
  serverId: pick(raw, 'server_id', 'serverId', 'server.id', 'guild_id'),
  authorId: pick(raw, 'author_id', 'authorId', 'author.id', 'user_id', 'user.id'),
  authorName: pick(raw, 'username', 'author.username', 'author.name', 'author.display_name') ?? 'Someone',
  isBot: Boolean(pick(raw, 'author.bot', 'author.is_bot', 'is_bot', 'bot')),
});

export const mention = (id) => `<@${id}>`;

// Accepts a real mention, <@id>, @id or a raw id.
export function parseUser(c, token) {
  const m = c.raw.mentions?.[0];
  if (m) return typeof m === 'string' ? m : m.id;
  const hit = /^<?@?!?([\w-]{6,})>?$/.exec(token ?? '');
  return hit?.[1] ?? null;
}

// Sends an ui.* payload. Order tried: Components V2 layout, classic embed, embed without images.
// Pings: mentions inside a card don't notify anyone, so they go in plain message text instead.
const stripImages = (embeds) => embeds.map(({ image, thumbnail, footer, ...rest }) => ({ ...rest, ...(footer && { footer: { text: footer.text } }) }));
const hasImages = (embeds) => embeds.some((e) => e.image || e.thumbnail || e.footer?.icon_url);

export async function send(bot, channelId, payload, replyTo) {
  const ping = (payload.ping ?? []).map(mention).join(' ');
  const layoutMode = Boolean(payload.layout);
  const emb = layoutMode ? payload.fallback : payload;
  if (layoutMode && ping) await bot.send(channelId, ping, { replyTo }).catch(() => {});

  const plan = [];
  if (layoutMode) plan.push(['layout', () => bot.sendLayout(channelId, payload.layout)]);
  if (emb?.embeds) {
    const body = (embeds) => ({ embeds, ...(emb.components && { components: emb.components }), ...(!(layoutMode && ping) && { replyTo }) });
    const content = layoutMode ? '' : ping;
    plan.push(['embed', () => bot.send(channelId, content, body(emb.embeds))]);
    if (hasImages(emb.embeds)) plan.push(['embed without images', () => bot.send(channelId, content, body(stripImages(emb.embeds)))]);
  }
  let first;
  for (const [name, fn] of plan) {
    try { return await fn(); } catch (err) { first ??= err; console.error(`[send: ${name} failed]`, err?.message ?? err); }
  }
  throw first ?? new Error('Nothing to send');
}

// Replace a message the bot posted earlier with a freshly built ui.* payload (buttons included or removed).
export async function editMessage(bot, channelId, messageId, payload) {
  if (payload.layout) return bot.editLayout(channelId, messageId, payload.layout);
  return bot.edit(channelId, messageId, '', { embeds: payload.embeds, components: payload.components ?? null });
}
// The same thing for answering a button click with i.update(...).
export const updateOf = (payload) => (payload.layout ? { layout: payload.layout } : { embeds: payload.embeds, components: payload.components ?? null });

// ───────── permissions ─────────
// Allowed: ADMIN_IDS, the server owner, adminrole / staffrole members, and now anyone whose Yapper role
// grants it: administrator or manage-server = admin, manage-messages (or kick/ban/timeout style perms) = mod.
const roleCache = new Map();
async function rolesOf(bot, serverId) {
  const cacheKey = `${bot.platformKey ?? 'yapper'}:${serverId}`;
  const hit = roleCache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.roles;
  const roles = await listRoles(bot, serverId).catch(() => []);
  roleCache.set(cacheKey, { roles, until: Date.now() + 60_000 });
  return roles;
}
const isAdminRole = (r) => Boolean(r.perms?.administrator || r.manage_server);
const isModRole = (r) => Boolean(r.manage_messages || Object.entries(r.perms ?? {}).some(([k, v]) => v && /kick|ban|timeout|moderate|mute|manage_(messages|members|roles|channels)/.test(k)));

export async function can(bot, c, level) {
  if (ADMIN_IDS.has(String(c.authorId))) return true;
  if (level === 'owner') return false; // owner-only commands: ADMIN_IDS and nobody else
  const channelPermissions = c.memberPermissions;
  if (channelPermissions && typeof channelPermissions.has === 'function') {
    const has = (...names) => names.some((name) => { try { return channelPermissions.has(name); } catch { return false; } });
    if (has('Administrator', 'ManageGuild')) return true;
    if (level === 'mod' && has('ManageMessages', 'ManageChannels', 'ManageRoles', 'KickMembers', 'BanMembers', 'ModerateMembers')) return true;
  }
  try {
    const server = await bot.server?.(c.serverId);
    const owner = pick(server, 'owner_id', 'ownerId', 'owner.id');
    if (owner && String(owner) === String(c.authorId)) return true;
  } catch { /* fall through */ }

  const mine = await memberRoleIds(bot, c.serverId, c.authorId);
  if (!mine?.length) return false;
  if (mine.some((r) => (c.cfg?.adminRoles ?? []).includes(r))) return true;
  if (level === 'mod' && mine.some((r) => (c.cfg?.staffRoles ?? []).includes(r))) return true;
  const roles = (await rolesOf(bot, c.serverId)).filter((r) => mine.includes(r.id));
  if (roles.some(isAdminRole)) return true;
  return level === 'mod' && roles.some(isModRole);
}

// ───────── channels (uses the real yapper.js methods) ─────────
export async function listAllChannels(bot, serverId) {
  return (await bot.channels(serverId)) ?? [];
}

// Creates category "logs" + channel "logs" (reuses them if they already exist).
export async function ensureLogChannel(bot, serverId) {
  const channels = (await bot.channels(serverId, { type: 'text' })) ?? [];
  const existing = channels.find((ch) => ch.name === 'logs');
  if (existing) return { channelId: existing.id, created: false };

  const cats = (await bot.categories(serverId)) ?? [];
  const cat = cats.find((x) => x.name?.toLowerCase() === 'logs') ?? await bot.createCategory(serverId, 'logs');
  const ch = await bot.createChannel(serverId, 'logs', { kind: 'text', categoryId: cat.id });
  return { channelId: ch.id, created: true };
}

export async function ensureChannel(bot, serverId, name) {
  const found = (await listAllChannels(bot, serverId)).find((ch) => ch.name === name);
  if (found) return { id: found.id, created: false };
  const ch = await bot.createChannel(serverId, name, { kind: 'text' });
  return { id: ch.id, created: true };
}

// ───────── roles ─────────
// yapper.js can read roles and assign them, but has no "create role" method.
// So: use the role if it exists, otherwise try the REST endpoint once, otherwise say what to do.
export async function listRoles(bot, serverId) {
  return (await bot.roles(serverId)) ?? [];
}

export async function ensureRole(bot, serverId, name) {
  const hit = (await listRoles(bot, serverId)).find((r) => r.name?.toLowerCase() === name);
  if (hit) return { id: hit.id, created: false };
  try {
    let r;
    if (typeof bot.createRole === 'function') r = await bot.createRole(serverId, name);
    else r = await bot.api('POST', `/servers/${serverId}/roles`, { name });
    const id = r?.role?.id ?? r?.id;
    if (!id) throw new Error('no role id came back');
    return { id, created: true };
  } catch (err) {
    console.error(`[role create: ${name}]`, err?.message ?? err);
    throw new Error(`no “${name}” role yet. Create a role with that name in Server settings, then run setup again`);
  }
}

export async function memberRoleIds(bot, serverId, userId) {
  try {
    const m = await bot.member(serverId, userId);
    const roles = pick(m, 'role_ids', 'roleIds', 'roles') ?? [];
    return roles.map((r) => (typeof r === 'object' ? r.id : r));
  } catch { return null; }
}

export const addRole = (bot, serverId, userId, roleId) => bot.addRole(serverId, userId, roleId);
export const removeRole = (bot, serverId, userId, roleId) => bot.removeRole(serverId, userId, roleId);

// ───────── message history helpers (used by purge / cleanup) ─────────
export const messageId = (m) => pick(m, 'id', 'message_id', 'messageId');
export const messageText = (m) => String(pick(m, 'content', 'text') ?? '');
export const isBotMessage = (m, bot) =>
  Boolean(pick(m, 'author.bot', 'author.is_bot', 'is_bot', 'bot')) ||
  Boolean((bot?.userId || process.env.BOT_ID) &&
    String(pick(m, 'author_id', 'authorId', 'author.id', 'user_id', 'user.id')) === String(bot?.userId || process.env.BOT_ID));

// Returns recent messages, NEWEST first. yapper.js returns them oldest first.
export async function fetchMessages(bot, channelId, limit = 100) {
  const res = await bot.messages(channelId, limit);
  const list = [...(Array.isArray(res) ? res : (res?.messages ?? res?.items ?? []))];
  const ts = (m) => Date.parse(pick(m, 'created_at', 'createdAt', 'timestamp', 'sent_at', 'at')) || null;
  const first = ts(list[0]), last = ts(list.at(-1));
  if (list.length > 1 && first && last) return first >= last ? list : list.reverse(); // trust timestamps
  return list.reverse(); // no timestamps: trust the documented oldest-first order
}

export const deleteMessage = (bot, channelId, id) => bot.delete(channelId, id);
export { sleep };
