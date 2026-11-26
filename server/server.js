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
const MAX_MSG = 48 * 1024;            // biggest single message accepted
const MAX_PRESENCE = 24 * 1024;        // biggest presence object kept per player
const RATE = 120;
const OWNER2_HASH = '85b72b321284915c6a8d720bee5503b25e19b0c2ce2859e1957ecd85c03acd8d';   // one-way hash of the game owner's private code: whoever proves it can manage admins and bans
const isOwnerKey = k => typeof k === 'string' && k.length < 80 && crypto.createHash('sha256').update('chaos-anchor-owner2:' + k.trim().toUpperCase()).digest('hex') === OWNER2_HASH;                      // messages per second per connection before we start dropping

// ---- small persistent store (the admin list); environment ADMINS always counts too
let DB = { 'config/admins': { ids: [], owner: OWNER_ID || null } };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
const envAdmins = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
function adminDoc() { const d = DB['config/admins'] || { ids: [] }; return { ids: [...new Set([...(d.ids || []), ...envAdmins])], owner: OWNER_ID || d.owner || null }; }
function bannedIds() { const d = DB['config/bans']; return d && Array.isArray(d.ids) ? d.ids : []; }
function saveDB() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB)); } catch (e) {} }

// ---- Doodle Duels leaderboards. Each player reports their own totals (kept on their device), so the boards rebuild
// themselves from whoever connects if this server restarts and forgets. Weeks start Monday 00:00 UTC.
const LB = DB.lb = Object.assign({ players: {}, weeks: {} }, DB.lb || {});
const weekNow = () => Math.floor((Date.now() - Date.UTC(2024, 0, 1)) / 604800000);
const lbNum = (v, max) => { v = Math.floor(+v || 0); return v < 0 ? 0 : v > max ? max : v; };
let lbDirty = false;
function lbPut(c, m) {
  const wk = weekNow(), n = c.acctName || clean(m.n, 16) || c.name;
  LB.players[c.uid] = { n, aw: lbNum(m.aw, 1e6), k: lbNum(m.k, 1e7), bs: lbNum(m.bs, 1e5), apt: lbNum(m.apt, 1e9), rg: lbNum(m.rg, 300), at: Date.now() };
  const week = (w, wins, pt) => { w = w | 0; if (w !== wk && w !== wk - 1) return; const W = LB.weeks[w] || (LB.weeks[w] = {}); W[c.uid] = { n, w: lbNum(wins, 1e5), pt: lbNum(pt, 604800) }; };
  week(m.wk, m.w, m.pt); if (m.lw && typeof m.lw === 'object') week(m.lw.wk, m.lw.w, m.lw.pt);
  for (const k of Object.keys(LB.weeks)) if (+k < wk - 1) delete LB.weeks[k];
  lbDirty = true;
}

