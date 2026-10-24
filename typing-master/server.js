'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('./lib/env')(path.join(__dirname, '.env'));

const { openDb } = require('./lib/db');
const auth = require('./lib/auth');
const { attach } = require('./lib/ws');
const { createRaceHub } = require('./lib/race');
const { words } = require('./lib/words');

/* ---------- config ---------- */
const PORT = Number(process.env.PORT) || 3000;
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'typing.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'tm_session';
const WEEK = 7 * 24 * 3600;

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* create below */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();
const db = openDb(DB_FILE);
const hub = createRaceHub({ db });
const online = new Map(); // userId -> open socket count

/* ---------- helpers ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: https:",
    "connect-src 'self' ws: wss: https://accounts.google.com",
    'frame-src https://accounts.google.com',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
}

function json(res, status, body, headers) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20000) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ }
  }
  return out;
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return ip.replace(/^::ffff:/, '').slice(0, 64);
}

function isSecure(req) {
  return COOKIE_SECURE || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}

function sessionCookie(req, userId) {
  const token = auth.signToken({ uid: userId }, SECRET, WEEK);
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${WEEK}${isSecure(req) ? '; Secure' : ''}`;
}
const clearCookie = (req) => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isSecure(req) ? '; Secure' : ''}`;

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const payload = auth.verifyToken(token, SECRET);
  if (!payload) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  return user && !user.banned ? user : null;
}

const publicUser = (u) => ({
  id: u.id, username: u.username, email: u.email, role: u.role,
  avatar: u.avatar || null, createdAt: u.created_at,
});

// Small in-memory rate limiter: returns true when the key has used up its allowance.
const hits = new Map();
function tooMany(key, max, windowMs, record = true) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  const blocked = list.length >= max;
  if (!blocked && record) list.push(now);
  hits.set(key, list);
  return blocked;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some((t) => now - t < 3600000)) hits.delete(k);
}, 600000).unref();

function uniqueUsername(base) {
  let name = String(base || 'player').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  if (name.length < 3) name = (name + 'typist').slice(0, 16);
  let candidate = name;
  let n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) candidate = `${name}${++n}`;
  return candidate;
}

function logLogin(userId, ip, method, req) {
  const now = Date.now();
  db.prepare('INSERT INTO logins (user_id, ip, method, user_agent, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, ip, method, String(req.headers['user-agent'] || '').slice(0, 200), now);
  db.prepare('UPDATE users SET last_ip = ?, last_seen = ? WHERE id = ?').run(ip, now, userId);
}

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/* ---------- owner account ---------- */
async function seedOwner() {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) {
    console.warn('OWNER_EMAIL / OWNER_PASSWORD are not set, so no owner account was created.');
    return;
  }
  const now = Date.now();
  const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(OWNER_EMAIL);
  if (!row) {
    const hash = await auth.hashPassword(OWNER_PASSWORD);
    db.prepare('INSERT INTO users (username, email, password_hash, role, created_at, consent_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uniqueUsername('Nilupul'), OWNER_EMAIL, hash, 'owner', now, now);
  } else {
    if (!(await auth.verifyPassword(OWNER_PASSWORD, row.password_hash))) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await auth.hashPassword(OWNER_PASSWORD), row.id);
    }
    db.prepare("UPDATE users SET role = 'owner', banned = 0 WHERE id = ?").run(row.id);
  }
  db.prepare("UPDATE users SET role = 'member' WHERE role = 'owner' AND email <> ?").run(OWNER_EMAIL);
}

