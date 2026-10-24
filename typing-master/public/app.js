'use strict';
/* Nilupul Rathnayake Typing Master: front end (no build step) */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const S = { me: null, cfg: {}, ws: null, wsQueue: [], onWs: null, words: null, destroy: null, hashBound: false };

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status, code: data.code });
  return data;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(ts).toLocaleDateString();
}

function avatar(u, big) {
  const cls = big ? 'av lg' : 'av';
  if (u.avatar) return `<img class="${cls}" src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer">`;
  return `<span class="${cls}" aria-hidden="true">${esc(String(u.username || u.name || '?').slice(0, 2).toUpperCase())}</span>`;
}

let toastTimer = null;
function toast(msg) {
  $('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

async function ensureWords() {
  if (!S.words) S.words = (await api('GET', '/api/words')).words;
  return S.words;
}
const pickWords = (n) => Array.from({ length: n }, () => S.words[Math.floor(Math.random() * S.words.length)]);

/* ================= WebSocket ================= */
function connectWs() {
  if (S.ws) return;
  let retry = 0;
  const open = () => {
    if (!S.me) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      retry = 0;
      const q = S.wsQueue; S.wsQueue = [];
      q.forEach((fn) => fn());
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (S.onWs) S.onWs(m);
    };
    ws.onclose = () => {
      S.ws = null;
      if (S.onWs) S.onWs({ t: '_closed' });
      if (S.me) setTimeout(open, Math.min(1000 * 2 ** retry++, 10000));
    };
  };
  open();
}
const wsSend = (o) => (S.ws && S.ws.readyState === 1 ? (S.ws.send(JSON.stringify(o)), true) : false);
const whenWs = (fn) => { if (S.ws && S.ws.readyState === 1) fn(); else S.wsQueue.push(fn); };

/* ================= Sign in ================= */
function showAuth() {
  if (S.destroy) S.destroy();
  S.destroy = null; S.onWs = null;
  let mode = 'login';
  $('#app').innerHTML = `
    <div class="auth">
      <section class="auth-hero">
        <div class="brand"><span class="mark">T</span><span><b>Typing Master</b><small>Nilupul Rathnayake</small></span></div>
        <h1>How fast are your fingers?</h1>
        <p>Take a timed typing test, then race friends in a live room. Your best scores go on the leaderboard.</p>
        <div class="demo" aria-hidden="true">
          <div class="lane"><span class="lname">Kasun</span><div class="track"><div class="nib" style="--to:92%;--t:3.4s">KA</div></div><span></span></div>
          <div class="lane me"><span class="lname">You</span><div class="track"><div class="nib" style="--to:78%;--t:3.4s">YO</div></div><span></span></div>
          <div class="lane"><span class="lname">Ama</span><div class="track"><div class="nib" style="--to:61%;--t:3.4s">AM</div></div><span></span></div>
        </div>
      </section>
      <section class="auth-side">
        <div class="auth-card">
          <h2 id="authTitle"></h2>
          <div class="tabs" role="tablist">
            <button role="tab" data-m="login" id="tabLogin">Log in</button>
            <button role="tab" data-m="signup" id="tabSignup">Sign up</button>
          </div>
          <div id="authErr" class="err" role="alert" hidden></div>
          <form id="authForm" novalidate></form>
          <div class="or">or</div>
          <label class="check" id="consentRow" hidden>
            <input type="checkbox" id="consent">
            <span>I understand this site records my IP address, login times and typing scores, and the site owner can see them.</span>
          </label>
          <div id="gbtn"></div>
        </div>
      </section>
    </div>`;

  const err = (m) => { const e = $('#authErr'); e.textContent = m || ''; e.hidden = !m; };

  function renderForm() {
    $('#authTitle').textContent = mode === 'login' ? 'Welcome back' : 'Create your account';
    $('#tabLogin').setAttribute('aria-selected', mode === 'login');
    $('#tabSignup').setAttribute('aria-selected', mode === 'signup');
    $('#consentRow').hidden = mode !== 'signup';
    err('');
    $('#authForm').innerHTML = mode === 'login'
      ? `<label class="field">Email or username<input class="input" name="identifier" autocomplete="username" required></label>
         <label class="field">Password<input class="input" type="password" name="password" autocomplete="current-password" required></label>
         <button class="btn wide" type="submit">Log in</button>`
      : `<label class="field">Username<input class="input" name="username" autocomplete="username" minlength="3" maxlength="20" required></label>
         <label class="field">Email<input class="input" type="email" name="email" autocomplete="email" required></label>
         <label class="field">Password<input class="input" type="password" name="password" autocomplete="new-password" minlength="8" required></label>
         <button class="btn wide" type="submit">Create account</button>`;
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.m; renderForm(); }));

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    err('');
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = mode === 'login'
        ? await api('POST', '/api/login', { identifier: f.identifier, password: f.password })
        : await api('POST', '/api/signup', { username: f.username, email: f.email, password: f.password, consent: $('#consent').checked });
      S.me = r.user;
      showApp();
    } catch (ex) { err(ex.message); btn.disabled = false; }
  });

  async function onGoogle(resp) {
    try {
      const r = await api('POST', '/api/google', { credential: resp.credential, consent: $('#consent').checked });
      S.me = r.user;
      showApp();
    } catch (ex) {
      if (ex.code === 'consent' && mode !== 'signup') { mode = 'signup'; renderForm(); }
      err(ex.message);
    }
  }

  const g = $('#gbtn');
  if (!S.cfg.googleClientId) {
    g.innerHTML = '<div><button class="btn ghost wide" disabled>Continue with Google</button><p class="muted small" style="margin-top:8px">Google login is not switched on yet. The site owner needs to add a Google client ID.</p></div>';
  } else {
    let tries = 0;
    const t = setInterval(() => {
      if (window.google && google.accounts) {
        clearInterval(t);
        google.accounts.id.initialize({ client_id: S.cfg.googleClientId, callback: onGoogle });
        google.accounts.id.renderButton(g, { theme: 'outline', size: 'large', text: 'continue_with', width: Math.min(400, Math.max(200, g.clientWidth || 320)) });
      } else if (++tries > 50) {
        clearInterval(t);
        g.innerHTML = '<p class="muted small">Google could not load. Check your connection and reload.</p>';
      }
    }, 200);
  }
  renderForm();
}

