// Yapin voice for Node, ported from the official yapper.py connect_voice().
// Yapin calls are end-to-end encrypted: the bot makes a random media key, encrypts its audio with it, and hands
// a copy to every person in the call, sealed (AES-256-GCM under a P-256 ECDH secret) so the server never sees it.
// Use connectYapperVoice(bot, rtc, serverId, channelId) -> { room, source, track, e2ee, leave() }.
import crypto from 'node:crypto';

const TOPIC = 'yapper-e2ee';
const b64 = (buf) => Buffer.from(buf).toString('base64');

// Pure helpers (exported so they can be tested against the Python SDK).
export function makeKeyPair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, pub: b64(ecdh.getPublicKey()) }; // uncompressed X9.62 point, same as the app and yapper.py
}
export function sealKey(ecdh, theirPubB64, mediaKey, fromId, toId, index = 0) {
  const secret = ecdh.computeSecret(Buffer.from(theirPubB64, 'base64'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  cipher.setAAD(Buffer.from(`${fromId}|${toId}|${index}`));
  const ct = Buffer.concat([cipher.update(mediaKey), cipher.final(), cipher.getAuthTag()]); // tag last, like Python's AESGCM
  return { iv: b64(iv), ct: b64(ct) };
}

async function handOutVoiceKey(rtc, room, mediaKey) {
  const me = room.localParticipant.identity;
  const { ecdh, pub: myPub } = makeKeyPair();
  const sent = new Map();
  let stopped = false;
  const ev = (name, fallback) => rtc.RoomEvent?.[name] ?? fallback;

  async function sendTo(p, pub) {
    const their = p?.attributes?.e2ee ?? pub;
    if (stopped || !their || p.identity === me || sent.get(p.identity) === their) return;
    sent.set(p.identity, their);
    try {
      const { iv, ct } = sealKey(ecdh, their, mediaKey, me, p.identity, 0);
      const msg = JSON.stringify({ i: 0, iv, ct, k: myPub });
      await room.localParticipant.publishData(Buffer.from(msg), { reliable: true, topic: TOPIC, destination_identities: [p.identity] });
    } catch {
      sent.delete(p.identity); // muted by a moderator or a bad key: try again on the next change
    }
  }

  const onPeer = (p) => { void sendTo(p); };
  const onAttrs = (_changed, p) => { void sendTo(p); };
  const onData = (payload, participant, _kind, topic) => {
    if (topic !== TOPIC || !participant) return;
    let k;
    try { k = JSON.parse(Buffer.from(payload).toString()).k; } catch { return; }
    if (typeof k === 'string') { sent.delete(participant.identity); void sendTo(participant, k); }
  };

  room.on(ev('ParticipantConnected', 'participantConnected'), onPeer);
  room.on(ev('ParticipantAttributesChanged', 'participantAttributesChanged'), onAttrs);
  room.on(ev('DataReceived', 'dataReceived'), onData);
  await room.localParticipant.setAttributes({ e2ee: myPub });
  const peers = room.remoteParticipants;
  for (const p of (peers?.values ? [...peers.values()] : Object.values(peers ?? {}))) await sendTo(p);

  return () => {
    stopped = true;
    room.off?.(ev('ParticipantConnected', 'participantConnected'), onPeer);
    room.off?.(ev('ParticipantAttributesChanged', 'participantAttributesChanged'), onAttrs);
    room.off?.(ev('DataReceived', 'dataReceived'), onData);
  };
}

export async function connectYapperVoice(bot, rtc, serverId, channelId, { sampleRate = 48_000, channels = 2 } = {}) {
  const ticket = await bot.api('POST', `/servers/${serverId}/voice/join`, { channel_id: channelId });
  const mediaKey = ticket.e2ee ? crypto.randomBytes(32) : null;
  const room = new rtc.Room();
  const options = { autoSubscribe: false, dynacast: false };
  // `e2ee`, not `encryption`: `encryption` would also encrypt the data message that carries the key (silent bot).
  if (mediaKey) options.e2ee = { keyProviderOptions: { sharedKey: mediaKey, ratchetWindowSize: 0, keyRingSize: 16, keyDerivationFunction: 1 } }; // 1 = HKDF, how the app derives the frame key
  const leaveApi = () => bot.api('POST', `/servers/${serverId}/voice/leave`).catch(() => {});
  try {
    await room.connect(ticket.url, ticket.token, options);
    const stopKeys = mediaKey ? await handOutVoiceKey(rtc, room, mediaKey) : null;
    const source = new rtc.AudioSource(sampleRate, channels);
    const track = rtc.LocalAudioTrack.createAudioTrack('audio', source);
    await room.localParticipant.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE, dtx: false, red: false }));
    return {
      room, source, track, e2ee: Boolean(mediaKey), muted: Boolean(ticket.voice_muted),
      async leave() { stopKeys?.(); try { await room.disconnect(); } catch { /* already gone */ } await leaveApi(); },
    };
  } catch (error) {
    try { await room.disconnect(); } catch { /* cleanup */ }
    await leaveApi();
    throw error;
  }
}
