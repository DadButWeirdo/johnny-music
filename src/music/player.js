import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ui } from '../ui.js';
import { getConfig, setConfig, serverIds, withStore } from '../store.js';
import { OnlineMusicSource, isYoutubeBotCheck } from './online-source.js';
import { connectYapperVoice } from '../yapper-voice.js';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_SAMPLES = SAMPLE_RATE / 100;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
const BUTTON_PREFIX = 'johnny:music:';
const require = createRequire(import.meta.url);
let bundledFfmpeg = null;
try { bundledFfmpeg = require('ffmpeg-static'); } catch { /* use the host's ffmpeg binary */ }
const asList = (value) => Array.isArray(value) ? value : value?.states ?? value?.voiceStates ?? value?.voice_states ?? value?.items ?? (value && typeof value === 'object' ? (value.userId || value.user_id ? [value] : Object.values(value)) : []);

function localRtc() {
  return import('@livekit/rtc-node');
}

function safeText(value, max = 160) {
  return String(value ?? '').replace(/[@<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function durationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Live / unknown';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const detached = process.platform !== 'win32';

// Kill a child AND everything it started (yt-dlp spawns helpers that can keep the audio pipe open forever).
function killChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function processExit(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export class MusicManager {
  constructor(bot, {
    source = new OnlineMusicSource(),
    rtcLoader = localRtc,
    spawnProcess = nodeSpawn,
    ffmpegPath = process.env.MUSIC_FFMPEG ?? bundledFfmpeg ?? 'ffmpeg',
    maxQueue = Number(process.env.MUSIC_MAX_QUEUE ?? 50),
  } = {}) {
    this.bot = bot;
    this.platform = bot.platformKey === 'yapper' ? 'yapper' : 'baff';
    this.scope = this.platform; // which saved-settings namespace (24/7 mode, theme) this player uses
    this.source = source;
    this.rtcLoader = rtcLoader;
    this.spawnProcess = spawnProcess;
    this.ffmpegPath = ffmpegPath;
    this.maxQueue = Number.isFinite(maxQueue) ? Math.max(1, Math.min(maxQueue, 100)) : 50;
    this.workDir = path.join(os.tmpdir(), 'johnny-music');
    try { mkdirSync(this.workDir, { recursive: true }); } catch { this.workDir = undefined; }
    this.sessions = new Map();
    this.voiceCache = new Map();
    this.rtcPromise = null;
    this.restore247Promise = null;
  }

  handleVoiceState(state = {}) {
    const serverId = state.serverId ?? state.server_id;
    const userId = state.userId ?? state.user_id ?? state.user?.id;
    const channelId = state.channelId ?? state.channel_id ?? null;
    if (!serverId || !userId) return;
    const key = String(serverId);
    const members = this.voiceCache.get(key) ?? new Map();
    if (channelId) members.set(String(userId), String(channelId));
    else members.delete(String(userId));
    this.voiceCache.set(key, members);
  }

  async userVoiceChannel(serverId, userId) {
    if (this.platform === 'yapper') {
      try {
        const rooms = await this.bot.voice(serverId);
        const hit = (rooms ?? []).find((room) => (room.user_ids ?? []).map(String).includes(String(userId)));
        if (hit?.channel_id) {
          this.handleVoiceState({ serverId, userId, channelId: hit.channel_id });
          return String(hit.channel_id);
        }
      } catch { /* fall back to the latest voice_join / voice_leave event */ }
      return this.voiceCache.get(String(serverId))?.get(String(userId)) ?? null;
    }
    try {
      const current = await this.bot.voiceStates(serverId);
      const states = asList(current);
      const match = states.find((state) => String(state.userId ?? state.user_id ?? state.user?.id) === String(userId));
      const channelId = match?.channelId ?? match?.channel_id;
      if (channelId) {
        this.handleVoiceState({ ...match, serverId });
        return String(channelId);
      }
    } catch { /* use the latest gateway voice-state event as a fallback */ }
    return this.voiceCache.get(String(serverId))?.get(String(userId)) ?? null;
  }

  async getRtc() {
    this.rtcPromise ??= this.rtcLoader();
    return this.rtcPromise;
  }

  async ensureSession(serverId, textChannelId, voiceChannelId) {
    let session = this.sessions.get(String(serverId));
    if (session && !session.closed && session.voiceChannelId !== String(voiceChannelId)) {
      throw new Error('Join my current voice channel to control this queue.');
    }
    if (session && !session.closed) {
      session.textChannelId = String(textChannelId);
      return session;
    }

    const rtc = await this.getRtc();
    if (this.platform === 'yapper') return this.ensureYapperSession(rtc, serverId, textChannelId, voiceChannelId);
    const join = await this.bot.joinVoice(voiceChannelId);
    const room = new rtc.Room();
    const sessionNew = {
      serverId: String(serverId),
      textChannelId: String(textChannelId),
      voiceChannelId: String(voiceChannelId),
      room,
      rtc,
      sourceTrack: null,
      queue: [],
      current: null,
      loop: 'off',
      loopCurrent: false,
      volume: 80,
      is247: false,
      paused: false,
      pauseWaiters: [],
      activeProcesses: [],
      skipRequested: false,
      replayRequested: false,
      stopRequested: false,
      stopping: false,
      closed: false,
      pumping: false,
      nowPlayingMessageId: null,
      status: 'Connecting',
      lastError: null,
    };
    try {
      await room.connect(join.url, join.token, { autoSubscribe: false, dynacast: false });
      const sourceTrack = new rtc.AudioSource(SAMPLE_RATE, CHANNELS);
      const track = rtc.LocalAudioTrack.createAudioTrack('johnny-music', sourceTrack);
      await room.localParticipant.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
      sessionNew.sourceTrack = sourceTrack;
      this.sessions.set(String(serverId), sessionNew);
      return sessionNew;
    } catch (error) {
      try { await room.disconnect(); } catch { /* cleanup */ }
      try { await this.bot.leaveVoice(serverId); } catch { /* cleanup */ }
      throw error;
    }
  }

  // Yapin: joins LiveKit, hands the media key to everyone in the call (Yapin calls are end-to-end encrypted)
  // and gives back the audio source we write frames into.
  async ensureYapperSession(rtc, serverId, textChannelId, voiceChannelId) {
    // Newer yapper.js has bot.connectVoice; older copies don't, so Johnny ships its own port of it.
    const call = typeof this.bot.connectVoice === 'function'
      ? await this.bot.connectVoice(rtc, serverId, voiceChannelId)
      : await connectYapperVoice(this.bot, rtc, serverId, voiceChannelId);
    const session = {
      serverId: String(serverId),
      textChannelId: String(textChannelId),
      voiceChannelId: String(voiceChannelId),
      room: { disconnect: () => call.leave() },
      call,
      rtc,
      sourceTrack: call.source,
      queue: [],
      current: null,
      loop: 'off',
      loopCurrent: false,
      volume: 80,
      is247: false,
      paused: false,
      pauseWaiters: [],
      activeProcesses: [],
      skipRequested: false,
      replayRequested: false,
      stopRequested: false,
      stopping: false,
      closed: false,
      pumping: false,
      nowPlayingMessageId: null,
      status: 'Connecting',
      lastError: null,
    };
    this.sessions.set(String(serverId), session);
    return session;
  }

  // A moderator disconnected the bot (or the call dropped): clean the session up instead of writing into a dead call.
  handleBotDisconnected(serverId, channelId) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed) return;
    if (channelId && String(channelId) !== session.voiceChannelId) return;
    session.queue.length = 0;
    session.stopRequested = true;
    session.stopping = true;
    this.releasePause(session);
    this.killProcesses(session);
    void this.closeSession(session).catch(() => {});
  }

  async enqueue({ serverId, textChannelId, userId, query }) {
    const voiceChannelId = await this.userVoiceChannel(serverId, userId);
    if (!voiceChannelId) return { ok: false, message: 'Join a voice channel first, then run `,play <song>` again.' };

    const track = await this.source.search(query);
    if (!track) return { ok: false, message: `I couldn't find a playable result for **${safeText(query)}**.` };

    const session = await this.ensureSession(serverId, textChannelId, voiceChannelId);
    if (session.queue.length >= this.maxQueue) {
      return { ok: false, message: `The queue is full. Johnny allows up to ${this.maxQueue} upcoming tracks per server.` };
    }
    track.requesterId = String(userId);
    session.queue.push(track);
    session.lastError = null;
    await this.render(session);
    if (!session.pumping) void this.pump(session).catch((error) => this.failSession(session, error));
    return { ok: true, track, position: session.queue.length + (session.current ? 1 : 0), session };
  }

  async waitUntilResumed(session) {
    while (session.paused && !session.stopping && !session.skipRequested) {
      await new Promise((resolve) => session.pauseWaiters.push(resolve));
    }
  }

  releasePause(session) {
    for (const resolve of session.pauseWaiters.splice(0)) resolve();
  }

  killProcesses(session, signal = 'SIGTERM') {
    const children = [...(session.activeProcesses ?? [])];
    for (const child of children) killChild(child, signal);
    // Anything that ignores SIGTERM gets SIGKILL a moment later, so Stop/Skip can never hang.
    if (signal !== 'SIGKILL' && children.length) {
      const timer = setTimeout(() => { for (const child of children) killChild(child, 'SIGKILL'); }, 1200);
      timer.unref?.();
    }
  }

  // Wait (briefly) until the background player loop has actually reacted, so the card we draw next is true.
  async waitFor(condition, timeoutMs = 4000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (condition()) return true;
      await sleep(40);
    }
    return condition();
  }

  async streamTrack(session, track) {
    const streamCandidate = async (candidate) => {
      if (session.skipRequested || session.replayRequested || session.stopping) return;
      const directAudio = typeof candidate.audioUrl === 'string' && /^https?:\/\//i.test(candidate.audioUrl);
      let extractor = null;
      let decoder;
      const decoderArgs = [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', directAudio ? candidate.audioUrl : 'pipe:0',
        '-vn', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
        '-f', 's16le', 'pipe:1',
      ];
      if (directAudio) {
        decoder = this.spawnProcess(this.ffmpegPath, decoderArgs, {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached,
        });
        session.activeProcesses = [decoder];
      } else {
        // cwd: yt-dlp writes HLS fragment files (named like "--Frag11") into its working directory.
        extractor = this.spawnProcess(this.source.ytdlpPath, this.source.streamArgs(candidate), {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached, ...(this.workDir ? { cwd: this.workDir } : {}),
        });
        decoder = this.spawnProcess(this.ffmpegPath, decoderArgs, {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached,
        });
        session.activeProcesses = [extractor, decoder];
      }

      let sourceError = '';
      let decoderError = '';
      let framesSent = 0;
      if (extractor) extractor.stderr?.setEncoding?.('utf8');
      decoder.stderr?.setEncoding?.('utf8');
      extractor?.stderr?.on('data', (chunk) => { sourceError = (sourceError + chunk).slice(-4000); });
      decoder.stderr?.on('data', (chunk) => { decoderError = (decoderError + chunk).slice(-4000); });
      extractor?.stdout?.on('error', () => {});
      decoder.stdin?.on('error', () => {});
      const sourceExit = extractor ? processExit(extractor, 'yt-dlp') : Promise.resolve({ code: 0, signal: null });
      const decoderExit = processExit(decoder, 'FFmpeg');
      if (extractor) extractor.stdout.pipe(decoder.stdin);

      try {
        let pending = Buffer.alloc(0);
        for await (const chunk of decoder.stdout) {
          if (session.stopping || session.skipRequested || session.replayRequested) break;
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          while (pending.length >= FRAME_BYTES && !session.stopping && !session.skipRequested && !session.replayRequested) {
            await this.waitUntilResumed(session);
            if (session.stopping || session.skipRequested || session.replayRequested) break;
            const frameBytes = pending.subarray(0, FRAME_BYTES);
            pending = pending.subarray(FRAME_BYTES);
            const samples = new Int16Array(frameBytes.buffer.slice(frameBytes.byteOffset, frameBytes.byteOffset + frameBytes.byteLength));
            const gain = Math.max(0.01, Math.min(1, Number(session.volume ?? 80) / 100));
            if (gain !== 1) {
              for (let index = 0; index < samples.length; index++) {
                samples[index] = Math.max(-32768, Math.min(32767, Math.round(samples[index] * gain)));
              }
            }
            await session.sourceTrack.captureFrame(new session.rtc.AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
            framesSent++;
          }
        }
        if (session.stopping || session.skipRequested || session.replayRequested) {
          // Interrupted on purpose: kill everything and move on without waiting for the processes to say goodbye.
          this.killProcesses(session);
          await Promise.race([Promise.allSettled([sourceExit, decoderExit]), sleep(1500)]);
          return framesSent;
        }
        const [sourceResult, decoderResult] = await Promise.all([sourceExit, decoderExit]);
        if (!session.skipRequested && !session.replayRequested && !session.stopping) {
          if (sourceResult.code !== 0) {
            const failure = new Error(sourceError.trim().slice(-700) || `The music source exited with code ${sourceResult.code ?? sourceResult.signal}.`);
            failure.youtubeChallenge = isYoutubeBotCheck(sourceError);
            failure.sourceFailure = true;
            throw failure;
          }
          if (decoderResult.code !== 0) {
            const message = decoderError.trim().slice(-500) || `FFmpeg exited with code ${decoderResult.code ?? decoderResult.signal}.`;
            const failure = new Error(directAudio ? `The Audius audio stream could not be opened: ${message}` : message);
            failure.stage = directAudio ? 'source' : 'decoder';
            failure.sourceFailure = directAudio;
            throw failure;
          }
          if (framesSent === 0) {
            const failure = new Error('The music source returned no playable audio data.');
            failure.sourceFailure = true;
            throw failure;
          }
          await session.sourceTrack.waitForPlayout();
        }
        return framesSent;
      } catch (error) {
        error.audioFramesSent = framesSent;
        if (!session.stopping && !session.skipRequested) {
          killChild(extractor, 'SIGTERM');
          killChild(decoder, 'SIGTERM');
        }
        throw error;
      } finally {
        if (session.stopping || session.skipRequested || session.replayRequested) this.killProcesses(session);
        if (session.activeProcesses?.includes(decoder) || (extractor && session.activeProcesses?.includes(extractor))) session.activeProcesses = [];
      }
    };

    try {
      await streamCandidate(track);
      return;
    } catch (error) {
      if (session.stopping || session.skipRequested || session.replayRequested) return;

      const sourceHint = `${track?.source ?? ''} ${track?.requestedSource ?? ''}`.toLowerCase();
      const sourceCanFallback = ['youtube', 'soundcloud', 'audius'].some((provider) => sourceHint.includes(provider));
      const canFallback = error?.sourceFailure === true
        && error.audioFramesSent === 0
        && sourceCanFallback
        && typeof this.source.fallbackTracks === 'function';
      if (!canFallback) throw error;

      let alternatives;
      try {
        alternatives = await this.source.fallbackTracks(track, {
          limit: this.source.fallbackLimit ?? 5,
          excludeUrls: [track.webpageUrl],
        });
      } catch (lookupError) {
        throw new Error(`The original source failed, and Johnny could not search alternate providers: ${String(lookupError?.message ?? lookupError).slice(-260)}`);
      }
      if (!Array.isArray(alternatives) || alternatives.length === 0) {
        throw new Error('The selected result could not be played. No alternate SoundCloud or Audius streams were available. Try another version of the track.');
      }

      console.warn('[baff music] Original audio source failed; trying SoundCloud and Audius alternatives.');
      let lastFailure = error;
      let attempted = 0;
      for (const alternative of alternatives) {
        if (session.stopping || session.skipRequested) return;
        attempted++;
        session.current = alternative;
        session.lastError = null;
        session.status = `Checking alternate result ${attempted}/${alternatives.length}`;
        await this.render(session).catch(() => {});
        try {
          await streamCandidate(alternative);
          session.lastError = null;
          return;
        } catch (alternativeError) {
          if (session.stopping || session.skipRequested) return;
          lastFailure = alternativeError;
          // Never restart a track after audio has already been sent to the voice room.
          if ((alternativeError.audioFramesSent ?? 0) > 0 || alternativeError.stage === 'decoder') {
            throw alternativeError;
          }
          const detail = String(alternativeError?.message ?? '').toLowerCase();
          if (detail.includes('drm protected')) {
            console.warn(`[baff music] Skipping DRM-protected ${alternative.source ?? 'provider'} result.`);
          } else {
            console.warn(`[baff music] Skipping an unavailable ${alternative.source ?? 'provider'} result: ${String(alternativeError?.message ?? alternativeError).slice(-180)}`);
          }
        }
      }
      const reason = String(lastFailure?.message ?? '').toLowerCase().includes('drm protected')
        ? 'The available SoundCloud results were DRM-protected, and no Audius stream could be played.'
        : 'The available SoundCloud and Audius results could not provide playable audio.';
      throw new Error(`${reason} Try another version of the track or a supported public audio URL.`);
    }
  }

  async pump(session) {
    if (session.pumping || session.closed) return;
    session.pumping = true;
    try {
      while (!session.stopping && !session.closed) {
        if (!session.current) session.current = session.queue.shift() ?? null;
        if (!session.current) break;

        let current = session.current;
        session.skipRequested = false;
        session.replayRequested = false;
        session.stopRequested = false;
        session.status = session.paused ? 'Paused' : 'Playing';
        await this.render(session);

        try {
          await this.streamTrack(session, current);
          current = session.current ?? current;
          session.lastError = null;
        } catch (error) {
          if (session.replayRequested && !session.stopping) {
            session.replayRequested = false;
            session.skipRequested = false;
            session.status = 'Replaying';
            continue;
          }
          if (!session.skipRequested && !session.stopping && !session.stopRequested) {
            session.lastError = safeText(error?.message ?? 'Playback failed', 220);
            session.status = 'Track failed — moving on';
            console.error('[baff music]', error?.message ?? error);
            await this.render(session).catch(() => {});
          }
        }

        if (session.stopping) break;
        if (session.stopRequested) {
          session.stopRequested = false;
          session.skipRequested = false;
          session.current = null;
          session.status = 'Stopped';
          break;
        }
        if (session.skipRequested) {
          if ((session.loop ?? 'off') === 'queue') session.queue.push(current);
          session.current = null;
          session.status = 'Skipped';
          continue;
        }
        if (session.replayRequested) {
          session.replayRequested = false;
          session.status = 'Replaying';
          continue;
        }
        if (session.lastError) {
          session.current = null;
          continue;
        }

        const loopMode = session.loop ?? (session.loopCurrent ? 'song' : 'off');
        if (loopMode === 'song') {
          session.status = 'Playing';
          continue;
        }
        if (loopMode === 'queue') session.queue.push(current);
        session.current = null;
        session.status = 'Finished';
        await this.render(session);
      }
    } finally {
      session.pumping = false;
      if (!session.stopping && !session.closed && !session.current && session.queue.length === 0) {
        if (session.is247) {
          session.status = 'Waiting in 24/7 channel';
          await this.render(session).catch(() => {});
        } else {
          if (session.status !== 'Stopped') session.status = 'Queue finished';
          await this.render(session).catch(() => {});
          await this.closeSession(session);
        }
      }
    }
  }

  async failSession(session, error) {
    session.status = 'Playback error';
    session.current = null;
    session.stopping = true;
    this.releasePause(session);
    this.killProcesses(session);
    await this.render(session).catch(() => {});
    await this.closeSession(session);
    console.error('[baff music]', error?.message ?? error);
  }

  async closeSession(session) {
    if (!session || session.closed) return;
    session.ending = true; // makeCard() shows the final state with every control disabled
    await this.render(session).catch(() => {});
    session.closed = true;
    this.releasePause(session);
    this.killProcesses(session);
    try { await session.room.disconnect(); } catch { /* cleanup */ }
    try { await this.bot.leaveVoice(session.serverId); } catch { /* cleanup */ }
    if (this.sessions.get(session.serverId) === session) this.sessions.delete(session.serverId);
  }

  async pause(serverId, { render = true } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed || !session.current) return false;
    session.paused = true;
    session.status = 'Paused';
    if (render) await this.render(session);
    return true;
  }

  async resume(serverId, { render = true } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed || !session.paused) return false;
    session.paused = false;
    session.status = 'Playing';
    this.releasePause(session);
    if (render) await this.render(session);
    return true;
  }

  async skip(serverId) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed || !session.current) return false;
    const previous = session.current;
    session.stopRequested = false;
    session.replayRequested = false;
    session.skipRequested = true;
    session.paused = false;
    session.status = 'Skipping';
    this.releasePause(session);
    this.killProcesses(session);
    await this.waitFor(() => session.closed || session.current !== previous || !session.pumping, 4000);
    return true;
  }

  async replay(serverId) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed || !session.current || !session.pumping) return false;
    session.stopRequested = false;
    session.skipRequested = false;
    session.replayRequested = true;
    session.paused = false;
    session.status = 'Replaying';
    this.releasePause(session);
    this.killProcesses(session);
    return true;
  }

  async setLoop(serverId, mode, { render = true } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed) return null;
    const normalized = String(mode ?? '').toLowerCase();
    if (!['off', 'song', 'queue'].includes(normalized)) throw new Error('Loop mode must be off, song, or queue.');
    session.loop = normalized;
    session.loopCurrent = normalized === 'song';
    if (render) await this.render(session);
    return normalized;
  }

  async toggleLoop(serverId, { render = true } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed || !session.current) return null;
    const current = session.loop ?? (session.loopCurrent ? 'song' : 'off');
    const next = current === 'off' ? 'song' : current === 'song' ? 'queue' : 'off';
    return this.setLoop(serverId, next, { render });
  }

  async unloop(serverId, { render = true } = {}) {
    return (await this.setLoop(serverId, 'off', { render })) !== null;
  }

  async setVolume(serverId, value, { render = true } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed) return null;
    const volume = Number(value);
    if (!Number.isInteger(volume) || volume < 1 || volume > 100) throw new Error('Volume must be between 1 and 100.');
    session.volume = volume;
    if (render) await this.render(session);
    return volume;
  }

  async shuffle(serverId, { render = true } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed) return null;
    for (let index = session.queue.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1));
      [session.queue[index], session.queue[swap]] = [session.queue[swap], session.queue[index]];
    }
    if (render) await this.render(session);
    return session.queue.length;
  }

  async remove(serverId, position, { render = true } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed) return null;
    const index = Number(position) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= session.queue.length) throw new Error('That queue position does not exist.');
    const [removed] = session.queue.splice(index, 1);
    if (render) await this.render(session);
    return removed;
  }

  async clearQueue(serverId, { render = true } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed) return null;
    const removed = session.queue.length;
    session.queue = [];
    if (render) await this.render(session);
    return removed;
  }

  async enable247({ serverId, textChannelId, userId }) {
    const voiceChannelId = await this.userVoiceChannel(serverId, userId);
    if (!voiceChannelId) return { ok: false, message: 'Join a voice channel first, then enable 24/7 mode.' };
    const session = await this.ensureSession(serverId, textChannelId, voiceChannelId);
    session.is247 = true;
    session.status = session.current ? session.status : 'Waiting in 24/7 channel';
    withStore(this.scope, () => setConfig(String(serverId), {
      music247: { enabled: true, voiceChannelId: String(voiceChannelId), textChannelId: String(textChannelId) },
    }));
    await this.render(session);
    return { ok: true, session };
  }

  async disable247(serverId) {
    const key = String(serverId);
    withStore(this.scope, () => setConfig(key, { music247: null }));
    const session = this.sessions.get(key);
    if (!session || session.closed) return true;
    session.is247 = false;
    if (!session.current && session.queue.length === 0 && !session.pumping) {
      await this.render(session).catch(() => {});
      await this.closeSession(session);
    } else {
      await this.render(session);
    }
    return true;
  }

  async stop(serverId, { announce = true, leave = false } = {}) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed) return false;
    session.queue = [];
    session.loop = 'off';
    session.loopCurrent = false;
    session.paused = false;
    session.stopRequested = true;
    session.skipRequested = Boolean(session.current) || session.pumping;
    session.replayRequested = false;
    // Update the state FIRST: nowplaying, the queue and the buttons must never show a stopped song as playing.
    session.current = null;
    session.status = leave ? 'Leaving voice channel' : 'Stopped';
    this.releasePause(session);
    this.killProcesses(session);
    if (leave) {
      session.is247 = false;
      withStore(this.scope, () => setConfig(String(serverId), { music247: null }));
    }
    if (session.pumping) {
      // The player loop notices the flags, ends, and closes the session (unless 24/7 keeps it).
      await this.waitFor(() => session.closed || !session.pumping, 4000);
    }
    if (!session.closed && !session.pumping) {
      session.current = null;
      session.stopRequested = false;
      session.skipRequested = false;
      if (leave || !session.is247) await this.closeSession(session);
      else {
        session.status = 'Waiting in 24/7 channel';
        await this.render(session).catch(() => {});
      }
    } else if (announce && !session.closed) {
      await this.render(session).catch(() => {});
    }
    return true;
  }

  async leave(serverId) {
    return this.stop(serverId, { announce: true, leave: true });
  }

  async restore247Connections() {
    // READY and the SDK's reconnect event can arrive close together. Share one
    // restore pass so the bot never tries to join the same LiveKit room twice.
    if (this.restore247Promise) return this.restore247Promise;
    this.restore247Promise = (async () => {
      const ids = withStore(this.scope, () => serverIds());
      for (const serverId of ids) {
        const saved = withStore(this.scope, () => getConfig(serverId).music247);
        if (!saved?.enabled || !saved.voiceChannelId || !saved.textChannelId || this.sessions.has(String(serverId))) continue;
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const session = await this.ensureSession(serverId, saved.textChannelId, saved.voiceChannelId);
            session.is247 = true;
            session.status = 'Waiting in 24/7 channel';
            await this.render(session);
            console.log(`[baff music] Restored 24/7 voice session for server ${serverId}.`);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        }
        if (lastError) console.error(`[baff music] Could not restore 24/7 session for server ${serverId}:`, lastError?.message ?? lastError);
      }
    })();
    try {
      await this.restore247Promise;
    } finally {
      this.restore247Promise = null;
    }
  }

  queueText(session) {
    const upcoming = session.queue.slice(0, 15).map((track, index) => {
      const duration = track.duration ? ` · ${durationLabel(track.duration)}` : '';
      const artist = track.artist ? ` — ${safeText(track.artist)}` : '';
      return `**${index + 1}.** ${safeText(track.title)}${artist}${duration}`;
    }).join('\n');
    const more = session.queue.length > 15 ? `\n…and ${session.queue.length - 15} more.` : '';
    return (upcoming || 'Nothing queued.') + more;
  }

  makeCard(session) {
    const track = session.current;
    const dead = Boolean(session.closed || session.ending);
    const live = Boolean(track) && !dead;
    const loop = session.loop ?? (session.loopCurrent ? 'song' : 'off');
    const volume = session.volume ?? 80;
    const id = session.serverId;
    const btn = (action, label, style = 'secondary', disabled = false) => ({
      type: 'button', style, label, custom_id: `${BUTTON_PREFIX}${action}:${id}`, disabled: Boolean(disabled),
    });

    // ── status ────────────────────────────────────────────────
    let stateIcon = '⏹';
    let stateText = session.status;
    if (dead) {
      stateText = session.status === 'Queue finished' ? 'Queue finished' : session.status === 'Leaving voice channel' ? 'Disconnected' : (session.status || 'Stopped');
    } else if (session.paused && track) { stateIcon = '⏸'; stateText = 'Paused'; }
    else if (track && session.status === 'Playing') { stateIcon = '▶'; stateText = 'Playing'; }
    else if (track) { stateIcon = '⏳'; }
    else if (session.status === 'Waiting in 24/7 channel') stateIcon = '🌙';

    const title = live ? (session.paused ? 'Paused' : 'Now Playing') : session.status === 'Queue finished' ? 'Queue Finished' : 'Player Stopped';

    // ── body ──────────────────────────────────────────────────
    const lines = [];
    if (track && !dead) {
      const meta = [track.artist ? safeText(track.artist) : null, durationLabel(track.duration), safeText(track.source, 32)].filter(Boolean).join('  ·  ');
      lines.push(`### ${safeText(track.title, 120)}`, meta);
      if (track.webpageUrl && !/api\.soundcloud\.com/i.test(track.webpageUrl) && !/^https:\/\/audius\.co\/?$/i.test(track.webpageUrl)) lines.push(`[Open original](${track.webpageUrl})`);
    } else {
      lines.push(session.status === 'Queue finished' ? 'Everything in the queue has been played.' : dead ? 'Playback has ended.' : 'Nothing is playing right now.');
    }
    lines.push('', `${stateIcon} **${stateText}**   ·   🔁 Loop **${loop === 'off' ? 'off' : loop}**   ·   🔊 **${volume}%**`);
    if (track?.requesterId && !dead) lines.push(`Requested by <@${track.requesterId}>`);
    if (session.is247) lines.push(`🌙 24/7 in <#${session.voiceChannelId}>`);

    const fields = [];
    if (session.queue.length) {
      const shown = session.queue.slice(0, 5).map((item, index) => `\`${index + 1}.\` ${safeText(item.title, 70)}${item.artist ? ` — ${safeText(item.artist, 40)}` : ''}${item.duration ? `  ·  ${durationLabel(item.duration)}` : ''}`);
      if (session.queue.length > 5) shown.push(`…and ${session.queue.length - 5} more`);
      fields.push([`Up next (${session.queue.length})`, shown.join('\n')]);
    }
    if (session.lastError && !dead) fields.push(['Heads up', session.lastError]);

    // ── controls ──────────────────────────────────────────────
    const idle = !live;
    const rows = [
      { type: 'row', components: [
        btn('replay', '⏮ Replay', 'secondary', idle),
        btn('pause', session.paused ? '▶ Resume' : '⏸ Pause', 'primary', idle),
        btn('skip', '⏭ Skip', 'secondary', idle),
        btn('stop', '⏹ Stop', 'danger', dead || (!track && session.queue.length === 0)),
        btn('leave', '⏏ Leave', 'secondary', dead),
      ] },
      { type: 'row', components: [
        btn('loop', `🔁 Loop: ${loop === 'off' ? 'Off' : loop === 'song' ? 'Song' : 'Queue'}`, loop === 'off' ? 'secondary' : 'success', idle),
        btn('shuffle', '🔀 Shuffle', 'secondary', dead || session.queue.length < 2),
        btn('voldown', '🔉 −10', 'secondary', dead || volume <= 1),
        btn('volup', '🔊 +10', 'secondary', dead || volume >= 100),
        btn('clear', '🗑 Clear', 'secondary', dead || session.queue.length === 0),
      ] },
    ];
    return ui.info({ title, description: lines.join('\n'), fields, rows, ...(track && !dead && track.thumbnail ? { image: track.thumbnail } : {}) }, withStore(this.scope, () => getConfig(session.serverId)));
  }

  async render(session, { fresh = false } = {}) {
    if (!session || session.closed) return null;
    const payload = this.makeCard(session);
    let message;
    if (fresh && session.nowPlayingMessageId) {
      // Move the live player card to the bottom of the chat and retire the old one.
      try { await this.bot.delete?.(session.textChannelId, session.nowPlayingMessageId); } catch { /* old card already gone */ }
      session.nowPlayingMessageId = null;
    }
    if (payload.layout) {
      if (session.nowPlayingMessageId) {
        try { await this.bot.editLayout(session.textChannelId, session.nowPlayingMessageId, payload.layout); return null; }
        catch { session.nowPlayingMessageId = null; }
      }
      message = await this.bot.sendLayout(session.textChannelId, payload.layout);
    } else {
      const data = payload.embeds ? payload : payload.fallback;
      if (session.nowPlayingMessageId) {
        try { await this.bot.edit(session.textChannelId, session.nowPlayingMessageId, '', { embeds: data.embeds, components: data.components }); return null; }
        catch { session.nowPlayingMessageId = null; }
      }
      message = await this.bot.send(session.textChannelId, '', { embeds: data.embeds, components: data.components });
    }
    session.nowPlayingMessageId = message?.id ?? message?.message?.id ?? null;
    return message;
  }

  async buttonAction(button, action, serverId) {
    const session = this.sessions.get(String(serverId));
    if (!session || session.closed) return button.ephemeral('There is no active music session.');
    if (button.server_id && String(button.server_id) !== String(serverId)) return button.ephemeral('This player belongs to another server.');
    if (button.user_id) {
      const voiceChannelId = await this.userVoiceChannel(serverId, button.user_id);
      if (voiceChannelId !== session.voiceChannelId) return button.ephemeral('Join my voice channel to use these controls.');
    }
    if (action === 'pause') {
      if (session.paused) await this.resume(serverId, { render: false });
      else await this.pause(serverId, { render: false });
    } else if (action === 'replay') await this.replay(serverId);
    else if (action === 'skip') await this.skip(serverId);
    else if (action === 'loop') await this.toggleLoop(serverId, { render: false });
    else if (action === 'shuffle') await this.shuffle(serverId, { render: false });
    else if (action === 'clear') await this.clearQueue(serverId, { render: false });
    else if (action === 'volup') await this.setVolume(serverId, Math.min(100, (session.volume ?? 80) + 10), { render: false });
    else if (action === 'voldown') await this.setVolume(serverId, Math.max(1, (session.volume ?? 80) - 10), { render: false });
    else if (action === 'stop') await this.stop(serverId, { announce: false });
    else if (action === 'leave') await this.leave(serverId);
    const next = this.makeCard(session);
    if (next.layout) return button.update({ layout: next.layout });
    const data = next.embeds ? next : next.fallback;
    return button.update({ embeds: data.embeds, components: data.components });
  }

}