/* ================= App shell ================= */
function showApp() {
  const owner = S.me.role === 'owner';
  $('#app').innerHTML = `
    <header class="top">
      <a class="brand" href="#practice"><span class="mark">T</span><span><b>Typing Master</b><small>Nilupul Rathnayake</small></span></a>
      <nav class="nav" aria-label="Main">
        <a href="#practice" data-v="practice">Practice</a>
        <a href="#race" data-v="race">Race</a>
        <a href="#board" data-v="board">Leaderboard</a>
        ${owner ? '<a href="#admin" data-v="admin">Members</a>' : ''}
      </nav>
      <div class="who">${avatar(S.me, true)}<span id="who-name">${esc(S.me.username)}</span><button class="btn ghost sm" id="logout">Log out</button></div>
    </header>
    <main id="main"></main>`;
  $('#logout').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch { /* ignore */ }
    if (S.destroy) S.destroy();
    S.destroy = null; S.me = null;
    if (S.ws) S.ws.close();
    showAuth();
  });
  connectWs();
  if (!S.hashBound) { window.addEventListener('hashchange', route); S.hashBound = true; }
  route();
}

function route() {
  if (!S.me) return;
  const [name, arg] = (location.hash.slice(1) || 'practice').split('/');
  const views = { practice: practiceView, race: raceView, board: boardView, admin: adminView };
  if (!views[name] || (name === 'admin' && S.me.role !== 'owner')) { location.hash = '#practice'; return; }
  if (S.destroy) S.destroy();
  S.destroy = null; S.onWs = null; S.wsQueue = [];
  const main = $('#main');
  main.innerHTML = '';
  main.className = name === 'admin' ? 'wide' : '';
  $$('.nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.v === name ? 'page' : 'false'));
  S.destroy = views[name](main, arg) || null;
}

/* ================= Typing sheet (shared by practice and races) ================= */
function createSheet(host, text, o = {}) {
  const words = text.split(' ');
  const typed = words.map(() => '');
  let cur = 0, okChars = 0, keys = 0, okKeys = 0, started = false, done = false, prevNow = null;

  host.innerHTML = `<div class="sheet nf"><div class="words"><div class="caret idle"></div>${
    words.map((w) => `<div class="wd">${[...w].map((c) => `<span class="l">${esc(c)}</span>`).join('')}</div>`).join('')
  }</div><div class="fhint">Click here and start typing</div><input class="hid" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Typing input"></div>`;
  const sheet = host.firstElementChild;
  const wEl = $('.words', sheet), caret = $('.caret', sheet), inp = $('.hid', sheet);
  const els = $$('.wd', wEl);

  const curOk = () => { const w = words[cur], t = typed[cur]; let c = 0; for (let j = 0; j < t.length && j < w.length; j++) if (t[j] === w[j]) c++; return c; };
  const stats = () => ({ chars: okChars + curOk(), keys, okKeys, words: cur, started, done });

  function paint(i) {
    const w = words[i], t = typed[i];
    let h = '';
    for (let j = 0; j < w.length; j++) {
      let c = 'l';
      if (j < t.length) c += t[j] === w[j] ? ' c' : ' bad';
      h += `<span class="${c}">${esc(w[j])}</span>`;
    }
    for (let k = w.length; k < t.length; k++) h += `<span class="l x">${esc(t[k])}</span>`;
    els[i].innerHTML = h;
    els[i].classList.toggle('err', i < cur && t !== w);
  }
  function place() {
    const el = els[cur], kids = el.children, p = typed[cur].length;
    let x;
    if (p < kids.length) x = kids[p].offsetLeft;
    else { const last = kids[kids.length - 1]; x = last.offsetLeft + last.offsetWidth; }
    const y = el.offsetTop;
    caret.style.transform = `translate(${x}px, ${y}px)`;
    wEl.scrollTop = Math.max(y - 44, 0);
    if (prevNow !== el) { if (prevNow) prevNow.classList.remove('now'); el.classList.add('now'); prevNow = el; }
  }
  function finish() {
    if (done) return;
    done = true; inp.disabled = true; inp.blur();
    sheet.classList.remove('nf');
    if (o.onFinish) o.onFinish(stats());
  }
  function begin() {
    started = true;
    caret.classList.remove('idle');
    if (o.onStart) o.onStart();
  }
  function typeChar(ch) {
    if (done) return;
    if (ch === ' ') return space();
    if (typed[cur].length >= words[cur].length + 8) return;
    if (!started) begin();
    const p = typed[cur].length;
    typed[cur] += ch; keys++;
    if (p < words[cur].length && ch === words[cur][p]) okKeys++;
    paint(cur); place();
    if (o.onChange) o.onChange(stats());
    if (!o.endless && cur === words.length - 1 && typed[cur] === words[cur]) finish();
  }
  function space() {
    if (!typed[cur].length) return;
    const ok = typed[cur] === words[cur];
    keys++;
    if (ok) { okChars += words[cur].length + 1; okKeys++; }
    const prev = cur;
    cur++;
    paint(prev);
    if (cur >= words.length) { finish(); return; }
    paint(cur); place();
    if (o.onChange) o.onChange(stats());
  }
  function back(whole) {
    if (done) return;
    if (typed[cur].length) {
      typed[cur] = whole ? '' : typed[cur].slice(0, -1);
      paint(cur); place();
      if (o.onChange) o.onChange(stats());
    } else if (cur > 0 && typed[cur - 1] !== words[cur - 1]) {
      const old = cur; cur--; paint(old); paint(cur); place();
    }
  }

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); if (o.onTab) o.onTab(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); back(e.ctrlKey || e.altKey); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeChar(e.key); }
  });
  inp.addEventListener('input', () => { const v = inp.value; inp.value = ''; for (const ch of v) typeChar(ch); });
  inp.addEventListener('paste', (e) => e.preventDefault());
  inp.addEventListener('focus', () => sheet.classList.remove('nf'));
  inp.addEventListener('blur', () => { if (!done) sheet.classList.add('nf'); });

  els[0].classList.add('now'); prevNow = els[0];
  requestAnimationFrame(place);

  return {
    focus: () => inp.focus(),
    stats,
    stop() { if (done) return; done = true; inp.disabled = true; inp.blur(); sheet.classList.remove('nf'); },
    destroy() { done = true; },
  };
}

