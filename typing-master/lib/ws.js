'use strict';
// Minimal RFC 6455 WebSocket server: text frames, ping/pong, close, fragmentation.
const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.closed = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._end());
    socket.on('error', () => this._end());
  }

  _data(chunk) {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    let frame;
    while (!this.closed && (frame = this._parse())) this._frame(frame);
  }

  _parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80);
    const op = b[0] & 0x0f;
    const masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) { this.terminate(); return null; }
      len = Number(big);
      off = 10;
    }
    if (!masked || len > MAX_FRAME) { this.terminate(); return null; }
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    return { fin, op, payload };
  }

  _frame({ fin, op, payload }) {
    if (op === 0x8) { this.close(); return; }
    if (op === 0x9) { this._write(0xa, payload); return; }
    if (op === 0xa) { this.alive = true; return; }
    if (op === 0x1 || op === 0x0) {
      if (op === 0x1) this.frag = [];
      this.frag.push(payload);
      if (fin) {
        const text = Buffer.concat(this.frag).toString('utf8');
        this.frag = [];
        this.emit('message', text);
      }
    }
  }

  _write(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }

  send(obj) { this._write(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  ping() { this._write(0x9, Buffer.alloc(0)); }
  close() {
    if (this.closed) return;
    try { this._write(0x8, Buffer.alloc(0)); } catch { /* ignore */ }
    this.socket.end();
    this._end();
  }
  terminate() { this.socket.destroy(); this._end(); }
  _end() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

// verify(req) must return a truthy context (e.g. the user) or null to refuse the connection.
function attach(server, { path = '/ws', verify, onConnection }) {
  const conns = new Set();

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.destroy();
      return;
    }
    const ctx = verify(req);
    if (!ctx) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = new Conn(socket);
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    onConnection(conn, ctx, req);
  });

  const beat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.terminate(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 30000);
  beat.unref();
}

module.exports = { attach };
