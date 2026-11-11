# Johnny Music on your phone (Termux) — setup guide

Music runs on the phone, everything else on Katabump. Why Debian inside Termux: the LiveKit voice library has no build for plain Android/Termux (only Linux, macOS, Windows),
so we run a small Debian inside Termux with `proot-distro`. Everything below is copy-paste.
Lines starting with `#` are comments, don't type them.

## Step 0 — What you need before starting
Johnny's own bot token (the same one Katabump uses): `YAPPER_BOT_TOKEN` and/or `BAFF_BOT_TOKEN` + `BAFF_APP_ID`.
No new bot is needed. The phone copy is the music half of the same Johnny: it only answers the music commands
(`,play`, `,queue`, `,skip` ...), has no slash commands, and never touches Katabump's commands or data.
Johnny needs **Connect + Speak** permission in the voice channels.

## Step 1 — Install Termux
Install Termux from **F-Droid** (f-droid.org/packages/com.termux) or from GitHub releases (github.com/termux/termux-app/releases).
Do NOT use the Play Store version, it is outdated and broken. Open Termux and allow notifications if Android asks.

## Step 2 — Update Termux and install proot-distro (in Termux)
```
pkg update -y && pkg upgrade -y
```
(If it asks about config files, just press Enter.)
```
pkg install -y proot-distro curl
```

## Step 3 — Install Debian (in Termux, ~200-300 MB download)
```
proot-distro install debian
proot-distro login debian
```
Your prompt now looks like `root@localhost:~#` — you are inside Debian.

## Step 4 — Install the tools (inside Debian)
```
apt update && apt upgrade -y
apt install -y curl ca-certificates gnupg unzip ffmpeg nano
```
Install Node.js 22:
```
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
ffmpeg -version | head -1
```
`node -v` must show `v22.something`. Now leave Debian:
```
exit
```

## Step 5 — Get the zip onto the phone and into Debian
1. Download `johnny-music.zip` to your phone (it lands in Downloads).
2. In Termux:
```
termux-setup-storage
```
Tap **Allow**. Then:
```
ls ~/storage/downloads | grep -i johnny
cp ~/storage/downloads/johnny-music.zip $PREFIX/var/lib/proot-distro/installed-rootfs/debian/root/
```
(If the file name differs, e.g. `johnny-music(1).zip`, use that exact name, in quotes.)

## Step 6 — Unzip and install (back inside Debian)
```
proot-distro login debian
cd ~
unzip johnny-music.zip
cd johnny-music
cp .env.example .env
nano .env
```
Paste Johnny's tokens (the same ones Katabump uses). Save in nano: press **CTRL** (extra-keys row) then **O**, Enter, then **CTRL** then **X**.
```
npm install
```
This also downloads `yt-dlp` automatically. Look for `[music] Online song search is ready.`
If you do not see it, run this once:
```
mkdir -p bin && curl -L -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 && chmod +x bin/yt-dlp && bin/yt-dlp --version
```

## Step 7 — Self-test, then first start
```
npm run simulate
```
It should end with the music test passing (it prints "Music simulation passed"). Then:
```
npm start
```
You should see `[music] ... online startup complete`. Join a voice channel and type `,play <song>`.
Stop it with **CTRL + C**.

## Step 8 — One-command launcher + keep it alive
```
exit
```
(you are back in Termux), then create the launcher:
```
cat > ~/start-music.sh <<'EOT'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
proot-distro login debian -- bash -c "cd ~/johnny-music && bash run-forever.sh"
EOT
chmod +x ~/start-music.sh
```
From now on, starting the bot is just:
```
~/start-music.sh
```
It auto-restarts after crashes. Leave Termux in the background (do not swipe it away).

### Redmi 13c (MIUI / HyperOS) — stop Android from killing it
- Settings → Apps → Manage apps → **Termux** → **Autostart: ON**, **Battery saver: No restrictions**.
- Open the recent-apps screen, long-press the Termux card and **lock** it.
- Keep the phone on Wi-Fi and plugged in if possible. Pull down the notification shade: Termux should show "wake lock held".
Menu names vary a little between versions, but those are the three things to find.

## Daily use
- Start: `~/start-music.sh` · Stop: CTRL + C
- Update the bot later: unzip a new version into `~/johnny-music` (keep `.env` and `data/`), then `npm install`.
- Free space check: `du -sh ~/johnny-music` inside Debian.

## If something breaks
- `Process completed (signal 9)` → Android killed it; re-check the Redmi settings above.
- `apt` errors about sandbox/permissions in Debian → run `echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/99sandbox` then retry.
- YouTube says "Sign in to confirm you're not a bot" → ask for the cookies setup.
- Johnny goes offline / flips offline when the phone starts → both copies share one token and the platform may allow only one connection; tell me which platform and I'll adjust.
- Bot online but silent in voice → check Johnny has Connect + Speak, and that you are in a voice channel when you run `,play`.
