/* ============================================================
   BlueChat frontend — auth, contacts, chat, presence.
   Call/WebRTC logic lives in calls.js (uses window.BC).
   ============================================================ */
'use strict';

const BC = (window.BC = {
  socket: null,
  me: null,
  token: null,
  currentPeer: null, // { id, username, avatar_hue, online }
  contacts: new Map(), // id -> contact
  pubkeys: new Map(), // id -> public key JWK string (for E2EE)
  // helpers
  initials(name = '?') {
    return name.trim().slice(0, 2).toUpperCase();
  },
  hueColor(hue = 210) {
    return `hsl(${hue}, 62%, 52%)`;
  },
  fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },
  fmtDay(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  },
  toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(BC._tt);
    BC._tt = setTimeout(() => t.classList.remove('show'), 2600);
  },
});

const $ = (id) => document.getElementById(id);

/* ---------------- Auth ---------------- */
let registerMode = false;

function setAuthMode(reg) {
  registerMode = reg;
  $('phraseField').classList.toggle('hidden', !reg);
  $('authBtn').textContent = reg ? 'Create account' : 'Sign in';
  $('authSub').textContent = reg
    ? 'Create your account with an invite phrase.'
    : 'Sign in to keep the conversation going.';
  $('authSwitch').innerHTML = reg
    ? `Already have an account? <button id="toggleMode" type="button">Sign in</button>`
    : `New here? <button id="toggleMode" type="button">Create an account</button>`;
  $('toggleMode').onclick = () => setAuthMode(!registerMode);
  $('password').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  hideError();
}

function showError(msg) {
  const e = $('authError');
  e.textContent = msg;
  e.classList.remove('hidden');
}
function hideError() { $('authError').classList.add('hidden'); }

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const username = $('username').value.trim();
  const password = $('password').value;
  const phrase = $('phrase').value.trim();
  if (!username || !password) return showError('Please fill in username and password.');

  const btn = $('authBtn');
  btn.disabled = true;
  try {
    const path = registerMode ? '/api/auth/register' : '/api/auth/login';
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, phrase }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    onAuthenticated(data.token, data.user);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
});

setAuthMode(false);

/* ---------------- Session ---------------- */
function onAuthenticated(token, user) {
  BC.token = token;
  BC.me = user;
  try { localStorage.setItem('bc_token', token); } catch {}
  $('authScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('meName').textContent = user.username;
  paintAvatar($('meAvatar'), user.username, user.avatar_hue);
  connectSocket();
}

function logout() {
  try { localStorage.removeItem('bc_token'); } catch {}
  if (BC.socket) BC.socket.disconnect();
  location.reload();
}
$('logoutBtn').onclick = logout;

/* ---------------- Socket ---------------- */
function connectSocket() {
  const socket = io({ auth: { token: BC.token } });
  BC.socket = socket;

  socket.on('connect_error', (e) => {
    if (e.message === 'unauthorized') { BC.toast('Session expired, please sign in again.'); logout(); }
  });

  socket.on('connect', async () => {
    // Set up end-to-end encryption keys and publish our public key.
    try {
      const pub = await E2EE.init(BC.me.username);
      socket.emit('me:pubkey', { pubkey: JSON.stringify(pub) });
    } catch (e) { console.error('E2EE init failed', e); }
    refreshContacts();
  });

  socket.on('chat:message', async (m) => {
    const dm = await decryptMessage(m);
    if (BC.currentPeer && (m.from === BC.currentPeer.id || m.to === BC.currentPeer.id)) {
      appendMessage(dm);
      scrollMessages();
    } else if (m.from !== BC.me.id) {
      const c = BC.contacts.get(m.from);
      BC.toast(`💬 ${c ? c.username : 'New message'}`);
    }
    refreshContacts();
  });

  socket.on('contacts:changed', refreshContacts);
  socket.on('presence:update', ({ userId, online }) => {
    const c = BC.contacts.get(userId);
    if (c) c.online = online;
    if (BC.currentPeer && BC.currentPeer.id === userId) {
      BC.currentPeer.online = online;
      updatePeerStatus();
    }
    renderSideList();
  });

  // Call events are handled in calls.js
  if (window.Calls) window.Calls.bind(socket);
}

/* ---------------- Contacts & search ---------------- */
let searchTimer = null;
$('searchInput').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) return renderSideList();
  searchTimer = setTimeout(() => {
    BC.socket.emit('users:search', { q }, (rows) => renderSearchResults(rows));
  }, 200);
});

