import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { isIP } from 'node:net';
import { existsSync, statSync, writeFileSync, mkdirSync, createWriteStream, chmodSync, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/* ──────────────────────────────────────────────────────────────────────────
 * Johnny music source (Baff)
 *
 * What changed vs. the old version, and why:
 *
 *  1. Searches are FLAT (--flat-playlist --ignore-errors). The old code made yt-dlp fully
 *     extract every search hit, so ONE bad hit (SoundCloud "No suitable extractor",
 *     YouTube "Requested format is not available") killed the whole search and Johnny fell
 *     through to Audius, which returned random tracks. Flat searches only read titles,
 *     artists and durations, so they are fast and never die on a single bad entry.
 *  2. YouTube Music (songs), YouTube and SoundCloud are searched IN PARALLEL, merged and
 *     scored by one scorer. Audius is only a last resort.
 *  3. Strict relevance: a result must actually contain what you typed (typo tolerant) or it
 *     is rejected. Remixes / covers / slowed / live / tutorials are pushed down unless you
 *     asked for them. No match => a clear "no exact match" message, never random noise.
 *  4. The ranked runners-up are kept on the track, so if the stream of #1 fails Johnny moves
 *     to the NEXT-BEST MATCH of the same song, not to a fresh unrelated search.
 *  5. yt-dlp keeps itself current (YouTube breaks old builds constantly) and is told to use
 *     Node as its JavaScript runtime, which current YouTube extraction requires.
 * ────────────────────────────────────────────────────────────────────────── */

const clean = (value, max = 180) => String(value ?? '').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isSpotifyUrl = (value) => /^https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-z-]+\/)?track\/[A-Za-z0-9]+/i.test(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ───────────────────────────── text matching ───────────────────────────── */

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'by', 'to', 'in', 'on', 'for']);
// Words people add to a query that say nothing about WHICH song it is.
const QUERY_NOISE = new Set([
  'official', 'audio', 'video', 'lyrics', 'lyric', 'hd', 'hq', '4k', 'song', 'music', 'full', 'version',
  'feat', 'ft', 'featuring', 'new', 'latest', 'mp3', 'download', 'free',
]);

function tokenize(value) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ').filter(Boolean);
}
const compact = (value) => tokenize(value).join('');

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

// 1 = exact word, 0.85 = typo, 0.7 = word starts with it, 0 = absent
function tokenMatch(queryToken, haystack) {
  if (haystack.has(queryToken)) return 1;
  const allow = queryToken.length >= 9 ? 2 : queryToken.length >= 4 ? 1 : 0;
  let best = 0;
  for (const word of haystack) {
    if (allow && levenshtein(queryToken, word, allow) <= allow) return 0.85;
    if (queryToken.length >= 4 && word.length > queryToken.length && word.startsWith(queryToken) && word.length <= queryToken.length + 3) best = Math.max(best, 0.7);
  }
  return best;
}

function analyseQuery(term) {
  const all = tokenize(term);
  let meaningful = all.filter((t) => !STOPWORDS.has(t) && !QUERY_NOISE.has(t));
  if (!meaningful.length) meaningful = all;
  const requiredCoverage = meaningful.length >= 3 ? 0.7 : 0.85;
  return { all, tokens: meaningful, compact: compact(term), requiredCoverage };
}

