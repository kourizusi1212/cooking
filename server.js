// ワイワイキッチン - 最大5人の協力3D料理ゲーム サーバー
// 依存パッケージなし（Node.js 18 以上）。  起動: node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const GAME_TIME = 300;   // 秒
const COOK_T = 8;        // パティが焼ける秒数
const BURN_T = 18;       // パティが焦げる秒数
const PASTA_T = 10;      // パスタがゆで上がる秒数
const PASTA_BURN = 24;   // パスタがのびる秒数
const SOUP_T = 12;       // スープができる秒数（具2つ以上で開始）
const SOUP_BURN = 30;    // スープが焦げる秒数
const ORDER_TIME = 180;  // お客さんが待ってくれる秒数
const GRAVITY = 14;
const TOP = 1.0;         // カウンターの高さ
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
  { type: 'crate', kind: 'onion',   x: 3.5,  z: -5.4, w: 1.6, d: 1.2 },
  { type: 'crate', kind: 'pasta',   x: 5.5,  z: -5.4, w: 1.6, d: 1.2 },
  // 中央のアイランド
  { type: 'grill',   x: -5.6, z: -1.5, w: 2,   d: 1.4 },
  { type: 'grill',   x: -3.4, z: -1.5, w: 2,   d: 1.4 },
  { type: 'counter', x: -1.2, z: -1.5, w: 2,   d: 1.4 },
  { type: 'board',   x: 1.0,  z: -1.5, w: 2,   d: 1.4 },
  { type: 'board',   x: 3.2,  z: -1.5, w: 2,   d: 1.4 },
  { type: 'counter', x: 5.1,  z: -1.5, w: 1.4, d: 1.4 },
  // 右の壁ぎわ（お鍋・ゴミ箱）
  { type: 'pot',     x: 7.9,  z: -2.9, w: 1.2, d: 1.6 },
  { type: 'pot',     x: 7.9,  z: -0.9, w: 1.2, d: 1.6 },
  { type: 'trash',   x: 8.0,  z: 2.2,  w: 1,   d: 1.4 },
  // 左の壁ぎわ
  { type: 'counter', x: -8.0, z: 2.2,  w: 1,   d: 1.4 },
  // 手前（提供口・ボウル）
  { type: 'bowls',   x: -7.0, z: 5.4, w: 1.6, d: 1.2 },
  { type: 'counter', x: -4,   z: 5.4, w: 3,   d: 1.2 },
  { type: 'serve',   x: 0,    z: 5.4, w: 3,   d: 1.2 },
  { type: 'counter', x: 4,    z: 5.4, w: 3,   d: 1.2 },
];
const STATION_DEFS = LAYOUT.map((s, i) => ({ id: i, ...s }));