function lineChart(a) {
  const W = 640, H = 150, pl = 34, pr = 10, pt = 10, pb = 22, n = a.length;
  const mx = Math.max(10, ...a) * 1.15;
  const X = (i) => pl + (n > 1 ? i / (n - 1) : 0.5) * (W - pl - pr);
  const Y = (v) => pt + (1 - v / mx) * (H - pt - pb);
  let grid = '', path = '', dots = '';
  for (let k = 0; k <= 3; k++) {
    const v = (mx * k) / 3, y = Y(v).toFixed(1);
    grid += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" style="stroke:var(--rule)"/><text x="${pl - 6}" y="${+y + 4}" text-anchor="end" style="fill:var(--ink2);font-size:11px">${Math.round(v)}</text>`;
  }
  a.forEach((v, i) => {
    path += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
    dots += `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3" style="fill:var(--cobalt)"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Words per minute for each second of the test">${grid}
    <path d="${path}" fill="none" style="stroke:var(--cobalt)" stroke-width="2.5" stroke-linejoin="round"/>${dots}
    <text x="${pl}" y="${H - 4}" style="fill:var(--ink2);font-size:11px">1 s</text>
    <text x="${W - pr}" y="${H - 4}" text-anchor="end" style="fill:var(--ink2);font-size:11px">${n} s</text></svg>`;
}

/* ================= Practice ================= */
function practiceView(root) {
  let dur = Number(lsGet('tm_dur')) || 30;
  if (![15, 30, 60].includes(dur)) dur = 30;
  let sheet = null, timer = null, t0 = 0, samples = [], lastSec = 0, alive = true;

  root.innerHTML = `
    <section class="panel">
      <div class="row between wrap">
        <div class="seg" role="group" aria-label="Test length">${[15, 30, 60].map((d) => `<button data-d="${d}" aria-pressed="${d === dur}">${d} s</button>`).join('')}</div>
        <button class="btn ghost" id="again">New text <kbd>Tab</kbd></button>
      </div>
      <div id="live">
        <div class="stats3">
          <div><span>Time left</span><b id="sTime">${dur}</b></div>
          <div><span>WPM</span><b id="sWpm">0</b></div>
          <div><span>Accuracy</span><b id="sAcc">100%</b></div>
        </div>
        <div id="sheetHost"></div>
        <p class="hint">Space moves to the next word. Backspace fixes a mistake. Tab starts a new text.</p>
      </div>
      <div id="result" hidden>
        <div class="result">
          <div class="big"><b id="rWpm">0</b><small>words per minute</small></div>
          <div class="rgrid">
            <div class="cell"><span>Accuracy</span><b id="rAcc"></b></div>
            <div class="cell"><span>Raw speed</span><b id="rRaw"></b></div>
            <div class="cell"><span>Right / wrong keys</span><b id="rKeys"></b></div>
          </div>
          <div class="chart" id="rChart"></div>
        </div>
        <div class="row between wrap" style="margin-top:14px"><p class="muted" id="rSaved"></p><button class="btn" id="rAgain">Go again</button></div>
      </div>
    </section>
    <section class="strip" id="mine" aria-label="Your stats"></section>`;

  const liveWpm = (el) => Math.round(sheet.stats().chars / 5 / (Math.max(el, 1) / 60));
  const accNow = () => { const s = sheet.stats(); return s.keys ? Math.round((s.okKeys / s.keys) * 100) : 100; };

  function newTest() {
    clearInterval(timer);
    samples = []; lastSec = 0;
    if (sheet) sheet.destroy();
    $('#result').hidden = true; $('#live').hidden = false;
    $('#sTime').textContent = dur; $('#sWpm').textContent = '0'; $('#sAcc').textContent = '100%';
    sheet = createSheet($('#sheetHost'), pickWords(400).join(' '), {
      endless: true,
      onStart() { t0 = Date.now(); timer = setInterval(tick, 200); },
      onChange() { $('#sWpm').textContent = liveWpm((Date.now() - t0) / 1000); $('#sAcc').textContent = `${accNow()}%`; },
      onTab: newTest,
    });
    sheet.focus();
  }
  function tick() {
    const el = (Date.now() - t0) / 1000;
    $('#sTime').textContent = Math.max(Math.ceil(dur - el), 0);
    if (Math.floor(el) > lastSec) { lastSec = Math.floor(el); samples.push(liveWpm(el)); }
    if (el >= dur) end();
  }
  function end() {
    clearInterval(timer);
    sheet.stop();
    const st = sheet.stats(), min = dur / 60;
    const wpm = Math.round(st.chars / 5 / min), raw = Math.round(st.keys / 5 / min);
    const acc = st.keys ? Math.round((st.okKeys / st.keys) * 100) : 100;
    samples.push(wpm);
    $('#rWpm').textContent = wpm;
    $('#rAcc').textContent = `${acc}%`;
    $('#rRaw').textContent = raw;
    $('#rKeys').textContent = `${st.okKeys} / ${st.keys - st.okKeys}`;
    $('#rChart').innerHTML = lineChart(samples);
    $('#live').hidden = true; $('#result').hidden = false;
    const saved = $('#rSaved');
    if (st.keys < 5) { saved.textContent = 'Too short to count. Type for the full time to save a score.'; return; }
    saved.textContent = 'Saving your score…';
    api('POST', '/api/scores', { wpm, accuracy: acc, duration: dur })
      .then(() => { if (alive) { saved.textContent = 'Saved to your profile.'; loadStats(); } })
      .catch((e) => { if (alive) saved.textContent = e.message; });
  }
  async function loadStats() {
    try {
      const s = await api('GET', '/api/me/stats');
      if (!alive) return;
      $('#mine').innerHTML = `
        <div class="cell"><span>Your best</span><b>${Math.round(s.best)} WPM</b></div>
        <div class="cell"><span>Your average</span><b>${Math.round(s.avg)} WPM</b></div>
        <div class="cell"><span>Tests taken</span><b>${s.tests}</b></div>`;
    } catch { /* stats are optional */ }
  }

  $$('.seg button', root).forEach((b) => b.addEventListener('click', () => {
    dur = Number(b.dataset.d); lsSet('tm_dur', dur);
    $$('.seg button', root).forEach((x) => x.setAttribute('aria-pressed', x === b));
    newTest();
  }));
  $('#again').addEventListener('click', newTest);
  $('#rAgain').addEventListener('click', newTest);
  ensureWords().then(() => { if (alive) { newTest(); loadStats(); } });

  return () => { alive = false; clearInterval(timer); if (sheet) sheet.destroy(); };
}

/* ================= Race ================= */
function raceView(root, arg) {
  let room = null, phase = 'none', sheet = null, textLen = 0, flush = null, myChars = 0;
  let roomsTimer = null, cdTimer = null, alive = true, results = null, raceT0 = 0;

  root.innerHTML = '<section class="panel" id="rp"></section>';
  const rp = $('#rp');
  const connected = () => S.ws && S.ws.readyState === 1;

  /* ----- lobby ----- */
  function renderLobby() {
    clearInterval(cdTimer);
    if (sheet) { sheet.destroy(); sheet = null; }
    rp.innerHTML = `
      <h1>Race</h1>
      <p class="muted">Up to 8 players type the same text. The first to finish wins.</p>
      <div class="cards">
        <div class="card"><h2>Quick race</h2><p>Jump into an open room, or start one for others to find.</p><button class="btn" id="quick">Find a race</button></div>
        <div class="card"><h2>Race friends</h2><p>Make a private room and send the code or invite link.</p><button class="btn ghost" id="create">Create a room</button></div>
        <div class="card"><h2>Have a code?</h2>
          <form id="joinForm" class="row"><input class="input" id="code" maxlength="5" placeholder="ABCDE" autocomplete="off" aria-label="Room code" style="text-transform:uppercase;font-family:var(--mono);letter-spacing:.14em"><button class="btn" type="submit">Join</button></form>
        </div>
      </div>
      <div class="open-rooms"><h2>Open rooms</h2><ul class="plain" id="openRooms"><li class="muted">Looking for rooms…</li></ul></div>`;
    $('#quick').addEventListener('click', () => connected() ? wsSend({ t: 'quick' }) : toast('Still connecting. Try again in a moment.'));
    $('#create').addEventListener('click', () => connected() ? wsSend({ t: 'create' }) : toast('Still connecting. Try again in a moment.'));
    $('#joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const c = $('#code').value.trim().toUpperCase();
      if (c.length !== 5) return toast('Room codes have 5 characters.');
      connected() ? wsSend({ t: 'join', code: c }) : toast('Still connecting. Try again in a moment.');
    });
    clearInterval(roomsTimer);
    const poll = () => wsSend({ t: 'rooms' });
    poll();
    roomsTimer = setInterval(poll, 4000);
  }
  function renderOpenRooms(list) {
    const ul = $('#openRooms');
    if (!ul) return;
    ul.innerHTML = list.length
      ? list.map((r) => `<li><span><b>${esc(r.host)}</b>'s room, ${r.count} ${r.count === 1 ? 'player' : 'players'}</span><button class="btn sm" data-join="${esc(r.code)}">Join</button></li>`).join('')
      : '<li class="muted">No open rooms right now. Start one with Quick race.</li>';
    $$('[data-join]', ul).forEach((b) => b.addEventListener('click', () => wsSend({ t: 'join', code: b.dataset.join })));
  }

  /* ----- room ----- */
  function buildShell() {
    clearInterval(roomsTimer);
    rp.innerHTML = '<div id="top"></div><div class="stage" id="stage"></div>';
  }
  function lanesHTML() {
    return room.players.map((p) => {
      const pct = textLen ? Math.min(100, (p.progress / textLen) * 100) : 0;
      return `<div class="lane${p.id === S.me.id ? ' me' : ''}${p.finished ? ' done' : ''}" data-id="${p.id}">
        <span class="lname">${esc(p.name)}${p.id === S.me.id ? ' <i>(you)</i>' : ''}</span>
        <div class="track"><div class="nib" style="left:${pct}%;transform:translateX(-${pct}%)">${esc(p.name.slice(0, 2).toUpperCase())}</div></div>
        <span class="lwpm">${p.wpm ? Math.round(p.wpm) : ''}</span></div>`;
    }).join('');
  }
  function renderTop() {
    const top = $('#top');
    if (!top || !room) return;
    const host = room.players.find((p) => p.id === room.hostId);
    const isHost = room.hostId === S.me.id;
    let action = '';
    if (phase === 'room') {
      action = isHost
        ? `<div class="row wrap"><button class="btn" id="start" ${room.players.length < 2 ? 'disabled' : ''}>Start race</button><span class="muted">${room.players.length < 2 ? 'Waiting for another player. Share the code or invite link.' : 'Start when everyone is here.'}</span></div>`
        : `<p class="muted">Waiting for ${esc(host ? host.name : 'the host')} to start the race.</p>`;
    }
    top.innerHTML = `
      <div class="roomhead">
        <div><span class="muted">Room code</span><span class="code">${esc(room.code)}</span></div>
        <div class="row"><button class="btn ghost sm" id="copy">Copy invite link</button><button class="btn ghost sm" id="leave">Leave room</button></div>
      </div>
      <div class="lanes" id="lanes">${lanesHTML()}</div>${action}`;
    $('#copy').addEventListener('click', async () => {
      const link = `${location.origin}/#race/${room.code}`;
      try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); } catch { toast(link); }
    });
    $('#leave').addEventListener('click', () => wsSend({ t: 'leave' }));
    const s = $('#start');
    if (s) s.addEventListener('click', () => wsSend({ t: 'start' }));
  }
  function applyProgress(players) {
    players.forEach((p) => {
      const lane = $(`.lane[data-id="${p.id}"]`, rp);
      if (!lane || (p.id === S.me.id && phase === 'racing' && !p.finished)) return;
      const pct = textLen ? Math.min(100, (p.progress / textLen) * 100) : 0;
      const nib = $('.nib', lane);
      nib.style.left = `${pct}%`; nib.style.transform = `translateX(-${pct}%)`;
      $('.lwpm', lane).textContent = p.wpm ? Math.round(p.wpm) : '';
      lane.classList.toggle('done', !!p.finished);
    });
  }
  function paintMine(frac, chars) {
    const lane = $('.lane.me', rp);
    if (!lane) return;
    const pct = Math.min(100, frac * 100), nib = $('.nib', lane);
    nib.style.left = `${pct}%`; nib.style.transform = `translateX(-${pct}%)`;
    const secs = (Date.now() - raceT0) / 1000;
    if (chars && secs > 1) $('.lwpm', lane).textContent = Math.round(chars / 5 / (secs / 60));
  }

  /* ----- stage (what sits under the lanes) ----- */
  function renderStage() {
    const st = $('#stage');
    if (!st) return;
    clearInterval(cdTimer);
    if (phase === 'room') {
      st.innerHTML = '<p class="hint">Everyone gets the same 35 words. You have 90 seconds, and finished races count on the leaderboard.</p>';
    } else if (phase === 'results' && results) {
      st.innerHTML = `
        <h2 style="margin-top:8px">Results</h2>
        <ol class="plain standings">${results.results.map((r) => `
          <li class="${r.id === S.me.id ? 'me' : ''}">
            <span class="pos${r.rank === 1 && r.finished ? ' first' : ''}">${r.rank}</span>
            <span class="who-cell">${avatar(r)}<b>${esc(r.name)}</b></span>
            <span class="num">${Math.round(r.wpm)} wpm</span>
            <span class="num acc">${r.finished ? `${Math.round(r.accuracy)}%` : 'unfinished'}</span>
          </li>`).join('')}</ol>
        <div class="row" style="margin-top:16px"><button class="btn" id="back">Back to room</button></div>`;
      $('#back').addEventListener('click', () => { phase = 'room'; renderStage(); renderTop(); });
    }
  }
  function startCountdown(ms) {
    const st = $('#stage');
    let left = Math.round(ms / 1000);
    st.innerHTML = `<div class="sheet" style="height:134px"><div class="countdown" id="cd" role="timer" aria-live="assertive">${left}</div></div>`;
    cdTimer = setInterval(() => { left--; const cd = $('#cd'); if (cd && left > 0) cd.textContent = left; else clearInterval(cdTimer); }, 1000);
  }
  function startSheet(text) {
    clearInterval(cdTimer);
    textLen = text.length; myChars = 0; raceT0 = Date.now();
    $('#stage').innerHTML = '<div id="sh"></div><p class="hint" id="rhint">Type the words as fast as you can. The first to finish wins.</p>';
    sheet = createSheet($('#sh'), text, {
      endless: false,
      onChange(s) {
        myChars = s.chars;
        paintMine(s.chars / textLen, s.chars);
        if (!flush) flush = setTimeout(() => { flush = null; wsSend({ t: 'progress', chars: myChars }); }, 100);
      },
      onFinish(s) {
        clearTimeout(flush); flush = null;
        wsSend({ t: 'finish', chars: s.chars, keys: s.keys, okKeys: s.okKeys });
        paintMine(1, s.chars);
        const h = $('#rhint'); if (h) h.textContent = 'Finished. Waiting for the others…';
      },
    });
    sheet.focus();
  }

  /* ----- messages from the server ----- */
  S.onWs = (m) => {
    if (!alive) return;
    switch (m.t) {
      case 'rooms': renderOpenRooms(m.rooms); break;
      case 'room':
        room = m; textLen = m.textLen || textLen;
        if (phase === 'none') { phase = 'room'; buildShell(); renderStage(); }
        renderTop();
        break;
      case 'left':
        room = null; phase = 'none'; results = null; textLen = 0; renderLobby(); break;
      case 'countdown':
        phase = 'countdown'; results = null; textLen = 0; renderTop(); startCountdown(m.ms); break;
      case 'go':
        phase = 'racing'; startSheet(m.text); renderTop(); break;
      case 'progress': applyProgress(m.players); break;
      case 'results':
        phase = 'results'; results = m; if (sheet) { sheet.destroy(); sheet = null; }
        textLen = m.textLen || textLen; renderStage(); break;
      case 'error': toast(m.msg); break;
      case '_closed':
        if (room) toast('Connection lost. Reconnecting…');
        room = null; phase = 'none'; renderLobby(); break;
      default: break;
    }
  };

  renderLobby();
  if (arg) {
    const code = String(arg).toUpperCase().slice(0, 5);
    history.replaceState(null, '', '#race');
    whenWs(() => wsSend({ t: 'join', code }));
  }

  return () => {
    alive = false;
    clearInterval(roomsTimer); clearInterval(cdTimer); clearTimeout(flush);
    if (sheet) sheet.destroy();
    wsSend({ t: 'leave' });
  };
}