// ================= Doodle Duels accounts, owner tools, events, bans, chat filter =================
// Accounts: username (3-16 letters/numbers/_) + password. Progress is stored with the account.
// Storage: Upstash Redis if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set (permanent),
// otherwise this server's own file (lost when a free Render server restarts; players' devices re-upload it).
const DD_OWNER = 'xuerou550091';
const DD_OWNER_HASH = 'd7cff5a46ec655a27ba6fe16f3eba332e4b89911596a09ff080482119fe50a03';   // one-way hash of the owner's setup code
const isDDOwnerCode = k => typeof k === 'string' && k.length < 60 && crypto.createHash('sha256').update('doodle-duels-owner:' + k.trim().toUpperCase()).digest('hex') === DD_OWNER_HASH;
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''), UP_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
DB.kv = DB.kv || {};
async function kvGet(k) {
  if (UP_URL && UP_TOK && typeof fetch === 'function') { try { const r = await fetch(UP_URL + '/get/' + encodeURIComponent(k), { headers: { Authorization: 'Bearer ' + UP_TOK } }); const j = await r.json(); if (j && j.result) return JSON.parse(j.result); return DB.kv[k] || null; } catch (e) { return DB.kv[k] || null; } }
  return DB.kv[k] || null;
}
function kvSet(k, v) {
  DB.kv[k] = v; lbDirty = true;
  if (UP_URL && UP_TOK && typeof fetch === 'function') fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOK, 'content-type': 'application/json' }, body: JSON.stringify(['SET', k, JSON.stringify(v)]) }).catch(() => {});
}
const acctKey = n => 'acct:' + String(n).toLowerCase();
const validName = n => typeof n === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(n);
const pwHash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
let EVENTS = { double: 0 }; setTimeout(() => kvGet('dd:events').then(e => { if (e && typeof e === 'object') EVENTS = Object.assign(EVENTS, e); }).catch(() => {}), 500);
const SERVER_BUILD = '173';
const online = new Map();   // lower name -> set of connections
function bindAcct(c, a) {
  if (c.acct && online.get(c.acct)) online.get(c.acct).delete(c);
  c.acct = a.lower; c.acctName = a.name; c.ddOwner = !!a.owner; c.name = a.name; names.set(c.uid, a.name);
  if (!online.has(a.lower)) online.set(a.lower, new Set()); online.get(a.lower).add(c);
}
function newSession(a) { const key = crypto.randomBytes(24).toString('hex'); a.keys = [...(a.keys || []).slice(-4), sha(key)]; return key; }
function acctReply(a, key) { const g = a.grants || []; a.grants = []; return { ok: true, name: a.name, key, owner: !!a.owner, rec: { salt: a.salt, hash: a.hash }, profile: a.profile || null, pAt: a.pAt || 0, grants: g }; }
async function acctMsg(c, m) {
  if (m.t === 'acct_create') {
    if (!validName(m.name)) return { error: 'Usernames are 3-16 letters, numbers or _' };
    if (typeof m.pw !== 'string' || m.pw.length < 4 || m.pw.length > 64) return { error: 'Passwords need at least 4 characters' };
    if (BAD_RE.test(m.name.toLowerCase())) return { error: 'Please pick a different username' };
    const lower = m.name.toLowerCase();
    if (lower === DD_OWNER && !isDDOwnerCode(m.oc)) return { error: 'That username is reserved' };
    if (await kvGet(acctKey(lower))) return { error: 'That username is taken' };
    const salt = crypto.randomBytes(12).toString('hex');
    const a = { name: m.name, lower, salt, hash: pwHash(m.pw, salt), owner: lower === DD_OWNER, created: Date.now(), keys: [], grants: [] };
    if (m.profile && typeof m.profile === 'object' && Buffer.byteLength(JSON.stringify(m.profile)) < 200000) { a.profile = m.profile; a.pAt = Date.now(); }
    const key = newSession(a); kvSet(acctKey(lower), a); bindAcct(c, a); return acctReply(a, key);
  }
  if (m.t === 'acct_login') {
    if (!validName(m.name)) return { error: 'Wrong username or password' };
    const a = await kvGet(acctKey(m.name)); if (!a || pwHash(m.pw || '', a.salt) !== a.hash) return { error: 'Wrong username or password' };
    if (a.banned) return { error: 'This account is banned' };
    const key = newSession(a); kvSet(acctKey(a.lower), a); bindAcct(c, a); return acctReply(a, key);
  }
  if (m.t === 'acct_resume') {
    if (!validName(m.name) || typeof m.key !== 'string') return { error: 'bad' };
    const lower = m.name.toLowerCase(); let a = await kvGet(acctKey(lower));
    if (!a) {   // the server forgot (restart without a database): rebuild the account from the player's device
      if (lower === DD_OWNER && !isDDOwnerCode(m.oc)) return { error: 'gone' };
      if (!m.rec || typeof m.rec.salt !== 'string' || typeof m.rec.hash !== 'string') return { error: 'gone' };
      a = { name: m.name, lower, salt: m.rec.salt.slice(0, 64), hash: m.rec.hash.slice(0, 128), owner: lower === DD_OWNER, created: Date.now(), keys: [sha(m.key)], grants: [] };
      if (m.profile && typeof m.profile === 'object' && Buffer.byteLength(JSON.stringify(m.profile)) < 200000) { a.profile = m.profile; a.pAt = Date.now(); }
      kvSet(acctKey(lower), a);
    }
    if (!(a.keys || []).includes(sha(m.key))) return { error: 'Please log in again' };
    if (a.banned) return { error: 'This account is banned' };
    bindAcct(c, a); const r = acctReply(a, m.key); kvSet(acctKey(lower), a); return r;
  }
  if (m.t === 'acct_save') {
    if (!c.acct || !m.profile || typeof m.profile !== 'object' || Buffer.byteLength(JSON.stringify(m.profile)) > 200000) return { error: 'not saved' };
    const a = await kvGet(acctKey(c.acct)); if (!a) return { error: 'gone' };
    a.profile = m.profile; a.pAt = Date.now(); kvSet(acctKey(c.acct), a); return { ok: true };
  }
  // ---------- owner tools (only the owner account)
  if (!m.t.startsWith('own_')) return null;
  if (!c.ddOwner) return { error: 'Only the owner can do that' };
  if (m.t === 'own_list') { const out = []; for (const [lower, set] of online) if (set.size) { const x = [...set][0]; out.push(x.acctName || lower); } return { ok: true, players: out }; }
  if (m.t === 'own_event' && m.kind === 'double') {   // double Erasers for everyone for a few hours
    const hrs = Math.max(0, Math.min(72, +m.n || 0)); EVENTS.double = hrs ? Date.now() + hrs * 3600000 : 0; kvSet('dd:events', EVENTS);
    for (const x of clients) send(x, { t: 'event', kind: 'double', until: EVENTS.double, by: c.acctName });
    return { ok: true };
  }
  if (m.t === 'own_event') {
    const kind = ['rain', 'crates'].includes(m.kind) ? m.kind : 'rain', n = Math.max(5, Math.min(200, m.n | 0 || 40));
    for (const x of clients) send(x, { t: 'event', kind, n, seed: Math.floor(Math.random() * 1e9), by: c.acctName });
    return { ok: true };
  }
  if (!validName(m.to)) return { error: 'Type a username' };
  const a = await kvGet(acctKey(m.to)); if (!a) return { error: 'No account called ' + m.to };
  const tell = msg => { for (const x of online.get(a.lower) || []) send(x, msg); };
  if (m.t === 'own_give' || m.t === 'own_spin' || m.t === 'own_crates') {
    const g = m.t === 'own_give' ? { erasers: Math.max(-1e6, Math.min(1e6, m.n | 0)) } : m.t === 'own_crates' ? { crates: Math.max(1, Math.min(1000, m.n | 0)), kind: ['sketchy', 'prism', 'notebook', 'winter'].includes(m.kind) ? m.kind : 'sketchy' } : { spin: String(m.tier || 'mythic').slice(0, 20) };
    g.from = c.acctName;
    if ((online.get(a.lower) || new Set()).size) tell({ t: 'grant', g }); else { a.grants = [...(a.grants || []), g].slice(-50); kvSet(acctKey(a.lower), a); }
    return { ok: true };
  }
  if (m.t === 'own_ban') {
    if (a.owner) return { error: 'You can\'t ban the owner' };
    a.banned = !!m.on; a.keys = m.on ? [] : a.keys; kvSet(acctKey(a.lower), a);
    if (m.on) for (const x of online.get(a.lower) || []) { send(x, { t: 'acct_banned' }); setTimeout(() => { try { x.ws.close(); } catch (e) {} }, 300); }
    return { ok: true };
  }
  if (m.t === 'own_mute') { a.muted = !!m.on; kvSet(acctKey(a.lower), a); for (const x of online.get(a.lower) || []) { x.muted = a.muted; send(x, { t: 'muted', on: a.muted }); } return { ok: true }; }
  return { error: 'unknown' };
}
// chat filter: swear words, links, phone numbers
const BAD_WORDS = ['fuck', 'fuk', 'fck', 'shit', 'bitch', 'bastard', 'cunt', 'dick', 'pussy', 'asshole', 'slut', 'whore', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kys', 'rape', 'porn', 'sex', 'nazi', 'wank', 'twat', 'bollocks', 'cock', 'penis', 'vagina', 'boob', 'tits'];
const BAD_RE = new RegExp(BAD_WORDS.map(w => w.split('').join('[^a-z0-9]?')).join('|'), 'i');
function cleanChat(t) {
  t = String(t || '').slice(0, 90);
  t = t.replace(/(https?:\/\/|www\.)\S+|\b\S+\.(com|net|org|gg|io|xyz|ru|ly)\b\S*/gi, '[link removed]');
  t = t.replace(/\d[\d\s-]{6,}\d/g, '###');
  for (const w of BAD_WORDS) t = t.replace(new RegExp(w.split('').join('[^a-z0-9]?'), 'gi'), s => '#'.repeat(s.length));
  return t;
}

function lbGet(c) {
  const wk = weekNow(), cur = LB.weeks[wk] || {}, prev = LB.weeks[wk - 1] || {};
  const rows = (obj, key) => Object.entries(obj).map(([id, r]) => [id, r.n, r[key] | 0]).filter(r => r[2] > 0).sort((a, b) => b[2] - a[2]);
  const pack = (obj, key) => { const all = rows(obj, key), i = all.findIndex(r => r[0] === c.uid); return { top: all.slice(0, 25).map(r => [r[0] === c.uid ? 1 : 0, r[1], r[2]]), me: i + 1, total: all.length }; };
  const place = (obj, key) => rows(obj, key).findIndex(r => r[0] === c.uid) + 1;
  return { wk, boards: { ww: pack(cur, 'w'), wpt: pack(cur, 'pt'), aw: pack(LB.players, 'aw'), k: pack(LB.players, 'k'), bs: pack(LB.players, 'bs'), rg: pack(LB.players, 'rg') },
    prev: { wk: wk - 1, ww: place(prev, 'w'), wpt: place(prev, 'pt'), total: Object.keys(prev).length } };
}

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
  if (Array.isArray(patch.cm)) { if (c.muted) delete patch.cm; else patch.cm = patch.cm.slice(0, 6).map(x => Array.isArray(x) ? [x[0], String(x[1] || '').slice(0, 20), cleanChat(x[2]), x[3]] : x); }
  if ('og' in patch && !c.ddOwner) delete patch.og;
  if (c.acctName && typeof patch.n === 'string') patch.n = c.acctName;
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
  res.end(`Doodle Duels server is running (build ${SERVER_BUILD}). Play at / .\nPlayers online: ${lobby ? lobby.size : 0}\nMatches running: ${Math.max(0, rooms.size - 1)}\nSaved data: ${UP_URL && UP_TOK ? 'permanent database (Upstash) connected' : 'temporary (resets when the server restarts)'}\n`);
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
      case 'acct_create': case 'acct_login': case 'acct_resume': case 'acct_save': case 'own_list': case 'own_event': case 'own_give': case 'own_spin': case 'own_crates': case 'own_ban': case 'own_mute':
        acctMsg(c, m).then(r => { if (r && r.ok && (m.t === 'acct_resume' || m.t === 'acct_login' || m.t === 'acct_create')) { kvGet(acctKey(c.acct)).then(a => { c.muted = !!(a && a.muted); }); } send(c, { t: 'reply', rid: m.rid, data: r }); }).catch(e => send(c, { t: 'reply', rid: m.rid, data: { error: 'server error' } })); break;
      case 'fr_status': {   // which of these account names are online right now
        const out = {}; for (const n of (Array.isArray(m.names) ? m.names.slice(0, 60) : [])) { if (typeof n !== 'string') continue; const l = n.toLowerCase().slice(0, 16); const set = online.get(l); out[l] = !!(set && set.size); }
        send(c, { t: 'reply', rid: m.rid, data: out }); break;
      }
      case 'fr_invite': {   // invite a friend (by account name) to your private game code
        let r = { error: 'Log in to invite friends' };
        if (c.acct && typeof m.to === 'string' && /^dd-[a-z0-9]{3,12}$/.test(String(m.code || '')) && Date.now() - (c.invAt || 0) > 2500) {
          c.invAt = Date.now(); const set = online.get(m.to.toLowerCase().slice(0, 16));
          if (set && set.size) { for (const x of set) send(x, { t: 'invite', from: c.acctName, code: m.code, size: Math.max(1, Math.min(5, m.size | 0)) }); r = { ok: true }; } else r = { error: 'They are offline' };
        } else if (c.acct) r = { error: 'Slow down a little' };
        send(c, { t: 'reply', rid: m.rid, data: r }); break;
      }
      case 'ev_get': send(c, { t: 'reply', rid: m.rid, data: { double: EVENTS.double || 0 } }); break;
      case 'lb_put': { if (Date.now() - (c.lbAt || 0) > 5000) { c.lbAt = Date.now(); lbPut(c, m); } send(c, { t: 'reply', rid: m.rid, data: true }); break; }
      case 'lb_get': send(c, { t: 'reply', rid: m.rid, data: lbGet(c) }); break;
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
  ws.on('close', () => { for (const name of [...c.rooms.keys()]) leaveRoom(c, name); clients.delete(c); if (c.acct && online.get(c.acct)) online.get(c.acct).delete(c); });
});

// refill flood budgets, drop dead connections
const iv1 = setInterval(() => { for (const c of clients) c.budget = RATE; }, 1000);
const iv3 = setInterval(() => { if (lbDirty) { lbDirty = false; saveDB(); if (UP_URL && UP_TOK) kvSet('lb', LB); } }, 30000);
if (UP_URL && UP_TOK) kvGet('lb').then(v => { if (v && v.players) { Object.assign(LB.players, v.players); Object.assign(LB.weeks, v.weeks || {}); } });
const iv2 = setInterval(() => { for (const c of clients) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) {} } }, 20000);

return new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, opt.host || '0.0.0.0', () => { const port = server.address().port; if (!opt.quiet) console.log('Chaos Anchor server listening on port ' + port + (OWNER_ID ? ' · owner ' + OWNER_ID : ' · no OWNER_ID set yet'));
    resolve({ port, players: () => clients.size, close() { clearInterval(iv1); clearInterval(iv2); clearInterval(iv3); for (const c of clients) { try { c.ws.terminate(); } catch (e) {} } try { wss.close(); } catch (e) {} return new Promise(r => server.close(() => r())); } }); });
});
}
module.exports = { start };
if (require.main === module) start().catch(e => { console.error(e.message); process.exit(1); });