// ---------------------------------------------------------------- レシピ
const VEG = ['lettuce', 'tomato', 'onion'];
const PLATE_OK = ['bun', 'patty_cooked', 'lettuce_chopped', 'tomato_chopped', 'onion_chopped', 'pasta_cooked'];
// v = 基本得点
const RECIPES = [
  { name: 'ハンバーガー',       v: 100, items: ['bun', 'patty_cooked'] },
  { name: 'レタスバーガー',     v: 110, items: ['bun', 'patty_cooked', 'lettuce_chopped'] },
  { name: 'トマトバーガー',     v: 110, items: ['bun', 'patty_cooked', 'tomato_chopped'] },
  { name: 'オニオンバーガー',   v: 110, items: ['bun', 'patty_cooked', 'onion_chopped'] },
  { name: 'デラックスバーガー', v: 160, items: ['bun', 'patty_cooked', 'lettuce_chopped', 'tomato_chopped'] },
  { name: 'ガーデンサラダ',     v: 110, items: ['lettuce_chopped', 'tomato_chopped'] },
  { name: 'トマトパスタ',       v: 140, items: ['pasta_cooked', 'tomato_chopped'] },
  { name: 'ミートパスタ',       v: 150, items: ['pasta_cooked', 'patty_cooked'] },
  { name: 'ナポリタン',         v: 170, items: ['pasta_cooked', 'onion_chopped', 'tomato_chopped'] },
  { name: 'トマトスープ',       v: 130, items: ['soup_onion+tomato'] },
  { name: '野菜スープ',         v: 130, items: ['soup_lettuce+onion'] },
  { name: 'ミネストローネ',     v: 180, items: ['soup_lettuce+onion+tomato'] },
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
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
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

function isContainer(it) { return !!it && (it.kind === 'plate' || it.kind === 'bowl'); }
function mkItem(kind) {
  return { kind, state: 'raw', prog: 0, cook: 0, contents: (kind === 'plate' || kind === 'bowl') ? [] : undefined };
}
function key(it) { return it.state === 'raw' ? it.kind : it.kind + '_' + it.state; }
function canAddToPlate(plate, it) {
  if (!plate || plate.kind !== 'plate' || isContainer(it)) return false;
  const k = key(it);
  if (!PLATE_OK.includes(k)) return false;
  return !plate.contents.some(c => key(c) === k);
}
function ser(it) {
  if (!it) return null;
  const o = { k: it.kind, s: it.state };
  if (isContainer(it)) o.c = it.contents.map(c => [c.kind, c.state]);
  if (it.prog) o.p = Math.round(it.prog);
  if (it.kind === 'patty' && it.cook) o.ck = Math.round(it.cook * 10) / 10;
  return o;
}
function serPot(p) {
  return { pot: 1, m: p.mode, it: p.items, s: p.state, ck: Math.round(p.cook * 10) / 10 };
}
function resetPot(p) { p.mode = null; p.items = []; p.cook = 0; p.state = 'raw'; }

function createRoom(code) {
  const r = {
    code, players: new Map(), phase: 'lobby', time: GAME_TIME, score: 0,
    delivered: 0, failed: 0, orders: [], nextOrder: 0, oid: 1, floor: [], fid: 1,
    st: STATION_DEFS.map(s => ({
      ...s, item: null,
      pot: s.type === 'pot' ? { mode: null, items: [], cook: 0, state: 'raw' } : null,
    })),
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
    id: r.oid++, name: rec.name, items: rec.items.slice(), v: rec.v,
    key: rec.items.slice().sort().join(','), t: ORDER_TIME, max: ORDER_TIME,
  });
  sfx(r, 'order');
}

function startGame(r) {
  r.phase = 'playing';
  r.time = GAME_TIME; r.score = 0; r.delivered = 0; r.failed = 0;
  r.orders = []; r.nextOrder = 20; r.oid = 1; r.floor = []; r.fid = 1;
  for (const s of r.st) { s.item = null; if (s.pot) resetPot(s.pot); }
  for (const p of r.players.values()) p.held = null;
  addOrder(r);
  if (r.players.size > 1) addOrder(r);
  toast(r, 'ゲームスタート！ 注文をさばこう', 'ok');
}

// ---------------------------------------------------------------- 床に置く・投げる
function addFloor(r, item, x, y, z, vx, vy, vz, by) {
  const f = { id: r.fid++, item, x, y, z, vx, vy, vz, fly: true, by: by || '', age: 0, dead: false };
  r.floor.push(f);
  if (r.floor.length > 30) {
    const i = r.floor.findIndex(q => !q.fly);
    if (i >= 0) r.floor.splice(i, 1);
  }
  return f;
}
function stationAt(r, x, z) {
  for (const s of r.st) if (Math.abs(x - s.x) <= s.w / 2 && Math.abs(z - s.z) <= s.d / 2) return s;
  return null;
}
function acceptsSlot(s, it) {
  if (s.type === 'grill') return it.kind === 'patty';
  if (s.type === 'board') return VEG.includes(it.kind);
  return s.type === 'counter';
}
function landOnStation(r, f, s) {
  const it = f.item;
  if (s.type === 'serve') {
    if (isContainer(it) && it.contents.length && submit(r, f.by || '誰か', it).ok) { f.dead = true; return; }
  } else if (s.type === 'trash') {
    f.dead = true; sfx(r, 'trash'); return;
  } else if (s.type === 'counter' || s.type === 'board' || s.type === 'grill') {
    if (!s.item) {
      if (acceptsSlot(s, it)) { s.item = it; f.dead = true; sfx(r, 'put'); return; }
    } else if (s.item.kind === 'plate' && canAddToPlate(s.item, it)) {
      s.item.contents.push(it); f.dead = true; sfx(r, 'put'); return;
    } else if (it.kind === 'plate' && canAddToPlate(it, s.item)) {
      it.contents.push(s.item); s.item = it; f.dead = true; sfx(r, 'put'); return;
    }
  }
  // そのまま上に置かれる
  f.y = TOP; f.fly = false; f.vx = f.vy = f.vz = 0; sfx(r, 'put');
}
function stepFloor(r, dt) {
  const SUB = 5, h = dt / SUB;
  for (const f of r.floor) {
    if (!f.fly || f.dead) continue;
    f.age += dt;
    if (f.age > 0.3) {
      for (const p of r.players.values()) {
        if (p.held) continue;
        if (Math.hypot(p.x - f.x, p.z - f.z) < 0.6 && f.y > 0.2 && f.y < 2.1) {
          p.held = f.item; f.dead = true; sfx(r, 'pick'); msg(p, 'ナイスキャッチ！', 'ok'); break;
        }
      }
      if (f.dead) continue;
    }
    for (let i = 0; i < SUB && f.fly && !f.dead; i++) {
      const ox = f.x, oy = f.y, oz = f.z;
      f.vy -= GRAVITY * h;
      f.x += f.vx * h; f.y += f.vy * h; f.z += f.vz * h;
      if (f.x > 8.3) { f.x = 8.3; f.vx *= -0.3; }
      if (f.x < -8.3) { f.x = -8.3; f.vx *= -0.3; }
      if (f.z > 5.8) { f.z = 5.8; f.vz *= -0.3; }
      if (f.z < -5.8) { f.z = -5.8; f.vz *= -0.3; }
      const s = stationAt(r, f.x, f.z);
      if (s) {
        if (oy >= TOP && f.y < TOP) { landOnStation(r, f, s); break; }
        if (f.y < TOP) { f.x = ox; f.z = oz; f.vx *= -0.3; f.vz *= -0.3; }
      }
      if (f.y <= 0) {
        f.y = 0;
        if (Math.abs(f.vy) > 3) { f.vy *= -0.25; f.vx *= 0.6; f.vz *= 0.6; }
        else { f.fly = false; f.vx = f.vy = f.vz = 0; }
      }
    }
  }
  r.floor = r.floor.filter(f => !f.dead);
}

