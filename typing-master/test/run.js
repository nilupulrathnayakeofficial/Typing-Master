'use strict';
// End-to-end tests. Starts the real server on a spare port with a throwaway database.
// Run with: npm test
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../lib/auth');

const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
// Throwaway owner for the test server only. The real owner login lives in .env and never appears in code.
const OWNER = { email: 'test-owner@example.com', password: 'test-owner-pass-1' };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra !== undefined ? '  ->  ' + JSON.stringify(extra) : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body, cookie, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch { /* none */ }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, json, cookie: sc ? sc.split(';')[0] : null, setCookie: sc };
}

function wsClient(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie } });
    const inbox = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      inbox.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].t === m.t) waiters.splice(i, 1)[0].resolve(m);
    };
    ws.onopen = () => resolve({
      send: (o) => ws.send(JSON.stringify(o)),
      next: (t, ms = 15000) => new Promise((res, rej) => {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), ms);
        waiters.push({ t, resolve: (m) => { clearTimeout(timer); const j = inbox.indexOf(m); if (j >= 0) inbox.splice(j, 1); res(m); } });
      }),
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('ws error'));
  });
}

async function googleTests() {
  console.log('\nGoogle token verification');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const keys = async () => [jwk];
  const CLIENT = 'client-123.apps.googleusercontent.com';
  const make = (over = {}, signWith = privateKey) => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      iss: 'https://accounts.google.com', aud: CLIENT, sub: '1234', email: 'a@b.com', email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 600, ...over,
    })).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signWith).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  const bad = async (token) => { try { await auth.verifyGoogleIdToken(token, CLIENT, keys); return false; } catch { return true; } };

  const good = await auth.verifyGoogleIdToken(make(), CLIENT, keys);
  check('accepts a valid token', good.email === 'a@b.com');
  check('rejects wrong audience', await bad(make({ aud: 'someone-else' })));
  check('rejects expired token', await bad(make({ exp: Math.floor(Date.now() / 1000) - 10 })));
  check('rejects wrong issuer', await bad(make({ iss: 'https://evil.example' })));
  check('rejects unverified email', await bad(make({ email_verified: false })));
  check('rejects a token signed with another key', await bad(make({}, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)));
  const t = make().split('.');
  t[1] = Buffer.from(JSON.stringify({ iss: 'accounts.google.com', aud: CLIENT, sub: '1', email: 'owner@x.com', email_verified: true, exp: 9999999999 })).toString('base64url');
  check('rejects a tampered payload', await bad(t.join('.')));
}

