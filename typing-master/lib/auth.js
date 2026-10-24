'use strict';
const crypto = require('crypto');

/* ---------- passwords (scrypt) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (pw, salt, len, opts) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/* ---------- session tokens (HS256 JWT) ---------- */
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function signToken(payload, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iat: now, exp: now + ttlSec });
  return `${head}.${body}.${hmac(`${head}.${body}`, secret)}`;
}

function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(hmac(`${parts[0]}.${parts[1]}`, secret));
  const got = Buffer.from(parts[2]);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

/* ---------- Google sign-in (ID token verification, no libraries) ---------- */
let keyCache = { keys: null, expires: 0 };

async function fetchGoogleKeys() {
  if (keyCache.keys && Date.now() < keyCache.expires) return keyCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error('Could not load Google signing keys');
  const json = await res.json();
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  keyCache = { keys: json.keys, expires: Date.now() + (m ? Number(m[1]) : 3600) * 1000 };
  return json.keys;
}

// Verifies signature, issuer, audience, expiry and email_verified. `getKeys` is injectable for tests.
async function verifyGoogleIdToken(idToken, clientId, getKeys = fetchGoogleKeys) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Unsupported algorithm');

  const jwk = (await getKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) throw new Error('Bad signature');
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw new Error('Bad issuer');
  if (payload.aud !== clientId) throw new Error('Wrong audience');
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  if (!payload.sub || !payload.email || payload.email_verified !== true) throw new Error('Email not verified');
  return payload;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, verifyGoogleIdToken };