/* ================= Leaderboard ================= */
function boardView(root) {
  let period = 'week', alive = true;
  root.innerHTML = `
    <section class="panel">
      <div class="row between wrap">
        <h1>Leaderboard</h1>
        <div class="seg" role="group" aria-label="Time range">
          <button data-p="day" aria-pressed="false">Today</button>
          <button data-p="week" aria-pressed="true">This week</button>
          <button data-p="all" aria-pressed="false">All time</button>
        </div>
      </div>
      <p class="muted" style="margin-top:6px">Each member's fastest score. Solo tests and finished races both count.</p>
      <div id="boardBody"></div>
    </section>`;
  async function load() {
    const body = $('#boardBody');
    body.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const r = await api('GET', `/api/leaderboard?period=${period}`);
      if (!alive) return;
      body.innerHTML = r.rows.length ? `
        <div class="tablewrap"><table class="tbl" style="min-width:0">
          <thead><tr><th>#</th><th>Player</th><th class="r">WPM</th><th class="r">Accuracy</th><th class="r">Tests</th></tr></thead>
          <tbody>${r.rows.map((x, i) => `<tr${x.username === r.me ? ' style="background:var(--cobalt-soft)"' : ''}>
            <td><span class="pos${i === 0 ? ' first' : ''}" style="display:inline-block;min-width:28px;text-align:center">${i + 1}</span></td>
            <td><span class="who-cell">${avatar(x)}<b>${esc(x.username)}</b></span></td>
            <td class="r"><b>${Math.round(x.wpm)}</b></td><td class="r">${Math.round(x.accuracy ?? 0)}%</td><td class="r">${x.tests}</td></tr>`).join('')}</tbody>
        </table></div>`
        : '<p class="empty">No scores in this range yet. Finish a test to take first place.</p>';
    } catch (e) { if (alive) body.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  }
  $$('.seg button', root).forEach((b) => b.addEventListener('click', () => {
    period = b.dataset.p;
    $$('.seg button', root).forEach((x) => x.setAttribute('aria-pressed', x === b));
    load();
  }));
  load();
  return () => { alive = false; };
}

