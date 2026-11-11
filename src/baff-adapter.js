import { withStore } from './store.js';
import { toBaffComponents } from './baff-components.js';

const API_ROOT = (process.env.BAFF_API_BASE ?? 'https://baff.gg/api').replace(/\/$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listOf = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === 'function') return [...value.values()];
  if (typeof value.cache?.values === 'function') return [...value.cache.values()];
  if (typeof value === 'object') return Object.values(value);
  return [];
};
const pick = (obj, ...paths) => {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], obj);
    if (value !== undefined && value !== null) return value;
  }
};
const idOf = (value) => value?.id ?? value?.user?.id ?? value?.channelId ?? null;
const channelKind = (channel) => {
  const value = channel?.type ?? channel?.kind;
  if (value === 0 || value === 'text' || value === 'guild_text') return 'text';
  if (value === 2 || value === 'voice' || value === 'guild_voice') return 'voice';
  if (value === 4 || value === 'category' || value === 'guild_category') return 'category';
  if (typeof value === 'string') return value.toLowerCase();
  return 'unknown';
};
const toPlainMessage = (message) => {
  if (!message) return null;
  const author = message.author ?? {};
  return {
    ...message,
    channel_id: message.channelId ?? message.channel_id,
    server_id: message.serverId ?? message.server_id,
    author_id: author.id ?? message.authorId ?? message.author_id,
    author: {
      ...author,
      id: author.id ?? message.authorId ?? message.author_id,
      username: author.username ?? author.displayName ?? 'Unknown',
      display_name: author.displayName ?? author.display_name ?? author.username,
      bot: Boolean(author.bot || ['bot', 'verified_bot', 'official'].includes(author.tag)),
    },
    created_at: message.createdAt ?? message.created_at,
  };
};
const unsupported = (feature) => {
  const error = new Error(`${feature} is not exposed by the baff.js methods documented for this integration.`);
  error.code = 'BAFF_FEATURE_UNAVAILABLE';
  error.feature = feature;
  return error;
};

/**
 * Compatibility surface for Johnny's existing Yaper-oriented feature modules.
 * It deliberately keeps Yaper's methods untouched and exposes a separate baff.gg
 * adapter over baff.js plus baff.gg's documented Bot REST API.
 */
