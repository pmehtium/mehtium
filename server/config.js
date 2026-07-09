import dotenv from 'dotenv';
dotenv.config();

function list(value, sep = ',') {
  return (value || '')
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',

  databaseUrl: process.env.DATABASE_URL || 'file:data/bluechat.db',
  databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || undefined,

  // Valid registration phrases (pipe-separated in env).
  secretPhrases: list(process.env.SECRET_PHRASES, '|'),

  stunUrls: list(process.env.STUN_URLS).length
    ? list(process.env.STUN_URLS)
    : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],

  turnUrls: list(process.env.TURN_URLS),
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
};

// Normalize a phrase so "Copper  Lantern " === "copper lantern".
export function normalizePhrase(p) {
  return (p || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Build the ICE server list sent to the browser.
export function iceServers() {
  const servers = [{ urls: config.stunUrls }];
  if (config.turnUrls.length && config.turnUsername) {
    servers.push({
      urls: config.turnUrls,
      username: config.turnUsername,
      credential: config.turnCredential,
    });
  }
  return servers;
}