async function main() {
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, OWNER_EMAIL: OWNER.email, OWNER_PASSWORD: OWNER.password, GOOGLE_CLIENT_ID: '', TRUST_PROXY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/api/config`); break; } catch { await sleep(100); } }

    console.log('Basics');
    const cfg = await call('GET', '/api/config');
    check('config endpoint answers', cfg.status === 200 && cfg.json.googleClientId === null);
    const page = await fetch(BASE + '/');
    const html = await page.text();
    check('home page is served', page.status === 200 && html.includes('Typing Master'));
    check('CSP header is set', (page.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
    const trav = await fetch(BASE + '/..%2f..%2fetc%2fpasswd');
    check('path traversal is blocked', trav.status === 403 || trav.status === 404);
    const w = await call('GET', '/api/words');
    check('word list is served', Array.isArray(w.json.words) && w.json.words.length > 100);

    console.log('\nSign up and log in');
    const noConsent = await call('POST', '/api/signup', { username: 'alice', email: 'alice@example.com', password: 'password123' });
    check('sign-up needs the consent box', noConsent.status === 400);
    const weak = await call('POST', '/api/signup', { username: 'alice', email: 'alice@example.com', password: 'short', consent: true });
    check('short password is refused', weak.status === 400);
    const badName = await call('POST', '/api/signup', { username: 'a b', email: 'alice@example.com', password: 'password123', consent: true });
    check('bad username is refused', badName.status === 400);
    const alice = await call('POST', '/api/signup', { username: 'alice', email: 'alice@example.com', password: 'password123', consent: true });
    check('alice signs up', alice.status === 201 && !!alice.cookie);
    check('session cookie is HttpOnly + SameSite', /HttpOnly/.test(alice.setCookie) && /SameSite=Lax/.test(alice.setCookie));
    const dupMail = await call('POST', '/api/signup', { username: 'alice2', email: 'ALICE@example.com', password: 'password123', consent: true });
    check('duplicate email is refused', dupMail.status === 409);
    const dupName = await call('POST', '/api/signup', { username: 'Alice', email: 'other@example.com', password: 'password123', consent: true });
    check('duplicate username is refused (any case)', dupName.status === 409);
    const bob = await call('POST', '/api/signup', { username: 'bob', email: 'bob@example.com', password: 'password123', consent: true });
    check('bob signs up', bob.status === 201);
    const wrong = await call('POST', '/api/login', { identifier: 'alice', password: 'nope-nope' });
    check('wrong password is refused', wrong.status === 401);
    const byUser = await call('POST', '/api/login', { identifier: 'alice', password: 'password123' });
    const byMail = await call('POST', '/api/login', { identifier: 'alice@example.com', password: 'password123' });
    check('login works by username and by email', byUser.status === 200 && byMail.status === 200);
    const me = await call('GET', '/api/me', null, alice.cookie);
    check('/api/me returns the member', me.json.user && me.json.user.username === 'alice' && me.json.user.role === 'member');
    check('/api/me does not leak the password hash', !JSON.stringify(me.json).includes('scrypt'));
    const evil = await call('POST', '/api/login', { identifier: 'alice', password: 'password123' }, null, { Origin: 'https://evil.example' });
    check('cross-site POST is blocked', evil.status === 403);
    const forged = await call('GET', '/api/me', null, 'tm_session=aaa.bbb.ccc');
    check('forged session cookie is refused', forged.status === 401);

    console.log('\nOwner account and dashboard');
    const owner = await call('POST', '/api/login', { identifier: OWNER.email, password: OWNER.password });
    check('owner logs in with the email and password', owner.status === 200 && owner.json.user.role === 'owner');
    const ownerBad = await call('POST', '/api/login', { identifier: OWNER.email, password: 'test-owner-pass-2' });
    check('owner password must match exactly', ownerBad.status === 401);
    const asAnon = await call('GET', '/api/admin/members');
    const asMember = await call('GET', '/api/admin/members', null, alice.cookie);
    check('anonymous visitors cannot open the dashboard', asAnon.status === 401);
    check('ordinary members cannot open the dashboard', asMember.status === 403);
    const asMemberOv = await call('GET', '/api/admin/overview', null, bob.cookie);
    check('members cannot read the overview either', asMemberOv.status === 403);
    const list = await call('GET', '/api/admin/members', null, owner.cookie);
    const a = (list.json.members || []).find((m) => m.username === 'alice');
    check('owner sees members', list.status === 200 && list.json.members.length === 3);
    check('owner sees IP addresses', a && a.signup_ip === '127.0.0.1' && a.last_ip === '127.0.0.1', a && [a.signup_ip, a.last_ip]);
    const logins = await call('GET', `/api/admin/members/${a.id}/logins`, null, owner.cookie);
    check('owner sees login history with IPs', logins.json.logins && logins.json.logins.length >= 3 && logins.json.logins[0].ip === '127.0.0.1');

    console.log('\nScores and leaderboard');
    const s1 = await call('POST', '/api/scores', { wpm: 72.4, accuracy: 96, duration: 30 }, alice.cookie);
    const s2 = await call('POST', '/api/scores', { wpm: 55, accuracy: 91, duration: 60 }, bob.cookie);
    check('valid scores are saved', s1.status === 201 && s2.status === 201);
    const cheat1 = await call('POST', '/api/scores', { wpm: 999, accuracy: 100, duration: 30 }, alice.cookie);
    const cheat2 = await call('POST', '/api/scores', { wpm: 50, accuracy: 100, duration: 7 }, alice.cookie);
    check('impossible scores are refused', cheat1.status === 400 && cheat2.status === 400);
    const lb = await call('GET', '/api/leaderboard?period=all', null, alice.cookie);
    check('leaderboard is ranked by WPM', lb.json.rows[0].username === 'alice' && Math.round(lb.json.rows[0].wpm) === 72);
    check('leaderboard hides emails and IPs', !JSON.stringify(lb.json).match(/example\.com|127\.0\.0\.1/));
    const members2 = await call('GET', '/api/admin/members', null, owner.cookie);
    const a2 = members2.json.members.find((m) => m.username === 'alice');
    check('dashboard shows each member\'s best speed', Math.round(a2.best) === 72 && a2.tests === 1);

    console.log('\nMultiplayer race');
    const unauth = await new Promise((res) => { const w2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); w2.onerror = () => res(true); w2.onopen = () => { w2.close(); res(false); }; });
    check('socket without login is refused', unauth);
    const wa = await wsClient(alice.cookie);
    const wb = await wsClient(bob.cookie);
    wa.send({ t: 'create' });
    const room = await wa.next('room');
    check('alice creates a room with a 5-character code', /^[A-Z2-9]{5}$/.test(room.code) && room.hostId === me.json.user.id);
    wb.send({ t: 'join', code: 'ZZZZZ' });
    check('bad room code gives an error', (await wb.next('error')).msg.includes('No room'));
    wb.send({ t: 'join', code: room.code.toLowerCase() });
    const roomB = await wb.next('room');
    check('bob joins with the code', roomB.players.length === 2);
    wb.send({ t: 'start' });
    check('only the host can start', (await wb.next('error')).msg.includes('host'));
    wa.send({ t: 'start' });
    await wa.next('countdown');
    const go = await wa.next('go');
    await wb.next('go');
    check('everyone gets the same text', go.text.split(' ').length === 35);
    const len = go.text.length;
    const raceStart = Date.now();

    wb.send({ t: 'progress', chars: 999 });
    wa.send({ t: 'progress', chars: Math.floor(len / 2) });
    const prog = await wb.next('progress');
    const pb = prog.players.find((p) => p.id === roomB.players.find((x) => x.name === 'bob').id);
    check('impossible progress is clamped', pb.progress < 40, pb.progress);
    wb.send({ t: 'finish', chars: len, keys: len, okKeys: len }); // far too fast: must be rejected
    check('superhuman finish is rejected', (await wb.next('error')).msg.includes('not accepted'));

    const minMs = Math.ceil((len / 5 / 300) * 60000) + 800;
    await sleep(Math.max(0, minMs - (Date.now() - raceStart)));
    wa.send({ t: 'finish', chars: len, keys: len + 4, okKeys: len });
    const res = await wa.next('results', 20000);
    check('race ends when everyone has finished', res.results.length === 2);
    check('alice ranks first, finished, with sane WPM', res.results[0].name === 'alice' && res.results[0].finished && res.results[0].wpm > 0 && res.results[0].wpm <= 300, res.results[0]);
    check('rejected finisher is not ranked as finished', res.results[1].name === 'bob' && !res.results[1].finished);
    const stats = await call('GET', '/api/me/stats', null, alice.cookie);
    check('race result is saved to alice\'s scores', stats.json.recent.some((r) => r.mode === 'race'));
    const statsB = await call('GET', '/api/me/stats', null, bob.cookie);
    check('rejected race result is not saved for bob', !statsB.json.recent.some((r) => r.mode === 'race'));
    const ov = await call('GET', '/api/admin/overview', null, owner.cookie);
    check('owner overview counts online members and races', ov.json.online === 2 && ov.json.races >= 1, ov.json);
    wa.close(); wb.close();

    console.log('\nSuspending a member');
    const ban = await call('POST', `/api/admin/members/${a.id}/ban`, { banned: true }, owner.cookie);
    check('owner can suspend a member', ban.status === 200);
    check('suspended member is logged out', (await call('GET', '/api/me', null, alice.cookie)).status === 401);
    check('suspended member cannot log in', (await call('POST', '/api/login', { identifier: 'alice', password: 'password123' })).status === 403);
    const ownerId = list.json.members.find((m) => m.role === 'owner').id;
    check('owner cannot be suspended', (await call('POST', `/api/admin/members/${ownerId}/ban`, { banned: true }, owner.cookie)).status === 400);
    const memberBan = await call('POST', `/api/admin/members/${a.id}/ban`, { banned: false }, bob.cookie);
    check('members cannot suspend anyone', memberBan.status === 403);

    console.log('\nGoogle login (not configured here)');
    const g = await call('POST', '/api/google', { credential: 'x' });
    check('Google endpoint says it is not set up', g.status === 501);
    await googleTests();

    console.log('\nLogin throttling');
    let last;
    for (let i = 0; i < 9; i++) last = await call('POST', '/api/login', { identifier: 'bob', password: 'wrong-' + i });
    check('repeated wrong passwords are throttled', last.status === 429, last.status);
  } catch (err) {
    failed++;
    console.log('  FAIL test crashed:', err.message);
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('\nServer log:\n' + log);
  process.exit(failed ? 1 : 0);
}

main();