function refreshContacts() {
  if (!BC.socket) return;
  BC.socket.emit('contacts:list', {}, (rows) => {
    BC.contacts.clear();
    rows.forEach((r) => {
      const id = Number(r.id);
      BC.contacts.set(id, { ...r, id });
      if (r.pubkey) BC.pubkeys.set(id, r.pubkey);
    });
    if (!$('searchInput').value.trim()) renderSideList();
  });
}

function renderSideList() {
  const list = $('sideList');
  const items = [...BC.contacts.values()];
  if (!items.length) {
    list.innerHTML = `<div class="empty">No conversations yet.<br>Search a username above to add someone.</div>`;
    return;
  }
  list.innerHTML = `<div class="list-label">Chats</div>`;
  items.forEach((c) => {
    const enc = c.last_body && c.last_body.startsWith('e2:');
    const preview = c.last_body ? (enc ? '🔒 Encrypted message' : esc(c.last_body)) : 'Tap to start chatting';
    const row = document.createElement('div');
    row.className = 'row' + (BC.currentPeer && BC.currentPeer.id === c.id ? ' active' : '');
    row.dataset.cid = c.id;
    row.innerHTML = `
      <div class="avatar">${avatarInner(c.username, c.avatar_hue, c.online)}</div>
      <div class="meta">
        <div class="name"><span>${esc(c.username)}</span>${c.last_at ? `<span class="time">${BC.fmtTime(c.last_at)}</span>` : ''}</div>
        <div class="preview">${preview}</div>
      </div>`;
    row.onclick = () => openConversation(c);
    list.appendChild(row);
  });
  // Decrypt encrypted previews in the background.
  items.forEach(async (c) => {
    if (c.last_body && c.last_body.startsWith('e2:')) {
      const text = await E2EE.decrypt(await getAes(c.id), c.last_body);
      const el = list.querySelector(`.row[data-cid="${c.id}"] .preview`);
      if (el) el.textContent = text;
    }
  });
}

function renderSearchResults(rows) {
  const list = $('sideList');
  if (!rows.length) { list.innerHTML = `<div class="empty">No users found.</div>`; return; }
  list.innerHTML = `<div class="list-label">Search results</div>`;
  rows.forEach((u) => {
    u.id = Number(u.id);
    if (u.pubkey) BC.pubkeys.set(u.id, u.pubkey);
    const row = document.createElement('div');
    row.className = 'row';
    const known = BC.contacts.has(u.id);
    row.innerHTML = `
      <div class="avatar">${avatarInner(u.username, u.avatar_hue, u.online)}</div>
      <div class="meta"><div class="name"><span>${esc(u.username)}</span></div>
        <div class="preview">${u.online ? 'online' : 'offline'}</div></div>
      <button class="add-btn">${known ? 'Chat' : 'Add'}</button>`;
    row.querySelector('.add-btn').onclick = (ev) => {
      ev.stopPropagation();
      BC.socket.emit('contact:add', { userId: u.id }, (res) => {
        if (res.error) return BC.toast(res.error);
        BC.contacts.set(u.id, { ...u });
        $('searchInput').value = '';
        refreshContacts();
        openConversation({ ...u });
      });
    };
    row.onclick = () => {
      BC.socket.emit('contact:add', { userId: u.id }, () => {});
      $('searchInput').value = '';
      openConversation({ ...u });
    };
    list.appendChild(row);
  });
}