export function createMusicManager(bot, options) {
  const manager = new MusicManager(bot, options);
  bot.on?.('voice_state_update', (state) => manager.handleVoiceState(state));
  if (manager.platform === 'yapper') {
    // Yapin sends voice_join / voice_leave ({ server_id, user_id, channel_id }), also about the bot itself.
    bot.on?.('voice_join', (ev) => manager.handleVoiceState({ server_id: ev.server_id, user_id: ev.user_id, channel_id: ev.channel_id }));
    bot.on?.('voice_leave', (ev) => {
      manager.handleVoiceState({ server_id: ev.server_id, user_id: ev.user_id, channel_id: null });
      const me = bot.me?.id ?? bot.me?.user?.id;
      if (me && String(ev.user_id) === String(me)) manager.handleBotDisconnected(ev.server_id, ev.channel_id);
    });
  }
  bot.on?.('ready', () => { void manager.restore247Connections(); });
  bot.on?.('reconnected', () => { void manager.restore247Connections(); });
  bot.onButton?.(/^johnny:music:(pause|replay|skip|loop|shuffle|clear|stop|leave|volup|voldown):([A-Za-z0-9_-]{1,64})$/, async (button) => {
    const match = /^johnny:music:(pause|replay|skip|loop|shuffle|clear|stop|leave|volup|voldown):([A-Za-z0-9_-]{1,64})$/.exec(button.custom_id ?? '');
    if (match) await manager.buttonAction(button, match[1], match[2]);
  });
  return manager;
}

export { OnlineMusicSource };
