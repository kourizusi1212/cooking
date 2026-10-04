// ワイワイキッチン - 最大5人の協力3D料理ゲーム サーバー
// 依存パッケージなし（Node.js 16 以上）。  起動: node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const GAME_TIME = 300; // 秒
const COOK_T = 8;      // 秒でパティが焼ける
const BURN_T = 18;     // 秒で焦げる
const ORDER_TIME = 100;
const TICK = 0.05;

// ---------------------------------------------------------------- キッチン配置
// x,z = 中心 / w,d = 幅,奥行 （高さはどれも1.0）
const LAYOUT = [
  // 奥の壁ぎわ
  { type: 'crate', kind: 'bun',     x: -6.5, z: -5.4, w: 1.6, d: 1.2 },
  { type: 'crate', kind: 'patty',   x: -4.5, z: -5.4, w: 1.6, d: 1.2 },
  { type: 'crate', kind: 'lettuce', x: -2.5, z: -5.4, w: 1.6, d: 1.2 },
  { type: 'crate', kind: 'tomato',  x: -0.5, z: -5.4, w: 1.6, d: 1.2 },
  { type: 'plates',                 x: 1.5,  z: -5.4, w: 1.6, d: 1.2 },
  { type: 'counter',                x: 3.5,  z: -5.4, w: 2,   d: 1.2 },
  { type: 'counter',                x: 5.5,  z: -5.4, w: 2,   d: 1.2 },
  // 中央のアイランド
  { type: 'grill',   x: -5.6, z: -1.5, w: 2, d: 1.4 },
  { type: 'grill',   x: -3.4, z: -1.5, w: 2, d: 1.4 },
  { type: 'counter', x: -1.2, z: -1.5, w: 2, d: 1.4 },
  { type: 'board',   x: 1.0,  z: -1.5, w: 2, d: 1.4 },
  { type: 'board',   x: 3.2,  z: -1.5, w: 2, d: 1.4 },
  { type: 'counter', x: 5.4,  z: -1.5, w: 2, d: 1.4 },
  // 手前（提供口）
  { type: 'counter', x: -4,  z: 5.4, w: 3, d: 1.2 },
  { type: 'serve',   x: 0,   z: 5.4, w: 3, d: 1.2 },
  { type: 'counter', x: 4,   z: 5.4, w: 3, d: 1.2 },
  // ゴミ箱
  { type: 'trash',   x: 8.0, z: 1.5, w: 1, d: 1.4 },
];
const STATION_DEFS = LAYOUT.map((s, i) => ({ id: i, ...s }));

// ---------------------------------------------------------------- レシピ
const PLATE_OK = ['bun', 'patty_cooked', 'lettuce_chopped', 'tomato_chopped'];
const RECIPES = [
  { name: 'ハンバーガー',       items: ['bun', 'patty_cooked'] },
  { name: 'レタスバーガー',     items: ['bun', 'patty_cooked', 'lettuce_chopped'] },
  { name: 'トマトバーガー',     items: ['bun', 'patty_cooked', 'tomato_chopped'] },
  { name: 'デラックスバーガー', items: ['bun', 'patty_cooked', 'lettuce_chopped', 'tomato_chopped'] },
  { name: 'ガーデンサラダ',     items: ['lettuce_chopped', 'tomato_chopped'] },
];
const COLORS = ['#e4572e', '#29a3a3', '#f2b632', '#7b5ea7', '#4c9f3e'];

// ---------------------------------------------------------------- 最小限の WebSocket 実装
class WS {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  parse() {
    while (this.buf.length >= 2 && !this.closed) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const op = b0 & 15;
      const masked = (b1 & 128) !== 0;
      let len = b1 & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 100000) { this.close(); return; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      const payload = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
      if (masked) {
        const m = this.buf.subarray(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      if (op === 1) { if (this.onmessage) this.onmessage(payload.toString('utf8')); }
      else if (op === 8) { this.close(); return; }
      else if (op === 9) { this.frame(10, payload); }
    }
  }
  frame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { this.close(); }
  }
  send(str) { this.frame(1, Buffer.from(str, 'utf8')); }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) { /* noop */ }
    if (this.onclose) this.onclose();
  }
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  onConnection(new WS(socket));
});

// ---------------------------------------------------------------- ゲームロジック
const rooms = new Map();
let nextPlayerId = 1;

function mkItem(kind) {
  return { kind, state: 'raw', prog: 0, cook: 0, contents: kind === 'plate' ? [] : undefined };
}
function key(it) { return it.state === 'raw' ? it.kind : it.kind + '_' + it.state; }
function canAddToPlate(plate, it) {
  if (it.kind === 'plate') return false;
  const k = key(it);
  if (!PLATE_OK.includes(k)) return false;
  return !plate.contents.some(c => key(c) === k);
}
function ser(it) {
  if (!it) return null;
  const o = { k: it.kind, s: it.state };
  if (it.kind === 'plate') o.c = it.contents.map(c => [c.kind, c.state]);
  if (it.prog) o.p = Math.round(it.prog);
  if (it.kind === 'patty' && it.cook) o.ck = Math.round(it.cook * 10) / 10;
  return o;
}