// Variants nobody wants unless they typed the word themselves.
// [name, pattern for the result's title, penalty, pattern for the query that makes it OK]
const UNWANTED_VARIANTS = [
  ['remix', /\bremix(?:ed)?\b|\brmx\b|\bflip\b|\bbootleg\b|\bmashup\b|\bmash up\b/i, 14, /\b(remix|rmx|flip|bootleg|mashup)\b/],
  ['cover', /\bcover(?:ed)?\b|\btribute\b|\bin the style of\b/i, 14, /\b(cover|tribute)\b/],
  ['slowed', /\bslowed\b|\bsped up\b|\bspeed up\b|\bnightcore\b|\b8d\b|\b16d\b|\breverb\b|\bbass boosted\b|\bpitch(?:ed)?\b|\bdaycore\b/i, 14, /\b(slowed|sped|speed|nightcore|reverb|8d|16d|pitch|pitched|bass|boosted)\b/],
  ['karaoke', /\bkaraoke\b|\binstrumental\b|\bbacking track\b|\bminus one\b|\bacapella\b/i, 14, /\b(karaoke|instrumental|acapella|backing)\b/],
  ['live', /\blive\b|\bconcert\b|\bperformance\b|\bperforms\b|\bsession\b/i, 6, /\b(live|concert|performance|session)\b/],
  ['acoustic', /\bacoustic\b|\bunplugged\b|\bpiano version\b/i, 6, /\b(acoustic|unplugged|piano)\b/],
  ['lofi', /\blo ?-?fi\b/i, 8, /\b(lofi|lo|fi)\b/],
  ['tutorial', /\btutorial\b|\blesson\b|\bhow to\b|\breaction\b|\breacts?\b|\breview\b|\bexplained\b|\bbreakdown\b|\btype beat\b|\bfl studio\b|\bshorts?\b|\b1 hour\b|\b10 hours?\b|\bloop\b/i, 16, /\b(tutorial|lesson|reaction|review|loop|hour|hours|shorts?|beat|explained|breakdown)\b/],
  ['sample', /\bsnippet\b|\bpreview\b|\bteaser\b|\btrailer\b|\bleak(?:ed)?\b|\bunreleased\b|\bdemo\b/i, 10, /\b(snippet|preview|teaser|trailer|demo|leak|leaked|unreleased)\b/],
];

// Provider bonus only breaks ties between results that genuinely match.
const PROVIDER_BONUS = { 'YouTube Music': 7, YouTube: 4, SoundCloud: 0, Audius: -25 };

function scoreCandidate(candidate, query, { youtubeDemoted = false } = {}) {
  const title = candidate.title ?? '';
  const artist = candidate.artist ?? '';
  const hay = new Set(tokenize(`${title} ${artist} ${candidate.channel ?? ''}`).filter((t) => !STOPWORDS.has(t)));
  const titleWords = tokenize(title).filter((t) => !STOPWORDS.has(t));
  const artistWords = new Set(tokenize(artist));

  let matched = 0;
  for (const token of query.tokens) matched += tokenMatch(token, hay);
  let coverage = query.tokens.length ? matched / query.tokens.length : 0;
  // "g unit" vs "G-Unit", "lil loaded" vs "lilloaded"
  const compactHay = compact(`${artist} ${title} ${candidate.channel ?? ''}`);
  if (query.compact.length >= 4 && compactHay.includes(query.compact)) coverage = Math.max(coverage, 1);

  // How much of the TITLE is what you asked for (so "Faded" beats "Faded (Some Long Edit Name)").
  const queryWords = new Set(query.all);
  const titleHits = titleWords.filter((w) => queryWords.has(w) || artistWords.has(w)).length;
  const precision = titleWords.length ? titleHits / titleWords.length : 0;

  let score = coverage * 60 + precision * 10;

  const titleCompact = compact(title);
  if (titleCompact && (titleCompact === query.compact || compact(`${artist} ${title}`) === query.compact || compact(`${title} ${artist}`) === query.compact)) score += 12;

  const wanted = ` ${query.all.join(' ')} `;
  const text = `${title} ${candidate.channel ?? ''}`;
  let wrongVersion = false;
  for (const [, pattern, penalty, allowedWhen] of UNWANTED_VARIANTS) {
    if (!pattern.test(text) || allowedWhen.test(wanted)) continue;
    score -= penalty;
    // Remix / cover / slowed / karaoke / tutorial is a different recording: never play it by mistake.
    if (penalty >= 14) wrongVersion = true;
  }

  // Studio / label audio is what people mean by "play <song>".
  if (/\s-\s*topic$/i.test(candidate.channel ?? '') || /provided to youtube/i.test(candidate.description ?? '')) score += 5;
  if (/\bofficial audio\b|\(audio\)|\[audio\]|\baudio only\b/i.test(title)) score += 4;
  else if (/\bofficial\b/i.test(title)) score += 2;
  if (/\bvevo\b/i.test(candidate.channel ?? '')) score += 2;

  const duration = candidate.duration;
  if (Number.isFinite(duration)) {
    if (duration < 45) score -= 10;
    else if (duration < 75) score -= 4;
    if (duration > 900 && !/\b(mix|hour|hours|full|album|playlist|compilation|set)\b/.test(wanted)) score -= 12;
  } else if (candidate.provider === 'YouTube' || candidate.provider === 'YouTube Music') {
    score -= 5; // flat YouTube hits normally have a duration; none usually means live/upcoming
  }

  score += PROVIDER_BONUS[candidate.provider] ?? 0;
  if (youtubeDemoted && /youtube/i.test(candidate.provider ?? '')) score -= 15;
  // Each provider already ranks by its own relevance + popularity: keep that as a tie-break.
  score += Math.max(0, 6 - (candidate.rankIndex ?? 9) * 1.2);

  return { score, coverage, precision, wrongVersion };
}

