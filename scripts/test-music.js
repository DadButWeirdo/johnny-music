import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { OnlineMusicSource } from '../src/music/online-source.js';
import { MusicManager } from '../src/music/player.js';
import { getConfig, load, withStore } from '../src/store.js';

const temp = await mkdtemp(path.join(tmpdir(), 'johnny-music-port-test-'));
process.env.BAFF_DATA_FILE = path.join(temp, 'baff-servers.json');
try {
  const toneFile = path.join(temp, 'tone.wav');
  const tone = spawnSync(process.env.MUSIC_FFMPEG ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', toneFile,
  ], { encoding: 'utf8' });
  assert.equal(tone.status, 0, `Could not generate test tone: ${tone.stderr}`);

  const makeScript = async (name, body) => {
    const file = path.join(temp, name);
    if (process.platform === 'win32') {
      await writeFile(file, `@echo off\r\n${body.replaceAll('\n', '\r\n')}\r\n`);
    } else {
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o755);
    }
    return file;
  };
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const tonePath = quote(toneFile);

  // Text searches run YouTube Music, YouTube and SoundCloud together (flat, so one bad hit can't kill them)
  // and pick the best REAL match.
  const multiProviderYtDlp = await makeScript('multi-yt-dlp', `case "$*" in
  *--flat-playlist*) case "$*" in
    *music.youtube.com*) printf '%s\\n' '{"entries":[]}' ;;
    *ytsearch*) printf '%s\\n' '{"entries":[{"id":"aaaaaaaaaaa","title":"Test Tone (Slowed + Reverb)","channel":"Random","duration":1,"url":"https://www.youtube.com/watch?v=aaaaaaaaaaa","ie_key":"Youtube"}]}' ;;
    *scsearch*) printf '%s\\n' '{"entries":[{"id":"1","title":"Test Tone","uploader":"Johnny Tests","duration":100,"webpage_url":"https://soundcloud.com/johnny-tests/test-tone","url":"https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A1","ie_key":"Soundcloud"}]}' ;;
  esac ;;
  *) cat ${tonePath} ;;
esac`);
  const searchCalls = [];
  const source = new OnlineMusicSource({
    ytdlpPath: multiProviderYtDlp,
    spawnProcess: (command, args, options) => { searchCalls.push(args); return spawn(command, args, options); },
  });
  const searchTrack = await source.search('test tone');
  assert.equal(searchTrack.title, 'Test Tone');
  assert.equal(searchTrack.source, 'SoundCloud', 'the slowed/reverb YouTube upload must lose to the real track');
  assert.ok(searchCalls.every((args) => args.includes('--flat-playlist') && args.includes('--ignore-errors')), 'searches must be flat and error tolerant');
  assert.ok(searchCalls.some((args) => args.at(-1).startsWith('scsearch')) && searchCalls.some((args) => args.at(-1).startsWith('ytsearch')) && searchCalls.some((args) => args.at(-1).includes('music.youtube.com')), 'all three providers are searched');
  assert.ok(searchCalls[0].includes('--ignore-config'), 'yt-dlp must ignore machine-wide config files');
  await assert.rejects(() => source.search('zzqx unrelated gibberish'), /exact match/, 'unrelated results must never be played');

  // If SoundCloud returns no result and YouTube has a format error, Audius is tried next.
  const emptyAndFormatYtDlp = await makeScript('empty-format-yt-dlp', `case "$*" in
  *--dump-single-json*) case "$*" in
    *scsearch*) printf '%s\\n' '{"entries":[]}' ;;
    *ytsearch*) echo 'ERROR: [youtube] Requested format is not available. Use --list-formats for a list of available formats' >&2; exit 1 ;;
  esac ;;
  *) exit 2 ;;
esac`);
  const apiFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/tracks/search') {
      return new Response(JSON.stringify({ data: [{
        id: 'format-fallback-01', title: 'Faded (Audius test)', duration: 210,
        user: { name: 'Test Artist' }, permalink: '/test/faded',
        is_available: true, is_delete: false, is_unlisted: false, artwork: {},
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  };
  const formatFallbackSource = new OnlineMusicSource({
    ytdlpPath: emptyAndFormatYtDlp,
    spawnProcess: spawn,
    fetchImpl: apiFetch,
    audiusApiBase: 'http://127.0.0.1:54321',
  });
  const formatFallbackTrack = await formatFallbackSource.search('faded');
  assert.equal(formatFallbackTrack.source, 'Audius');
  assert.equal(formatFallbackTrack.id, 'format-fallback-01');

  const fakeRtc = {
    AudioFrame: class AudioFrame {
      constructor(samples, sampleRate, channels, samplesPerChannel) {
        this.samples = samples; this.sampleRate = sampleRate; this.channels = channels; this.samplesPerChannel = samplesPerChannel;
      }
    },
  };

  // Reproduce the provider failures from the logs: YouTube bot check, then a
  // DRM-locked SoundCloud result, then a second SoundCloud result that can play.
  const playbackYtDlp = await makeScript('playback-yt-dlp', `case "$*" in
  *youtube.com/watch?v=blocked*) echo 'ERROR: [youtube] Sign in to confirm you are not a bot. This helps protect our community.' >&2; exit 1 ;;
  *soundcloud.com/test/faded-drm*) echo 'ERROR: [soundcloud] This video is DRM protected' >&2; exit 1 ;;
  *soundcloud.com/test/faded-playable*) cat ${tonePath} ;;
  *) echo 'unexpected extractor request' >&2; exit 2 ;;
esac`);
  const youtubeTrack = {
    id: 'youtube-blocked', title: 'Faded', artist: 'Test Artist', duration: 1,
    webpageUrl: 'https://www.youtube.com/watch?v=blocked', source: 'Youtube', requestedSource: 'YouTube search',
    query: 'faded',
  };
  const soundcloudAlternatives = [
    { id: 'sc-drm', title: 'Faded DRM', artist: 'Test Artist', duration: 1, webpageUrl: 'https://soundcloud.com/test/faded-drm', source: 'Soundcloud', requestedSource: 'SoundCloud alternative' },
    { id: 'sc-playable', title: 'Faded playable', artist: 'Test Artist', duration: 1, webpageUrl: 'https://soundcloud.com/test/faded-playable', source: 'Soundcloud', requestedSource: 'SoundCloud alternative' },
  ];
  const playbackSource = {
    ytdlpPath: playbackYtDlp,
    streamArgs: (track) => OnlineMusicSource.prototype.streamArgs.call(source, track),
    async fallbackTracks() { return soundcloudAlternatives; },
  };
  const playbackManager = new MusicManager({ platformKey: 'baff' }, {
    source: playbackSource,
    rtcLoader: async () => fakeRtc,
    spawnProcess: spawn,
    ffmpegPath: process.env.MUSIC_FFMPEG ?? 'ffmpeg',
  });
  let fallbackFrames = 0;
  const playbackSession = {
    stopping: false, skipRequested: false, replayRequested: false, paused: false, pauseWaiters: [], activeProcesses: [], volume: 100,
    rtc: fakeRtc, current: youtubeTrack,
    sourceTrack: { async captureFrame(frame) { assert.equal(frame.sampleRate, 48_000); fallbackFrames++; }, async waitForPlayout() {} },
  };
  await playbackManager.streamTrack(playbackSession, youtubeTrack);
  assert.equal(playbackSession.current.title, 'Faded playable');
  assert.ok(fallbackFrames >= 90, `Expected audio frames after rejecting the DRM result; got ${fallbackFrames}`);

  // When all SoundCloud results fail with DRM, the independent Audius HTTP
  // stream is used directly by FFmpeg. It is not sent through yt-dlp.
  const toneBuffer = await readFile(toneFile);
  const audiusServer = createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (requestUrl.pathname === '/v1/tracks/search') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{
        id: 'audius-test-01', title: 'Faded (Audius test stream)', duration: 1,
        user: { name: 'Johnny Test Creator' }, permalink: '/johnny-test/faded',
        is_available: true, is_delete: false, is_unlisted: false, artwork: {},
      }] }));
      return;
    }
    if (requestUrl.pathname === '/v1/tracks/audius-test-01/stream') {
      response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': toneBuffer.length });
      response.end(toneBuffer);
      return;
    }
    response.writeHead(404); response.end('Not found');
  });
  await new Promise((resolve) => audiusServer.listen(0, '127.0.0.1', resolve));
  const audiusBase = `http://127.0.0.1:${audiusServer.address().port}`;
  try {
    const drmYtDlp = await makeScript('all-drm-yt-dlp', `case "$*" in
      *soundcloud*) echo 'ERROR: [soundcloud] This video is DRM protected' >&2; exit 1 ;;
      *youtube*) echo 'ERROR: [youtube] Sign in to confirm you are not a bot' >&2; exit 1 ;;
      *) exit 2 ;;
    esac`);
    const audiusSource = new OnlineMusicSource({
      ytdlpPath: drmYtDlp, spawnProcess: spawn, audiusApiBase: audiusBase,
      audiusAppName: 'johnny-test', fallbackLimit: 3,
    });
    const audiusTrack = { ...youtubeTrack };
    const audiusManager = new MusicManager({ platformKey: 'baff' }, {
      source: audiusSource, rtcLoader: async () => fakeRtc, spawnProcess: spawn,
      ffmpegPath: process.env.MUSIC_FFMPEG ?? 'ffmpeg',
    });
    let audiusFrames = 0;
    const audiusSession = {
      stopping: false, skipRequested: false, replayRequested: false, paused: false, pauseWaiters: [], activeProcesses: [], volume: 100,
      rtc: fakeRtc, current: audiusTrack,
      sourceTrack: { async captureFrame(frame) { assert.equal(frame.sampleRate, 48_000); audiusFrames++; }, async waitForPlayout() {} },
    };
    await audiusManager.streamTrack(audiusSession, audiusTrack);
    assert.equal(audiusSession.current.source, 'Audius');
    assert.equal(audiusSession.current.id, 'audius-test-01');
    assert.ok(audiusFrames >= 90, `Expected Audius PCM frames, got ${audiusFrames}`);
  } finally {
    await new Promise((resolve) => audiusServer.close(resolve));
  }

  // Spotify is metadata only; its title and artist are resolved through the
  // same SoundCloud-first source selection as ordinary text searches.
  const spotifyFetch = async () => new Response(JSON.stringify({ title: 'Faded', author_name: 'Alan Walker' }), { status: 200 });
  const spotifyYtDlp = await makeScript('spotify-yt-dlp', `case "$*" in
  *--flat-playlist*) case "$*" in
    *scsearch*) printf '%s\n' '{"entries":[{"id":"9","title":"Faded","uploader":"Alan Walker","duration":200,"webpage_url":"https://soundcloud.com/alanwalker/faded","ie_key":"Soundcloud"}]}' ;;
    *) printf '%s\n' '{"entries":[]}' ;;
  esac ;;
esac`);
  const spotifySource = new OnlineMusicSource({
    ytdlpPath: spotifyYtDlp,
    spawnProcess: spawn,
    fetchImpl: spotifyFetch,
  });
  const spotifyTrack = await spotifySource.search('https://open.spotify.com/track/0000000000000000000000');
  assert.equal(spotifyTrack.requestedSource, 'Spotify match via SoundCloud');
  assert.equal(spotifyTrack.artist, 'Alan Walker');
  assert.equal(spotifyTrack.spotifyTitle, 'Faded');

  // PCM scaling and the imported Discord-style queue controls.
  let frames = 0;
  const manager = new MusicManager({ platformKey: 'baff' }, {
    source,
    rtcLoader: async () => fakeRtc,
    spawnProcess: spawn,
    ffmpegPath: process.env.MUSIC_FFMPEG ?? 'ffmpeg',
  });
  const session = {
    stopping: false, skipRequested: false, replayRequested: false, paused: false,
    pauseWaiters: [], activeProcesses: [], volume: 50, rtc: fakeRtc,
    sourceTrack: { async captureFrame(frame) { assert.equal(frame.sampleRate, 48_000); frames++; }, async waitForPlayout() {} },
  };
  await manager.streamTrack(session, searchTrack);
  assert.ok(frames >= 90, `Expected FFmpeg PCM frames, got ${frames}`);

  const controlSession = {
    serverId: 'test-server', textChannelId: 'test-channel', voiceChannelId: 'test-voice',
    queue: [{ title: 'Queued 1' }, { title: 'Queued 2' }, { title: 'Queued 3' }], current: { title: 'Current' },
    loop: 'off', loopCurrent: false, volume: 80, paused: false, pauseWaiters: [], activeProcesses: [],
    stopping: false, skipRequested: false, replayRequested: false, stopRequested: false,
    closed: false, pumping: false, status: 'Playing', is247: false, room: { async disconnect() {} },
  };
  const controlManager = new MusicManager({ async leaveVoice() {} });
  controlManager.sessions.set('test-server', controlSession);
  assert.equal(await controlManager.pause('test-server', { render: false }), true);
  assert.equal(await controlManager.resume('test-server', { render: false }), true);
  assert.equal(await controlManager.setLoop('test-server', 'queue', { render: false }), 'queue');
  assert.equal(await controlManager.toggleLoop('test-server', { render: false }), 'off');
  assert.equal(await controlManager.unloop('test-server', { render: false }), true);
  assert.equal(await controlManager.setVolume('test-server', 65, { render: false }), 65);
  assert.equal(await controlManager.remove('test-server', 2, { render: false }).then((track) => track.title), 'Queued 2');
  assert.equal(await controlManager.shuffle('test-server', { render: false }), 2);
  assert.equal(await controlManager.clearQueue('test-server', { render: false }), 2);
  assert.equal(await controlManager.skip('test-server'), true);
  assert.equal(await controlManager.stop('test-server', { announce: false }), true);

  const replaySession = {
    current: { title: 'Paused song' }, pumping: true, closed: false, paused: true,
    stopRequested: false, skipRequested: false, replayRequested: false,
    pauseWaiters: [], activeProcesses: [],
  };
  controlManager.sessions.set('replay-server', replaySession);
  assert.equal(await controlManager.replay('replay-server'), true);
  assert.equal(replaySession.paused, false, 'replay resumes a paused track before restarting it');
  assert.equal(replaySession.replayRequested, true, 'replay signals the active pump to restart the current item');

  // Persist and restore the Baff-only 24/7 connection config.
  await withStore('baff', () => load('baff'));
  const joined = [];
  const fakeRoom = () => ({
    localParticipant: { async publishTrack() {} },
    async connect(url, token) { joined.push({ url, token }); },
    async disconnect() {},
  });
  const fake247Rtc = {
    Room: class { constructor() { return fakeRoom(); } },
    AudioSource: class { async captureFrame() {} async waitForPlayout() {} },
    LocalAudioTrack: { createAudioTrack: () => ({}) },
    TrackPublishOptions: class { constructor() {} },
    TrackSource: { SOURCE_MICROPHONE: 1 },
  };
  const fakeBot = {
    platformKey: 'baff',
    async voiceStates() { return [{ userId: 'music-user', channelId: 'voice-247' }]; },
    async joinVoice() { return { url: 'wss://livekit.test', token: 'test-ticket' }; },
    async leaveVoice() {},
  };
  const persistentManager = new MusicManager(fakeBot, { rtcLoader: async () => fake247Rtc });
  persistentManager.render = async () => null;
  const enabled = await persistentManager.enable247({ serverId: 'server-247', textChannelId: 'text-247', userId: 'music-user' });
  assert.equal(enabled.ok, true);
  assert.equal(withStore('baff', () => getConfig('server-247').music247.enabled), true);
  await persistentManager.closeSession(enabled.session);
  await Promise.all([persistentManager.restore247Connections(), persistentManager.restore247Connections()]);
  assert.equal(persistentManager.sessions.get('server-247')?.is247, true);
  assert.equal(joined.length, 2, '24/7 should reconnect once after a restart even if ready/reconnected handlers race');
  await persistentManager.disable247('server-247');
  assert.equal(withStore('baff', () => getConfig('server-247').music247), null);

  console.log('[music test] SoundCloud-first resolution, YouTube format fallback, SoundCloud DRM skip, Audius HTTP stream, Spotify metadata mapping, FFmpeg PCM streaming, volume/queue/loop controls, and persistent Baff 24/7 restore passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
