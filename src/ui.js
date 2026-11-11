import { theme } from './theme.js';

const toInt = (hex) => parseInt(String(hex).replace('#', ''), 16);
// Yapper rejects HTML-looking text in layouts. <member> becomes ‹member›, mentions are kept.
const safe = (s) => String(s).replace(/<(?![@#])([^>\s][^>]*)>/g, '‹$1›');
const text = (content) => ({ type: 10, content: safe(content) });
const gallery = (url) => ({ type: 12, items: [{ media: { url } }] });
const divider = (line = true) => ({ type: 14, divider: line, spacing: 1 });
const stamp = (iso) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';

// In admin-written text (spec.rich) these tags place an image or GIF exactly where they appear.
// {footerimage: …} / {footergif: …} go at the very bottom.
const TAG = /\{(gif|image|img|banner|footergif|footerimage)\s*:\s*(https?:\/\/[^\s}]+)\s*\}/gi;
function richParts(src) {
  const parts = [], footer = [];
  let last = 0, m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(src))) {
    const t = src.slice(last, m.index).trim();
    if (t) parts.push({ text: t });
    if (/^footer/i.test(m[1])) footer.push(m[2]); else parts.push({ media: m[2] });
    last = m.index + m[0].length;
  }
  const rest = src.slice(last).trim();
  if (rest) parts.push({ text: rest });
  return { parts, footer };
}

// 1. One model for every message. Per-server overrides live in cfg.look (see the look command).
function model(kind, spec, cfg) {
  const look = cfg?.look ?? {};
  const k = theme.kinds[kind] ?? {};
  const desc = String(spec.description ?? '');
  const rich = spec.rich ? richParts(desc) : null;
  const bare = Boolean(spec.bare);
  return {
    title: [look.glyphs === false ? '' : k.glyph, spec.title].filter(Boolean).join('  '),
    parts: rich ? rich.parts : (desc ? [{ text: desc }] : []),
    fields: spec.fields ?? [], // [[name, value, inline?], ...]
    rows: spec.rows ?? [],
    image: spec.image ?? null,
    footerMedia: rich?.footer?.[0] ?? look.footerImage ?? theme.footerImage ?? null,
    footer: bare ? null : (spec.footer ?? (look.footer === false ? null : look.footer ?? theme.brand)),
    color: toInt(look.colors?.[kind] ?? k.color ?? cfg?.color ?? theme.accent),
    at: !bare && (look.timestamp ?? theme.timestamp) ? new Date().toISOString() : undefined,
    look,
  };
}

// 2. Renderers turn the model into a payload. Add a new style = add one here.
const renderers = {
  embed: (m) => {
    const media = m.parts.find((p) => p.media)?.media ?? m.image ?? m.look.banner ?? theme.banner;
    const body = m.parts.filter((p) => p.text).map((p) => p.text).join('\n\n');
    return {
      embeds: [{
        title: m.title || undefined,
        description: body || undefined,
        color: m.color,
        fields: m.fields.map(([name, value, inline = false]) => ({ name, value: String(value).slice(0, 1024), inline })),
        ...(media && { image: { url: media } }),
        ...(m.footer || m.footerMedia ? { footer: { text: m.footer ?? '​', ...(m.footerMedia && { icon_url: m.footerMedia }) } } : {}),
        timestamp: m.at,
      }],
      ...(m.rows.length && { components: m.rows }),
    };
  },

  // Components V2: one sheet. banner / heading / text + images in place / fields / buttons / footer / footer image
  layout: (m) => {
    const banner = m.look.banner ?? theme.banner;
    const foot = [m.footer, m.at && stamp(m.at)].filter(Boolean).join('  ·  ');
    const components = [
      ...(banner ? [gallery(banner)] : []),
      ...(m.title ? [text(`## ${m.title}`)] : []),
      ...m.parts.map((p) => (p.media ? gallery(p.media) : text(p.text))),
      ...(m.image ? [gallery(m.image)] : []),
      ...(m.fields.length ? [divider(), text(m.fields.map(([n, v]) => `**${n}**\n${v}`).join('\n\n'))] : []),
      ...m.rows,
      ...(foot ? [divider(), text(foot)] : []),
      ...(m.footerMedia ? [gallery(m.footerMedia)] : []),
    ];
    const container = { type: 17, components };
    if (m.look.accentBar ?? theme.accentBar) container.accent_color = m.color;
    return { layout: (m.look.container ?? theme.container !== false) ? [container] : components };
  },
};

const make = (kind) => (spec, cfg) => {
  const m = model(kind, spec, cfg);
  const payload = renderers[cfg?.look?.style ?? theme.style](m);
  // If Components V2 is rejected by the server, send() falls back to this embed.
  Object.defineProperty(payload, 'fallback', { value: renderers.embed(m) });
  // People to notify. Mentions inside cards don't ping, so send() adds them as plain message text.
  Object.defineProperty(payload, 'ping', { value: cfg?.look?.pings === false ? [] : (spec.ping ?? []).map(String) });
  return payload;
};

export const ui = {
  success: make('success'),
  error: make('error'),
  notice: make('notice'),
  info: make('info'),
  log: make('log'),
};