// ---------------------------------------------------------------- ティック
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
      if (s.type === 'pot') {
        const p = s.pot;
        if (p.mode === 'pasta' || (p.mode === 'soup' && p.items.length >= 2)) {
          const rd = p.mode === 'pasta' ? PASTA_T : SOUP_T;
          const bn = p.mode === 'pasta' ? PASTA_BURN : SOUP_BURN;
          const nm = p.mode === 'pasta' ? 'パスタ' : 'スープ';
          p.cook += TICK;
          if (p.state === 'raw' && p.cook >= rd) { p.state = 'cooked'; toast(r, nm + 'ができた！', 'ok'); sfx(r, 'ding'); }
          else if (p.state === 'cooked' && p.cook >= bn) { p.state = 'burnt'; toast(r, nm + 'がダメになった…', 'bad'); sfx(r, 'bad'); }
        }
      }
    }
    stepFloor(r, TICK);
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
      r.nextOrder = 18 + Math.random() * 8;
    }
    if (r.time <= 0) {
      r.time = 0; r.phase = 'over';
      for (const p of r.players.values()) p.held = null;
      r.floor = [];
      sfx(r, 'end');
    }
  }
  if (r.players.size === 0) return;
  const R2 = n => Math.round(n * 100) / 100;
  broadcast(r, {
    t: 's', ph: r.phase, tm: Math.round(r.time * 10) / 10, sc: r.score, dl: r.delivered, fl: r.failed,
    o: r.orders.map(o => ({ i: o.id, n: o.name, it: o.items, t: Math.round(o.t * 10) / 10, m: o.max })),
    p: [...r.players.values()].map(p => ({
      i: p.id, n: p.name, c: p.color,
      x: R2(p.x), z: R2(p.z), r: Math.round(p.r * 1000) / 1000, h: ser(p.held),
    })),
    s: r.st.map(s => (s.type === 'pot' ? serPot(s.pot) : ser(s.item))),
    f: r.floor.map(f => ({
      i: f.id, x: R2(f.x), y: R2(f.y), z: R2(f.z),
      v: f.fly ? [R2(f.vx), R2(f.vy), R2(f.vz)] : 0, it: ser(f.item),
    })),
  });
}

function near(p, s) {
  const dx = Math.max(Math.abs(p.x - s.x) - s.w / 2, 0);
  const dz = Math.max(Math.abs(p.z - s.z) - s.d / 2, 0);
  return Math.hypot(dx, dz) <= 2.4;
}

