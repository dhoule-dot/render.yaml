(() => {
  const $ = (id) => document.getElementById(id);
  const screens = ['home-screen', 'lobby-screen', 'game-screen', 'results-screen'];
  const state = { ws: null, connected: false, inviteOrigin: location.origin, roomCode: '', playerId: '', name: '', isHost: false, players: [], packets: [], packetIndex: 0, board: [], active: null, score: 0, lines: 0, combo: 0, piecesPlaced: 0, status: 'waiting', marginUntil: 0, timer: null, lastSent: 0, matchEnded: false, justAttacked: false, pendingJoin: '', attackEntries: [], packetCats: new Set(), message: '' };
  const colors = { EDU: '#b9d091', EXP: '#e9a886', SKL: '#edd084', PRJ: '#9fc6c1' };
  const ROWS = 20, COLS = 10;

  function showScreen(id) { for (const screen of screens) $(screen).classList.toggle('active', screen === id); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  let toastTimer;
  function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2700); }
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { state.ws = new WebSocket(`${protocol}//${location.host}`); }
    catch { $('connection-label').textContent = 'SERVER NOT FOUND'; return; }
    state.ws.addEventListener('open', () => { state.connected = true; $('connection-label').textContent = 'CONNECTED'; document.querySelector('.top-meta .live-dot').style.background = '#83b58c'; });
    state.ws.addEventListener('close', () => { state.connected = false; $('connection-label').textContent = 'DISCONNECTED'; document.querySelector('.top-meta .live-dot').style.background = '#ef705b'; if (!state.matchEnded) toast('Connection lost. Refresh to rejoin the game.'); });
    state.ws.addEventListener('error', () => { state.connected = false; $('connection-label').textContent = 'RECONNECTING'; });
    state.ws.addEventListener('message', event => { let msg; try { msg = JSON.parse(event.data); } catch { return; } handleMessage(msg); });
    if (location.protocol !== 'file:') fetch('/__resume_rush_info').then(r => r.json()).then(info => { if (info.preferred) state.inviteOrigin = info.preferred; }).catch(() => {});
  }
  function send(type, data = {}) { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type, ...data })); }
  setInterval(() => { if (state.connected) send('heartbeat'); }, 25000);
  function askName() {
    const remembered = sessionStorage.getItem('resume-rush-name') || '';
    const entered = window.prompt('What name should the crew see?', remembered || '');
    if (entered === null) return '';
    const name = entered.trim().slice(0, 18) || 'Player';
    sessionStorage.setItem('resume-rush-name', name); state.name = name; return name;
  }
  function readyToCreate() { if (state.ws?.readyState === WebSocket.OPEN) return true; toast('Game server not connected. Start the server, then open its web address (not the HTML file).'); return false; }
  function beginCreate() { if (!readyToCreate()) return; const name = askName(); if (name) send('create_room', { name }); }
  function beginJoin(code) { if (!readyToCreate()) return; const name = askName(); if (name) send('join_room', { name, code: code.trim().toUpperCase() }); }
  function handleMessage(msg) {
    if (msg.type === 'error') { toast(msg.message || 'Something went wrong.'); return; }
    if (msg.type === 'room_joined') {
      state.roomCode = msg.roomCode; state.playerId = msg.playerId; state.players = msg.players || []; state.isHost = !!state.players.find(p => p.id === state.playerId)?.host;
      $('lobby-room-code').textContent = state.roomCode; $('big-room-code').textContent = state.roomCode; $('results-room-code').textContent = state.roomCode;
      showScreen('lobby-screen'); renderLobby(); return;
    }
    if (msg.type === 'lobby_update') { state.players = msg.players || state.players; state.isHost = !!state.players.find(p => p.id === state.playerId)?.host; renderLobby(); return; }
    if (msg.type === 'game_started') { startGame(msg); return; }
    if (msg.type === 'players_update') { state.players = msg.players || state.players; renderPlayers(); return; }
    if (msg.type === 'margin_attack') { state.marginUntil = msg.until; state.justAttacked = true; $('board-shell').classList.add('attacked'); $('game-status').textContent = `${msg.from.toUpperCase()} SHRANK YOUR MARGINS`; pushFeed(`<b>${escapeHtml(msg.from)}</b> sent you a margin squeeze.`); toast('Margin squeeze! The board is tighter for 10 seconds.'); renderBoard(); sendUpdate(); setTimeout(() => $('board-shell').classList.remove('attacked'), 520); return; }
    if (msg.type === 'attack_feed') { pushFeed(`<b>${escapeHtml(msg.attacker)}</b> squeezed <b>${escapeHtml(msg.target)}</b>’s margins.`); return; }
    if (msg.type === 'game_over') { finishGame(msg.results || []); return; }
  }
  function renderLobby() {
    $('roster-count').textContent = state.players.length;
    $('roster-list').innerHTML = state.players.map(p => `<div class="roster-person"><span class="roster-avatar" style="background:${p.color}">${escapeHtml((p.name || '?').slice(0,1).toUpperCase())}</span><span>${escapeHtml(p.name)}${p.id === state.playerId ? '<i class="you-tag">YOU</i>' : ''}</span>${p.host ? '<span class="host-badge">HOST</span>' : ''}<span class="ready-badge">READY ✓</span></div>`).join('');
    const canStart = state.isHost && state.players.length >= 2;
    $('start-game-button').disabled = !canStart;
    $('start-game-button').innerHTML = state.isHost ? 'Start the challenge <span>↗</span>' : 'Waiting for host <span>…</span>';
    $('lobby-hint').textContent = state.players.length < 2 ? 'Waiting for one more builder…' : (state.isHost ? 'Everyone’s in. Ready when you are.' : 'The host can start when the crew is ready.');
  }

  function startGame(msg) {
    state.roomCode = msg.roomCode; state.playerId = msg.playerId; state.players = msg.players || []; state.isHost = !!state.players.find(p => p.id === state.playerId)?.host;
    state.packets = msg.packets || []; state.packetIndex = 0; state.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null)); state.active = null; state.score = 0; state.lines = 0; state.combo = 0; state.piecesPlaced = 0; state.status = 'playing'; state.marginUntil = 0; state.matchEnded = false; state.penaltyApplied = false; state.packetCats = new Set(); state.attackEntries = [];
    $('game-room-code').textContent = state.roomCode; $('game-player-count').textContent = String(state.players.length).padStart(2, '0'); $('attack-log-items').innerHTML = '<p>Match a verb to send someone a margin squeeze.</p>';
    showScreen('game-screen'); spawn(); render(); sendUpdate(); clearInterval(state.timer); state.timer = setInterval(tick, 690);
  }
  function clonePacket(packet) { return { shape: packet.shape.map(p => [...p]), cells: packet.cells.map(c => ({ ...c })) }; }
  function spawn() {
    if (state.packetIndex >= state.packets.length) { state.status = 'done'; state.active = null; applyFinalPenalty(); render(); sendUpdate(); return; }
    const packet = clonePacket(state.packets[state.packetIndex++]);
    const maxX = Math.max(...packet.shape.map(p => p[0]));
    state.active = { shape: packet.shape, cells: packet.cells, x: Math.max(0, Math.floor((COLS - maxX - 1) / 2)), y: 0 };
    if (!valid(state.active, 0, 0, false)) { state.status = 'out'; state.active = null; applyFinalPenalty(); render(); sendUpdate(); return; }
    updateNext();
  }
  function valid(piece, dx, dy, useMargins = true) {
    const restricted = useMargins && Date.now() < state.marginUntil;
    for (const [x, y] of piece.shape) {
      const nx = piece.x + x + dx, ny = piece.y + y + dy;
      if (nx < (restricted ? 1 : 0) || nx >= (restricted ? COLS - 1 : COLS) || ny >= ROWS) return false;
      if (ny >= 0 && state.board[ny][nx]) return false;
    }
    return true;
  }
  function act(key) {
    if (state.status !== 'playing' || !state.active) return;
    if (key === 'ArrowLeft' || key === 'ArrowRight') { const dx = key === 'ArrowLeft' ? -1 : 1; if (valid(state.active, dx, 0)) state.active.x += dx; }
    else if (key === 'ArrowDown') { if (valid(state.active, 0, 1)) { state.active.y++; state.score++; } else lockPiece(); }
    else if (key === 'Space') { let dist = 0; while (valid(state.active, 0, 1)) { state.active.y++; dist++; } state.score += dist * 2; lockPiece(); }
    else if (key === 'ArrowUp' || key.toLowerCase() === 'q' || key.toLowerCase() === 'e') rotatePiece();
    render(); sendUpdate();
  }
  function rotatePiece() {
    const width = Math.max(...state.active.shape.map(p => p[0])) + 1;
    const height = Math.max(...state.active.shape.map(p => p[1])) + 1;
    const mapped = state.active.shape.map(([x,y], i) => ({ p: [height - 1 - y, x], cell: state.active.cells[i] }));
    const minX = Math.min(...mapped.map(a => a.p[0])), minY = Math.min(...mapped.map(a => a.p[1]));
    const shape = mapped.map(a => [a.p[0]-minX, a.p[1]-minY]);
    const cells = mapped.map(a => a.cell);
    const trial = { ...state.active, shape, cells };
    const newWidth = Math.max(...shape.map(p => p[0])) + 1;
    const shiftedX = Math.min(trial.x, COLS - newWidth);
    trial.x = Math.max(Date.now() < state.marginUntil ? 1 : 0, shiftedX);
    if (valid(trial, 0, 0)) state.active = trial;
  }
  function lockPiece() {
    if (!state.active) return;
    let above = false;
    state.active.shape.forEach(([x,y], i) => {
      const gx = state.active.x + x, gy = state.active.y + y;
      if (gy < 0) above = true; else state.board[gy][gx] = { ...state.active.cells[i], color: colors[state.active.cells[i].cat] || '#c8c6b3' };
    });
    state.piecesPlaced++;
    if (above) { state.status = 'out'; state.active = null; applyFinalPenalty(); render(); sendUpdate(); return; }
    state.score += 10 * 4;
    for (const cell of state.active.cells) if (!state.packetCats.has(cell.cat)) { state.packetCats.add(cell.cat); state.score += 65; }
    const full = state.board.filter(row => row.every(Boolean));
    if (full.length) {
      const matched = full.some(row => { const verbs = row.map(c => c.verb).filter(Boolean); return verbs.length >= 3 && verbs.every(v => v === verbs[0]); });
      state.lines += full.length;
      const base = [0,100,260,440,700][Math.min(full.length,4)];
      if (matched) { state.combo = Math.min(state.combo + 1, 9); state.score += base * (1 + state.combo) + 100; send('attack'); toast(`Verb combo ×${1 + state.combo}! A random rival gets squeezed.`); }
      else { state.score += base; state.combo = 0; }
      state.board = state.board.filter(row => !row.every(Boolean));
      while (state.board.length < ROWS) state.board.unshift(Array(COLS).fill(null));
      pushFeed(matched ? `<b>Verb match!</b> ×${1 + state.combo} combo — a random rival is squeezed.` : `<b>${full.length} line${full.length > 1 ? 's' : ''} cleared.</b> Nice fit.`);
    }
    state.active = null;
    if (state.packetIndex >= state.packets.length) { state.status = 'done'; applyFinalPenalty(); render(); sendUpdate(); return; }
    spawn(); render(); sendUpdate();
  }
  function applyFinalPenalty() { if (state.penaltyApplied) return; state.penaltyApplied = true; const holes = countHoles(); state.score = Math.max(0, state.score - holes * 12); if (state.status === 'done') state.score += Math.max(0, 200 - state.piecesPlaced * 2); }
  function countHoles() {
    let holes = 0;
    for (let x = 0; x < COLS; x++) { let blockSeen = false; for (let y = 0; y < ROWS; y++) { if (state.board[y][x]) blockSeen = true; else if (blockSeen) holes++; } }
    return holes;
  }
  function tick() {
    if (state.status !== 'playing' || !state.active) return;
    if (Date.now() >= state.marginUntil && state.marginUntil) { state.marginUntil = 0; $('game-status').textContent = 'MARGINS BACK TO NORMAL'; }
    if (valid(state.active, 0, 1)) state.active.y++; else lockPiece();
    render(); sendUpdate();
  }
  function cellElement(cell, x, y, cls = 'locked') {
    const el = document.createElement('div'); el.className = `cell ${cls}`; el.style.setProperty('--x', x + 1); el.style.setProperty('--y', y + 1); el.style.setProperty('--c', cell.color || colors[cell.cat] || '#c8c6b3'); el.title = cell.text || cell.cat;
    const code = document.createElement('span'); code.className = 'cell-code'; code.textContent = cell.cat; el.appendChild(code); return el;
  }
  function renderBoard() {
    const board = $('board'); board.innerHTML = '';
    for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++) if (state.board[y]?.[x]) board.appendChild(cellElement(state.board[y][x], x, y, 'locked'));
    if (state.active) {
      let gy = state.active.y; while (valid(state.active, 0, gy - state.active.y + 1)) gy++;
      state.active.shape.forEach(([x,y], i) => { const py = state.active.y + y + (gy - state.active.y); const px = state.active.x + x; if (py >= 0 && py < ROWS) board.appendChild(cellElement(state.active.cells[i], px, py, 'ghost')); });
      state.active.shape.forEach(([x,y], i) => { const py = state.active.y + y, px = state.active.x + x; if (py >= 0 && py < ROWS) board.appendChild(cellElement(state.active.cells[i], px, py, 'current')); });
    }
    const underAttack = Date.now() < state.marginUntil;
    $('left-mask').classList.toggle('active', underAttack); $('right-mask').classList.toggle('active', underAttack); $('attack-banner').classList.toggle('active', underAttack);
    if (underAttack) { const remaining = Math.max(0, Math.ceil((state.marginUntil - Date.now())/1000)); $('attack-banner').innerHTML = `MARGINS INCOMING <b>${String(remaining).padStart(2,'0')}</b>`; }
  }
  function updateNext() {
    const p = state.packets[state.packetIndex]; const el = $('next-preview'); el.innerHTML = '';
    if (!p) { $('next-description').textContent = 'That’s the last detail. Make this page count.'; return; }
    const maxX = Math.max(...p.shape.map(c=>c[0])), maxY = Math.max(...p.shape.map(c=>c[1]));
    el.style.gridTemplateColumns = `repeat(${maxX+1},20px)`; el.style.gridTemplateRows = `repeat(${maxY+1},20px)`;
    p.shape.forEach(([x,y],i) => { const tile=document.createElement('div'); tile.className='preview-cell'; tile.style.gridColumn=x+1; tile.style.gridRow=y+1; tile.style.background=colors[p.cells[i].cat] || '#c8c6b3'; tile.title=p.cells[i].text; el.appendChild(tile); });
    $('next-description').textContent = p.cells.map(c => `${c.cat} · ${c.text}`).join('  /  ') || 'A new resume detail is on the way.';
  }
  function renderPlayers() {
    const list = $('players-board'); if (!list) return;
    const others = state.players.filter(p => p.id !== state.playerId);
    list.innerHTML = others.map(p => {
      const attack = p.marginUntil > Date.now(); const playing = p.status === 'playing'; const progress = Math.min(100, Math.round((p.piecesPlaced || 0) / 36 * 100));
      return `<div class="opponent" style="--opp-color:${p.color}"><span class="op-avatar" style="background:${p.color}">${escapeHtml((p.name||'?').slice(0,1).toUpperCase())}</span><span>${escapeHtml(p.name)}${p.host ? ' <small>HOST</small>' : ''}</span><span class="opp-score">${Number(p.score||0).toLocaleString()}</span><span class="opp-state ${attack?'under-attack':''}">${attack?'MARGINS SQUEEZED':playing?'BUILDING':p.status==='out'?'PAGE FULL':'PACKET DONE'}</span><span class="opp-meter"><i style="width:${progress}%"></i></span></div>`;
    }).join('');
    $('game-player-count').textContent = String(state.players.length).padStart(2,'0');
  }
  function render() {
    renderBoard(); renderPlayers(); $('score-value').textContent = String(state.score).padStart(4,'0'); $('lines-count').innerHTML = `LINES <b>${String(state.lines).padStart(2,'0')}</b>`;
    $('pieces-count').innerHTML = `BLOCKS <b>${String(state.piecesPlaced).padStart(2,'0')} / ${String(state.packets.length).padStart(2,'0')}</b>`; $('combo-value').textContent = `×${1 + state.combo}`; $('combo-pill').classList.toggle('hot', state.combo > 0);
    if (state.status === 'playing') $('game-status').textContent = state.combo ? `VERB STREAK ×${1 + state.combo} — KEEP IT GOING` : 'YOUR NEXT BLOCK IS READY';
  }
  function sendUpdate() {
    const now = Date.now(); if (now - state.lastSent < 85) { clearTimeout(state.sendTimer); state.sendTimer = setTimeout(sendUpdate, 90); return; } state.lastSent = now;
    send('player_update', { score: state.score, lines: state.lines, combo: state.combo, status: state.status, board: state.board, active: state.active ? { shape: state.active.shape, x: state.active.x, y: state.active.y } : null, piecesPlaced: state.piecesPlaced, marginUntil: state.marginUntil });
  }
  function finishGame(results) {
    state.matchEnded = true; state.status = state.status === 'playing' ? 'done' : state.status; clearInterval(state.timer);
    const mine = results.findIndex(p => p.id === state.playerId); const winner = results[0];
    $('results-heading').innerHTML = mine === 0 ? 'You made it <em>fit.</em>' : `${escapeHtml(winner?.name || 'The crew')} takes the <em>lead.</em>`;
    $('results-subtitle').textContent = mine === 0 ? 'A tidy page and a well-timed verb. Nicely played.' : `${mine >= 0 ? `You placed #${mine+1}. ` : ''}Every good resume is a work in progress.`;
    $('podium').innerHTML = results.map((p,i) => `<div class="podium-card ${i===0?'winner':''}"><div class="podium-place">${['01 / FIRST PLACE','02 / RUNNER-UP','03 / BUILDER'][Math.min(i,2)]}</div><div class="podium-lines">${p.lines} LINES</div><div class="podium-name">${escapeHtml(p.name)}${p.id===state.playerId?' (YOU)':''}</div><div class="podium-score">${Number(p.score).toLocaleString()} pts · ${p.piecesPlaced} details</div></div>`).join('');
    showScreen('results-screen');
  }
  function pushFeed(html) { const box = $('attack-log-items'); const message = document.createElement('p'); message.innerHTML = html; box.prepend(message); while (box.children.length > 4) box.lastElementChild.remove(); }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('Copied. Send it to the crew!'); } catch { toast(text); } }

  $('create-button').addEventListener('click', beginCreate);
  $('join-scroll').addEventListener('click', () => { $('join-code').focus(); $('join-panel').scrollIntoView({ behavior:'smooth', block:'center' }); });
  $('join-form').addEventListener('submit', e => { e.preventDefault(); const code=$('join-code').value.trim().toUpperCase(); if (code.length !== 4) return toast('Enter the four-letter room code.'); beginJoin(code); });
  $('join-code').addEventListener('input', e => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g,''));
  $('start-game-button').addEventListener('click', () => send('start_game'));
  $('copy-code-button').addEventListener('click', () => copyText(state.roomCode));
  $('copy-link-button').addEventListener('click', () => copyText(`${state.inviteOrigin}${location.pathname}?room=${state.roomCode}`));
  $('leave-room-button').addEventListener('click', () => { location.href = location.pathname; });
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());
  $('dialog-close').addEventListener('click', () => $('help-dialog').close()); $('got-it-button').addEventListener('click', () => $('help-dialog').close());
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('help-dialog').open) { $('help-dialog').close(); return; }
    if (['ArrowLeft','ArrowRight','ArrowDown','ArrowUp',' '].includes(e.key)) e.preventDefault();
    if (e.key === ' ') act('Space'); else if (['ArrowLeft','ArrowRight','ArrowDown','ArrowUp'].includes(e.key) || ['q','e','Q','E'].includes(e.key)) act(e.key);
  });
  document.querySelectorAll('.mobile-controls button').forEach(btn => btn.addEventListener('click', () => act(btn.dataset.key)));
  $('board').addEventListener('pointerdown', e => { if (e.clientX < window.innerWidth * .4) act('ArrowLeft'); else if (e.clientX > window.innerWidth * .6) act('ArrowRight'); });
  $('back-home-button').addEventListener('click', () => { state.matchEnded = true; location.href = location.pathname; });
  connect();
  const requestedRoom = new URLSearchParams(location.search).get('room'); if (requestedRoom) { $('join-code').value = requestedRoom.toUpperCase().slice(0,4); setTimeout(() => $('join-code').focus(), 450); }
})();
