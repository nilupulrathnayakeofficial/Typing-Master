'use strict';
const crypto = require('crypto');
const { randomWords } = require('./words');

const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 3000;
const LIMIT_MS = 90000;
const TEXT_WORDS = 35;
const MAX_CPS = 25;      // 25 chars/second = 300 WPM, anything faster is rejected
const TICK_MS = 150;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round1 = (n) => Math.round(n * 10) / 10;

function createRaceHub({ db }) {
  const rooms = new Map();
  const sessions = new Map(); // conn -> { user, room }
  const insertScore = db.prepare(
    'INSERT INTO scores (user_id, wpm, accuracy, duration, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const newCode = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 5; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    } while (rooms.has(code));
    return code;
  };

  const shape = (p) => ({
    id: p.id, name: p.name, avatar: p.avatar,
    progress: p.progress, finished: p.finished, wpm: p.wpm,
  });

  const broadcast = (room, msg) => { for (const p of room.players.values()) p.conn.send(msg); };

  const sendRoom = (room) => broadcast(room, {
    t: 'room', code: room.code, isPublic: room.isPublic, hostId: room.hostId,
    state: room.state, textLen: room.text.length,
    players: [...room.players.values()].map(shape),
  });

  function destroyRoom(room) {
    clearTimeout(room.startTimer);
    clearTimeout(room.limitTimer);
    clearInterval(room.tick);
    rooms.delete(room.code);
  }

  function makeRoom(isPublic) {
    const room = {
      code: newCode(), isPublic, hostId: null, state: 'lobby',
      players: new Map(), text: '', startAt: 0,
      startTimer: null, limitTimer: null, tick: null, dirty: false,
    };
    rooms.set(room.code, room);
    return room;
  }

  function addPlayer(room, conn, user) {
    if (room.state !== 'lobby') return conn.send({ t: 'error', msg: 'That race has already started.' });
    if (room.players.size >= MAX_PLAYERS && !room.players.has(user.id)) {
      return conn.send({ t: 'error', msg: 'That room is full.' });
    }
    // The same member opening a second tab replaces their older seat.
    const old = room.players.get(user.id);
    if (old && old.conn !== conn) {
      const s = sessions.get(old.conn);
      if (s) s.room = null;
      old.conn.send({ t: 'left' });
    }
    room.players.set(user.id, {
      id: user.id, name: user.username, avatar: user.avatar || null, conn,
      progress: 0, finished: false, finishMs: 0, wpm: 0, accuracy: 100, cheat: false,
    });
    if (!room.hostId) room.hostId = user.id;
    sessions.get(conn).room = room;
    sendRoom(room);
  }

  function leave(conn, notify) {
    const s = sessions.get(conn);
    if (!s || !s.room) return;
    const room = s.room;
    s.room = null;
    const p = room.players.get(s.user.id);
    if (p && p.conn === conn) room.players.delete(s.user.id);
    if (notify) conn.send({ t: 'left' });
    if (room.players.size === 0) return destroyRoom(room);
    if (room.hostId === s.user.id) room.hostId = room.players.keys().next().value;
    if (room.state === 'racing') checkDone(room);
    if (rooms.has(room.code)) sendRoom(room);
  }

  function start(conn) {
    const s = sessions.get(conn);
    const room = s && s.room;
    if (!room) return;
    if (room.hostId !== s.user.id) return conn.send({ t: 'error', msg: 'Only the host can start the race.' });
    if (room.state !== 'lobby') return;
    if (room.players.size < 2) return conn.send({ t: 'error', msg: 'You need at least 2 players to start.' });

    room.state = 'countdown';
    for (const p of room.players.values()) Object.assign(p, { progress: 0, finished: false, finishMs: 0, wpm: 0, accuracy: 100, cheat: false });
    broadcast(room, { t: 'countdown', ms: COUNTDOWN_MS });
    sendRoom(room);

    room.startTimer = setTimeout(() => {
      room.state = 'racing';
      room.text = randomWords(TEXT_WORDS).join(' ');
      room.startAt = Date.now();
      room.dirty = true;
      broadcast(room, { t: 'go', text: room.text, limitMs: LIMIT_MS });
      sendRoom(room);
      room.tick = setInterval(() => {
        if (!room.dirty) return;
        room.dirty = false;
        broadcast(room, { t: 'progress', players: [...room.players.values()].map(shape) });
      }, TICK_MS);
      room.limitTimer = setTimeout(() => endRace(room), LIMIT_MS + 500);
    }, COUNTDOWN_MS);
  }

  function progress(conn, msg) {
    const s = sessions.get(conn);
    const room = s && s.room;
    if (!room || room.state !== 'racing') return;
    const p = room.players.get(s.user.id);
    if (!p || p.finished) return;
    const elapsed = (Date.now() - room.startAt) / 1000;
    const chars = clamp(Math.floor(Number(msg.chars) || 0), 0, Math.min(room.text.length, elapsed * MAX_CPS + 8));
    p.progress = chars;
    p.wpm = elapsed > 1 ? round1(chars / 5 / (elapsed / 60)) : 0;
    room.dirty = true;
  }

  function finish(conn, msg) {
    const s = sessions.get(conn);
    const room = s && s.room;
    if (!room || room.state !== 'racing') return;
    const p = room.players.get(s.user.id);
    if (!p || p.finished) return;
    if (Math.floor(Number(msg.chars) || 0) < room.text.length) return;

    const ms = Date.now() - room.startAt;
    const wpm = room.text.length / 5 / (ms / 60000);
    p.finished = true;
    p.finishMs = ms;
    p.progress = room.text.length;
    if (ms < 1500 || wpm > 300) {
      p.cheat = true;
      p.wpm = 0;
      conn.send({ t: 'error', msg: 'That time was not accepted.' });
    } else {
      const keys = Math.max(0, Math.floor(Number(msg.keys) || 0));
      const ok = clamp(Math.floor(Number(msg.okKeys) || 0), 0, keys);
      p.wpm = round1(wpm);
      p.accuracy = keys ? round1((ok / keys) * 100) : 100;
      insertScore.run(p.id, p.wpm, p.accuracy, Math.max(1, Math.round(ms / 1000)), 'race', Date.now());
    }
    room.dirty = true;
    checkDone(room);
  }

  function checkDone(room) {
    if (room.state !== 'racing') return;
    if ([...room.players.values()].every((p) => p.finished)) endRace(room);
  }

  function endRace(room) {
    if (room.state !== 'racing') return;
    clearTimeout(room.limitTimer);
    clearInterval(room.tick);
    const elapsed = Math.min(Date.now() - room.startAt, LIMIT_MS);
    for (const p of room.players.values()) {
      if (!p.finished) p.wpm = round1(p.progress / 5 / (Math.max(elapsed, 1000) / 60000));
    }
    const ranked = [...room.players.values()].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.cheat !== b.cheat) return a.cheat ? 1 : -1;
      return a.finished ? a.finishMs - b.finishMs : b.progress - a.progress;
    });
    const results = ranked.map((p, i) => ({
      id: p.id, name: p.name, avatar: p.avatar, rank: i + 1,
      wpm: p.wpm, accuracy: p.accuracy, finished: p.finished && !p.cheat, progress: p.progress,
    }));
    room.state = 'lobby';
    broadcast(room, { t: 'results', results, textLen: room.text.length });
    for (const p of room.players.values()) Object.assign(p, { progress: 0, finished: false, finishMs: 0, wpm: 0 });
    sendRoom(room);
  }

  function openRooms() {
    return [...rooms.values()]
      .filter((r) => r.isPublic && r.state === 'lobby' && r.players.size < MAX_PLAYERS)
      .map((r) => ({ code: r.code, host: r.players.get(r.hostId)?.name || '', count: r.players.size }));
  }

  function handle(conn, user, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    let s = sessions.get(conn);
    if (!s) { s = { user, room: null }; sessions.set(conn, s); }

    switch (msg.t) {
      case 'create':
        leave(conn, false);
        addPlayer(makeRoom(false), conn, user);
        break;
      case 'quick': {
        leave(conn, false);
        const open = [...rooms.values()].find((r) => r.isPublic && r.state === 'lobby' && r.players.size < MAX_PLAYERS && !r.players.has(user.id));
        addPlayer(open || makeRoom(true), conn, user);
        break;
      }
      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return conn.send({ t: 'error', msg: 'No room with that code.' });
        leave(conn, false);
        addPlayer(room, conn, user);
        break;
      }
      case 'leave': leave(conn, true); break;
      case 'start': start(conn); break;
      case 'progress': progress(conn, msg); break;
      case 'finish': finish(conn, msg); break;
      case 'rooms': conn.send({ t: 'rooms', rooms: openRooms() }); break;
      default: break;
    }
  }

  function disconnect(conn) {
    leave(conn, false);
    sessions.delete(conn);
  }

  return { handle, disconnect, roomCount: () => rooms.size };
}

module.exports = { createRaceHub };
