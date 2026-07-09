import { createClient } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

// For a local file: URL, make sure the parent directory exists first.
if (config.databaseUrl.startsWith('file:')) {
  const filePath = config.databaseUrl.slice('file:'.length);
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Works with a local SQLite file (file:...) OR a remote Turso DB (libsql://...).
export const db = createClient({
  url: config.databaseUrl,
  authToken: config.databaseAuthToken,
});

export async function initDb() {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT UNIQUE NOT NULL,
        password   TEXT NOT NULL,
        avatar_hue INTEGER NOT NULL DEFAULT 210,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS contacts (
        owner_id   INTEGER NOT NULL,
        contact_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, contact_id)
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id   INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        body        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        delivered   INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_pair
         ON messages (sender_id, receiver_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_inbox
         ON messages (receiver_id, delivered)`,
    ],
    'write'
  );
  console.log(`[db] ready (${config.databaseUrl.split('?')[0]})`);
}

// ---------- Users ----------
export async function createUser(username, passwordHash, hue) {
  const now = Date.now();
  const res = await db.execute({
    sql: `INSERT INTO users (username, password, avatar_hue, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [username, passwordHash, hue, now],
  });
  return { id: Number(res.lastInsertRowid), username, avatar_hue: hue };
}

export async function findUserByUsername(username) {
  const res = await db.execute({
    sql: `SELECT * FROM users WHERE username = ? COLLATE NOCASE`,
    args: [username],
  });
  return res.rows[0] || null;
}

export async function findUserById(id) {
  const res = await db.execute({
    sql: `SELECT id, username, avatar_hue FROM users WHERE id = ?`,
    args: [id],
  });
  return res.rows[0] || null;
}

export async function searchUsers(query, excludeId) {
  const res = await db.execute({
    sql: `SELECT id, username, avatar_hue FROM users
          WHERE username LIKE ? COLLATE NOCASE AND id != ?
          ORDER BY username LIMIT 15`,
    args: [`%${query}%`, excludeId],
  });
  return res.rows;
}

// ---------- Contacts ----------
export async function addContact(ownerId, contactId) {
  const now = Date.now();
  // Add both directions so a conversation shows up for each side.
  await db.batch(
    [
      {
        sql: `INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at) VALUES (?, ?, ?)`,
        args: [ownerId, contactId, now],
      },
      {
        sql: `INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at) VALUES (?, ?, ?)`,
        args: [contactId, ownerId, now],
      },
    ],
    'write'
  );
}

export async function listContacts(ownerId) {
  const res = await db.execute({
    sql: `SELECT u.id, u.username, u.avatar_hue,
                 (SELECT body FROM messages m
                   WHERE (m.sender_id = c.owner_id AND m.receiver_id = c.contact_id)
                      OR (m.sender_id = c.contact_id AND m.receiver_id = c.owner_id)
                   ORDER BY m.id DESC LIMIT 1) AS last_body,
                 (SELECT created_at FROM messages m
                   WHERE (m.sender_id = c.owner_id AND m.receiver_id = c.contact_id)
                      OR (m.sender_id = c.contact_id AND m.receiver_id = c.owner_id)
                   ORDER BY m.id DESC LIMIT 1) AS last_at
          FROM contacts c
          JOIN users u ON u.id = c.contact_id
          WHERE c.owner_id = ?
          ORDER BY last_at DESC NULLS LAST, u.username ASC`,
    args: [ownerId],
  });
  return res.rows;
}

// ---------- Messages ----------
export async function saveMessage(senderId, receiverId, body, delivered) {
  const now = Date.now();
  const res = await db.execute({
    sql: `INSERT INTO messages (sender_id, receiver_id, body, created_at, delivered)
          VALUES (?, ?, ?, ?, ?)`,
    args: [senderId, receiverId, body, now, delivered ? 1 : 0],
  });
  return {
    id: Number(res.lastInsertRowid),
    sender_id: senderId,
    receiver_id: receiverId,
    body,
    created_at: now,
  };
}

export async function getConversation(userA, userB, limit = 200) {
  const res = await db.execute({
    sql: `SELECT id, sender_id, receiver_id, body, created_at FROM messages
          WHERE (sender_id = ? AND receiver_id = ?)
             OR (sender_id = ? AND receiver_id = ?)
          ORDER BY id ASC LIMIT ?`,
    args: [userA, userB, userB, userA, limit],
  });
  return res.rows;
}

export async function getUndelivered(receiverId) {
  const res = await db.execute({
    sql: `SELECT id, sender_id, receiver_id, body, created_at FROM messages
          WHERE receiver_id = ? AND delivered = 0 ORDER BY id ASC`,
    args: [receiverId],
  });
  return res.rows;
}

export async function markDelivered(receiverId) {
  await db.execute({
    sql: `UPDATE messages SET delivered = 1 WHERE receiver_id = ? AND delivered = 0`,
    args: [receiverId],
  });
}
