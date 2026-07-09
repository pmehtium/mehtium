import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config, normalizePhrase } from './config.js';
import { createUser, findUserByUsername } from './db.js';

export const authRouter = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const validPhrases = new Set(config.secretPhrases.map(normalizePhrase));

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    config.jwtSecret,
    { expiresIn: '30d' }
  );
}

function hueFor(username) {
  // Deterministic pleasant blue-ish hue per user for their avatar.
  let h = 0;
  for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

authRouter.post('/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const phrase = normalizePhrase(req.body.phrase || '');

    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3-20 characters: letters, numbers or underscore.',
      });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (!validPhrases.has(phrase)) {
      return res.status(403).json({ error: 'That secret phrase is not valid.' });
    }
    if (await findUserByUsername(username)) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await createUser(username, hash, hueFor(username));
    return res.json({ token: signToken(user), user });
  } catch (err) {
    console.error('[register]', err);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    const row = await findUserByUsername(username);
    if (!row) return res.status(401).json({ error: 'Invalid username or password.' });

    const ok = await bcrypt.compare(password, String(row.password));
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

    const user = { id: Number(row.id), username: row.username, avatar_hue: row.avatar_hue };
    return res.json({ token: signToken(user), user });
  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Verify a JWT (used by the Socket.io handshake).
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}
