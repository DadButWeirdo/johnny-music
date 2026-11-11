import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, 'bin');
const executableName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const destination = path.join(binDir, executableName);

if (process.env.MUSIC_SKIP_YTDLP_DOWNLOAD === '1') process.exit(0);
if (existsSync(destination)) process.exit(0);
const systemBinary = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' });
if (systemBinary.status === 0) process.exit(0);

const assets = {
  linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : process.arch === 'x64' ? 'yt-dlp_linux' : null,
  darwin: process.arch === 'arm64' || process.arch === 'x64' ? 'yt-dlp_macos' : null,
  win32: process.arch === 'x64' ? 'yt-dlp.exe' : null,
};
const asset = assets[process.platform];
if (!asset) {
  console.warn('[music] Automatic yt-dlp setup is unavailable for this OS/architecture. Install yt-dlp and set MUSIC_YTDLP_PATH.');
  process.exit(0);
}

const temp = `${destination}.download`;
try {
  await mkdir(binDir, { recursive: true });
  const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
    headers: { 'user-agent': 'Johnny-Music-Setup/1.0' },
  });
  if (!response.ok || !response.body) throw new Error(`GitHub returned HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), (await import('node:fs')).createWriteStream(temp, { mode: 0o755 }));
  if (process.platform !== 'win32') await chmod(temp, 0o755);
  await rename(temp, destination);
  console.log('[music] Online song search is ready.');
} catch (error) {
  await rm(temp, { force: true }).catch(() => {});
  console.warn(`[music] Could not download yt-dlp automatically (${error.message}). Install yt-dlp on the host or set MUSIC_YTDLP_PATH. The rest of npm install can continue.`);
}
