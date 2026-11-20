const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const rooms = new Map();
const sockets = new Set();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const colors = ['#ff705d', '#77c4ac', '#e9b44c', '#9d8add', '#63a6d8', '#e78bb4', '#a9bd59', '#da8958'];

function json(client, type, data = {}) { sendFrame(client.socket, JSON.stringify({ type, ...data })); }
function sendFrame(socket, body) {
  if (socket.destroyed) return;
  const payload = Buffer.from(body);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}
function sendControlFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  const body = Buffer.from(payload);
  if (body.length > 125) return;
  const header = Buffer.from([0x80 | opcode, body.length]);
  socket.write(Buffer.concat([header, body]));
}
function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0], second = client.buffer[1];
    let len = second & 0x7f, offset = 2;
    if (len === 126) { if (client.buffer.length < 4) return; len = client.buffer.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (client.buffer.length < 10) return; const longLen = client.buffer.readBigUInt64BE(2); if (longLen > 1000000n) { client.socket.destroy(); return; } len = Number(longLen); offset = 10; }
    const masked = (second & 0x80) !== 0;
    if (masked) offset += 4;
    if (client.buffer.length < offset + len) return;
    let payload = client.buffer.subarray(offset, offset + len);
    if (masked) {
      const mask = client.buffer.subarray(offset - 4, offset);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    client.buffer = client.buffer.subarray(offset + len);
    const opcode = first & 0x0f;
    if (opcode === 8) { sendControlFrame(client.socket, 8, payload); client.socket.end(); return; }
    if (opcode === 9) { sendControlFrame(client.socket, 10, payload); continue; }
    if (opcode === 10) { client.lastPongAt = Date.now(); continue; }
    if (opcode !== 1) continue;
    try { handle(client, JSON.parse(payload.toString('utf8'))); }
    catch { json(client, 'error', { message: 'That message could not be read.' }); }
  }
}

function cleanName(value) {
  const name = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Player';
}
function newCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
  return code;
}
function roomView(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, host: p.id === room.hostId, color: p.color, status: p.status || 'waiting', score: p.score || 0, lines: p.lines || 0, combo: p.combo || 0, marginUntil: p.marginUntil || 0, board: p.board || null, active: p.active || null, piecesPlaced: p.piecesPlaced || 0 }));
}
function broadcast(room, type, data = {}) {
  const packet = { type, roomCode: room.code, ...data };
  for (const p of room.players) if (p.client) json(p.client, type, { ...packet, players: roomView(room) });
}
function getRoom(client) { return client.roomCode ? rooms.get(client.roomCode) : null; }
function getPlayer(room, client) { return room && room.players.find(p => p.id === client.playerId); }