function createRoom(code) {
  const r = {
    code, players: new Map(), phase: 'lobby', time: GAME_TIME, score: 0,
    delivered: 0, failed: 0, orders: [], nextOrder: 0, oid: 1,
    st: STATION_DEFS.map(s => ({ ...s, item: null })),
  };
  r.timer = setInterval(() => tick(r), TICK * 1000);
  return r;
}
function broadcast(r, obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  for (const p of r.players.values()) p.ws.send(s);
}
function toast(r, text, k) { broadcast(r, { t: 'm', text, k: k || 'info' }); }
function msg(p, text, k) { p.ws.send(JSON.stringify({ t: 'm', text, k: k || 'info' })); }
function sfx(r, n) { broadcast(r, { t: 'x', n }); }

function addOrder(r) {
  const rec = RECIPES[Math.floor(Math.random() * RECIPES.length)];
  r.orders.push({
    id: r.oid++, name: rec.name, items: rec.items.slice(),
    key: rec.items.slice().sort().join(','), t: ORDER_TIME, max: ORDER_TIME,
  });
  sfx(r, 'order');
}

function startGame(r) {
  r.phase = 'playing';
  r.time = GAME_TIME; r.score = 0; r.delivered = 0; r.failed = 0;
  r.orders = []; r.nextOrder = 14; r.oid = 1;
  for (const s of r.st) s.item = null;
  for (const p of r.players.values()) p.held = null;
  addOrder(r);
  if (r.players.size > 1) addOrder(r);
  toast(r, 'ゲームスタート！ 注文をさばこう', 'ok');
}

function tick(r) {
  if (r.phase === 'playing') {
    r.time -= TICK;
    for (const s of r.st) {
      const it = s.item;
      if (s.type === 'grill' && it && it.kind === 'patty') {
        it.cook += TICK;
        if (it.state === 'raw' && it.cook >= COOK_T) { it.state = 'cooked'; sfx(r, 'ding'); }
        else if (it.state === 'cooked' && it.cook >= BURN_T) { it.state = 'burnt'; toast(r, 'パティが焦げた！', 'bad'); sfx(r, 'bad'); }
      }
    }
    for (const o of r.orders) o.t -= TICK;
    const expired = r.orders.filter(o => o.t <= 0);
    if (expired.length) {
      for (const o of expired) { r.failed++; r.score = Math.max(0, r.score - 30); toast(r, `${o.name} の注文が時間切れ… -30`, 'bad'); }
      r.orders = r.orders.filter(o => o.t > 0);
      sfx(r, 'bad');
    }
    const maxActive = Math.min(6, 2 + r.players.size);
    r.nextOrder -= TICK;
    if (r.orders.length === 0 || r.nextOrder <= 0) {
      if (r.orders.length < maxActive) addOrder(r);
      r.nextOrder = 12 + Math.random() * 6;
    }
    if (r.time <= 0) {
      r.time = 0; r.phase = 'over';
      for (const p of r.players.values()) p.held = null;
      sfx(r, 'end');
    }
  }
  if (r.players.size === 0) return;
  broadcast(r, {
    t: 's', ph: r.phase, tm: Math.round(r.time * 10) / 10, sc: r.score, dl: r.delivered, fl: r.failed,
    o: r.orders.map(o => ({ i: o.id, n: o.name, it: o.items, t: Math.round(o.t * 10) / 10, m: o.max })),
    p: [...r.players.values()].map(p => ({
      i: p.id, n: p.name, c: p.color,
      x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100,
      r: Math.round(p.r * 1000) / 1000, h: ser(p.held),
    })),
    s: r.st.map(s => ser(s.item)),
  });
}

function near(p, s) {
  const dx = Math.max(Math.abs(p.x - s.x) - s.w / 2, 0);
  const dz = Math.max(Math.abs(p.z - s.z) - s.d / 2, 0);
  return Math.hypot(dx, dz) <= 2.4;
}

function doUse(r, p, s) {
  const held = p.held;
  if (r.phase !== 'playing') { msg(p, 'ゲーム開始前です', 'info'); return; }
  switch (s.type) {
    case 'crate': {
      if (held && held.kind === 'plate') {
        const it = mkItem(s.kind);
        if (canAddToPlate(held, it)) { held.contents.push(it); sfx(r, 'put'); }
        else msg(p, 'それは皿に直接乗せられない（加工が必要）', 'bad');
        return;
      }
      if (held) { msg(p, '手がふさがっている', 'bad'); return; }
      p.held = mkItem(s.kind); sfx(r, 'pick'); return;
    }
    case 'plates':
      if (held) { msg(p, '手がふさがっている', 'bad'); return; }
      p.held = mkItem('plate'); sfx(r, 'pick'); return;
    case 'trash':
      if (!held) { msg(p, '捨てるものがない', 'info'); return; }
      if (held.kind === 'plate') held.contents = []; else p.held = null;
      sfx(r, 'trash'); return;
    case 'serve': return serve(r, p);
  }
  // 置き場のあるステーション（counter / board / grill）
  if (!held && s.item) { p.held = s.item; s.item = null; sfx(r, 'pick'); return; }
  if (held && !s.item) {
    if (s.type === 'grill' && held.kind !== 'patty') { msg(p, 'グリルにはパティだけ置ける', 'bad'); return; }
    if (s.type === 'board' && held.kind !== 'lettuce' && held.kind !== 'tomato') { msg(p, 'まな板では野菜を切る', 'bad'); return; }
    s.item = held; p.held = null; sfx(r, 'put'); return;
  }
  if (held && s.item) {
    if (held.kind === 'plate' && canAddToPlate(held, s.item)) { held.contents.push(s.item); s.item = null; sfx(r, 'put'); return; }
    if (s.item.kind === 'plate' && canAddToPlate(s.item, held)) { s.item.contents.push(held); p.held = null; sfx(r, 'put'); return; }
    msg(p, 'ここには置けない（まだ加工が必要かも）', 'bad');
  }
}

