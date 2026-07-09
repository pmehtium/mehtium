# BlueChat 💬

A WhatsApp-style web app: **1:1 chat**, **voice & video calls**, and **group calls** (up to 4 people), with an invite-only registration gate. Built with Node.js, Socket.io and WebRTC, storing chats in **SQLite** (via libSQL — runs as a local file locally, and as a free persistent cloud DB on Render via Turso).

- 🔐 Registration gated by a **6-word secret phrase**
- 💬 Real-time 1:1 messaging, saved to SQLite (offline messages delivered on reconnect)
- 🔎 Search any username and add them as a contact
- 📞 Voice calls, 📹 video calls — peer-to-peer via WebRTC (STUN + optional TURN)
- 👥 Turn any call into a **group call** by adding 2–3 more people (mesh, up to 4 total)
- 📱 Beautiful, mobile-responsive white & blue UI (installable as a PWA)

---

## The 5 secret registration phrases

A new user must type **one of these** (all six words) to register. They're set via the `SECRET_PHRASES` env var (pipe-separated). Share them only with people you want to let in.

```
1.  copper lantern river echo marble fox
2.  silver thunder maple quartz otter drift
3.  amber canyon velvet signal harbor pine
4.  crimson willow pixel nomad glacier bloom
5.  cobalt meadow falcon ember cipher tide
```

To use your **own** phrases, change `SECRET_PHRASES` in `.env` (local) and in Render's environment settings. They are reusable — anyone with a valid phrase can register. (See "Making phrases single-use" below.)

---

## Project structure

```
bluechat/
├─ server/
│  ├─ index.js       Express + Socket.io bootstrap, static hosting, /healthz, /api/ice
│  ├─ config.js      Env config, ICE server assembly, phrase normalization
│  ├─ db.js          libSQL/SQLite schema + queries (users, contacts, messages)
│  ├─ auth.js        Register / login (bcrypt + JWT), secret-phrase gate
│  └─ signaling.js   Socket.io: presence, chat, contacts, WebRTC call signaling
├─ public/
│  ├─ index.html     App shell (auth, chat, call overlay, modals)
│  ├─ css/styles.css White & blue responsive theme
│  └─ js/
│     ├─ app.js      Auth, contacts, chat, presence, UI
│     └─ calls.js    WebRTC engine (voice/video/group, mesh)
├─ render.yaml       Render Blueprint (one-click deploy config)
├─ .env.example      Copy to .env for local dev
└─ package.json
```

---

## 1) Run locally

Requirements: **Node.js 18+**.

```bash
git clone <your-repo-url> bluechat
cd bluechat
cp .env.example .env          # then edit .env if you like
npm install
npm start
```

Open **http://localhost:3000** in two browser tabs (or two devices on the same network), register two users with a secret phrase, add each other, and chat/call.

> **Camera & mic:** browsers only allow WebRTC on `localhost` or `https://`. Localhost works out of the box; on a deployed site you must be on HTTPS (Render gives you HTTPS automatically).

---

## 2) Push to GitHub

```bash
git init
git add .
git commit -m "BlueChat: chat + video/voice + group calls"
git branch -M main
git remote add origin https://github.com/<you>/bluechat.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `.env`, and local `*.db` files, so no secrets or bulky files get committed.

---

## 3) Deploy to Render

You have two options. **Blueprint** is the easiest.

### Option A — Blueprint (recommended)

1. Go to **[dashboard.render.com](https://dashboard.render.com)** → **New +** → **Blueprint**.
2. Connect your GitHub and pick the **bluechat** repo. Render reads `render.yaml`.
3. It creates a Web Service. `JWT_SECRET` is auto-generated. Click **Apply**.
4. Wait for the build, then open the `*.onrender.com` URL. Done — HTTPS is automatic.

### Option B — Manual Web Service

1. **New +** → **Web Service** → pick the repo.
2. Environment: **Node**. Build command: `npm install`. Start command: `npm start`.
3. Add the env vars listed below.

### Environment variables on Render

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | ✅ | Long random string (Blueprint auto-generates it). |
| `SECRET_PHRASES` | ✅ | Pipe-separated 6-word phrases (the 5 above by default). |
| `DATABASE_URL` | ✅ | `file:/tmp/bluechat.db` (ephemeral) **or** a Turso `libsql://…` URL (persistent — see below). |
| `DATABASE_AUTH_TOKEN` | if Turso | Turso auth token. |
| `STUN_URLS` | optional | Defaults to Google STUN. |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | recommended | For reliable calls across mobile/firewalls (see below). |

---

## 4) Persisting chats for free (Turso) — "a small SQLite that persists"

Render's free instances have an **ephemeral** filesystem: the local SQLite file is wiped on every deploy/restart. Two ways to keep your chat history:

**A. Turso (free, recommended).** Turso is hosted SQLite (libSQL) — the exact same engine this app already uses, just remote. Free tier is generous (billions of row reads, plenty of storage).