const cards = [
  ['EDU', 'BA Economics', 'Education', ''], ['EDU', 'May 2027', 'Education', ''], ['EDU', 'GPA 3.7', 'Education', ''], ['EDU', 'Dean’s List', 'Education', ''],
  ['EDU', 'Data Science minor', 'Education', ''], ['EDU', 'Research methods', 'Education', ''], ['EDU', 'State University', 'Education', ''], ['EDU', 'Honors program', 'Education', ''],
  ['EXP', 'Career peer mentor', 'Experience', 'Guided'], ['EXP', '12 students / week', 'Experience', 'Guided'], ['EXP', 'Reviewed 80 resumes', 'Experience', 'Reviewed'], ['EXP', 'Raised event turnout 30%', 'Experience', 'Increased'],
  ['EXP', 'Campus bookstore', 'Experience', 'Managed'], ['EXP', 'Trained 4 new hires', 'Experience', 'Trained'], ['EXP', 'Spring 2025', 'Experience', ''], ['EXP', 'Customer service', 'Experience', 'Resolved'],
  ['SKL', 'Excel · SQL', 'Skills', ''], ['SKL', 'Figma · Canva', 'Skills', ''], ['SKL', 'Spanish · English', 'Skills', ''], ['SKL', 'Public speaking', 'Skills', 'Presented'],
  ['SKL', 'Research · writing', 'Skills', 'Analyzed'], ['SKL', 'Project planning', 'Skills', 'Coordinated'], ['SKL', 'Google Workspace', 'Skills', ''], ['SKL', 'Power BI basics', 'Skills', ''],
  ['PRJ', 'Budget tracker app', 'Projects', 'Built'], ['PRJ', 'Team of 3', 'Projects', 'Collaborated'], ['PRJ', 'Used 400 survey rows', 'Projects', 'Analyzed'], ['PRJ', 'Won campus showcase', 'Projects', 'Presented'],
  ['PRJ', 'Food access map', 'Projects', 'Designed'], ['PRJ', 'Mapped 25 resources', 'Projects', 'Mapped'], ['PRJ', 'Student org website', 'Projects', 'Created'], ['PRJ', '2,000 visits / month', 'Projects', 'Increased'],
  ['EXP', 'Volunteer coordinator', 'Experience', 'Organized'], ['EXP', 'Scheduled 18 volunteers', 'Experience', 'Scheduled'], ['PRJ', 'Career fair guide', 'Projects', 'Authored'], ['PRJ', '40 employers listed', 'Projects', 'Connected'],
  ['SKL', 'Tableau · Python', 'Skills', 'Visualized'], ['EDU', 'Statistics · UX design', 'Education', ''], ['EXP', 'Summer 2024', 'Experience', ''], ['PRJ', 'Prototype tested by 20 peers', 'Projects', 'Tested']
];
function networkAddressInfo() {
  const entries = Object.entries(os.networkInterfaces()).flatMap(([name, rows]) => (rows || []).filter(item => item.family === 'IPv4' && !item.internal).map(item => ({ name, address: item.address })));
  const wifi = entries.find(item => /wi[- ]?fi|wireless|wlan/i.test(item.name));
  const ordered = wifi ? [wifi, ...entries.filter(item => item.address !== wifi.address)] : entries;
  return { addresses: ordered.map(item => `http://${item.address}:${PORT}`), preferred: ordered[0] ? `http://${ordered[0].address}:${PORT}` : `http://localhost:${PORT}` };
}
function requestOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto === 'https' ? 'https' : (forwardedProto === 'http' ? 'http' : 'http');
  return host && /^[a-z0-9.:[\]-]+$/i.test(host) ? `${protocol}://${host}` : '';
}
const shapes = [
  [[0,0],[1,0],[2,0],[3,0]], [[0,0],[0,1],[0,2],[1,2]], [[1,0],[1,1],[1,2],[0,2]],
  [[0,0],[1,0],[0,1],[1,1]], [[1,0],[2,0],[0,1],[1,1]], [[1,0],[0,1],[1,1],[2,1]], [[0,0],[1,0],[1,1],[2,1]]
];
function shuffled(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
function makePacketPool() {
  const deck = shuffled(cards);
  const full = Array.from({ length: 5 }, (_, i) => [...deck.map(c => ({ cat: c[0], text: c[1], section: c[2], verb: c[3] }))]);
  const pieces = full.flat();
  return Array.from({ length: 36 }, (_, i) => ({ index: i, shape: shapes[i % shapes.length], cells: pieces.slice(i * 4, i * 4 + 4) }));
}
function startRoom(room) {
  if (room.state !== 'lobby' || room.players.length < 2) return;
  room.state = 'playing'; room.startedAt = Date.now();
  const packetPool = makePacketPool(), openingPackets = new Set();
  for (const p of room.players) {
    p.score = 0; p.lines = 0; p.combo = 0; p.status = 'playing'; p.board = null; p.active = null; p.piecesPlaced = 0; p.marginUntil = 0;
    if (p.client) {
      let packets = shuffled(packetPool);
      while (openingPackets.has(packets[0].index)) packets = shuffled(packetPool);
      openingPackets.add(packets[0].index);
      json(p.client, 'game_started', { roomCode: room.code, playerId: p.id, players: roomView(room), packets });
    }
  }
  broadcast(room, 'players_update');
}
function endIfDone(room) {
  if (room.state !== 'playing' || room.players.some(p => p.status === 'playing')) return;
  room.state = 'results';
  const results = room.players.map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score || 0, lines: p.lines || 0, status: p.status || 'out', piecesPlaced: p.piecesPlaced || 0 })).sort((a,b) => b.score - a.score);
  broadcast(room, 'game_over', { results });
}