/* ---------- API ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;

async function api(req, res, url) {
  const ip = clientIp(req);
  const route = `${req.method} ${url.pathname}`;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
      if (!ok) throw new HttpError(403, 'Request blocked.');
    }
  }

  if (route === 'GET /api/config') return json(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null });
  if (route === 'GET /api/words') return json(res, 200, { words });

  if (route === 'POST /api/signup') {
    if (tooMany(`signup:${ip}`, 10, 3600000)) throw new HttpError(429, 'Too many sign-ups from this network. Try again later.');
    const b = await readJson(req);
    const username = String(b.username || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!USER_RE.test(username)) throw new HttpError(400, 'Username must be 3 to 20 letters, numbers or underscores.');
    if (!EMAIL_RE.test(email) || email.length > 120) throw new HttpError(400, 'Enter a valid email address.');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8 to 128 characters.');
    if (b.consent !== true) throw new HttpError(400, 'Tick the box to confirm you understand what we record.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already registered. Try logging in.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');
    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO users (username, email, password_hash, signup_ip, last_ip, consent_at, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(username, email, await auth.hashPassword(password), ip, ip, now, now, now);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    logLogin(user.id, ip, 'signup', req);
    return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, user.id) });
  }

  if (route === 'POST /api/login') {
    const b = await readJson(req);
    const id = String(b.identifier || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!id || !password) throw new HttpError(400, 'Enter your email or username and your password.');
    if (tooMany(`fail-ip:${ip}`, 30, 900000, false) || tooMany(`fail-id:${id}`, 8, 900000, false)) {
      throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(id, id);
    const ok = user && (await auth.verifyPassword(password, user.password_hash));
    if (!ok) {
      tooMany(`fail-ip:${ip}`, 1e9, 900000);
      tooMany(`fail-id:${id}`, 1e9, 900000);
      throw new HttpError(401, 'Wrong email, username or password.');
    }
    if (user.banned) throw new HttpError(403, 'This account has been suspended.');
    logLogin(user.id, ip, 'password', req);
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, user.id) });
  }

  if (route === 'POST /api/google') {
    if (!GOOGLE_CLIENT_ID) throw new HttpError(501, 'Google login is not set up on this site yet.');
    if (tooMany(`google:${ip}`, 30, 900000)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const b = await readJson(req);
    let g;
    try { g = await auth.verifyGoogleIdToken(b.credential, GOOGLE_CLIENT_ID); }
    catch { throw new HttpError(401, 'Google could not confirm your sign-in. Try again.'); }

    const email = g.email.toLowerCase();
    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(g.sub) || db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const now = Date.now();
    if (!user) {
      if (b.consent !== true) throw new HttpError(400, 'Tick the box to confirm you understand what we record, then continue with Google.', 'consent');
      const info = db.prepare(
        'INSERT INTO users (username, email, google_id, avatar, signup_ip, last_ip, consent_at, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(uniqueUsername(g.given_name || g.name || email.split('@')[0]), email, g.sub, g.picture || null, ip, ip, now, now, now);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else if (!user.google_id) {
      // Only the owner's pre-created account may be linked automatically; other password accounts are not hijackable.
      if (user.role !== 'owner') throw new HttpError(409, 'This email already has a password account. Log in with your password instead.');
      db.prepare('UPDATE users SET google_id = ?, avatar = COALESCE(avatar, ?) WHERE id = ?').run(g.sub, g.picture || null, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    } else if (g.picture && g.picture !== user.avatar) {
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(g.picture, user.id);
      user.avatar = g.picture;
    }
    if (user.banned) throw new HttpError(403, 'This account has been suspended.');
    logLogin(user.id, ip, 'google', req);
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, user.id) });
  }

  if (route === 'POST /api/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) });

  const me = currentUser(req);

  if (route === 'GET /api/me') {
    if (!me) throw new HttpError(401, 'Not logged in.');
    db.prepare('UPDATE users SET last_ip = ?, last_seen = ? WHERE id = ?').run(ip, Date.now(), me.id);
    return json(res, 200, { user: publicUser(me) });
  }

  if (!me) throw new HttpError(401, 'Please log in first.');

  if (route === 'POST /api/scores') {
    if (tooMany(`score:${me.id}`, 12, 60000)) throw new HttpError(429, 'Slow down a little.');
    const b = await readJson(req);
    const wpm = Number(b.wpm), accuracy = Number(b.accuracy), duration = Number(b.duration);
    if (!Number.isFinite(wpm) || wpm < 0 || wpm > 300) throw new HttpError(400, 'That score was not accepted.');
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) throw new HttpError(400, 'That score was not accepted.');
    if (![15, 30, 60].includes(duration)) throw new HttpError(400, 'That score was not accepted.');
    db.prepare('INSERT INTO scores (user_id, wpm, accuracy, duration, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(me.id, Math.round(wpm * 10) / 10, Math.round(accuracy * 10) / 10, duration, 'solo', Date.now());
    return json(res, 201, { ok: true });
  }

  if (route === 'GET /api/me/stats') {
    const s = db.prepare('SELECT COUNT(*) AS tests, COALESCE(MAX(wpm),0) AS best, COALESCE(AVG(wpm),0) AS avg FROM scores WHERE user_id = ?').get(me.id);
    const recent = db.prepare('SELECT wpm, accuracy, duration, mode, created_at FROM scores WHERE user_id = ? ORDER BY id DESC LIMIT 8').all(me.id);
    return json(res, 200, { tests: s.tests, best: s.best, avg: s.avg, recent });
  }

  if (route === 'GET /api/leaderboard') {
    const period = url.searchParams.get('period');
    const since = period === 'day' ? Date.now() - 86400000 : period === 'week' ? Date.now() - 7 * 86400000 : 0;
    const rows = db.prepare(`
      SELECT u.username, u.avatar, MAX(s.wpm) AS wpm,
             (SELECT accuracy FROM scores x WHERE x.user_id = u.id AND x.created_at >= ? ORDER BY x.wpm DESC LIMIT 1) AS accuracy,
             COUNT(*) AS tests
      FROM scores s JOIN users u ON u.id = s.user_id
      WHERE s.created_at >= ? AND u.banned = 0
      GROUP BY u.id ORDER BY wpm DESC LIMIT 25`).all(since, since);
    return json(res, 200, { rows, me: me.username });
  }

  /* ----- owner only ----- */
  if (url.pathname.startsWith('/api/admin/')) {
    if (me.role !== 'owner') throw new HttpError(403, 'Only the owner can see this.');

    if (route === 'GET /api/admin/overview') {
      const day = Date.now() - 86400000;
      const u = db.prepare('SELECT COUNT(*) AS members, SUM(created_at >= ?) AS newToday FROM users').get(day);
      const s = db.prepare("SELECT COUNT(*) AS tests, COALESCE(AVG(wpm),0) AS avg, COALESCE(SUM(mode = 'race'),0) AS races FROM scores").get();
      return json(res, 200, { members: u.members, newToday: u.newToday || 0, tests: s.tests, races: s.races, avgWpm: s.avg, online: online.size, rooms: hub.roomCount() });
    }

    if (route === 'GET /api/admin/members') {
      const rows = db.prepare(`
        SELECT u.id, u.username, u.email, u.role, u.banned, u.avatar,
               (u.google_id IS NOT NULL) AS google, (u.password_hash IS NOT NULL) AS hasPassword,
               u.signup_ip, u.last_ip, u.created_at, u.last_seen,
               COUNT(s.id) AS tests, COALESCE(MAX(s.wpm), 0) AS best, COALESCE(AVG(s.wpm), 0) AS avg,
               (SELECT wpm FROM scores WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS lastWpm
        FROM users u LEFT JOIN scores s ON s.user_id = u.id
        GROUP BY u.id ORDER BY u.created_at DESC`).all();
      return json(res, 200, { members: rows.map((r) => ({ ...r, banned: !!r.banned, google: !!r.google, hasPassword: !!r.hasPassword, online: online.has(r.id) })) });
    }

    let m = /^\/api\/admin\/members\/(\d+)\/logins$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const rows = db.prepare('SELECT ip, method, user_agent AS agent, created_at AS at FROM logins WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(Number(m[1]));
      return json(res, 200, { logins: rows });
    }

    m = /^\/api\/admin\/members\/(\d+)\/ban$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      const b = await readJson(req);
      const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(m[1]));
      if (!target) throw new HttpError(404, 'Member not found.');
      if (target.role === 'owner') throw new HttpError(400, 'The owner account cannot be suspended.');
      db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(b.banned ? 1 : 0, target.id);
      return json(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

/* ---------- static files ---------- */
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (err) {
      if (!(err instanceof HttpError) && !err.status) console.error(err);
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong on our side.', code: err.code });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});

attach(server, {
  path: '/ws',
  verify(req) {
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return null; } catch { return null; }
    }
    return currentUser(req);
  },
  onConnection(conn, user, req) {
    const ip = clientIp(req);
    db.prepare('UPDATE users SET last_ip = ?, last_seen = ? WHERE id = ?').run(ip, Date.now(), user.id);
    online.set(user.id, (online.get(user.id) || 0) + 1);

    let count = 0;
    const reset = setInterval(() => { count = 0; }, 1000);
    conn.on('message', (text) => {
      if (++count > 60) return conn.terminate();
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      try { hub.handle(conn, user, msg); } catch (err) { console.error('race error', err); }
    });
    conn.on('close', () => {
      clearInterval(reset);
      hub.disconnect(conn);
      const n = (online.get(user.id) || 1) - 1;
      if (n <= 0) online.delete(user.id); else online.set(user.id, n);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), user.id);
    });
    conn.send({ t: 'hello' });
  },
});

seedOwner().then(() => {
  server.listen(PORT, () => {
    console.log(`Typing Master is running at http://localhost:${PORT}`);
    console.log(`Database: ${DB_FILE}`);
    console.log(GOOGLE_CLIENT_ID ? 'Google login: on' : 'Google login: off (set GOOGLE_CLIENT_ID in .env)');
  });
});

module.exports = { server };
