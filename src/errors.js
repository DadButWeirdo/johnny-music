// Turns raw API failures (like Cloudflare's HTML error pages) into one short, readable sentence.
export function cleanApiError(err) {
  const msg = String(err?.message ?? err ?? '');
  const html = /<!DOCTYPE|<html|<head|cf-error|cloudflare/i.test(msg);
  if (!html && msg.length < 400) return err instanceof Error ? err : new Error(msg);
  const code = /Error code (\d{3})/i.exec(msg)?.[1] ?? /\b(5\d\d)\b/.exec(msg)?.[1] ?? err?.status ?? '';
  const clean = new Error(html
    ? `Yapper’s servers had a temporary problem${code ? ` (error ${code})` : ''}. Please try again in a moment.`
    : msg.slice(0, 300));
  clean.status = err?.status ?? (Number(code) || undefined);
  clean.transient = html;
  return clean;
}

const isTransient = (e) => e?.transient || [502, 503, 504, 520, 521, 522, 524].includes(e?.status);

// Every SDK call goes through bot.api, so wrapping it covers everything.
export function wrapApi(bot) {
  const raw = bot.api.bind(bot);
  bot.api = async (...args) => {
    for (let attempt = 0; ; attempt++) {
      try { return await raw(...args); }
      catch (e) {
        const err = cleanApiError(e);
        if (attempt === 0 && isTransient(err)) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        throw err;
      }
    }
  };
}