function handle(client, msg) {
  if (msg.type === 'heartbeat') { json(client, 'heartbeat_ack'); return; }
  if (msg.type === 'create_room') {
    if (client.roomCode) return;
    const room = { code: newCode(), hostId: client.playerId, state: 'lobby', players: [] };
    const player = { id: client.playerId, name: cleanName(msg.name), client, color: colors[0], ready: true };
    client.roomCode = room.code; room.players.push(player); rooms.set(room.code, room);
    json(client, 'room_joined', { roomCode: room.code, playerId: player.id, hostId: room.hostId, players: roomView(room) });
    broadcast(room, 'lobby_update'); return;
  }
  if (msg.type === 'join_room') {
    if (client.roomCode) return;
    const room = rooms.get(String(msg.code || '').toUpperCase());
    if (!room || room.state !== 'lobby') return json(client, 'error', { message: 'That room is closed or the code is not right.' });
    if (room.players.length >= 8) return json(client, 'error', { message: 'This room already has 8 players.' });
    const player = { id: client.playerId, name: cleanName(msg.name), client, color: colors[room.players.length % colors.length], ready: true };
    client.roomCode = room.code; room.players.push(player);
    json(client, 'room_joined', { roomCode: room.code, playerId: player.id, hostId: room.hostId, players: roomView(room) });
    broadcast(room, 'lobby_update'); return;
  }
  const room = getRoom(client), player = getPlayer(room, client);
  if (!room || !player) return;
  if (msg.type === 'ready') { player.ready = !!msg.ready; broadcast(room, 'lobby_update'); return; }
  if (msg.type === 'start_game') {
    if (player.id !== room.hostId) return json(client, 'error', { message: 'Only the host can start the game.' });
    if (room.players.length < 2) return json(client, 'error', { message: 'Invite at least one more player first.' });
    startRoom(room); return;
  }
  if (msg.type === 'player_update' && room.state === 'playing' && player.status === 'playing') {
    player.score = Number(msg.score) || 0; player.lines = Number(msg.lines) || 0; player.combo = Number(msg.combo) || 0;
    player.status = ['playing','out','done'].includes(msg.status) ? msg.status : 'playing';
    player.board = Array.isArray(msg.board) ? msg.board : null; player.active = msg.active || null; player.piecesPlaced = Number(msg.piecesPlaced) || 0; player.marginUntil = Number(msg.marginUntil) || 0;
    broadcast(room, 'players_update'); endIfDone(room); return;
  }
  if (msg.type === 'attack' && room.state === 'playing') {
    const targets = room.players.filter(p => p.id !== player.id && p.status === 'playing' && p.client);
    if (targets.length) {
      const target = targets[crypto.randomInt(targets.length)]; target.marginUntil = Date.now() + 10000;
      json(target.client, 'margin_attack', { from: player.name, until: target.marginUntil });
      broadcast(room, 'attack_feed', { attacker: player.name, target: target.name });
    }
    return;
  }
}

function leave(client) {
  sockets.delete(client);
  const room = getRoom(client); if (!room) return;
  const idx = room.players.findIndex(p => p.id === client.playerId);
  if (idx >= 0) {
    const [player] = room.players.splice(idx, 1);
    if (room.state === 'playing') player.status = 'out';
  }
  if (!room.players.length) rooms.delete(room.code);
  else {
    if (room.hostId === client.playerId) room.hostId = room.players[0].id;
    broadcast(room, room.state === 'lobby' ? 'lobby_update' : 'players_update'); endIfDone(room);
  }
  client.roomCode = null;
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end('Bad request'); return; }
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('ok'); return; }
  if (pathname === '/__resume_rush_info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    const info = networkAddressInfo();
    res.end(JSON.stringify({ ...info, preferred: requestOrigin(req) || info.preferred })); return;
  }
  let target = path.resolve(ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  });
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { socket, buffer: Buffer.alloc(0), playerId: crypto.randomUUID(), roomCode: null, lastPongAt: Date.now() };
  sockets.add(client); socket.on('data', chunk => parseFrames(client, chunk)); socket.on('close', () => leave(client)); socket.on('error', () => leave(client));
});

const keepalive = setInterval(() => {
  const now = Date.now();
  for (const client of sockets) {
    if (now - client.lastPongAt > 65000) { client.socket.destroy(); continue; }
    sendControlFrame(client.socket, 9);
  }
}, 30000);
keepalive.unref();

server.listen(PORT, HOST, () => {
  console.log(`Resume Rush is ready at http://localhost:${PORT}`);
  const addresses = networkAddressInfo().addresses;
  if (addresses.length) console.log('On the same Wi-Fi, use: ' + addresses.join('  |  '));
  else console.log('For phones on the same Wi-Fi, open this computer’s local network address on port ' + PORT + '.');
  console.log('Press Ctrl+C to stop the game server.');
});
