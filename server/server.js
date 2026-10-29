// Chaos Anchor game server
// Relays who is online, parties, invites, the match queue and in-match positions between copies of the desktop app.
// Identity: each app keeps a secret random token; your player id is a hash of it, so ids survive server restarts
// and nobody can pretend to be someone else without that token. No emails or passwords are stored.
// Run:  npm install  then  npm start      (PORT defaults to 8080)
// Settings (environment variables): OWNER_ID = your player id (shown in the app's Settings → Online),
//                                   ADMINS   = extra admin ids, comma separated (optional)
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let WSMOD; try { WSMOD = require('ws'); } catch (e) { WSMOD = require('./ws'); }
const { WebSocketServer } = WSMOD;

function start(opt) { opt = opt || {};

const PORT = opt.port != null ? opt.port : (+process.env.PORT || 8080);
const OWNER_ID = (opt.owner || process.env.OWNER_ID || '').trim();
const DATA_FILE = path.join(opt.dataDir || __dirname, 'data.json');
const MAX_MSG = 16 * 1024;            // biggest single message accepted
const MAX_PRESENCE = 8 * 1024;        // biggest presence object kept per player
const RATE = 60;
const OWNER2_HASH = '85b72b321284915c6a8d720bee5503b25e19b0c2ce2859e1957ecd85c03acd8d';   // one-way hash of the game owner's private code: whoever proves it can manage admins and bans
const isOwnerKey = k => typeof k === 'string' && k.length < 80 && crypto.createHash('sha256').update('chaos-anchor-owner2:' + k.trim().toUpperCase()).digest('hex') === OWNER2_HASH;                      // messages per second per connection before we start dropping

// ---- small persistent store (the admin list); environment ADMINS always counts too
let DB = { 'config/admins': { ids: [], owner: OWNER_ID || null } };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
const envAdmins = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
function adminDoc() { const d = DB['config/admins'] || { ids: [] }; return { ids: [...new Set([...(d.ids || []), ...envAdmins])], owner: OWNER_ID || d.owner || null }; }
function bannedIds() { const d = DB['config/bans']; return d && Array.isArray(d.ids) ? d.ids : []; }
function saveDB() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB)); } catch (e) {} }

const uidOf = token => 'u_' + crypto.createHash('sha256').update('chaos-anchor:' + token).digest('base64url').slice(0, 22);
const tagOf = uid => String(parseInt(crypto.createHash('md5').update(uid).digest('hex').slice(0, 6), 16) % 9000 + 1000);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '').slice(0, n).trim();

// ---- state
const clients = new Set();               // live connections
const rooms = new Map();                 // room name -> Map(peerId -> {c, presence, updatedAt})
const names = new Map();                 // uid -> display name (people seen since the server started)
let peerSeq = 0;

function send(c, m) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); }
function roomOf(name) { let r = rooms.get(name); if (!r) { r = new Map(); rooms.set(name, r); } return r; }
function peerView(id, e) { return { peer: id, by: e.c.uid, presence: e.presence, updatedAt: e.updatedAt }; }
function broadcast(name, m, except) { const r = rooms.get(name); if (!r) return; const s = JSON.stringify(m); for (const e of r.values()) if (e.c !== except && e.c.ws.readyState === 1) e.c.ws.send(s); }

function joinRoom(c, name) {
  if (c.rooms.has(name)) return c.rooms.get(name);
  const r = roomOf(name); const id = 'p' + (++peerSeq).toString(36);
  r.set(id, { c, presence: {}, updatedAt: Date.now() }); c.rooms.set(name, id);
  send(c, { t: 'joined', room: name, peer: id, peers: [...r].map(([pid, e]) => peerView(pid, e)) });
  broadcast(name, { t: 'peer', room: name, p: peerView(id, r.get(id)) }, c);
  return id;
}
function leaveRoom(c, name) {
  const id = c.rooms.get(name); if (!id) return; c.rooms.delete(name);
  const r = rooms.get(name); if (r) { r.delete(id); if (!r.size && name !== 'lobby') rooms.delete(name); }
  broadcast(name, { t: 'gone', room: name, peer: id });
}
function setPresence(c, name, patch) {
  const id = c.rooms.get(name); if (!id || !patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  const e = rooms.get(name).get(id); const next = Object.assign({}, e.presence);
  for (const k of Object.keys(patch).slice(0, 40)) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_PRESENCE) return;
  if (typeof next.n === 'string') { const n = clean(next.n, 16); if (n) { names.set(c.uid, n); c.name = n; } }
  e.presence = next; e.updatedAt = Date.now();
  broadcast(name, { t: 'peer', room: name, p: peerView(id, e) });
}