// ---------------------------------------------------------------- 操作
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
    case 'bowls':
      if (held) { msg(p, '手がふさがっている', 'bad'); return; }
      p.held = mkItem(s.type === 'plates' ? 'plate' : 'bowl'); sfx(r, 'pick'); return;
    case 'trash':
      if (!held) { msg(p, '捨てるものがない', 'info'); return; }
      if (isContainer(held)) held.contents = []; else p.held = null;
      sfx(r, 'trash'); return;
    case 'serve': return serve(r, p);
    case 'pot': return usePot(r, p, s);
  }
  // 置き場のあるステーション（counter / board / grill）
  if (!held && s.item) { p.held = s.item; s.item = null; sfx(r, 'pick'); return; }
  if (held && !s.item) {
    if (s.type === 'grill' && held.kind !== 'patty') { msg(p, 'グリルにはパティだけ置ける', 'bad'); return; }
    if (s.type === 'board' && !VEG.includes(held.kind)) { msg(p, 'まな板では野菜を切る', 'bad'); return; }
    s.item = held; p.held = null; sfx(r, 'put'); return;
  }
  if (held && s.item) {
    if (held.kind === 'plate' && canAddToPlate(held, s.item)) { held.contents.push(s.item); s.item = null; sfx(r, 'put'); return; }
    if (s.item.kind === 'plate' && canAddToPlate(s.item, held)) { s.item.contents.push(held); p.held = null; sfx(r, 'put'); return; }
    msg(p, 'ここには置けない（まだ加工が必要かも）', 'bad');
  }
}

function usePot(r, p, s) {
  const pot = s.pot, h = p.held;
  const cooked = pot.state === 'cooked';
  if (!h) {
    if (!pot.mode) { msg(p, 'お鍋は空っぽ', 'info'); return; }
    if (pot.state === 'burnt') { resetPot(pot); msg(p, '中身を捨てた', 'info'); sfx(r, 'trash'); return; }
    if (pot.mode === 'pasta') {
      if (!cooked) { msg(p, 'まだゆでている途中…', 'info'); return; }
      const it = mkItem('pasta'); it.state = 'cooked';
      p.held = it; resetPot(pot); sfx(r, 'pick'); return;
    }
    msg(p, 'スープはボウルですくおう', 'info'); return;
  }
  if (h.kind === 'bowl') {
    if (pot.mode !== 'soup' || !cooked) { msg(p, 'スープがまだできていない', 'info'); return; }
    if (h.contents.length) { msg(p, 'このボウルはもう使っている', 'bad'); return; }
    h.contents.push({ kind: 'soup', state: pot.items.slice().sort().join('+') });
    resetPot(pot); sfx(r, 'pick'); return;
  }
  if (h.kind === 'plate') {
    if (pot.mode === 'pasta' && cooked) {
      const it = mkItem('pasta'); it.state = 'cooked';
      if (canAddToPlate(h, it)) { h.contents.push(it); resetPot(pot); sfx(r, 'put'); }
      else msg(p, 'もうパスタが乗っている', 'bad');
      return;
    }
    msg(p, 'ゆで上がったパスタだけ皿に乗せられる', 'info'); return;
  }
  if (h.kind === 'pasta' && h.state === 'raw') {
    if (pot.mode) { msg(p, 'お鍋は使用中', 'bad'); return; }
    pot.mode = 'pasta'; pot.cook = 0; pot.state = 'raw'; p.held = null; sfx(r, 'put'); return;
  }
  if (VEG.includes(h.kind) && h.state === 'chopped') {
    if (pot.mode === 'pasta') { msg(p, 'パスタをゆでている最中', 'bad'); return; }
    if (pot.state !== 'raw') { msg(p, 'できあがったスープには足せない', 'bad'); return; }
    if (pot.items.includes(h.kind)) { msg(p, 'その具はもう入っている', 'bad'); return; }
    pot.mode = 'soup'; pot.items.push(h.kind); p.held = null; sfx(r, 'put');
    if (pot.items.length === 2) msg(p, '煮込み開始！', 'ok');
    return;
  }
  msg(p, VEG.includes(h.kind) ? '野菜は切ってから入れよう' : 'お鍋には入れられない', 'bad');
}