export class BaffAdapter {
  constructor(client, token, { apiRoot = API_ROOT } = {}) {
    if (!client) throw new TypeError('BaffAdapter requires a baff.js Client.');
    if (!token) throw new Error('Missing BAFF_BOT_TOKEN.');
    this.client = client;
    this.token = token;
    this.apiRoot = apiRoot;
    this.platformKey = 'baff';
    this.userId = client.user?.id ?? null;
    this.handlers = new Map();
    this.buttonHandlers = [];
    this._bound = false;
    this.lastGatewayPacketAt = Date.now();
    this.bindGateway();
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  async emit(event, payload) {
    for (const handler of this.handlers.get(event) ?? []) {
      try { await withStore('baff', () => handler(payload)); }
      catch (error) { console.error(`[baff event:${event}]`, error); }
    }
  }

  onButton(customId, handler) {
    this.buttonHandlers.push({ match: customId, handler });
    return this;
  }

  setClient(client) {
    if (!client) throw new TypeError('BaffAdapter requires a baff.js Client.');
    this.client = client;
    this._bound = false;
    this.lastGatewayPacketAt = Date.now();
    this.bindGateway();
    return this;
  }


  bindGateway() {
    if (this._bound) return;
    this._bound = true;
    this.client.on('raw', (packet) => {
      // The baff.js raw event represents incoming gateway packets. Track all packets,
      // not just messages, so an otherwise quiet server still counts as connected.
      this.lastGatewayPacketAt = Date.now();
      withStore('baff', () => this.handleRaw(packet)).catch((error) => console.error('[baff gateway]', error));
    });
    this.client.on('interactionCreate', (interaction) => {
      withStore('baff', () => this.handleInteraction(interaction)).catch((error) => console.error('[baff interaction]', error));
    });
    this.client.on('ready', () => {
      this.lastGatewayPacketAt = Date.now();
      this.userId = this.client.user?.id ?? this.userId;
    });
    this.client.on('reconnected', () => {
      this.lastGatewayPacketAt = Date.now();
      void this.emit('reconnected', {}).catch((error) => console.error('[baff reconnect]', error));
    });
    this.client.on('error', (error) => console.error('[baff client]', error));
  }

  async handleRaw(packet) {
    const event = packet?.t;
    const data = packet?.d ?? {};
    if (!event) return;
    if (process.env.DEBUG_EVENTS) console.log('[baff event]', event, JSON.stringify(data)?.slice(0, 400));

    if (event === 'READY') {
      this.userId = data.user?.id ?? this.userId;
      return this.emit('ready', data);
    }
    if (event === 'MESSAGE_CREATE') {
      const message = toPlainMessage(data);
      const self = this.userId && String(message.author_id) === String(this.userId);
      message.author_bot = Boolean(message.author.bot || self);
      message.content = String(message.content ?? '');
      return this.emit('message', message);
    }
    if (event === 'MEMBER_ADD') {
      const member = data.member ?? {};
      const user = member.user ?? member;
      return this.emit('member_join', {
        ...member,
        server_id: data.serverId ?? data.server_id,
        user_id: user.id ?? member.userId,
        username: user.username ?? user.displayName ?? 'Someone',
      });
    }
    if (event === 'MEMBER_REMOVE') {
      return this.emit('member_leave', { server_id: data.serverId ?? data.server_id, user_id: data.userId ?? data.user_id });
    }
    if (event === 'MESSAGE_REACTION_ADD' || event === 'MESSAGE_REACTION_REMOVE') {
      const suffix = event.endsWith('_ADD') ? 'add' : 'remove';
      return this.emit(`message_reaction_${suffix}`, {
        channel_id: data.channelId,
        message_id: data.messageId,
        user_id: data.userId,
        server_id: data.serverId,
        emoji: data.emoji,
      });
    }
    // Preserve unknown gateway packets for future feature modules and diagnostics.
    return this.emit(event.toLowerCase(), data);
  }

  async handleInteraction(interaction) {
    if (!interaction?.isButton?.()) return;
    const customId = interaction.customId ?? interaction.custom_id;
    const found = this.buttonHandlers.find(({ match }) => {
      if (match instanceof RegExp) { match.lastIndex = 0; return match.test(customId ?? ''); }
      return match === customId;
    });
    if (!found) return;
    const user = interaction.user ?? {};
    const data = {
      custom_id: customId,
      user_id: user.id,
      username: user.username ?? user.displayName,
      message_id: interaction.message?.id,
      channel_id: interaction.channelId,
      server_id: interaction.serverId,
      id: interaction.id,
      token: interaction.token,
    };
    const wrap = {
      ...data,
      userMention: `<@${user.id}>`,
      reply: (content, options = {}) => interaction.reply({ content: String(content ?? ''), ...options }),
      ephemeral: (content, options = {}) => interaction.reply({ content: String(content ?? ''), ephemeral: true, ...options }),
      update: (changes = {}) => {
        const next = { ...changes };
        if (next.layout) {
          next.components = toBaffComponents(next.layout);
          next.flags = 32768;
          delete next.layout;
        } else if (Array.isArray(next.components)) {
          next.components = toBaffComponents(next.components);
        }
        if (next.components === null) next.components = [];
        return interaction.update(next);
      },
      ack: () => interaction.deferUpdate(),
    };
    try { await found.handler(wrap); }
    catch (error) {
      console.error('[baff button]', error);
      try {
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'That action could not be completed.', ephemeral: true });
      } catch { /* the interaction may already have expired */ }
    }
  }

  async api(method, path, body, options = {}) {
    const verb = String(method).toUpperCase();
    const url = `${this.apiRoot}${path.startsWith('/') ? path : `/${path}`}`;
    const safeRetry = ['GET', 'PUT', 'DELETE'].includes(verb);
    const maxAttempts = options.retries ?? (safeRetry ? 3 : 1);
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          method: verb,
          headers: {
            Authorization: `Bot ${this.token}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeout ?? 30_000),
        });
      } catch (error) {
        if (safeRetry && attempt + 1 < maxAttempts) { await sleep(500 * (attempt + 1)); continue; }
        throw error;
      }
      if (response.ok || response.status === 204) {
        if (response.status === 204) return null;
        return response.json().catch(() => null);
      }
      const result = await response.json().catch(() => ({}));
      const retryAfter = Number(response.headers.get('retry-after')) || Number(result?.retry_after) || 0;
      const retryable = response.status === 429 || (safeRetry && response.status >= 500);
      if (retryable && attempt + 1 < maxAttempts && retryAfter <= 60) {
        await sleep(Math.max(retryAfter * 1000, 500 * (attempt + 1)));
        continue;
      }
      const apiError = new Error(result?.error?.message ?? result?.message ?? result?.error ?? `${verb} ${path} failed (${response.status})`);
      apiError.status = response.status;
      apiError.code = result?.error?.code ?? result?.code;
      apiError.body = result;
      throw apiError;
    }
  }

  async _server(serverId) {
    return this.client.servers.fetch(String(serverId));
  }
  async _channel(channelId) {
    return this.client.channels.fetch(String(channelId));
  }
  async _member(serverId, userId) {
    const server = await this._server(serverId);
    const members = await server.members.fetch();
    return members?.get?.(String(userId)) ?? listOf(members).find((member) => String(idOf(member)) === String(userId)) ?? null;
  }
  async _message(channelId, messageId) {
    const channel = await this._channel(channelId);
    const history = await channel.messages.fetch({ limit: 100 });
    return listOf(history).find((message) => String(message.id) === String(messageId)) ?? null;
  }

  async send(channelId, content = '', options = {}) {
    const channel = await this._channel(channelId);
    const message = {
      content: String(content ?? ''),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.embeds ? { embeds: options.embeds } : {}),
      ...(options.components ? { components: toBaffComponents(options.components) } : {}),
      ...(options.flags !== undefined ? { flags: options.flags } : {}),
    };
    if (!message.embeds && !message.components && !message.replyTo && !message.flags) return channel.send(message.content);
    return channel.send(message);
  }

  async sendLayout(channelId, components, options = {}) {
    const channel = await this._channel(channelId);
    return channel.send({
      components: toBaffComponents(components),
      flags: 32768,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    });
  }

  async edit(channelId, messageId, content, options = {}) {
    const message = await this._message(channelId, messageId);
    if (!message?.edit) throw new Error('That message is not in the most recent 100 messages or can no longer be edited.');
    const changes = {};
    if (content !== undefined && content !== null) changes.content = String(content);
    if (options.embeds !== undefined) changes.embeds = options.embeds;
    if (options.components !== undefined) changes.components = options.components === null ? [] : toBaffComponents(options.components);
    return message.edit(changes);
  }

  async editLayout(channelId, messageId, components) {
    const message = await this._message(channelId, messageId);
    if (!message?.edit) throw new Error('That message is not in the most recent 100 messages or can no longer be edited.');
    return message.edit({ components: toBaffComponents(components), flags: 32768 });
  }

  async delete(channelId, messageId) {
    return this.api('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  async messages(channelId, limit = 50) {
    const channel = await this._channel(channelId);
    const result = await channel.messages.fetch({ limit: Math.min(100, Math.max(1, Number(limit) || 50)) });
    return listOf(result).map(toPlainMessage);
  }

  async message(channelId, messageId) {
    const message = await this._message(channelId, messageId);
    return toPlainMessage(message);
  }

  async bulkDelete(channelId, messageIds) {
    let deleted = 0;
    for (const id of messageIds) {
      try { await this.delete(channelId, id); deleted++; }
      catch (error) { if (error.status !== 404) throw error; }
    }
    return { deleted, skipped: messageIds.length - deleted };
  }

  async react(channelId, messageId, emoji) {
    const encoded = encodeURIComponent(String(emoji));
    return this.api('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}`);
  }

  async reactions(channelId, messageId) {
    const message = await this._message(channelId, messageId);
    const reactions = message?.reactions;
    if (Array.isArray(reactions)) {
      return reactions.map((reaction) => ({
        emoji: reaction.emoji?.name ?? reaction.emoji,
        count: Number(reaction.count ?? 0),
      }));
    }
    const cache = reactions?.cache;
    if (cache) {
      return listOf(cache).map((reaction) => ({
        emoji: reaction.emoji?.name ?? reaction.emoji,
        count: Number(reaction.count ?? 0),
      }));
    }
    // baff.gg documents reactions on the message object and per-emoji routes,
    // but not a route that lists every reaction for a message. Do not guess one.
    return [];
  }

  async server(serverId) {
    const server = await this._server(serverId);
    return {
      id: server.id,
      name: server.name,
      owner_id: server.ownerId ?? server.owner?.id,
      ownerId: server.ownerId ?? server.owner?.id,
      iconUrl: server.iconUrl,
    };
  }

  async servers() {
    const cache = this.client.servers?.cache;
    if (cache) return listOf(cache).map((server) => ({ id: server.id, name: server.name, owner_id: server.ownerId }));
    return [];
  }

  async channels(serverId, { type } = {}) {
    const server = await this._server(serverId);
    const channels = listOf(server.channels?.cache);
    return channels.map((channel) => this._normalizeChannel(channel))
      .filter((channel) => !type || channel.type === type);
  }

  _normalizeChannel(channel) {
    return {
      id: channel.id,
      name: channel.name,
      type: channelKind(channel),
      parent_id: channel.parentId ?? channel.parent_id ?? null,
      categoryId: channel.parentId ?? channel.parent_id ?? null,
      server_id: channel.serverId ?? channel.guildId ?? channel.server_id,
      private: Boolean(channel.private),
      read_only: Boolean(channel.readOnly ?? channel.read_only),
      slowmode: channel.slowmode ?? 0,
      position: channel.position ?? 0,
    };
  }

  async categories(serverId) {
    return (await this.channels(serverId)).filter((channel) => channel.type === 'category');
  }

  async channel(channelId) {
    try { return this._normalizeChannel(await this._channel(channelId)); }
    catch { return null; }
  }

  async roles(serverId) {
    const server = await this._server(serverId);
    let roles = listOf(server.roles?.cache);
    if (!roles.length && typeof server.roles?.fetch === 'function') roles = listOf(await server.roles.fetch());
    return roles.map((role) => {
      const permission = role.permissions ?? role.permission;
      const has = (name) => { try { return Boolean(permission?.has?.(name)); } catch { return false; } };
      return {
        ...role,
        id: role.id,
        name: role.name,
        color: role.color ?? role.hexColor,
        perms: {
          administrator: has('Administrator'),
          manage_server: has('ManageGuild'),
          manage_messages: has('ManageMessages'),
          manage_channels: has('ManageChannels'),
          manage_roles: has('ManageRoles'),
          kick_members: has('KickMembers'),
          ban_members: has('BanMembers'),
          moderate_members: has('ModerateMembers'),
        },
      };
    });
  }

  async member(serverId, userId) {
    const member = await this._member(serverId, userId);
    if (!member) return null;
    const roles = listOf(member.roles?.cache ?? member.roles).map((role) => typeof role === 'string' ? role : role.id);
    const user = member.user ?? {};
    return {
      ...member,
      id: user.id ?? member.id,
      user_id: user.id ?? member.id,
      username: user.username ?? user.displayName,
      display_name: user.displayName ?? user.display_name ?? user.username,
      role_ids: roles,
      roles,
      nick: member.nickname ?? member.nick ?? null,
    };
  }

  async members(serverId, after) {
    const server = await this._server(serverId);
    const members = listOf(await server.members.fetch());
    return members.filter((member) => !after || String(idOf(member)) > String(after)).map((member) => ({
      ...member,
      id: member.user?.id ?? member.id,
      user_id: member.user?.id ?? member.id,
      username: member.user?.username ?? member.user?.displayName,
      role_ids: listOf(member.roles?.cache ?? member.roles).map((role) => typeof role === 'string' ? role : role.id),
    }));
  }

  async user(userId) {
    for (const server of listOf(this.client.servers?.cache)) {
      const member = listOf(server.members?.cache).find((entry) => String(entry.user?.id ?? entry.id) === String(userId));
      if (member?.user) return member.user;
    }
    if (typeof this.client.users?.fetch === 'function') return this.client.users.fetch(String(userId));
    return null;
  }

  async addRole(serverId, userId, roleId) {
    const member = await this._member(serverId, userId);
    if (typeof member?.roles?.add !== 'function') throw unsupported('Adding member roles');
    return member.roles.add(String(roleId));
  }

  async removeRole(serverId, userId, roleId) {
    const member = await this._member(serverId, userId);
    if (typeof member?.roles?.remove !== 'function') throw unsupported('Removing member roles');
    return member.roles.remove(String(roleId));
  }

  async createRole(serverId, name) {
    const server = await this._server(serverId);
    if (typeof server.roles?.create !== 'function') throw unsupported('Creating server roles');
    return server.roles.create({ name });
  }

  async createChannel() { throw unsupported('Creating channels'); }
  async createCategory() { throw unsupported('Creating channel categories'); }
  async deleteCategory() { throw unsupported('Deleting channel categories'); }
  async editChannel() { throw unsupported('Editing channel settings and permissions'); }
  async deleteChannel() { throw unsupported('Deleting channels'); }

  async kick(serverId, userId, reason = '') {
    const server = await this._server(serverId);
    if (typeof server.members?.kick === 'function') return server.members.kick(String(userId), { reason });
    throw unsupported('Kicking members');
  }

  async ban(serverId, userId, reason = '') {
    const server = await this._server(serverId);
    if (typeof server.members?.ban !== 'function') throw unsupported('Banning members');
    return server.members.ban(String(userId), { reason });
  }

  async unban() { throw unsupported('Unbanning members'); }
  async bans() { throw unsupported('Listing server bans'); }

  async timeout(serverId, userId, minutes, reason = '') {
    const member = await this._member(serverId, userId);
    if (typeof member?.timeout !== 'function') throw unsupported('Member timeouts');
    return member.timeout(Math.max(0, Number(minutes) || 0) * 60_000, reason ? { reason } : undefined);
  }

  async setNickname(serverId, userId, nickname) {
    const targetId = !userId || (process.env.BOT_ID && String(userId) === String(process.env.BOT_ID)) ? this.userId : userId;
    const member = await this._member(serverId, targetId);
    if (typeof member?.setNickname === 'function') return member.setNickname(nickname);
    throw unsupported('Changing member nicknames');
  }

  async moveMember() { throw unsupported('Moving other members between voice channels'); }
  async disconnectMember() { throw unsupported('Disconnecting other members from voice channels'); }
  async voice() { throw unsupported('Reading other members’ voice states'); }

  // Baff's documented voice API: read voice states and obtain/release a LiveKit join ticket.
  async voiceStates(serverId) {
    return this.api('GET', `/servers/${encodeURIComponent(serverId)}/voice-states`);
  }

  async joinVoice(channelId) {
    const channel = await this._channel(channelId);
    if (typeof channel?.join !== 'function') throw unsupported('Joining a voice channel');
    return channel.join();
  }

  async leaveVoice(serverId) {
    if (typeof this.client.voice?.leave === 'function') return this.client.voice.leave(String(serverId));
    return this.api('DELETE', `/voice?serverId=${encodeURIComponent(serverId)}`);
  }

  async dm() { throw unsupported('Opening direct messages'); }
  async dmSend(userId, content, options = {}) {
    const channelId = await this.dm(userId);
    if (!channelId) throw new Error('baff.gg did not return a DM channel.');
    return this.send(channelId, content, options);
  }

  async setStatus() { throw unsupported('Changing the bot account status'); }
  async setProfile() { throw unsupported('Changing the bot account profile'); }
  async setAvatar() { throw unsupported('Changing the bot account avatar'); }
  async setBanner() { throw unsupported('Changing the bot account banner'); }
}
