// "<bot> is typing…" indicator for prefix commands, on both Yaper and baff.gg.
//
// baff.gg : uses the channel's native sendTyping() (re-sent every few seconds, because a typing
//           indicator expires on its own after ~10s).
// Yaper   : the Yaper bot API documents no typing endpoint, so we probe one once. If Yaper rejects it,
//           we remember that and fall back to a small "is typing…" message that only appears when a
//           command is still running after a short delay, and is deleted as soon as the command finishes.
//
// Everything here is best-effort: any failure is swallowed so a command can never break because of it.

const REFRESH_MS = 7000;      // native typing lasts ~10s, so refresh before it fades
const PLACEHOLDER_DELAY = 2000; // only show the fallback message for commands slower than this

const unsupported = { native: new Set() }; // platforms whose native typing call is known not to work

const nameOf = (bot) => {
  const raw = bot.me ?? bot.client?.user ?? {};
  return raw.display_name ?? raw.displayName ?? raw.username ?? raw.name ?? process.env.BOT_NAME ?? 'Johnny';
};

async function nativeTyping(bot, channelId) {
  const platform = bot.platformKey ?? 'yapper';
  if (unsupported.native.has(platform)) return false;
  try {
    if (platform === 'baff') {
      const channel = await bot._channel(channelId);
      if (typeof channel?.sendTyping !== 'function') { unsupported.native.add(platform); return false; }
      await channel.sendTyping();
      return true;
    }
    if (typeof bot.sendTyping === 'function') { await bot.sendTyping(channelId); return true; }
    if (typeof bot.api === 'function') { await bot.api('POST', `/channels/${channelId}/typing`, undefined, { retries: 0, timeout: 5000 }); return true; }
    unsupported.native.add(platform);
    return false;
  } catch (err) {
    // 404 / 405 / 501 etc. = endpoint doesn't exist. Don't keep poking it.
    if (!err?.status || [400, 404, 405, 410, 501].includes(err.status)) unsupported.native.add(platform);
    return false;
  }
}

/** Start the indicator. Returns an async stop() that must be called when the reply is done. */
export function startTyping(bot, channelId) {
  if (!bot || !channelId) return async () => {};
  let stopped = false;
  let refresh = null;
  let delayTimer = null;
  let placeholder = null;

  const startPlaceholder = () => {
    delayTimer = setTimeout(async () => {
      if (stopped) return;
      try {
        const msg = await bot.send(channelId, `*${nameOf(bot)} is typing…*`);
        placeholder = msg?.id ?? msg?.message?.id ?? null;
        if (stopped && placeholder) bot.delete(channelId, placeholder).catch(() => {});
      } catch { /* best effort */ }
    }, PLACEHOLDER_DELAY);
  };

  (async () => {
    if (stopped) return;
    if (await nativeTyping(bot, channelId)) {
      refresh = setInterval(() => { if (!stopped) nativeTyping(bot, channelId); }, REFRESH_MS);
    } else if (!stopped) {
      startPlaceholder();
    }
  })();

  return async () => {
    stopped = true;
    if (refresh) clearInterval(refresh);
    if (delayTimer) clearTimeout(delayTimer);
    if (placeholder) { const id = placeholder; placeholder = null; await bot.delete(channelId, id).catch(() => {}); }
  };
}

/** Run fn while the indicator is showing. */
export async function withTyping(bot, channelId, fn) {
  const stop = startTyping(bot, channelId);
  try { return await fn(); } finally { stop().catch(() => {}); }
}
