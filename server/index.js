import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { Server as SocketServer } from 'socket.io';

import { config, iceServers } from './config.js';
import { initDb } from './db.js';
import { authRouter } from './auth.js';
import { attachSignaling } from './signaling.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '256kb' }));

// Health check for Render.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Expose ICE (STUN/TURN) config to the browser (no secrets beyond TURN creds).
app.get('/api/ice', (_req, res) => res.json({ iceServers: iceServers() }));

// Auth REST endpoints.
app.use('/api/auth', authRouter);

// Static frontend.
app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
});
attachSignaling(io);

async function start() {
  await initDb();
  server.listen(config.port, () => {
    console.log(`\n  BlueChat running on http://localhost:${config.port}`);
    console.log(`  TURN configured: ${config.turnUrls.length ? 'yes' : 'no (STUN only)'}\n`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