// ---- http (health check + a tiny status page) and websocket on the same port
// the game itself, playable in any browser at the server's address
const GAME_FILE = opt.gameFile || path.join(__dirname, 'public', 'index.html');
let GAME = null; try { GAME = fs.readFileSync(GAME_FILE); } catch (e) {}
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (GAME && (req.url === '/' || req.url.startsWith('/?') || req.url === '/play')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(GAME); }
  const lobby = rooms.get('lobby');
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`Chaos Anchor server is running. Play at / .\nPlayers online: ${lobby ? lobby.size : 0}\nMatches running: ${Math.max(0, rooms.size - 1)}\n`);
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

wss.on('connection', ws => {
  const c = { ws, uid: null, name: 'Player', rooms: new Map(), budget: RATE, alive: true };
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', raw => {
    if (--c.budget < 0) return;                              // flood protection
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!c.uid) {                                             // first message must be hello
      if (m.t !== 'hello' || typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 128) return ws.close();
      c.uid = uidOf(m.token); c.name = clean(m.name, 16) || 'Player';
      c.owner = (!!OWNER_ID && c.uid === OWNER_ID) || isOwnerKey(m.ok);
      if (!c.owner && bannedIds().includes(c.uid)) { send(c, { t: 'banned' }); return setTimeout(() => ws.close(), 200); }
      names.set(c.uid, c.name); clients.add(c);
      return send(c, { t: 'welcome', uid: c.uid, tag: tagOf(c.uid), owner: c.owner, ownerSet: true });
    }
    const room = typeof m.room === 'string' ? clean(m.room, 64) : 'lobby';
    switch (m.t) {
      case 'join': if (c.rooms.size < 4) joinRoom(c, room); break;
      case 'leave': leaveRoom(c, room); break;
      case 'presence': setPresence(c, room, m.patch); break;
      case 'name': { const n = clean(m.name, 16); if (n) { c.name = n; names.set(c.uid, n); } break; }
      case 'profiles': {
        const out = {}; for (const id of (Array.isArray(m.ids) ? m.ids.slice(0, 64) : [])) if (typeof id === 'string' && names.has(id)) out[id] = { id, name: names.get(id) + '#' + tagOf(id) };
        send(c, { t: 'reply', rid: m.rid, data: out }); break;
      }
      case 'search': {
        const q = clean(m.q, 32).toLowerCase(); const out = [];
        for (const [id, n] of names) { if (id === c.uid) continue; const full = n + '#' + tagOf(id); if (!q || full.toLowerCase().includes(q)) out.push({ id, name: full }); if (out.length >= 20) break; }
        send(c, { t: 'reply', rid: m.rid, data: out }); break;
      }
      case 'db_get': { const p = clean(m.path, 200); send(c, { t: 'reply', rid: m.rid, data: p === 'config/admins' ? adminDoc() : (DB[p] || null) }); break; }
      case 'db_set': {
        const p = clean(m.path, 200);
        const ok = c.owner && p.startsWith('config/') && m.data && typeof m.data === 'object' && Buffer.byteLength(JSON.stringify(m.data)) < 8192;
        if (ok) { DB[p] = m.data; saveDB(); const d = p === 'config/admins' ? adminDoc() : m.data; for (const x of clients) send(x, { t: 'db', path: p, data: d });
          if (p === 'config/bans') for (const x of [...clients]) if (!x.owner && bannedIds().includes(x.uid)) { send(x, { t: 'banned' }); setTimeout(() => { try { x.ws.close(); } catch (e) {} }, 200); } }
        send(c, { t: 'reply', rid: m.rid, data: ok, error: ok ? null : 'not_allowed' }); break;
      }
    }
  });
  ws.on('close', () => { for (const name of [...c.rooms.keys()]) leaveRoom(c, name); clients.delete(c); });
});

// refill flood budgets, drop dead connections
const iv1 = setInterval(() => { for (const c of clients) c.budget = RATE; }, 1000);
const iv2 = setInterval(() => { for (const c of clients) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) {} } }, 20000);

return new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, opt.host || '0.0.0.0', () => { const port = server.address().port; if (!opt.quiet) console.log('Chaos Anchor server listening on port ' + port + (OWNER_ID ? ' · owner ' + OWNER_ID : ' · no OWNER_ID set yet'));
    resolve({ port, players: () => clients.size, close() { clearInterval(iv1); clearInterval(iv2); for (const c of clients) { try { c.ws.terminate(); } catch (e) {} } try { wss.close(); } catch (e) {} return new Promise(r => server.close(() => r())); } }); });
});
}
module.exports = { start };
if (require.main === module) start().catch(e => { console.error(e.message); process.exit(1); });
