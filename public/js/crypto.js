/* ============================================================
   BlueChat — end-to-end encryption for chat messages.
   ECDH (P-256) key agreement + AES-GCM. The server only ever
   sees ciphertext; keys never leave the browser.
   ============================================================ */
'use strict';

const E2EE = (window.E2EE = {
  myPriv: null,      // CryptoKey (ECDH private)
  myPubJwk: null,    // JWK object (public) — published to the server
  aesCache: new Map(), // otherUserId -> derived AES-GCM CryptoKey

  async init(username) {
    const store = 'bc_keys_' + username;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(store)); } catch {}
    if (saved && saved.priv && saved.pub) {
      this.myPriv = await crypto.subtle.importKey('jwk', saved.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
      this.myPubJwk = saved.pub;
    } else {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
      const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
      const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
      this.myPubJwk = pub;
      this.myPriv = await crypto.subtle.importKey('jwk', priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
      try { localStorage.setItem(store, JSON.stringify({ priv, pub })); } catch {}
    }
    return this.myPubJwk;
  },

  // Derive (and cache) the shared AES key with another user from their public JWK.
  async deriveAes(userId, theirPubJwk) {
    if (this.aesCache.has(userId)) return this.aesCache.get(userId);
    if (!theirPubJwk || !this.myPriv) return null;
    const pub = typeof theirPubJwk === 'string' ? JSON.parse(theirPubJwk) : theirPubJwk;
    const theirPub = await crypto.subtle.importKey('jwk', pub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const aes = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPub },
      this.myPriv,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    this.aesCache.set(userId, aes);
    return aes;
  },

  async encrypt(aes, text) {
    if (!aes) return text; // fall back to plaintext if we have no key
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(text));
    return 'e2:' + b64(iv) + ':' + b64(new Uint8Array(ct));
  },

  async decrypt(aes, payload) {
    if (typeof payload !== 'string' || !payload.startsWith('e2:')) return payload; // legacy plaintext
    if (!aes) return '🔒 Encrypted message';
    try {
      const [, ivb, ctb] = payload.split(':');
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(ivb) }, aes, ub64(ctb));
      return new TextDecoder().decode(pt);
    } catch {
      return '🔒 Unable to decrypt';
    }
  },
});

function b64(u8) { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); }
function ub64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }
