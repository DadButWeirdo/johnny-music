import { listRoles } from './adapter.js';

export const pick = (obj, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => a?.[k], obj);
    if (v !== undefined && v !== null) return v;
  }
};
export const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
export const rand = (n) => Math.floor(Math.random() * n);
export const sample = (list) => list[rand(list.length)];
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const idOf = (m) => m?.id ?? m?.message?.id ?? null;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const defang = (s) => String(s).replace(/@(everyone|here)/gi, '@\u200b$1');

export function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// "10m", "2h", "1d", "30s", "1w". A bare number means minutes. Returns milliseconds.
export function parseDuration(token) {
  const m = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(token ?? '');
  if (!m) return null;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(m[2] ?? 'm').toLowerCase()];
}

export function fmtDuration(ms) {
  const parts = [];
  let s = Math.round(ms / 1000);
  for (const [n, label] of [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']]) {
    if (s >= n) { parts.push(`${Math.floor(s / n)}${label}`); s %= n; }
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

export function fmtDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Channel by mention, id or name. No token = the channel the command was used in.
export async function findChannel(c, token, { type } = {}) {
  if (!token) return (await c.bot.channel(c.channelId)) ?? { id: c.channelId };
  const clean = token.replace(/^<#|>$/g, '').replace(/^#/, '').toLowerCase();
  const list = (await c.bot.channels(c.serverId, type ? { type } : {})) ?? [];
  return list.find((ch) => ch.id?.toLowerCase() === clean || ch.name?.toLowerCase() === clean) ?? null;
}

// Role by id or name (exact first, then "starts with").
export async function findRole(c, query) {
  const q = String(query ?? '').replace(/^<@&|>$/g, '').replace(/^@/, '').trim().toLowerCase();
  if (!q) return null;
  const roles = await listRoles(c.bot, c.serverId);
  return roles.find((r) => r.id?.toLowerCase() === q)
    ?? roles.find((r) => r.name?.toLowerCase() === q)
    ?? roles.find((r) => r.name?.toLowerCase().startsWith(q))
    ?? null;
}

// Everything after the first n words, with line breaks and blank lines kept as typed.
export const afterTokens = (s, n) => {
  let rest = String(s ?? '').trim();
  for (let i = 0; i < n; i++) rest = rest.replace(/^\S+\s*/, '');
  return rest;
};

// {gif: https://…} {image: …} {banner: …} {footerimage: …} are only for admin-written text.
export const MEDIA_TAG = /\{(?:gif|image|img|banner|footergif|footerimage)\s*:\s*https?:\/\/[^\s}]+\s*\}/gi;
export const stripMedia = (s) => String(s ?? '').replace(MEDIA_TAG, '').trim();
