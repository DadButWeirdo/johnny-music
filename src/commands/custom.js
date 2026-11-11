import { ui } from '../ui.js';
import { ctxOf, mention, send } from '../adapter.js';
import { getConfig, setConfig } from '../store.js';
import { sample, defang, MEDIA_TAG } from '../util.js';

const fail = (c, title, description) => c.reply(ui.error({ title, description }, c.cfg));

// {user} {name} {server} {channel} {args} {choose:a|b|c}
async function fill(bot, c, tpl, args) {
  let out = tpl.replace(/\{user\}/g, mention(c.authorId)).replace(/\{name\}/g, c.authorName)
    .replace(/\{args\}/g, args).replace(/\{channel\}/g, `<#${c.channelId}>`);
  if (out.includes('{server}')) out = out.replace(/\{server\}/g, (await bot.server(c.serverId).catch(() => null))?.name ?? 'this server');
  out = out.replace(/\{choose:([^}]*)\}/g, (_, list) => sample(list.split('|')).trim());
  return defang(out).slice(0, 1800);
}

// Plain text normally. If the reply contains {gif: …} / {image: …} tags it becomes a borderless card with the picture in place.
async function sendRich(bot, c, cfg, text) {
  if (new RegExp(MEDIA_TAG.source, 'i').test(text)) {
    return send(bot, c.channelId, ui.info({ title: '', description: text, rich: true, bare: true }, cfg), c.id);
  }
  return bot.send(c.channelId, text, { replyTo: c.id });
}

export async function runCustom(bot, raw, cfg, tpl, args) {
  const c = ctxOf(raw);
  await sendRich(bot, c, cfg, await fill(bot, c, tpl, args));
}

export default [
  {
    name: 'cc', aliases: ['customcommand'], category: 'Settings', perm: 'admin', usage: 'cc add|remove|list <name> [reply]', desc: 'Create your own text commands',
    run: (c) => {
      const map = { ...(c.cfg.customCommands ?? {}) };
      const m = /^(\S+)\s*(\S*)\s*([\s\S]*)$/.exec(c.body) ?? [];
      const [, sub = '', name = '', text = ''] = m;
      const p = c.prefix;
      if (sub === 'list' || !sub) {
        const names = Object.keys(map);
        return c.reply(ui.info({ title: 'Custom commands', description: names.length ? names.map((n) => `\`${p}${n}\``).join('  ') : `None yet. \`${p}cc add hello Hi {user}!\`\nPlaceholders: {user} {name} {server} {channel} {args} {choose:a|b|c}` }, c.cfg));
      }
      const key = name.toLowerCase();
      if (sub === 'remove') {
        if (!map[key]) return fail(c, 'Not found', `There is no custom command called \`${key}\`.`);
        delete map[key];
        return c.reply(ui.success({ title: 'Custom command removed', description: `\`${p}${key}\`` }, setConfig(c.serverId, { customCommands: map })));
      }
      if (sub !== 'add' || !key || !text.trim()) return fail(c, 'Custom commands', `Usage: \`${p}cc add <name> <reply>\``);
      if (!/^[a-z0-9_-]{1,32}$/.test(key)) return fail(c, 'Invalid name', 'Use 1 to 32 letters, numbers, - or _.');
      if (c.lookup.has(key) || c.cfg.aliases?.[key]) return fail(c, 'Already taken', `\`${key}\` is already a command or alias.`);
      if (!map[key] && Object.keys(map).length >= 50) return fail(c, 'Limit reached', 'Up to 50 custom commands.');
      map[key] = text.trim().slice(0, 1500);
      return c.reply(ui.success({ title: 'Custom command saved', description: `\`${p}${key}\`  →  ${map[key].slice(0, 200)}` }, setConfig(c.serverId, { customCommands: map })));
    },
  },
  {
    name: 'responder', aliases: ['ar', 'autoresponder'], category: 'Settings', perm: 'admin', usage: 'responder add|react|remove|list', desc: 'Reply or react when a word appears',
    run: (c) => {
      const list = [...(c.cfg.responders ?? [])];
      const [, sub = '', rest = ''] = /^(\S+)\s*([\s\S]*)$/.exec(c.body) ?? [];
      const p = c.prefix;
      if (sub === 'list' || !sub) {
        return c.reply(ui.info({ title: 'Auto-responders', description: list.length ? list.map((r, i) => `**${i + 1}**  \`${r.t}\`  →  ${r.e ?? r.r.slice(0, 80)}`).join('\n') : `None yet.\n\`${p}responder add hello | Hey {user}!\`\n\`${p}responder react gg | 🎉\`` }, c.cfg));
      }
      if (sub === 'remove') {
        const n = Number.parseInt(rest, 10);
        if (!Number.isInteger(n) || n < 1 || n > list.length) return fail(c, 'Invalid number', `See them with \`${p}responder list\`.`);
        list.splice(n - 1, 1);
        return c.reply(ui.success({ title: 'Auto-responder removed' }, setConfig(c.serverId, { responders: list })));
      }
      if (!['add', 'react'].includes(sub)) return fail(c, 'Auto-responders', `Usage: \`${p}responder add <word> | <reply>\` or \`react <word> | <emoji>\``);
      const cut = rest.indexOf('|');
      const t = rest.slice(0, cut).trim().toLowerCase();
      const v = rest.slice(cut + 1).trim();
      if (cut < 1 || !t || !v) return fail(c, 'Missing details', `Usage: \`${p}responder ${sub} <word> | <${sub === 'add' ? 'reply' : 'emoji'}>\``);
      if (list.length >= 50) return fail(c, 'Limit reached', 'Up to 50 auto-responders.');
      list.push(sub === 'add' ? { t: t.slice(0, 50), r: v.slice(0, 1500) } : { t: t.slice(0, 50), e: v.split(/\s+/)[0] });
      return c.reply(ui.success({ title: 'Auto-responder added', description: `\`${t}\`  →  ${sub === 'add' ? v.slice(0, 200) : v.split(/\s+/)[0]}` }, setConfig(c.serverId, { responders: list })));
    },
  },
];

export function attachCustom(bot) {
  const last = new Map();
  bot.on('message', async (raw) => {
    try {
      const c = ctxOf(raw);
      if (!c.serverId || raw.author_bot || raw.command) return;
      const cfg = getConfig(c.serverId);
      if (!cfg.responders?.length || c.content.startsWith(cfg.prefix)) return;
      const text = c.content.toLowerCase();
      const hit = cfg.responders.find((r) => text.includes(r.t));
      if (!hit) return;
      const key = `${bot.platformKey ?? 'yapper'}:${c.channelId}:${hit.t}`;
      if (Date.now() - (last.get(key) ?? 0) < 8000) return;
      last.set(key, Date.now());
      if (hit.e) await bot.react(c.channelId, c.id, hit.e);
      if (hit.r) await sendRich(bot, c, cfg, await fill(bot, c, hit.r, ''));
    } catch (err) { console.error('[responder]', err); }
  });
}