function doChop(r, p, s) {
  if (r.phase !== 'playing') return;
  const it = s.item;
  if (s.type !== 'board' || !it) { msg(p, 'まな板に野菜を置いてから切ろう', 'info'); return; }
  if (it.state !== 'raw' || (it.kind !== 'lettuce' && it.kind !== 'tomato')) { msg(p, 'もう切ってある', 'info'); return; }
  it.prog += 25;
  if (it.prog >= 100) { it.state = 'chopped'; it.prog = 0; sfx(r, 'ding'); }
  else sfx(r, 'chop');
}

function serve(r, p) {
  const h = p.held;
  if (!h || h.kind !== 'plate' || !h.contents.length) { msg(p, 'お皿に料理を乗せて持ってこよう', 'info'); return; }
  const k = h.contents.map(key).sort().join(',');
  let idx = -1, best = Infinity;
  r.orders.forEach((o, i) => { if (o.key === k && o.t < best) { best = o.t; idx = i; } });
  if (idx < 0) { msg(p, 'その料理の注文はありません', 'bad'); sfx(r, 'bad'); return; }
  const o = r.orders.splice(idx, 1)[0];
  const pts = 100 + Math.round((o.t / o.max) * 50) + o.items.length * 10;
  r.score += pts; r.delivered++; p.held = null;
  toast(r, `${p.name} が ${o.name} を提供！ +${pts}`, 'ok');
  sfx(r, 'serve');
}

// ---------------------------------------------------------------- 接続処理
function cleanRoomCode(s) {
  const c = String(s || '').trim().slice(0, 16).replace(/[^\w\-ぁ-んァ-ヶー一-龥]/g, '');
  return c || 'kitchen';
}

function onConnection(ws) {
  let room = null, me = null;
  ws.onmessage = raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (me) return;
      const code = cleanRoomCode(m.room);
      let r = rooms.get(code);
      if (!r) { r = createRoom(code); rooms.set(code, r); }
      if (r.players.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ t: 'err', text: `ルーム「${code}」は満員です（最大${MAX_PLAYERS}人）` }));
        if (r.players.size === 0) { clearInterval(r.timer); rooms.delete(code); }
        return;
      }
      const used = new Set([...r.players.values()].map(p => p.slot));
      let slot = 0; while (used.has(slot)) slot++;
      const id = nextPlayerId++;
      me = {
        id, ws, slot, color: COLORS[slot],
        name: String(m.name || '').trim().slice(0, 10) || 'シェフ' + id,
        x: -4 + slot * 2, z: 2.5, r: 0, held: null,
      };
      room = r;
      r.players.set(id, me);
      ws.send(JSON.stringify({
        t: 'init', id, room: code, max: MAX_PLAYERS, stations: STATION_DEFS,
        cfg: { cook: COOK_T, burn: BURN_T, time: GAME_TIME },
      }));
      toast(r, `${me.name} が入室しました`, 'info');
      return;
    }
    if (!room || !me) return;

    if (m.t === 'p') {
      const x = +m.x, z = +m.z, ry = +m.r;
      if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(ry)) {
        me.x = Math.max(-8.2, Math.min(8.2, x));
        me.z = Math.max(-5.7, Math.min(5.7, z));
        me.r = ry;
      }
    } else if (m.t === 'u' || m.t === 'f') {
      const s = room.st[m.s | 0];
      if (!s) return;
      if (!near(me, s)) { msg(me, '遠すぎる', 'info'); return; }
      if (m.t === 'u') doUse(room, me, s); else doChop(room, me, s);
    } else if (m.t === 'start') {
      if (room.phase !== 'playing') startGame(room);
    }
  };
  ws.onclose = () => {
    if (!room || !me) return;
    room.players.delete(me.id);
    if (room.players.size === 0) { clearInterval(room.timer); rooms.delete(room.code); }
    else toast(room, `${me.name} が退室しました`, 'info');
  };
}

server.listen(PORT, () => {
  console.log('\n🍔 ワイワイキッチン サーバー起動！');
  console.log(`  この PC から:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  同じネットワークの友達: http://${i.address}:${PORT}`);
    }
  }
  console.log('  ※インターネット越しに遊ぶ場合は README を参照\n');
});
