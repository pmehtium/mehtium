/* ============================================================
   BlueChat — WebRTC voice / video / group calls (mesh topology).
   Depends on window.BC (app.js) and Socket.io.
   ============================================================ */
'use strict';

const Calls = (window.Calls = {
  ice: [{ urls: ['stun:stun.l.google.com:19302'] }],
  cur: null,      // active call state
  incoming: null, // pending incoming call
  ringTimer: null,
  speakerOn: true,

  async loadIce() {
    try {
      const r = await fetch('/api/ice');
      const j = await r.json();
      if (j.iceServers?.length) this.ice = j.iceServers;
    } catch { /* keep default STUN */ }
  },

  bind(socket) {
    this.socket = socket;
    this.loadIce();
    setupOutputToggle();

    socket.on('call:incoming', (d) => this.onIncoming(d));
    socket.on('call:peer-joined', (d) => this.onPeerJoined(d));
    socket.on('call:peer-left', (d) => this.onPeerLeft(d));
    socket.on('call:rejected', () => this.onRejected());
    socket.on('call:cancelled', () => this.onCancelled());
    socket.on('rtc:signal', (d) => this.onSignal(d));

    // If the socket drops mid-call we can't signal any more — clean up so the
    // next call isn't blocked by a ghost "in a call" state.
    socket.on('disconnect', () => {
      if (this.cur) { clog('socket disconnected during call -> ending'); this.end(); }
      if (this.incoming) { document.getElementById('incomingModal').classList.remove('show'); this.incoming = null; }
    });
  },

  /* -------- Outgoing -------- */
  async start(media) {
    if (this.cur) return BC.toast('You are already in a call.');
    if (!BC.currentPeer) return BC.toast('Open a conversation first.');
    const peer = BC.currentPeer;
    try {
      const localStream = await getLocal(media);
      const callId = (crypto.randomUUID && crypto.randomUUID()) || 'c' + Date.now();
      this.cur = newCall(callId, media, localStream);
      openOverlay();
      addSelfTile(localStream, media === 'video');
      // A placeholder tile for the person we're ringing.
      addPeerTile(peer.id, peer.username, peer.avatar_hue);
      setStatus(`Ringing ${peer.username}…`);
      this.socket.emit('call:invite', { callId, toId: peer.id, media });
      this.ringTimer = setTimeout(() => {
        if (this.cur && this.cur.peers.get(peer.id) && !this.cur.peers.get(peer.id).pc) {
          BC.toast('No answer.');
          this.socket.emit('call:cancel', { callId, toId: peer.id });
          this.end();
        }
      }, 35000);
    } catch (err) {
      console.error(err);
      BC.toast('Could not access mic/camera. Check permissions.');
      this.end();
    }
  },

  /* -------- Incoming -------- */
  onIncoming(d) {
    clog('incoming', d.callId, 'from', d.from.username, 'cur=', this.cur && this.cur.callId);
    // If already in this exact call (group add landing), ignore duplicate.
    if (this.cur && this.cur.callId === d.callId) return;
    if (this.cur) {
      // Only reject if we're genuinely in a LIVE call. Otherwise the previous
      // call left stale state (screen lock / socket drop) — clear it and ring.
      const live = [...this.cur.peers.values()].some(
        (p) => p.pc && ['connecting', 'connected', 'completed'].includes(p.pc.connectionState)
      );
      if (live) {
        clog('busy -> rejecting', d.callId);
        this.socket.emit('call:reject', { callId: d.callId, toId: d.from.id });
        return;
      }
      clog('stale call state detected -> clearing before ringing');
      this.end();
    }
    this.incoming = d;
    const modal = document.getElementById('incomingModal');
    document.getElementById('incName').textContent = d.from.username;
    document.getElementById('incType').textContent =
      (d.media === 'video' ? 'Incoming video call…' : 'Incoming voice call…');
    const av = document.getElementById('incAvatar');
    av.style.background = BC.hueColor(d.from.avatar_hue);
    av.textContent = BC.initials(d.from.username);
    modal.classList.add('show');
  },

  async accept() {
    const inc = this.incoming;
    if (!inc) return;
    document.getElementById('incomingModal').classList.remove('show');
    this.incoming = null;
    try {
      const localStream = await getLocal(inc.media);
      this.cur = newCall(inc.callId, inc.media, localStream);
      openOverlay();
      addSelfTile(localStream, inc.media === 'video');
      setStatus('Connecting…');
      this.socket.emit('call:accept', { callId: inc.callId }, async (res) => {
        if (res?.error) { BC.toast(res.error); this.end(); return; }
        // Offer to every peer already in the call.
        for (const peerId of res.peers || []) {
          await this.createConnection(peerId, true);
        }
      });
    } catch (err) {
      console.error(err);
      BC.toast('Could not access mic/camera.');
      this.reject();
    }
  },

  reject() {
    const inc = this.incoming;
    document.getElementById('incomingModal').classList.remove('show');
    if (inc) this.socket.emit('call:reject', { callId: inc.callId, toId: inc.from.id });
    this.incoming = null;
  },

  /* -------- Peer lifecycle -------- */
  onPeerJoined(d) {
    if (!this.cur || this.cur.callId !== d.callId) return;
    // The newcomer will send us an offer; just make sure a tile exists.
    setStatus('');
    if (!this.cur.peers.has(d.peer.id)) {
      addPeerTile(d.peer.id, d.peer.username, 210);
    }
  },

  onPeerLeft(d) {
    if (!this.cur || this.cur.callId !== d.callId) return;
    const entry = this.cur.peers.get(d.peerId);
    if (entry) {
      if (entry.pc) entry.pc.close();
      entry.tile?.remove();
      this.cur.peers.delete(d.peerId);
    }
    relayout();
    if (this.cur.peers.size === 0) { BC.toast('Call ended.'); this.end(); }
  },

  onRejected() { BC.toast('Call declined.'); this.end(); },
  onCancelled() {
    if (this.incoming) {
      document.getElementById('incomingModal').classList.remove('show');
      this.incoming = null;
      BC.toast('Caller cancelled.');
    }
  },

  async createConnection(peerId, initiator) {
    if (!this.cur) return null;
    let entry = this.cur.peers.get(peerId);
    if (!entry) { addPeerTile(peerId, 'Guest', 210); entry = this.cur.peers.get(peerId); }
    if (entry.pc) return entry.pc;

    const pc = new RTCPeerConnection({ iceServers: this.ice });
    entry.pc = pc;
    this.cur.localStream.getTracks().forEach((t) => pc.addTrack(t, this.cur.localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('rtc:signal', { callId: this.cur.callId, toId: peerId, data: { candidate: e.candidate } });
      }
    };
    pc.ontrack = (e) => {
      entry.stream = e.streams[0];
      attachRemote(entry, e.streams[0]);
      setStatus('');
      applySink(this.speakerOn); // route audio to the chosen output
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        // let peer-left handle removal; nothing here
      }
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('rtc:signal', { callId: this.cur.callId, toId: peerId, data: { sdp: pc.localDescription } });
    }
    return pc;
  },

  async onSignal({ callId, fromId, data }) {
    if (!this.cur || this.cur.callId !== callId) return;
    let entry = this.cur.peers.get(fromId);
    if (!entry) { addPeerTile(fromId, 'Guest', 210); entry = this.cur.peers.get(fromId); }

    if (data.sdp) {
      const isOffer = data.sdp.type === 'offer';
      if (isOffer && !entry.pc) await this.createConnection(fromId, false);
      const pc = entry.pc;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (isOffer) {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('rtc:signal', { callId, toId: fromId, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate && entry.pc) {
      try { await entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { /* ignore */ }
    }
  },

  /* -------- Controls -------- */
  toggleMic() {
    if (!this.cur) return;
    this.cur.micOn = !this.cur.micOn;
    this.cur.localStream.getAudioTracks().forEach((t) => (t.enabled = this.cur.micOn));
    document.getElementById('ccMic').classList.toggle('active', this.cur.micOn);
  },
  toggleCam() {
    if (!this.cur || this.cur.media !== 'video') return;
    this.cur.camOn = !this.cur.camOn;
    this.cur.localStream.getVideoTracks().forEach((t) => (t.enabled = this.cur.camOn));
    document.getElementById('ccCam').classList.toggle('active', this.cur.camOn);
    document.querySelector('.tile.self')?.classList.toggle('novideo', !this.cur.camOn);
  },
  // Mobile only: switch audio output between earpiece and loudspeaker (best effort).
  async toggleSpeaker() {
    this.speakerOn = !this.speakerOn;
    document.getElementById('ccSpeaker').classList.toggle('active', this.speakerOn);
    await applySink(this.speakerOn);
    BC.toast(this.speakerOn ? '🔊 Speaker' : '📞 Earpiece');
  },

  openPicker() {
    if (!this.cur) return;
    if (this.cur.peers.size >= 3) return BC.toast('Group calls support up to 4 people.');
    const list = document.getElementById('pickerList');
    const items = [...BC.contacts.values()].filter((c) => !this.cur.peers.has(c.id));
    list.innerHTML = items.length ? '' : '<div class="empty">No more contacts to add.</div>';
    items.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<div class="avatar sm" style="background:${BC.hueColor(c.avatar_hue)}">${BC.initials(c.username)}</div>
        <div class="meta"><div class="name"><span>${c.username}</span></div></div>`;
      row.onclick = () => {
        this.socket.emit('call:invite', { callId: this.cur.callId, toId: c.id, media: this.cur.media });
        addPeerTile(c.id, c.username, c.avatar_hue);
        document.getElementById('pickerModal').classList.remove('show');
        BC.toast(`Inviting ${c.username}…`);
      };
      list.appendChild(row);
    });
    document.getElementById('pickerModal').classList.add('show');
  },

  // Tap the small picture-in-picture to swap who's shown full-screen.
  swap() {
    if (!this.cur) return;
    this.cur.swapped = !this.cur.swapped;
    relayout();
  },

  end() {
    clearTimeout(this.ringTimer);
    if (this.cur) {
      clog('end', this.cur.callId);
      const callId = this.cur.callId;
      this.cur.peers.forEach((e, peerId) => {
        // Peers that never connected are still ringing — tell them to stop.
        if (!e.pc) this.socket.emit('call:cancel', { callId, toId: peerId });
        if (e.pc) e.pc.close();
      });
      this.socket.emit('call:leave', { callId });
      try { this.cur.localStream.getTracks().forEach((t) => t.stop()); } catch {}
    }
    this.cur = null;
    document.getElementById('callGrid').innerHTML = '';
    document.getElementById('callOverlay').classList.remove('show');
  },
});

/* ---------------- helpers ---------------- */
function clog(...args) { try { console.log('[call]', ...args); } catch {} }

function newCall(callId, media, localStream) {
  return { callId, media, localStream, peers: new Map(), micOn: true, camOn: media === 'video', swapped: false };
}

// Show the earpiece/speaker button only on mobile browsers that can switch output.
const OUTPUT_SUPPORTED = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
const IS_MOBILE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
function setupOutputToggle() {
  const btn = document.getElementById('ccSpeaker');
  if (!btn) return;
  btn.style.display = IS_MOBILE && OUTPUT_SUPPORTED ? 'grid' : 'none';
}
// Route all remote audio to earpiece (speaker=false) or loudspeaker (speaker=true).
async function applySink(speaker) {
  if (!OUTPUT_SUPPORTED) return;
  let target = ''; // '' = system default
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    if (speaker) {
      const spk = outs.find((d) => /speaker|speakerphone/i.test(d.label));
      target = spk ? spk.deviceId : (outs.find((d) => d.deviceId === 'default')?.deviceId || '');
    } else {
      const ear = outs.find((d) => /earpiece|receiver|handset/i.test(d.label));
      target = ear ? ear.deviceId : '';
    }
    const els = [...document.querySelectorAll('#callGrid video')];
    await Promise.all(els.map((el) => (el.setSinkId ? el.setSinkId(target).catch(() => {}) : null)));
  } catch { /* best effort */ }
}

async function getLocal(media) {
  const constraints = media === 'video'
    ? { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } }
    : { audio: true, video: false };
  return navigator.mediaDevices.getUserMedia(constraints);
}

function openOverlay() { document.getElementById('callOverlay').classList.add('show'); }
function setStatus(txt) {
  const el = document.getElementById('callStatus');
  el.textContent = txt;
  el.style.display = txt ? 'block' : 'none';
}

function makeTile(idAttr, username, hue, isSelf) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (isSelf ? ' self' : '');
  tile.dataset.peer = idAttr;
  const vid = document.createElement('video');
  vid.autoplay = true; vid.playsInline = true; vid.muted = isSelf;
  const novid = document.createElement('div');
  novid.className = 'novid';
  novid.innerHTML = `<div class="avatar lg" style="background:${BC.hueColor(hue)}">${BC.initials(username)}</div>`;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = isSelf ? 'You' : username;
  tile.append(novid, vid, label);
  document.getElementById('callGrid').appendChild(tile);
  relayout();
  return { tile, vid };
}

function addSelfTile(stream, hasVideo) {
  const { tile, vid } = makeTile('self', BC.me.username, BC.me.avatar_hue || 210, true);
  vid.srcObject = stream;
  if (!hasVideo) tile.classList.add('novideo');
}

function addPeerTile(peerId, username, hue) {
  if (Calls.cur.peers.has(peerId)) {
    // update label if we learned the name
    const e = Calls.cur.peers.get(peerId);
    if (username && e.tile) e.tile.querySelector('.label').textContent = username;
    return;
  }
  const { tile, vid } = makeTile(peerId, username, hue, false);
  tile.classList.add('novideo'); // until a remote video track arrives
  Calls.cur.peers.set(peerId, { pc: null, tile, vid, username, stream: null });
}

function attachRemote(entry, stream) {
  entry.vid.srcObject = stream;
  const hasVideo = stream.getVideoTracks().some((t) => t.readyState === 'live');
  entry.tile.classList.toggle('novideo', !hasVideo);
}

/* Assign layout roles: 1:1 -> remote big + self picture-in-picture; group -> equal grid. */
function relayout() {
  const grid = document.getElementById('callGrid');
  const tiles = [...grid.children];
  const selfTile = grid.querySelector('.tile.self');
  const remotes = tiles.filter((t) => t !== selfTile);
  tiles.forEach((t) => t.classList.remove('is-big', 'is-pip'));
  grid.classList.remove('stage-duo', 'stage-grid', 'g1', 'g2', 'g3', 'g4');

  if (remotes.length <= 1) {
    grid.classList.add('stage-duo');
    const remote = remotes[0] || null;
    const swapped = Calls.cur && Calls.cur.swapped && remote;
    if (!remote) {
      selfTile && selfTile.classList.add('is-big');
    } else if (swapped) {
      selfTile.classList.add('is-big');
      remote.classList.add('is-pip');
    } else {
      remote.classList.add('is-big');
      selfTile && selfTile.classList.add('is-pip');
    }
  } else {
    grid.classList.add('stage-grid', 'g' + Math.min(tiles.length, 4));
  }
}

/* CSS: .tile.novideo hides the video element and shows the avatar */
const style = document.createElement('style');
style.textContent = `.tile.novideo video{opacity:0} .tile:not(.novideo) .novid{opacity:0}`;
document.head.appendChild(style);

/* ---------------- wire up buttons ---------------- */
document.getElementById('audioCallBtn').onclick = () => Calls.start('audio');
document.getElementById('videoCallBtn').onclick = () => Calls.start('video');
document.getElementById('ccMic').onclick = () => Calls.toggleMic();
document.getElementById('ccCam').onclick = () => Calls.toggleCam();
document.getElementById('ccAdd').onclick = () => Calls.openPicker();
document.getElementById('ccSpeaker').onclick = () => Calls.toggleSpeaker();
document.getElementById('ccEnd').onclick = () => Calls.end();
document.getElementById('incAccept').onclick = () => Calls.accept();
document.getElementById('incReject').onclick = () => Calls.reject();
document.getElementById('pickerClose').onclick = () =>
  document.getElementById('pickerModal').classList.remove('show');
document.getElementById('callGrid').addEventListener('click', (e) => {
  if (e.target.closest('.tile.is-pip')) Calls.swap();
});