/* ───────────────────────────── process / network helpers ───────────────────────────── */

function isPrivateAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (['localhost', 'localhost.localdomain'].includes(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
    if (host.startsWith('::ffff:')) return isPrivateAddress(host.slice('::ffff:'.length));
  }
  return false;
}

const localBinary = () => path.resolve(process.cwd(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function executablePath() {
  const configured = process.env.MUSIC_YTDLP_PATH;
  if (configured) return configured;
  const local = localBinary();
  return existsSync(local) ? local : 'yt-dlp';
}

function runCommand(executable, args, spawnProcess, timeoutMs = 35_000, { maxBytes = 4_000_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message, error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish({ code: -2, stdout, stderr: `${stderr}\nTimed out.`, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBytes) {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        finish({ code: -3, stdout: '', stderr: 'The music provider returned too much metadata.' });
      }
    });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
    child.once('error', (error) => finish({ code: -1, stdout, stderr: error.message, error }));
    child.once('close', (code) => finish({ code, stdout, stderr }));
  });
}

async function runJson(executable, args, spawnProcess, timeoutMs = 35_000) {
  const result = await runCommand(executable, args, spawnProcess, timeoutMs);
  if (result.error) throw new Error(`Couldn't start yt-dlp: ${result.error.message}. Johnny tries to download it automatically; otherwise install yt-dlp or set MUSIC_YTDLP_PATH.`);
  if (result.timedOut) throw new Error('Music search timed out. Please try again.');
  const text = result.stdout.trim();
  const failure = () => new Error(clean(result.stderr, 500) || `The music source returned exit code ${result.code}.`);
  if (result.code !== 0 && !text) throw failure();
  try { return JSON.parse(text); }
  catch {
    if (result.code !== 0) throw failure();
    throw new Error('The music provider returned an unreadable search result.');
  }
}

export function isYoutubeBotCheck(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return message.includes('sign in to confirm you’re not a bot')
    || message.includes("sign in to confirm you're not a bot")
    || message.includes('confirm you are not a bot')
    || message.includes('confirm you’re not a bot')
    || message.includes("confirm you're not a bot");
}

/* ───────────────────────────── track building ───────────────────────────── */

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeIdOf(info, pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (/(^|\.)youtube\.com$/.test(url.hostname)) {
      const v = url.searchParams.get('v');
      if (v && YT_ID.test(v)) return v;
      const shorts = /^\/shorts\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
      if (shorts) return shorts[1];
    }
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1, 12);
      if (YT_ID.test(id)) return id;
    }
  } catch { /* not a URL */ }
  return null;
}

// Old yt-dlp builds only recognise api.soundcloud.com/tracks/<digits>. Newer search results
// come back as ".../tracks/soundcloud%3Atracks%3A<digits>", which those builds reject with
// "No suitable extractor (Soundcloud)". The plain numeric form works on every version.
function soundcloudNumericUrl(url) {
  const match = /^https?:\/\/api(?:-v2)?\.soundcloud\.com\/tracks\/(?:soundcloud(?:%3A|:)tracks(?:%3A|:))?(\d+)/i.exec(String(url ?? ''));
  return match ? `https://api.soundcloud.com/tracks/${match[1]}` : null;
}

