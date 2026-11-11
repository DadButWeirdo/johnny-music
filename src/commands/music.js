import { ui } from '../ui.js';
import { createMusicManager } from '../music/player.js';
import { OnlineMusicSource } from '../music/online-source.js';
import { getConfig } from '../store.js';

const managers = new WeakMap();
const unavailable = (context) => !['baff', 'yapper'].includes(context.bot.platformKey);
const reply = (context, title, description, kind = 'info') => context.reply(ui[kind]({ title, description }, context.cfg));
const managerOf = (context) => managers.get(context.bot);
const sourceLine = (track) => {
  if (track.requestedSource?.toLowerCase().includes('spotify')) return `Spotify link matched · Source: ${track.source}`;
  return `Source: ${track.source}`;
};
const trackLine = (track) => `**${track.title}**${track.artist ? ` — ${track.artist}` : ''}`;

function requireManager(context) {
  const manager = managerOf(context);
  if (!manager) throw new Error('The music player is not initialized. Restart Johnny and check the startup logs.');
  return manager;
}

export default [
  {
    name: 'play', aliases: ['p'], platforms: ['baff', 'yapper'], category: 'Music', usage: 'play <song, YouTube/Spotify/SoundCloud link, or direct audio URL>', desc: 'Search for and play music online', cooldown: 2,
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const query = c.rest.trim();
      if (!query) return reply(c, 'Choose a song', `Usage: \`${c.prefix}play <song name or link>\`\nTry a title, YouTube/Spotify/SoundCloud link, or supported direct audio URL.`);
      let result;
      try {
        result = await requireManager(c).enqueue({ serverId: c.serverId, textChannelId: c.channelId, userId: c.authorId, query });
      } catch (error) {
        return reply(c, 'Couldn’t find that track', String(error?.message ?? 'The music source could not find a playable track.').slice(0, 700), 'notice');
      }
      if (!result.ok) return reply(c, 'Couldn’t add that track', result.message, 'notice');
      const secs = result.track.duration;
      const length = secs ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}` : null;
      const meta = [result.track.artist, length, result.track.source].filter(Boolean).join('  ·  ');
      const where = result.position === 1 ? 'Starting now' : `Position **${result.position}** in the queue`;
      return reply(c, result.position === 1 ? 'Added to player' : 'Added to queue', `**${result.track.title}**\n${meta}\n${where}`, 'success');
    },
  },
  {
    name: 'queue', aliases: ['q'], platforms: ['baff', 'yapper'], category: 'Music', usage: 'queue', desc: 'Show the current track and upcoming queue',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const manager = requireManager(c);
      const session = manager.sessions.get(String(c.serverId));
      if (!session) return reply(c, 'Queue is empty', 'Add a track with `,play <song>` or `/play`.');
      const current = session.current ? `**Now playing:** ${trackLine(session.current)}` : '**Nothing is playing right now.**';
      const loop = session.loop ?? (session.loopCurrent ? 'song' : 'off');
      return reply(c, 'Music queue', `${current}\n\n**Up next (${session.queue.length})**\n${manager.queueText(session)}\n\n**Loop:** ${loop} · **Volume:** ${session.volume ?? 80}% · **Status:** ${session.paused ? 'Paused' : session.status}`);
    },
  },
  {
    name: 'nowplaying', aliases: ['np'], platforms: ['baff', 'yapper'], category: 'Music', usage: 'nowplaying', desc: 'Show the live player card with controls',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const manager = requireManager(c);
      const session = manager.sessions.get(String(c.serverId));
      if (!session || session.closed || !session.current) return reply(c, 'Nothing is playing', 'Use `,play <song>` to start music.', 'notice');
      // Re-post the live player card at the bottom of the chat; its buttons control playback.
      session.textChannelId = String(c.channelId);
      await manager.render(session, { fresh: true });
    },
  },
  {
    name: 'pause', platforms: ['baff', 'yapper'], category: 'Music', usage: 'pause', desc: 'Pause the current track',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const changed = await requireManager(c).pause(c.serverId);
      return reply(c, changed ? 'Playback paused' : 'Nothing is playing', 'Use `,resume` to continue.', changed ? 'success' : 'notice');
    },
  },
  {
    name: 'resume', platforms: ['baff', 'yapper'], category: 'Music', usage: 'resume', desc: 'Resume the paused track',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const changed = await requireManager(c).resume(c.serverId);
      return reply(c, changed ? 'Playback resumed' : 'Nothing is paused', 'The player is ready.', changed ? 'success' : 'notice');
    },
  },
  {
    name: 'skip', aliases: ['next'], platforms: ['baff', 'yapper'], category: 'Music', usage: 'skip', desc: 'Skip the current track',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const changed = await requireManager(c).skip(c.serverId);
      return reply(c, changed ? 'Track skipped' : 'Nothing is playing', 'Moving to the next queued track.', changed ? 'success' : 'notice');
    },
  },
  {
    name: 'replay', aliases: ['back'], platforms: ['baff', 'yapper'], category: 'Music', usage: 'replay', desc: 'Restart the current track',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const changed = await requireManager(c).replay(c.serverId);
      return reply(c, changed ? 'Replaying track' : 'Nothing is playing', 'Restarting the current track from the beginning.', changed ? 'success' : 'notice');
    },
  },
  {
    name: 'loop', platforms: ['baff', 'yapper'], category: 'Music', usage: 'loop <off|song|queue>', desc: 'Set track or queue loop mode',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const manager = requireManager(c);
      const mode = c.rest.trim().toLowerCase();
      try {
        const result = mode ? await manager.setLoop(c.serverId, mode) : await manager.toggleLoop(c.serverId);
        if (result === null) return reply(c, 'No active player', 'Play a track first.', 'notice');
        return reply(c, 'Loop updated', `Loop mode is now **${result}**.`, result === 'off' ? 'info' : 'success');
      } catch (error) { return reply(c, 'Invalid loop mode', error.message, 'notice'); }
    },
  },
  {
    name: 'unloop', platforms: ['baff', 'yapper'], category: 'Music', usage: 'unloop', desc: 'Turn off track and queue looping',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const changed = await requireManager(c).unloop(c.serverId);
      return reply(c, changed ? 'Loop disabled' : 'No active player', 'Playback will continue without repeating tracks.', changed ? 'success' : 'notice');
    },
  },
  {
    name: 'shuffle', platforms: ['baff', 'yapper'], category: 'Music', usage: 'shuffle', desc: 'Shuffle the upcoming queue',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const count = await requireManager(c).shuffle(c.serverId);
      return reply(c, count === null ? 'No active player' : 'Queue shuffled', count === null ? 'Play a track first.' : `Shuffled **${count}** upcoming tracks.`, count === null ? 'notice' : 'success');
    },
  },
  {
    name: 'clearqueue', aliases: ['cq', 'queueclear'], platforms: ['baff', 'yapper'], category: 'Music', usage: 'clearqueue', desc: 'Remove all upcoming tracks without stopping the current one',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const removed = await requireManager(c).clearQueue(c.serverId);
      return reply(c, removed === null ? 'Queue is empty' : 'Queue cleared', removed === null ? 'There is no active music queue.' : `Removed **${removed}** upcoming ${removed === 1 ? 'track' : 'tracks'}.`, 'success');
    },
  },
  {
    name: 'remove', platforms: ['baff', 'yapper'], category: 'Music', usage: 'remove <queue position>', desc: 'Remove a song from the upcoming queue',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      try {
        const removed = await requireManager(c).remove(c.serverId, c.args[0]);
        if (!removed) return reply(c, 'No active queue', 'Play a track first.', 'notice');
        return reply(c, 'Track removed', `${trackLine(removed)} was removed from the queue.`, 'success');
      } catch (error) { return reply(c, 'Could not remove track', error.message, 'notice'); }
    },
  },
  {
    name: 'volume', aliases: ['vol'], platforms: ['baff', 'yapper'], category: 'Music', usage: 'volume <1-100>', desc: 'Set playback volume',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      try {
        const volume = await requireManager(c).setVolume(c.serverId, c.args[0]);
        if (volume === null) return reply(c, 'No active player', 'Play a track first.', 'notice');
        return reply(c, 'Volume changed', `Playback volume is now **${volume}%**.`, 'success');
      } catch (error) { return reply(c, 'Invalid volume', error.message, 'notice'); }
    },
  },
  {
    name: 'stop', platforms: ['baff', 'yapper'], category: 'Music', usage: 'stop', desc: 'Stop playback and clear the queue',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const changed = await requireManager(c).stop(c.serverId);
      return reply(c, changed ? 'Music stopped' : 'Nothing is playing', 'Playback stopped and the queue was cleared.', changed ? 'success' : 'notice');
    },
  },
  {
    name: 'leave', aliases: ['dc', 'disconnect'], platforms: ['baff', 'yapper'], category: 'Music', usage: 'leave', desc: 'Disconnect Johnny from the voice channel and disable 24/7 mode',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const changed = await requireManager(c).leave(c.serverId);
      return reply(c, changed ? 'Disconnected from voice' : 'Not connected', 'Johnny left the voice channel and 24/7 mode is disabled.', changed ? 'success' : 'notice');
    },
  },
  {
    name: '247', aliases: ['24/7'], platforms: ['baff', 'yapper'], category: 'Music', usage: '247', desc: 'Keep Johnny connected to your voice channel',
    run: async (c) => {
      if (unavailable(c)) return reply(c, 'Music unavailable', 'Music playback is available on Baff and Yapin only.');
      const manager = requireManager(c);
      const saved = getConfig(c.serverId).music247;
      const session = manager.sessions.get(String(c.serverId));
      if (saved?.enabled || session?.is247) {
        await manager.disable247(c.serverId);
        return reply(c, '24/7 disabled', 'Johnny will disconnect after the current queue finishes.', 'success');
      }
      try {
        const result = await manager.enable247({ serverId: c.serverId, textChannelId: c.channelId, userId: c.authorId });
        return reply(c, result.ok ? '24/7 enabled' : 'Could not enable 24/7', result.ok ? 'Johnny will stay connected to this voice channel, including after the queue ends and after a restart.' : result.message, result.ok ? 'success' : 'notice');
      } catch (error) { return reply(c, 'Could not enable 24/7', error?.message ?? 'Voice connection failed.', 'notice'); }
    },
  },
];

export function attachMusic(bot) {
  if (!['baff', 'yapper'].includes(bot.platformKey)) return;
  managers.set(bot, createMusicManager(bot, { source: new OnlineMusicSource() }));
}