function doChop(r, p, s) {
  if (r.phase !== 'playing') return;
  const it = s.item;
  if (s.type !== 'board' || !it) { msg(p, 'まな板に野菜を置いてから切ろう', 'info'); return; }
  if (it.state !== 'raw' || !VEG.includes(it.kind)) { msg(p, 'もう切ってある', 'info'); return; }
  it.prog += 25;
  if (it.prog >= 100) { it.state = 'chopped'; it.prog = 0; sfx(r, 'ding'); }
  else sfx(r, 'chop');
}

// 提供（皿・ボウルの中身が注文と一致するか）
function submit(r, who, cont) {
  if (r.phase !== 'playing') return { ok: false, why: 'ゲーム中のみ提供できます' };
  if (!cont.contents.length) return { ok: false, why: 'お皿に料理を乗せて持ってこよう' };
  const k = cont.contents.map(key).sort().join(',');
  let idx = -1, best = Infinity;
  r.orders.forEach((o, i) => { if (o.key === k && o.t < best) { best = o.t; idx = i; } });
  if (idx < 0) return { ok: false, why: 'その料理の注文はありません' };
  const o = r.orders.splice(idx, 1)[0];
  const pts = o.v + Math.round((o.t / o.max) * 60);
  r.score += pts; r.delivered++;
  toast(r, `${who} が ${o.name} を提供！ +${pts}`, 'ok');
  sfx(r, 'serve');
  return { ok: true };
}
function serve(r, p) {
  const h = p.held;
  if (!isContainer(h) || !h.contents.length) { msg(p, 'お皿やボウルに料理を入れて持ってこよう', 'info'); return; }
  const res = submit(r, p.name, h);
  if (res.ok) p.held = null; else { msg(p, res.why, 'bad'); sfx(r, 'bad'); }
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
        cfg: { cook: COOK_T, burn: BURN_T, pasta: PASTA_T, pastaBurn: PASTA_BURN, soup: SOUP_T, soupBurn: SOUP_BURN, time: GAME_TIME, g: GRAVITY },
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
    } else if (m.t === 'pu') {   // 床・台の上のものを拾う
      if (room.phase !== 'playing') return;
      const f = room.floor.find(q => q.id === (m.f | 0) && !q.fly);
      if (!f || Math.hypot(me.x - f.x, me.z - f.z) > 2.4) return;
      if (me.held) { msg(me, '手がふさがっている', 'bad'); return; }
      me.held = f.item; room.floor = room.floor.filter(q => q !== f); sfx(room, 'pick');
    } else if (m.t === 'dr') {   // その場に置く（足元の少し前）
      if (room.phase !== 'playing' || !me.held) return;
      const ry = Number.isFinite(+m.r) ? +m.r : me.r;
      const x = Math.max(-8.2, Math.min(8.2, me.x - Math.sin(ry) * 0.7));
      const z = Math.max(-5.7, Math.min(5.7, me.z - Math.cos(ry) * 0.7));
      addFloor(room, me.held, x, 1.1, z, 0, 0, 0, me.name);
      me.held = null;
    } else if (m.t === 'th') {   // 投げる
      if (room.phase !== 'playing' || !me.held) return;
      const ry = Number.isFinite(+m.r) ? +m.r : me.r;
      const pt = Math.max(-1.4, Math.min(1.4, Number.isFinite(+m.pt) ? +m.pt : 0));
      const pw = Math.max(0.15, Math.min(1, Number.isFinite(+m.pw) ? +m.pw : 0.5));
      let dx = -Math.sin(ry) * Math.cos(pt), dy = Math.sin(pt) + 0.15, dz = -Math.cos(ry) * Math.cos(pt);
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      const sp = 4 + 9 * pw;
      addFloor(room, me.held, me.x + dx * 0.5, 1.5, me.z + dz * 0.5, dx * sp, dy * sp, dz * sp, me.name);
      me.held = null; sfx(room, 'put');
    } else if (m.t === 'start') {
      if (room.phase !== 'playing') startGame(room);
    }
  };
  ws.onclose = () => {
    if (!room || !me) return;
    room.players.delete(me.id);
    if (me.held && room.phase === 'playing') addFloor(room, me.held, me.x, 1.1, me.z, 0, 0, 0, me.name);
    if (room.players.size === 0) { clearInterval(room.timer); rooms.delete(room.code); }
    else toast(room, `${me.name} が退室しました`, 'info');
  };
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🍔 ワイワイキッチン サーバー起動！');
  console.log(`  この PC から:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  同じネットワークの友達: http://${i.address}:${PORT}`);
    }
  }
  console.log('  ※インターネット越しに遊ぶ場合は README を参照\n');
});
