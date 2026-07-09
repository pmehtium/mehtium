import { verifyToken } from './auth.js';
import {
  findUserById,
  searchUsers,
  addContact,
  listContacts,
  saveMessage,
  getConversation,
  getUndelivered,
  markDelivered,
  setPubkey,
  getPubkey,
} from './db.js';

// userId -> Set<socketId>
const online = new Map();
// callId -> { participants: Set<userId>, media: 'audio'|'video' }
const calls = new Map();

function isOnline(userId) {
  return online.has(userId) && online.get(userId).size > 0;
}

function addOnline(userId, socketId) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socketId);
}

function removeOnline(userId, socketId) {
  const set = online.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) online.delete(userId);
}

export function attachSignaling(io) {
  // ---- Authenticate every socket via JWT in the handshake ----
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = token && verifyToken(token);
    if (!payload) return next(new Error('unauthorized'));
    socket.user = { id: Number(payload.id), username: payload.username };
    next();
  });

  io.on('connection', async (socket) => {
    const me = socket.user;
    socket.join(`u:${me.id}`);
    const wasOffline = !isOnline(me.id);
    addOnline(me.id, socket.id);

    // Tell my contacts I'm online.
    if (wasOffline) await broadcastPresence(io, me.id, true);

    // Deliver any messages that arrived while I was offline.
    try {
      const pending = await getUndelivered(me.id);
      if (pending.length) {
        for (const m of pending) {
          socket.emit('chat:message', normalizeMsg(m));
        }
        await markDelivered(me.id);
      }
    } catch (e) {
      console.error('[deliver pending]', e);
    }

    // ---------- E2EE public keys ----------
    // Client publishes its ECDH public key (JWK string) after login.
    socket.on('me:pubkey', async ({ pubkey }) => {
      if (typeof pubkey === 'string' && pubkey.length < 2000) await setPubkey(me.id, pubkey);
    });
    // Fetch another user's public key to derive a shared secret.
    socket.on('user:pubkey', async ({ userId }, cb) => {
      cb?.({ pubkey: await getPubkey(Number(userId)) });
    });

    // ---------- Contacts & search ----------
    socket.on('contacts:list', async (_data, cb) => {
      const rows = await listContacts(me.id);
      cb?.(rows.map((r) => ({ ...r, online: isOnline(Number(r.id)) })));
    });

    socket.on('users:search', async ({ q }, cb) => {
      if (!q || q.trim().length < 1) return cb?.([]);
      const rows = await searchUsers(q.trim(), me.id);
      cb?.(rows.map((r) => ({ ...r, online: isOnline(Number(r.id)) })));
    });

    socket.on('contact:add', async ({ userId }, cb) => {
      const other = await findUserById(userId);
      if (!other) return cb?.({ error: 'User not found.' });
      await addContact(me.id, Number(other.id));
      // Refresh the other user's contact list if they're online.
      io.to(`u:${other.id}`).emit('contacts:changed');
      cb?.({ ok: true, contact: { ...other, online: isOnline(Number(other.id)) } });
    });

    // ---------- Chat ----------
    socket.on('chat:history', async ({ withId }, cb) => {
      const rows = await getConversation(me.id, Number(withId));
      cb?.(rows.map(normalizeMsg));
    });

    socket.on('chat:send', async ({ toId, body, tempId }, cb) => {
      const text = (body || '').toString().slice(0, 4000).trim();
      if (!text) return cb?.({ error: 'Empty message.' });
      const to = Number(toId);
      const delivered = isOnline(to);
      const saved = await saveMessage(me.id, to, text, delivered);
      const msg = normalizeMsg(saved);
      // Make sure both sides share the conversation as a contact.
      await addContact(me.id, to);
      io.to(`u:${to}`).emit('chat:message', msg);
      io.to(`u:${to}`).emit('contacts:changed');
      cb?.({ ok: true, tempId, message: msg });
    });

    socket.on('presence:get', ({ ids }, cb) => {
      const map = {};
      (ids || []).forEach((id) => (map[id] = isOnline(Number(id))));
      cb?.(map);
    });

    // ---------- Call setup ----------
    // Start (or extend) a call. `toId` is who we're inviting.
    socket.on('call:invite', async ({ callId, toId, media }) => {
      const to = Number(toId);
      if (!calls.has(callId)) {
        calls.set(callId, { participants: new Set([me.id]), media: media || 'video' });
      } else {
        calls.get(callId).participants.add(me.id);
      }
      const caller = await findUserById(me.id);
      io.to(`u:${to}`).emit('call:incoming', {
        callId,
        media: media || 'video',
        from: { id: me.id, username: caller?.username, avatar_hue: caller?.avatar_hue },
      });
    });

    // Callee accepted -> join the mesh. Return the peers they must offer to.
    socket.on('call:accept', ({ callId }, cb) => {
      const call = calls.get(callId);
      if (!call) return cb?.({ error: 'Call no longer exists.' });
      const existing = [...call.participants].filter((id) => id !== me.id);
      call.participants.add(me.id);
      // Tell existing peers a newcomer arrived (they wait for the offer).
      existing.forEach((peerId) => {
        io.to(`u:${peerId}`).emit('call:peer-joined', {
          callId,
          peer: { id: me.id, username: me.username },
        });
      });
      // Newcomer initiates offers to each existing peer.
      cb?.({ ok: true, media: call.media, peers: existing });
    });

    socket.on('call:reject', ({ callId, toId }) => {
      io.to(`u:${Number(toId)}`).emit('call:rejected', { callId, from: me.id });
    });

    socket.on('call:cancel', ({ callId, toId }) => {
      io.to(`u:${Number(toId)}`).emit('call:cancelled', { callId, from: me.id });
    });

    // Leave the call -> notify remaining peers.
    socket.on('call:leave', ({ callId }) => {
      leaveCall(io, callId, me.id);
    });

    // ---------- WebRTC signaling relay (offer / answer / ICE) ----------
    socket.on('rtc:signal', ({ callId, toId, data }) => {
      io.to(`u:${Number(toId)}`).emit('rtc:signal', {
        callId,
        fromId: me.id,
        data,
      });
    });

    // ---------- Disconnect ----------
    socket.on('disconnect', async () => {
      removeOnline(me.id, socket.id);
      if (!isOnline(me.id)) {
        // Leave any calls this user was in.
        for (const [callId, call] of calls) {
          if (call.participants.has(me.id)) leaveCall(io, callId, me.id);
        }
        await broadcastPresence(io, me.id, false);
      }
    });
  });
}

function leaveCall(io, callId, userId) {
  const call = calls.get(callId);
  if (!call) return;
  call.participants.delete(userId);
  call.participants.forEach((peerId) => {
    io.to(`u:${peerId}`).emit('call:peer-left', { callId, peerId: userId });
  });
  if (call.participants.size === 0) calls.delete(callId);
}

async function broadcastPresence(io, userId, isUp) {
  // Notify anyone who has this user as a contact.
  const contactsOfChange = await listContacts(userId);
  contactsOfChange.forEach((c) => {
    io.to(`u:${c.id}`).emit('presence:update', { userId, online: isUp });
  });
}

function normalizeMsg(m) {
  return {
    id: Number(m.id),
    from: Number(m.sender_id),
    to: Number(m.receiver_id),
    body: m.body,
    at: Number(m.created_at),
  };
}