/* ================= Owner: members ================= */
function adminView(root) {
  let members = [], alive = true, timer = null, query = '';
  const details = new Map(); // member id -> html of the login history, kept open across refreshes

  root.innerHTML = `
    <section class="panel">
      <div class="row between wrap">
        <div><h1>Members</h1><p class="muted">Everyone who signed up, their typing speed and the IP addresses recorded.</p></div>
        <div class="row wrap"><input class="input" id="q" style="width:260px" placeholder="Search name, email or IP" aria-label="Search members"><button class="btn ghost" id="csv">Download CSV</button></div>
      </div>
      <div class="stats4" id="ov"></div>
      <div class="tablewrap"><table class="tbl">
        <thead><tr><th>Member</th><th>Signs in with</th><th class="r">Best WPM</th><th class="r">Average</th><th class="r">Last</th><th class="r">Tests</th><th>Signup IP</th><th>Latest IP</th><th>Last seen</th><th></th></tr></thead>
        <tbody id="tb"></tbody>
      </table></div>
      <p class="muted small" style="margin-top:12px">IP addresses are personal data. Members agree to their IP being recorded when they sign up. Keep this page private and delete data when someone asks.</p>
    </section>`;

  const matches = (m) => !query || [m.username, m.email, m.signup_ip, m.last_ip].some((v) => String(v || '').toLowerCase().includes(query));

  function rowHTML(m) {
    const how = [m.hasPassword ? 'Password' : '', m.google ? 'Google' : ''].filter(Boolean).join(' + ');
    return `<tr data-id="${m.id}">
      <td><div class="who-cell">${avatar(m, true)}<div><b>${esc(m.username)} ${m.role === 'owner' ? '<span class="pill">Owner</span>' : ''}${m.banned ? ' <span class="pill bad">Suspended</span>' : ''}</b><span>${esc(m.email)}</span></div></div></td>
      <td>${esc(how)}</td>
      <td class="r"><b>${m.tests ? Math.round(m.best) : '–'}</b></td>
      <td class="r">${m.tests ? Math.round(m.avg) : '–'}</td>
      <td class="r">${m.lastWpm != null ? Math.round(m.lastWpm) : '–'}</td>
      <td class="r">${m.tests}</td>
      <td class="mono">${esc(m.signup_ip || '–')}</td>
      <td class="mono">${esc(m.last_ip || '–')}</td>
      <td>${m.online ? '<span class="dot"></span>Online' : esc(ago(m.last_seen))}</td>
      <td><div class="row"><button class="btn ghost sm" data-act="logins" data-id="${m.id}">${details.has(m.id) ? 'Hide history' : 'History'}</button>${
        m.role === 'owner' ? '' : `<button class="btn ${m.banned ? 'ghost' : 'danger'} sm" data-act="ban" data-id="${m.id}" data-banned="${m.banned ? 0 : 1}">${m.banned ? 'Restore' : 'Suspend'}</button>`}</div></td>
    </tr>${details.has(m.id) ? `<tr class="detail"><td colspan="10">${details.get(m.id)}</td></tr>` : ''}`;
  }
  function renderRows() {
    const list = members.filter(matches);
    $('#tb').innerHTML = list.length ? list.map(rowHTML).join('') : '<tr><td colspan="10" class="empty">No members match your search.</td></tr>';
  }
  async function load() {
    try {
      const [ov, ml] = await Promise.all([api('GET', '/api/admin/overview'), api('GET', '/api/admin/members')]);
      if (!alive) return;
      members = ml.members;
      $('#ov').innerHTML = [
        ['Members', ov.members], ['New in 24 h', ov.newToday], ['Online now', ov.online],
        ['Tests taken', ov.tests], ['Races finished', ov.races], ['Average WPM', Math.round(ov.avgWpm)],
      ].map(([k, v]) => `<div class="cell"><span>${k}</span><b>${v}</b></div>`).join('');
      renderRows();
    } catch (e) { if (alive) $('#tb').innerHTML = `<tr><td colspan="10" class="empty">${esc(e.message)}</td></tr>`; }
  }

  $('#q').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderRows(); });
  $('#tb').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.act === 'logins') {
      if (details.has(id)) { details.delete(id); renderRows(); return; }
      try {
        const r = await api('GET', `/api/admin/members/${id}/logins`);
        details.set(id, r.logins.length
          ? `<b>Recent logins</b><div class="tablewrap" style="margin-top:8px"><table class="tbl" style="min-width:0"><thead><tr><th>When</th><th>IP address</th><th>Method</th><th>Browser</th></tr></thead><tbody>${
            r.logins.map((l) => `<tr><td>${esc(new Date(l.at).toLocaleString())}</td><td class="mono">${esc(l.ip || '–')}</td><td>${esc(l.method)}</td><td class="muted small">${esc((l.agent || '').slice(0, 90))}</td></tr>`).join('')
          }</tbody></table></div>`
          : '<span class="muted">No logins recorded yet.</span>');
        renderRows();
      } catch (ex) { toast(ex.message); }
    } else if (b.dataset.act === 'ban') {
      const suspend = b.dataset.banned === '1';
      if (suspend && !confirm('Suspend this member? They will be logged out and cannot log in until restored.')) return;
      try { await api('POST', `/api/admin/members/${id}/ban`, { banned: suspend }); toast(suspend ? 'Member suspended.' : 'Member restored.'); load(); }
      catch (ex) { toast(ex.message); }
    }
  });
  $('#csv').addEventListener('click', () => {
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
    const head = ['username', 'email', 'role', 'status', 'best_wpm', 'avg_wpm', 'tests', 'signup_ip', 'last_ip', 'joined', 'last_seen'];
    const lines = members.map((m) => [m.username, m.email, m.role, m.banned ? 'suspended' : 'active', Math.round(m.best), Math.round(m.avg), m.tests, m.signup_ip, m.last_ip,
      new Date(m.created_at).toISOString(), m.last_seen ? new Date(m.last_seen).toISOString() : ''].map(cell).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'typing-master-members.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  load();
  timer = setInterval(load, 15000);
  return () => { alive = false; clearInterval(timer); };
}

/* ================= Boot ================= */
(async function boot() {
  try { S.cfg = await api('GET', '/api/config'); } catch { /* keep defaults */ }
  try { S.me = (await api('GET', '/api/me')).user; } catch { S.me = null; }
  if (S.me) showApp(); else showAuth();
})();