/* ---------------- E2E encryption helpers ---------------- */
async function getAes(userId) {
  let pk = BC.pubkeys.get(userId);
  if (!pk) {
    const c = BC.contacts.get(userId);
    if (c && c.pubkey) pk = c.pubkey;
  }
  if (!pk) {
    pk = await new Promise((r) => BC.socket.emit('user:pubkey', { userId }, (res) => r(res && res.pubkey)));
  }
  if (pk) BC.pubkeys.set(userId, pk);
  return E2EE.deriveAes(userId, pk);
}

async function decryptMessage(m) {
  const other = m.from === BC.me.id ? m.to : m.from;
  const aes = await getAes(other);
  return { ...m, body: await E2EE.decrypt(aes, m.body) };
}

/* ---------------- Conversation ---------------- */
function openConversation(peer) {
  BC.currentPeer = { ...peer, id: Number(peer.id) };
  $('chatEmpty').classList.add('hidden');
  $('chatActive').classList.remove('hidden');
  $('app').classList.add('show-chat');
  $('peerName').textContent = peer.username;
  paintAvatar($('peerAvatar'), peer.username, peer.avatar_hue);
  updatePeerStatus();
  renderSideList();

  $('messages').innerHTML = '';
  BC.socket.emit('chat:history', { withId: peer.id }, async (rows) => {
    const decoded = await Promise.all(rows.map(decryptMessage));
    let lastDay = '';
    decoded.forEach((m) => {
      const day = BC.fmtDay(m.at);
      if (day !== lastDay) { addDaySep(day); lastDay = day; }
      appendMessage(m);
    });
    scrollMessages();
  });
}

function updatePeerStatus() {
  const s = $('peerStatus');
  const on = BC.currentPeer && BC.currentPeer.online;
  s.textContent = on ? 'online' : 'offline';
  s.classList.toggle('on', !!on);
}

function appendMessage(m) {
  const div = document.createElement('div');
  const mine = m.from === BC.me.id;
  div.className = 'msg ' + (mine ? 'out' : 'in');
  div.innerHTML = `${esc(m.body)}<span class="t">${BC.fmtTime(m.at)}</span>`;
  $('messages').appendChild(div);
}
function addDaySep(label) {
  const d = document.createElement('div');
  d.className = 'day-sep';
  d.textContent = label;
  $('messages').appendChild(d);
}
function scrollMessages() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

async function sendMessage() {
  const input = $('msgInput');
  const body = input.value.trim();
  if (!body || !BC.currentPeer) return;
  input.value = '';
  const peerId = BC.currentPeer.id;
  const aes = await getAes(peerId);
  const wire = await E2EE.encrypt(aes, body); // ciphertext for the wire + DB
  BC.socket.emit('chat:send', { toId: peerId, body: wire }, (res) => {
    if (res.error) return BC.toast(res.error);
    appendMessage({ ...res.message, body }); // show our own plaintext locally
    scrollMessages();
    refreshContacts();
  });
}
$('sendBtn').onclick = sendMessage;
$('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
$('backBtn').onclick = () => $('app').classList.remove('show-chat');

/* ---------------- Avatar rendering ---------------- */
function avatarInner(username, hue, online) {
  return `<span style="position:absolute;inset:0;display:grid;place-items:center;border-radius:50%;background:${BC.hueColor(hue)}">${BC.initials(username)}</span>
          <span class="dot ${online ? 'on' : ''}"></span>`;
}
function paintAvatar(el, username, hue) {
  el.style.background = BC.hueColor(hue);
  el.textContent = BC.initials(username);
}

function esc(s = '') {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* expose a few helpers for calls.js */
BC.openConversation = openConversation;
BC.refreshContacts = refreshContacts;

/* ---------------- Auto-login ---------------- */
(function tryResume() {
  let token = null;
  try { token = localStorage.getItem('bc_token'); } catch {}
  if (!token) return;
  // Validate by connecting; decode username from token payload for display.
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    onAuthenticated(token, { id: payload.id, username: payload.username, avatar_hue: 210 });
  } catch {
    try { localStorage.removeItem('bc_token'); } catch {}
  }
})();