function bestThumbnail(info, youtubeId) {
  if (typeof info.thumbnail === 'string' && /^https:\/\//i.test(info.thumbnail)) return info.thumbnail;
  if (Array.isArray(info.thumbnails)) {
    for (let i = info.thumbnails.length - 1; i >= 0; i--) {
      const url = info.thumbnails[i]?.url;
      if (typeof url === 'string' && /^https:\/\//i.test(url)) return url;
    }
  }
  return youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : null;
}

function toTrack(info, { query, requestedSource = 'Direct link', provider = null } = {}) {
  if (!info || info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') return null;
  if (info._type === 'playlist') return null;
  const rawUrl = info.webpage_url ?? info.original_url ?? (String(info.url ?? '').startsWith('http') ? info.url : null);
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;

  let pageUrl = rawUrl;
  let id = info.id ? String(info.id) : null;
  const youtubeId = youtubeIdOf(info, rawUrl);
  if (youtubeId) {
    pageUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
    id = youtubeId;
  } else {
    const sc = soundcloudNumericUrl(rawUrl);
    if (sc) { pageUrl = sc; id = sc.split('/').pop(); }
  }
  // YouTube searches also return channels and playlists: only single videos are playable songs.
  if ((provider === 'YouTube' || provider === 'YouTube Music') && !youtubeId) return null;
  if (provider === 'SoundCloud' && /soundcloud\.com\/[^/]+\/sets\//i.test(pageUrl)) return null;

  const duration = Number(info.duration);
  const rawArtist = clean(info.artist ?? info.artists?.[0] ?? info.uploader ?? info.channel ?? info.creator, 120);
  return {
    id: String(id ?? pageUrl),
    title: clean(info.track ?? info.title, 180) || 'Untitled track',
    artist: rawArtist.replace(/\s*-\s*Topic$/i, ''),
    channel: clean(info.channel ?? info.uploader ?? '', 120),
    description: clean(info.description, 200),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    thumbnail: bestThumbnail(info, youtubeId),
    webpageUrl: pageUrl,
    source: provider ?? (clean(info.extractor_key ?? info.extractor, 32) || 'Direct link'),
    provider,
    requestedSource,
    query: clean(query, 180),
  };
}

function entriesOf(info) {
  if (Array.isArray(info?.entries)) return info.entries.filter(Boolean);
  return info ? [info] : [];
}

/* ───────────────────────────── the source ───────────────────────────── */

export class OnlineMusicSource {
  constructor({
    ytdlpPath,
    spawnProcess = nodeSpawn,
    fetchImpl = globalThis.fetch,
    timeoutMs = 35_000,
    fallbackLimit = 5,
    searchLimit = 8,
    autoUpdate,
    audiusApiBase = process.env.AUDIUS_API_BASE ?? 'https://api.audius.co',
    audiusAppName = process.env.AUDIUS_APP_NAME ?? 'johnny-bot',
  } = {}) {
    this.managedBinary = !ytdlpPath;
    this.ytdlpPath = ytdlpPath ?? executablePath();
    this.spawnProcess = spawnProcess;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.searchTimeoutMs = Math.min(timeoutMs, 25_000);
    this.fallbackLimit = Math.max(2, Math.min(Number(fallbackLimit) || 5, 8));
    this.searchLimit = Math.max(4, Math.min(Number(searchLimit) || 8, 15));
    this.audiusApiBase = String(audiusApiBase).replace(/\/+$/, '');
    this.audiusAppName = clean(audiusAppName, 80) || 'johnny-bot';
    this.autoUpdate = autoUpdate ?? (this.managedBinary && process.env.MUSIC_YTDLP_AUTOUPDATE !== '0');
    this.channel = ['stable', 'nightly', 'master'].includes(process.env.MUSIC_YTDLP_CHANNEL) ? process.env.MUSIC_YTDLP_CHANNEL : 'nightly';
    this.supportsJsRuntimes = false;
    this.supportsIgnoreNoFormats = false;
    this.version = null;
    this.youtubeDemotedUntil = 0;
    this.ready = null;
    // Prepare yt-dlp in the background so the first /play is already on a fresh build.
    if (this.autoUpdate) {
      this.ready = this.prepare().catch((error) => console.warn('[baff music] yt-dlp setup:', error?.message ?? error));
    }
  }

  /* ----- yt-dlp lifecycle ----- */

  async prepare() {
    let check = await runCommand(this.ytdlpPath, ['--version'], this.spawnProcess, 15_000);
    if (check.code !== 0 && !process.env.MUSIC_YTDLP_PATH) {
      const downloaded = await this.downloadBinary().catch((error) => { console.warn(`[baff music] Could not download yt-dlp: ${error.message}`); return false; });
      if (downloaded) {
        this.ytdlpPath = localBinary();
        check = await runCommand(this.ytdlpPath, ['--version'], this.spawnProcess, 15_000);
      }
    }
    if (check.code === 0) await this.updateIfStale();
    await this.probeCapabilities();
  }

  async whenReady(maxWaitMs = 25_000) {
    if (!this.ready) return;
    await Promise.race([this.ready, sleep(maxWaitMs)]);
  }

  async downloadBinary() {
    const assets = {
      linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : process.arch === 'x64' ? 'yt-dlp_linux' : null,
      darwin: process.arch === 'arm64' || process.arch === 'x64' ? 'yt-dlp_macos' : null,
      win32: process.arch === 'x64' ? 'yt-dlp.exe' : null,
    };
    const asset = assets[process.platform];
    if (!asset || !this.fetchImpl) return false;
    const base = this.channel === 'stable'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
      : this.channel === 'master'
        ? 'https://github.com/yt-dlp/yt-dlp-master-builds/releases/latest/download'
        : 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download';
    const destination = localBinary();
    const temp = `${destination}.download`;
    try {
      mkdirSync(path.dirname(destination), { recursive: true });
      const response = await this.fetchImpl(`${base}/${asset}`, { redirect: 'follow', signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'Johnny-Music/2.0' } });
      if (!response.ok || !response.body) throw new Error(`GitHub returned HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { mode: 0o755 }));
      if (process.platform !== 'win32') chmodSync(temp, 0o755);
      renameSync(temp, destination);
      console.log(`[baff music] Downloaded yt-dlp (${this.channel}).`);
      return true;
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }

  async updateIfStale() {
    // YouTube changes weekly; an old yt-dlp is the #1 cause of "Requested format is not available".
    const marker = path.join(path.dirname(localBinary()), '.yt-dlp-last-update');
    try {
      if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 12 * 3600_000) return;
    } catch { /* update anyway */ }
    const result = await runCommand(this.ytdlpPath, ['-U', '--update-to', `${this.channel}@latest`], this.spawnProcess, 120_000);
    const out = clean(`${result.stdout} ${result.stderr}`, 200);
    if (result.code === 0) console.log(`[baff music] yt-dlp update check: ${out || 'ok'}`);
    else console.warn(`[baff music] yt-dlp self-update skipped (${out || `exit ${result.code}`}). Update it manually if YouTube fails.`);
    try { mkdirSync(path.dirname(marker), { recursive: true }); writeFileSync(marker, String(Date.now())); } catch { /* read-only host */ }
  }

  async probeCapabilities() {
    const version = await runCommand(this.ytdlpPath, ['--version'], this.spawnProcess, 15_000);
    if (version.code === 0) this.version = clean(version.stdout, 40);
    const help = await runCommand(this.ytdlpPath, ['--help'], this.spawnProcess, 20_000, { maxBytes: 600_000 });
    const text = help.stdout ?? '';
    this.supportsJsRuntimes = text.includes('--js-runtimes');
    this.supportsIgnoreNoFormats = text.includes('--ignore-no-formats-error');
    if (this.version) console.log(`[baff music] yt-dlp ${this.version}${this.supportsJsRuntimes ? ' (Node JS runtime enabled)' : ' (old build: no JS runtime support, YouTube may fail)'}`);
  }

  commonArgs() {
    const args = ['--ignore-config', '--no-warnings', '--no-progress', '--socket-timeout', '15', '--retries', '2', '--extractor-retries', '2'];
    // Current YouTube extraction needs a JavaScript runtime; Johnny is already running on Node.
    if (this.supportsJsRuntimes && process.env.MUSIC_YTDLP_JS_RUNTIME !== 'off') args.push('--js-runtimes', `node:${process.execPath}`);
    const cookies = process.env.MUSIC_YOUTUBE_COOKIES;
    if (cookies && existsSync(cookies)) args.push('--cookies', cookies);
    if (process.env.MUSIC_YTDLP_EXTRA_ARGS) args.push(...process.env.MUSIC_YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean));
    return args;
  }

  flatSearchArgs(target) {
    return [...this.commonArgs(), '--flat-playlist', '--ignore-errors', '--skip-download', '--dump-single-json', target];
  }

  linkArgs(url) {
    const args = [...this.commonArgs(), '--no-playlist', '--skip-download', '--dump-single-json'];
    if (this.supportsIgnoreNoFormats) args.push('--ignore-no-formats-error');
    args.push(url);
    return args;
  }

  /* ----- providers ----- */

  async flatSearch(target, provider, { query, requestedSource }) {
    const info = await runJson(this.ytdlpPath, this.flatSearchArgs(target), this.spawnProcess, this.searchTimeoutMs);
    const tracks = [];
    const seen = new Set();
    let rankIndex = 0;
    for (const entry of entriesOf(info)) {
      const track = toTrack(entry, { query, requestedSource, provider });
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      track.rankIndex = rankIndex++;
      tracks.push(track);
    }
    return tracks;
  }

  async searchAudius(term, { limit = this.fallbackLimit, query = term } = {}) {
    if (!this.fetchImpl) return [];
    const safeTerm = clean(term, 180);
    if (!safeTerm) return [];
    let base;
    try {
      base = new URL(this.audiusApiBase);
    } catch {
      throw new Error('AUDIUS_API_BASE must be a valid HTTPS URL.');
    }
    // HTTPS is required in production; local HTTP is allowed only for the offline test server.
    if (base.protocol !== 'https:' && !isPrivateAddress(base.hostname)) {
      throw new Error('Audius API must use HTTPS.');
    }
    const url = new URL('/v1/tracks/search', base);
    url.searchParams.set('query', safeTerm);
    url.searchParams.set('app_name', this.audiusAppName);
    url.searchParams.set('limit', String(Math.max(1, Math.min(Number(limit) || 5, 10))));
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Audius search returned HTTP ${response.status}.`);
    const payload = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const results = [];
    const seen = new Set();
    for (const item of data) {
      if (!item || item.is_delete || item.is_unlisted || item.is_available === false || !item.id) continue;
      const id = String(item.id);
      if (!/^[A-Za-z0-9_-]{2,100}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const title = clean(item.title, 180);
      if (!title) continue;
      const duration = Number(item.duration);
      const permalink = typeof item.permalink === 'string' && item.permalink.startsWith('/')
        ? `https://audius.co${item.permalink}`
        : 'https://audius.co';
      const streamUrl = new URL(`/v1/tracks/${encodeURIComponent(id)}/stream`, base);
      streamUrl.searchParams.set('app_name', this.audiusAppName);
      results.push({
        id,
        title,
        artist: clean(item.user?.name ?? item.artist, 120),
        channel: '',
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        thumbnail: typeof item.artwork?.['480x480'] === 'string' ? item.artwork['480x480'] : null,
        webpageUrl: permalink,
        audioUrl: streamUrl.toString(),
        source: 'Audius',
        provider: 'Audius',
        requestedSource: 'Audius fallback',
        query: clean(query, 180),
        rankIndex: results.length,
      });
      if (results.length >= Math.max(1, Math.min(Number(limit) || 5, 10))) break;
    }
    return results;
  }

  async spotifySearchTerm(url) {
    if (!this.fetchImpl) throw new Error('Spotify link lookup is unavailable in this Node runtime.');
    // Spotify is used for track metadata only. Playback is resolved separately from a playable source.
    const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    const response = await this.fetchImpl(endpoint, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Spotify couldn't provide track details (${response.status}). Try the song title instead.`);
    const data = await response.json();
    const title = clean(data.title, 180);
    const artist = clean(data.author_name, 120);
    if (!title) throw new Error('I could not read the song name from that Spotify link. Try the title and artist instead.');
    return { term: [artist, title].filter(Boolean).join(' '), title, artist };
  }

  /* ----- search + ranking ----- */

  // Search every provider at once, score everything with one scorer, keep only real matches.
  async findCandidates(term, { query = term, spotify = false, excludeUrls = [], matchTerm = term } = {}) {
    await this.whenReady();
    // `term` is what we ask the providers; `matchTerm` is what a result must actually contain.
    const analysed = analyseQuery(matchTerm);
    const n = this.searchLimit;
    const tag = spotify ? 'Spotify match via ' : '';
    const safeTerm = clean(term, 180);
    const jobs = [
      ['YouTube Music', () => this.flatSearch(`https://music.youtube.com/search?q=${encodeURIComponent(safeTerm)}#songs`, 'YouTube Music', { query, requestedSource: `${tag}YouTube Music` })],
      ['YouTube', () => this.flatSearch(`ytsearch${n}:${safeTerm}`, 'YouTube', { query, requestedSource: `${tag}YouTube` })],
      ['SoundCloud', () => this.flatSearch(`scsearch${n}:${safeTerm}`, 'SoundCloud', { query, requestedSource: `${tag}SoundCloud` })],
      ['Audius', () => this.searchAudius(safeTerm, { limit: 5, query })],
    ];
    const settled = await Promise.allSettled(jobs.map(([, job]) => job()));
    const errors = [];
    const pool = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') pool.push(...outcome.value);
      else errors.push(`${jobs[index][0]}: ${clean(outcome.reason?.message ?? outcome.reason, 160)}`);
    });

    const excluded = new Set(excludeUrls.filter(Boolean).map((url) => String(url).toLowerCase()));
    const demoted = Date.now() < this.youtubeDemotedUntil;
    const scored = [];
    const seenKey = new Set();
    for (const candidate of pool) {
      const key = candidate.webpageUrl.toLowerCase();
      if (excluded.has(key) || seenKey.has(key)) continue;
      seenKey.add(key);
      scored.push({ candidate, ...scoreCandidate(candidate, analysed, { youtubeDemoted: demoted }) });
    }
    scored.sort((a, b) => b.score - a.score);

    // Drop the same recording uploaded twice (same title + near-identical length) on the same provider.
    const finalSeen = new Set();
    const qualified = [];
    for (const item of scored) {
      if (item.coverage < analysed.requiredCoverage || item.wrongVersion) continue;
      const fingerprint = `${compact(item.candidate.title)}|${Math.round((item.candidate.duration ?? 0) / 3)}|${item.candidate.provider}`;
      if (finalSeen.has(fingerprint)) continue;
      finalSeen.add(fingerprint);
      qualified.push(item.candidate);
    }
    const nearMisses = scored.filter((item) => (item.coverage < analysed.requiredCoverage || item.wrongVersion) && item.coverage > 0)
      .sort((a, b) => b.coverage - a.coverage || b.score - a.score)
      .slice(0, 3).map((item) => item.candidate);
    return { qualified, nearMisses, errors, total: pool.length };
  }

  async search(input) {
    let query = clean(input, 240);
    if (/^spotify:track:[A-Za-z0-9]+$/i.test(query)) query = `https://open.spotify.com/track/${query.split(':').at(-1)}`;
    if (!query) throw new Error('Type a song name or paste a supported music link.');

    let spotify = null;
    if (isSpotifyUrl(query)) spotify = await this.spotifySearchTerm(query);

    const isUrl = /^https?:\/\//i.test(query) && !spotify;
    let track = null;

    if (isUrl) {
      const parsed = new URL(query);
      if (parsed.username || parsed.password) throw new Error('Links containing embedded usernames or passwords are not supported.');
      if (isPrivateAddress(parsed.hostname)) throw new Error('That URL is not a public music source.');
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only public HTTP(S) music links are supported.');
      await this.whenReady();
      try {
        const info = await runJson(this.ytdlpPath, this.linkArgs(query), this.spawnProcess, this.timeoutMs);
        track = entriesOf(info).map((entry) => toTrack(entry, { query, requestedSource: 'Direct link' })).find(Boolean) ?? null;
      } catch (error) {
        throw new Error(`Could not read that music link: ${clean(error.message, 260)}. Try a song title or a supported direct audio URL.`);
      }
      if (!track) throw new Error('No playable track was found at that link.');
    } else {
      const term = spotify?.term ?? query;
      const { qualified, nearMisses, errors, total } = await this.findCandidates(term, { query, spotify: Boolean(spotify) });
      if (!qualified.length) {
        if (total === 0 && errors.length) {
          throw new Error(`Every music provider failed for “${clean(term, 120)}”: ${errors.join(' | ')}`);
        }
        const close = nearMisses.length
          ? ` Closest results were: ${nearMisses.map((t) => `${t.title}${t.artist ? ` — ${t.artist}` : ''}`).join('; ')}. Run play again with the exact title and artist.`
          : ' Try the exact title and artist, or paste a link.';
        throw new Error(`I couldn’t find an exact match for “${clean(term, 120)}”, so I didn’t play anything random.${close}`);
      }
      track = qualified[0];
      // Keep the ranked runners-up: if this stream fails we move to the next-best match of the SAME song.
      track.alternates = qualified.slice(1, 1 + this.fallbackLimit * 3);
    }

    if (spotify) {
      track.artist = track.artist || spotify.artist;
      track.spotifyTitle = spotify.title;
    }
    if (track.duration && track.duration > Number(process.env.MUSIC_MAX_DURATION_SECONDS ?? 14_400)) {
      throw new Error('That track is longer than Johnny’s playback limit.');
    }
    return track;
  }

  async fallbackTracks(track, { limit = this.fallbackLimit, excludeUrls = [] } = {}) {
    if (!track) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || this.fallbackLimit, 8));
    const provider = String(track.provider ?? track.source ?? '');
    // A YouTube stream just failed: prefer other providers for a while (usually a bot check / blocked IP).
    if (/youtube/i.test(provider)) this.youtubeDemotedUntil = Date.now() + 5 * 60_000;

    const failed = new Set([track.webpageUrl, ...excludeUrls].filter(Boolean).map((url) => String(url).toLowerCase()));
    let pool = Array.isArray(track.alternates) ? track.alternates : null;

    if (!pool) {
      // Direct links have no ranked list: look for the same song by its own title and artist.
      const title = track.spotifyTitle || track.title;
      const term = [track.artist, title].filter(Boolean).join(' ') || track.query;
      if (!term) return [];
      // The artist is only used to search; a re-upload by a different channel is still the same song.
      const found = await this.findCandidates(term, { query: track.query || term, excludeUrls: [...failed], matchTerm: title });
      pool = found.qualified;
      if (!pool.length && found.total === 0 && found.errors.length) throw new Error(found.errors.join(' | '));
    }

    const remaining = pool.filter((candidate) => !failed.has(String(candidate.webpageUrl).toLowerCase()));
    // Same ranking, but results from a different provider than the one that just failed go first.
    const isSame = (candidate) => String(candidate.provider ?? candidate.source) === provider;
    const ordered = /youtube|audius/i.test(provider)
      ? [...remaining.filter((c) => !isSame(c)), ...remaining.filter(isSame)]
      : remaining;
    return ordered.slice(0, safeLimit * 3).map((candidate) => ({
      ...candidate,
      artist: candidate.artist || track.artist,
      ...(track.spotifyTitle ? { spotifyTitle: track.spotifyTitle } : {}),
    }));
  }

  // Kept for integrations that expect one fallback result; the player uses fallbackTracks.
  async fallbackTrack(track) {
    return (await this.fallbackTracks(track, { limit: 1 }))[0] ?? null;
  }

  streamArgs(track) {
    return [
      ...this.commonArgs(), '--quiet', '--no-playlist', '--no-part', '--fragment-retries', '3',
      '-f', 'bestaudio/best', '-o', '-', String(track.webpageUrl).replace(/^https?:\/\/music\.youtube\.com\//i, 'https://www.youtube.com/'),
    ];
  }
}

export { executablePath as getYtDlpPath };