1. Sign up at **[turso.tech](https://turso.tech)** and install the CLI (or use the web dashboard).
2. Create a database and grab its URL + token:
   ```bash
   turso db create bluechat
   turso db show bluechat --url          # -> libsql://bluechat-<you>.turso.io
   turso db tokens create bluechat       # -> a long token
   ```
3. In Render, set:
   ```
   DATABASE_URL=libsql://bluechat-<you>.turso.io
   DATABASE_AUTH_TOKEN=<the token>
   ```
4. Redeploy. The app creates its tables automatically on first boot. Your chats now survive restarts — no code changes needed.

**B. Render Persistent Disk (paid).** Upgrade the service to a paid plan, attach a 1 GB disk mounted at `/var/data`, and set `DATABASE_URL=file:/var/data/bluechat.db`. The `render.yaml` has this block commented out and ready.

---

## 5) TURN server — making calls connect everywhere

WebRTC uses **STUN** to discover your public address (free, already configured) and **TURN** to relay media when a direct connection is impossible (common on mobile data and strict corporate/Wi-Fi networks). Without TURN, some calls will ring but never connect.

Easiest free TURN — **[Metered.ca](https://www.metered.ca/)** (50 GB/month free):

1. Create a free account → **TURN Server** → copy your credentials.
2. In Render set, for example:
   ```
   TURN_URLS=turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp
   TURN_USERNAME=<your metered username>
   TURN_CREDENTIAL=<your metered credential>
   ```
3. Redeploy. The server hands these to every browser via `/api/ice`. Startup logs will show `TURN configured: yes`.

Prefer to self-host? Run [coturn](https://github.com/coturn/coturn) on a small VPS and point the same three vars at it.

---

## How it works (quick tour)

- **Auth:** `POST /api/auth/register` checks your username, password (bcrypt-hashed) and secret phrase, then returns a **JWT**. The browser stores it and reuses it. Socket.io connections are authenticated with the same token in the handshake.
- **Chat:** messages are **encrypted in the browser** (see End-to-end encryption below), sent over Socket.io as ciphertext, written to the `messages` table as ciphertext, and relayed to the recipient's room (`u:<id>`). If the recipient is offline, the message is stored `delivered=0` and pushed the moment they reconnect.
- **Calls:** the signaling server never touches your audio/video — it only relays SDP offers/answers and ICE candidates between browsers (`rtc:signal`). Media flows **peer-to-peer**.
- **Group calls:** a **mesh** — each participant holds a direct connection to every other participant. When someone new accepts, they create offers to everyone already in the call. Capped at 4 total to keep the mesh light.

---

## Calls: reliability & diagnostics

If a call rings the first time but a later call doesn't ring the other side, it's almost always leftover call state from a previous call that didn't clean up (screen lock, app backgrounded, or the socket dropping between calls). BlueChat guards against this:

- An incoming call is only rejected as "busy" if you're in a **genuinely live** call; otherwise stale state is cleared automatically so the new call rings.
- Ending or cancelling a call notifies the other side (so ringing modals dismiss), and a dropped socket tears the call down locally.

To diagnose call behavior, open the browser console — every call transition is logged with a `[call]` prefix (`[call] incoming …`, `[call] busy -> rejecting`, `[call] stale call state detected -> clearing`, `[call] end …`). On a phone, use remote debugging (Chrome `chrome://inspect`, or Safari Web Inspector) to see the same logs. If you ever see `busy -> rejecting` when you weren't actually on a call, that's the case the guard now handles.

## Earpiece vs. speakerphone (mobile)

On phones, a speaker/earpiece toggle appears in the call controls (it's hidden on desktop, which has no earpiece). It's **best-effort**: it uses the browser's `setSinkId` output-routing API where available (mainly Android Chrome). Note that **iOS Safari does not let web apps switch between the earpiece and loudspeaker** — that's an Apple platform limitation, not a bug in the app — so on iPhones the button is hidden and iOS decides routing itself (it tends to use the earpiece for audio-only and the loudspeaker when video is on). A fully reliable earpiece/speaker switch on every phone would require a native app wrapper.

## Customizing

- **Colors:** edit the CSS variables at the top of `public/css/styles.css` (`--blue-*`, `--bg`, bubbles…).
- **App name / logo:** `public/index.html` (the `.brand` block and the inline SVG favicon).
- **Group size limit:** `public/js/calls.js` (`peers.size >= 3` check in `openPicker`).
- **Making phrases single-use:** in `server/auth.js`, after a successful `createUser`, delete the used phrase from a persisted list (e.g. add a `used_phrases` table) instead of the in-memory `Set`. As written, phrases are reusable invites.

---

## End-to-end encryption

BlueChat is end-to-end encrypted across the board:

- **Chats (1:1):** every message is encrypted in your browser with a key that only you and the recipient can derive. On login the app generates an **ECDH P-256** key pair; the private key never leaves your device (`localStorage`), and only the public key is uploaded. Sender and recipient derive a shared **AES-GCM 256** key via ECDH and encrypt/decrypt locally. **The server and the SQLite database only ever store ciphertext** (`e2:…`) — a database dump reveals nothing readable. This is verified in the automated test suite.
- **Voice / video / group calls:** WebRTC media is peer-to-peer and always encrypted with **DTLS-SRTP** by the browser. The signaling server only relays connection setup (SDP/ICE), never audio or video, so calls are end-to-end encrypted by design — even a TURN relay only forwards encrypted packets it can't read. Group calls are a mesh of these individually-encrypted peer connections.

Key-management caveat (by design, worth knowing): the chat private key is stored per-device. If a user signs in on a **new device**, that device generates a fresh key, so it can send/receive new messages but can't decrypt history created on the old device. Clearing browser storage has the same effect. For a v1 this is a reasonable trade-off; a future upgrade could derive keys deterministically from the password or add encrypted key backup.

Still worth adding before heavy production use: rate-limiting on the auth endpoints and spam/flood limits (a 4 000-char message cap is already in place).

## A note on where data lives

The SQLite database is **server-side** (on Render), not on each user's phone — and it has to be, because it's the shared relay that routes messages between people who are rarely online at the same second (offline messages are held until you reconnect). You can't put that one shared database on a single user's device. What makes this private isn't the *location* of the database but the *encryption*: with E2EE, that server-side DB holds only ciphertext, so "on the server" no longer means "readable by the server." (If you ever want a local decrypted copy of your own history cached on each device, that's a separate feature — an in-browser IndexedDB mirror — and easy to add later.)

---

MIT licensed. Have fun. 💙
