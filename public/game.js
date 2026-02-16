// ===== Territory.io v5 — Client =====
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const miniCanvas = document.getElementById('minimap');
const miniCtx = miniCanvas.getContext('2d');

let socket;
let myPi = -1, myColor = '#fff';
let mapW = 2000, mapH = 1000, chunkSize = 40;
let camX = 0, camY = 0, zoom = 1;
let joined = false, alive = false;

const chunks = {};
let playerColors = {};
let BLDG = {}, TECH = {};
let state = null;
let lb = { p: [], c: [] };
let clanList = [];
let discordEnabled = false;
let discordUser = null;
let terrainPreview = null;
let spawnMode = false;
let selectedSpawn = null;

const TERRAIN_COLORS = {
  0: [30, 60, 120],
  1: [100, 180, 60],
  2: [40, 120, 40],
  3: [210, 190, 120],
  4: [140, 130, 120],
  5: [180, 200, 200],
  6: [230, 240, 255],
  7: [60, 100, 160],
  8: [160, 140, 100],
  9: [60, 100, 60],
};
const BARB_COLOR = [100, 40, 40];

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function connectSocket() {
  socket = io();

  socket.on('mi', (d) => {
    mapW = d.w; mapH = d.h; chunkSize = d.cs;
    BLDG = d.bldg || {}; TECH = d.tech || {};
    discordEnabled = d.discordEnabled || false;
    updateDiscordUI();
  });

  socket.on('discord_user', (u) => {
    discordUser = u;
    updateDiscordUI();
  });

  socket.on('tp', (d) => {
    terrainPreview = d;
    if (spawnMode) renderSpawnPreview();
  });

  socket.on('joined', (d) => {
    myPi = d.pi; myColor = d.color;
    camX = d.sx - Math.floor(canvas.width / 2);
    camY = d.sy - Math.floor(canvas.height / 2);
    joined = true; alive = true;
    spawnMode = false;
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('spawnScreen').style.display = 'none';
    document.getElementById('respawnScreen').style.display = 'none';
    document.getElementById('deathScreen').style.display = 'none';
    document.getElementById('ui').style.display = 'block';
    requestChunks();
  });

  socket.on('ch', (chunks_data) => {
    for (const c of chunks_data) chunks[`${c.cx},${c.cy}`] = c;
  });

  socket.on('st', (s) => { state = s; updateUI(); });
  socket.on('lb', (l) => { lb = l; updateLeaderboard(); });
  socket.on('pc', (c) => { Object.assign(playerColors, c); });
  socket.on('cl', (c) => { clanList = c; });
  socket.on('clu', (c) => { clanList = c; });
  socket.on('tg', () => {});

  socket.on('msg', (m) => showMessage(m));

  socket.on('reward', (r) => {
    let msg = '보상: ';
    if (r.food) msg += `식량+${r.food} `;
    if (r.wood) msg += `목재+${r.wood} `;
    if (r.stone) msg += `석재+${r.stone} `;
    if (r.gold) msg += `금+${r.gold} `;
    if (r.troops) msg += `병력+${r.troops} `;
    showMessage(msg);
  });

  socket.on('died', () => {
    alive = false;
    document.getElementById('deathScreen').style.display = 'flex';
  });

  socket.on('cj', (d) => showMessage(`클랜 가입: ${d.clan?.name || '?'}`));
  socket.on('cl_left', () => showMessage('클랜 탈퇴'));
}

function updateDiscordUI() {
  const loginBtn = document.getElementById('discordLoginBtn');
  const userDiv = document.getElementById('discordUserInfo');
  const nameDisplay = document.getElementById('discordNameDisplay');
  if (!discordEnabled) { if (loginBtn) loginBtn.style.display = 'none'; return; }
  if (discordUser) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (userDiv) {
      userDiv.style.display = 'flex';
      const avatar = userDiv.querySelector('.discord-avatar');
      if (avatar && discordUser.avatar) avatar.src = discordUser.avatar;
      const name = userDiv.querySelector('.discord-name');
      if (name) name.textContent = discordUser.displayName;
    }
    if (nameDisplay) nameDisplay.textContent = discordUser.displayName;
    const nameInput = document.getElementById('nameInput');
    if (nameInput && discordUser.displayName) nameInput.value = discordUser.displayName;
  } else {
    if (loginBtn) loginBtn.style.display = 'flex';
    if (userDiv) userDiv.style.display = 'none';
  }
}

function showSpawnSelect() {
  spawnMode = true; selectedSpawn = null;
  document.getElementById('spawnScreen').style.display = 'flex';
  if (terrainPreview) renderSpawnPreview();
}

function renderSpawnPreview() {
  const spawnCanvas = document.getElementById('spawnMapCanvas');
  if (!spawnCanvas || !terrainPreview) return;
  const sCtx = spawnCanvas.getContext('2d');
  const pw = terrainPreview.w, ph = terrainPreview.h;
  spawnCanvas.width = pw; spawnCanvas.height = ph;
  const imgData = sCtx.createImageData(pw, ph);
  for (let i = 0; i < pw * ph; i++) {
    const t = terrainPreview.t[i], o = terrainPreview.o[i];
    const c = TERRAIN_COLORS[t] || [0,0,0];
    const pi4 = i * 4;
    if (o === 1) { imgData.data[pi4]=200; imgData.data[pi4+1]=200; imgData.data[pi4+2]=200; }
    else if (o === 2) { imgData.data[pi4]=BARB_COLOR[0]; imgData.data[pi4+1]=BARB_COLOR[1]; imgData.data[pi4+2]=BARB_COLOR[2]; }
    else { imgData.data[pi4]=c[0]; imgData.data[pi4+1]=c[1]; imgData.data[pi4+2]=c[2]; }
    imgData.data[pi4+3] = 255;
  }
  sCtx.putImageData(imgData, 0, 0);
  if (selectedSpawn) {
    const sx = Math.floor(selectedSpawn.x / 5), sy = Math.floor(selectedSpawn.y / 5);
    sCtx.strokeStyle = '#ff0'; sCtx.lineWidth = 2;
    sCtx.beginPath(); sCtx.arc(sx, sy, 5, 0, Math.PI*2); sCtx.stroke();
    sCtx.fillStyle = '#ff0';
    sCtx.beginPath(); sCtx.arc(sx, sy, 2, 0, Math.PI*2); sCtx.fill();
  }
}

function handleSpawnMapClick(e) {
  const c = document.getElementById('spawnMapCanvas');
  if (!c || !terrainPreview) return;
  const rect = c.getBoundingClientRect();
  const px = Math.floor((e.clientX - rect.left) * c.width / rect.width);
  const py = Math.floor((e.clientY - rect.top) * c.height / rect.height);
  selectedSpawn = { x: px * 5, y: py * 5 };
  const el = document.getElementById('spawnCoords');
  if (el) el.textContent = `좌표: (${selectedSpawn.x}, ${selectedSpawn.y})`;
  renderSpawnPreview();
}

function confirmSpawn() {
  const name = document.getElementById('nameInput').value.trim() || 'Player';
  const data = { name };
  if (selectedSpawn) { data.sx = selectedSpawn.x; data.sy = selectedSpawn.y; }
  socket.emit('join', data);
}

function quickSpawn() {
  const name = document.getElementById('nameInput').value.trim() || 'Player';
  socket.emit('join', { name });
}

function showRespawnSelect() {
  document.getElementById('deathScreen').style.display = 'none';
  spawnMode = true; selectedSpawn = null;
  document.getElementById('respawnScreen').style.display = 'flex';
  if (terrainPreview) renderRespawnPreview();
}

function renderRespawnPreview() {
  const rc = document.getElementById('respawnMapCanvas');
  if (!rc || !terrainPreview) return;
  const rCtx = rc.getContext('2d');
  const pw = terrainPreview.w, ph = terrainPreview.h;
  rc.width = pw; rc.height = ph;
  const imgData = rCtx.createImageData(pw, ph);
  for (let i = 0; i < pw * ph; i++) {
    const t = terrainPreview.t[i], o = terrainPreview.o[i];
    const c = TERRAIN_COLORS[t] || [0,0,0];
    const pi4 = i * 4;
    if (o === 1) { imgData.data[pi4]=200; imgData.data[pi4+1]=200; imgData.data[pi4+2]=200; }
    else if (o === 2) { imgData.data[pi4]=BARB_COLOR[0]; imgData.data[pi4+1]=BARB_COLOR[1]; imgData.data[pi4+2]=BARB_COLOR[2]; }
    else { imgData.data[pi4]=c[0]; imgData.data[pi4+1]=c[1]; imgData.data[pi4+2]=c[2]; }
    imgData.data[pi4+3] = 255;
  }
  rCtx.putImageData(imgData, 0, 0);
  if (selectedSpawn) {
    const sx = Math.floor(selectedSpawn.x / 5), sy = Math.floor(selectedSpawn.y / 5);
    rCtx.strokeStyle = '#ff0'; rCtx.lineWidth = 2;
    rCtx.beginPath(); rCtx.arc(sx, sy, 5, 0, Math.PI*2); rCtx.stroke();
  }
}

function handleRespawnMapClick(e) {
  const rc = document.getElementById('respawnMapCanvas');
  if (!rc || !terrainPreview) return;
  const rect = rc.getBoundingClientRect();
  const px = Math.floor((e.clientX - rect.left) * rc.width / rect.width);
  const py = Math.floor((e.clientY - rect.top) * rc.height / rect.height);
  selectedSpawn = { x: px * 5, y: py * 5 };
  const el = document.getElementById('respawnCoords');
  if (el) el.textContent = `좌표: (${selectedSpawn.x}, ${selectedSpawn.y})`;
  renderRespawnPreview();
}

function confirmRespawn() {
  const data = {};
  if (selectedSpawn) { data.sx = selectedSpawn.x; data.sy = selectedSpawn.y; }
  socket.emit('respawn', data);
  document.getElementById('respawnScreen').style.display = 'none';
  spawnMode = false;
}

function quickRespawn() {
  socket.emit('respawn', {});
  document.getElementById('deathScreen').style.display = 'none';
  spawnMode = false;
}

function requestChunks() {
  if (!joined) return;
  const vw = canvas.width / zoom, vh = canvas.height / zoom;
  socket.emit('vp', { x: Math.floor(camX), y: Math.floor(camY), w: Math.ceil(vw), h: Math.ceil(vh) });
}

function render() {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!joined) { requestAnimationFrame(render); return; }

  const vw = canvas.width / zoom, vh = canvas.height / zoom;
  const sx = Math.max(0, Math.floor(camX / chunkSize));
  const sy = Math.max(0, Math.floor(camY / chunkSize));
  const ex = Math.min(Math.ceil(mapW / chunkSize) - 1, Math.floor((camX + vw) / chunkSize));
  const ey = Math.min(Math.ceil(mapH / chunkSize) - 1, Math.floor((camY + vh) / chunkSize));
  const pixW = Math.ceil(vw), pixH = Math.ceil(vh);
  if (pixW <= 0 || pixH <= 0) { requestAnimationFrame(render); return; }

  const offCanvas = document.createElement('canvas');
  offCanvas.width = pixW; offCanvas.height = pixH;
  const offCtx = offCanvas.getContext('2d');
  const imgData = offCtx.createImageData(pixW, pixH);
  const data = imgData.data;
  const camXf = Math.floor(camX), camYf = Math.floor(camY);

  for (let cy = sy; cy <= ey; cy++) {
    for (let cx = sx; cx <= ex; cx++) {
      const chunk = chunks[`${cx},${cy}`];
      if (!chunk) continue;
      const baseX = cx * chunkSize - camXf, baseY = cy * chunkSize - camYf;
      for (let ly = 0; ly < chunkSize; ly++) {
        const py = baseY + ly;
        if (py < 0 || py >= pixH) continue;
        for (let lx = 0; lx < chunkSize; lx++) {
          const px = baseX + lx;
          if (px < 0 || px >= pixW) continue;
          const li = ly * chunkSize + lx;
          const t = chunk.t[li], o = chunk.o[li];
          const pi4 = (py * pixW + px) * 4;
          if (o >= 0 && playerColors[o]) {
            const col = hexToRgb(playerColors[o]);
            const tc = TERRAIN_COLORS[t] || [0,0,0];
            data[pi4] = Math.floor(col[0]*0.65+tc[0]*0.35);
            data[pi4+1] = Math.floor(col[1]*0.65+tc[1]*0.35);
            data[pi4+2] = Math.floor(col[2]*0.65+tc[2]*0.35);
          } else if (o === -2) {
            const tc = TERRAIN_COLORS[t] || [0,0,0];
            data[pi4] = Math.floor(BARB_COLOR[0]*0.6+tc[0]*0.4);
            data[pi4+1] = Math.floor(BARB_COLOR[1]*0.6+tc[1]*0.4);
            data[pi4+2] = Math.floor(BARB_COLOR[2]*0.6+tc[2]*0.4);
          } else {
            const tc = TERRAIN_COLORS[t] || [0,0,0];
            data[pi4] = tc[0]; data[pi4+1] = tc[1]; data[pi4+2] = tc[2];
          }
          data[pi4+3] = 255;
        }
      }
    }
  }

  offCtx.putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offCanvas, 0, 0, pixW, pixH, 0, 0, pixW * zoom, pixH * zoom);

  if (state?.cap) {
    const cx2 = (state.cap.x - camXf) * zoom, cy2 = (state.cap.y - camYf) * zoom;
    ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 2;
    ctx.strokeRect(cx2 - 4, cy2 - 4, 8, 8);
    ctx.fillStyle = '#ffd700'; ctx.font = '10px monospace';
    ctx.fillText('HQ', cx2 - 6, cy2 - 7);
  }

  renderMinimap();
  requestAnimationFrame(render);
}

function renderMinimap() {
  const mw = miniCanvas.width, mh = miniCanvas.height;
  miniCtx.fillStyle = '#111';
  miniCtx.fillRect(0, 0, mw, mh);
  const scaleX = mw / mapW, scaleY = mh / mapH;
  const miniImg = miniCtx.createImageData(mw, mh);
  for (const key in chunks) {
    const chunk = chunks[key];
    const baseGX = chunk.cx * chunkSize, baseGY = chunk.cy * chunkSize;
    for (let ly = 0; ly < chunkSize; ly++) {
      for (let lx = 0; lx < chunkSize; lx++) {
        const gx = baseGX + lx, gy = baseGY + ly;
        const mx = Math.floor(gx * scaleX), my = Math.floor(gy * scaleY);
        if (mx < 0 || mx >= mw || my < 0 || my >= mh) continue;
        const li = ly * chunkSize + lx, o = chunk.o[li], t = chunk.t[li];
        const mi = (my * mw + mx) * 4;
        if (o >= 0 && playerColors[o]) {
          const col = hexToRgb(playerColors[o]);
          miniImg.data[mi]=col[0]; miniImg.data[mi+1]=col[1]; miniImg.data[mi+2]=col[2];
        } else if (o === -2) {
          miniImg.data[mi]=BARB_COLOR[0]; miniImg.data[mi+1]=BARB_COLOR[1]; miniImg.data[mi+2]=BARB_COLOR[2];
        } else {
          const tc = TERRAIN_COLORS[t] || [0,0,0];
          miniImg.data[mi]=tc[0]; miniImg.data[mi+1]=tc[1]; miniImg.data[mi+2]=tc[2];
        }
        miniImg.data[mi+3] = 255;
      }
    }
  }
  miniCtx.putImageData(miniImg, 0, 0);
  const vw = canvas.width / zoom, vh = canvas.height / zoom;
  miniCtx.strokeStyle = '#fff'; miniCtx.lineWidth = 1;
  miniCtx.strokeRect(camX * scaleX, camY * scaleY, vw * scaleX, vh * scaleY);
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

function updateUI() {
  if (!state) return;
  const r = state.r;
  document.getElementById('resFood').textContent = r.f;
  document.getElementById('resWood').textContent = r.w;
  document.getElementById('resStone').textContent = r.s;
  document.getElementById('resGold').textContent = r.g;
  document.getElementById('apDisplay').textContent = `AP: ${state.ap}/${state.ma}`;
  document.getElementById('troopDisplay').textContent = `병력: ${state.tt}/${state.mt}`;
  if (state.pr > Date.now()) {
    const remain = Math.ceil((state.pr - Date.now()) / 60000);
    document.getElementById('protectionDisplay').textContent = `보호막: ${remain}분`;
    document.getElementById('protectionDisplay').style.display = 'block';
  } else {
    document.getElementById('protectionDisplay').style.display = 'none';
  }
}

function updateLeaderboard() {
  const el = document.getElementById('lbList');
  if (!el) return;
  let html = '';
  for (let i = 0; i < Math.min(10, lb.p.length); i++) {
    const p = lb.p[i];
    const me = p.i === myPi ? ' style="color:#ffd700;font-weight:bold"' : '';
    html += `<div${me}>${i+1}. ${p.ct||''}${p.name} - ${p.cells}칸 (${p.troops}병)</div>`;
  }
  el.innerHTML = html;
}

let msgTimeout;
function showMessage(text) {
  const el = document.getElementById('messageBox');
  if (!el) return;
  el.textContent = text; el.style.display = 'block'; el.style.opacity = '1';
  clearTimeout(msgTimeout);
  msgTimeout = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 500); }, 3000);
}

let isDragging = false, dragX = 0, dragY = 0, isRightDrag = false;

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) { isDragging = true; dragX = e.clientX; dragY = e.clientY; }
  if (e.button === 2) { isRightDrag = true; dragX = e.clientX; dragY = e.clientY; }
});
canvas.addEventListener('mousemove', (e) => {
  if (isDragging || isRightDrag) {
    camX -= (e.clientX - dragX) / zoom; camY -= (e.clientY - dragY) / zoom;
    camX = Math.max(0, Math.min(mapW - canvas.width/zoom, camX));
    camY = Math.max(0, Math.min(mapH - canvas.height/zoom, camY));
    dragX = e.clientX; dragY = e.clientY;
    requestChunks();
  }
});
canvas.addEventListener('mouseup', (e) => {
  if (e.button === 0) isDragging = false;
  if (e.button === 2) isRightDrag = false;
});

canvas.addEventListener('click', (e) => {
  if (!joined || !alive) return;
  const gx = Math.floor(camX + e.clientX / zoom);
  const gy = Math.floor(camY + e.clientY / zoom);
  if (gx < 0 || gy < 0 || gx >= mapW || gy >= mapH) return;
  if (e.shiftKey) {
    socket.emit('matk', { tx: gx, ty: gy });
  } else {
    const cells = [];
    for (let dy = -brushSize; dy <= brushSize; dy++)
      for (let dx = -brushSize; dx <= brushSize; dx++)
        if (dx*dx + dy*dy <= brushSize*brushSize) cells.push({ x: gx+dx, y: gy+dy });
    socket.emit('exp', { cells });
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const oldZoom = zoom;
  if (e.deltaY < 0) zoom = Math.min(zoom * 1.15, 20);
  else zoom = Math.max(zoom / 1.15, 0.3);
  camX += e.clientX / oldZoom - e.clientX / zoom;
  camY += e.clientY / oldZoom - e.clientY / zoom;
  camX = Math.max(0, Math.min(mapW - canvas.width/zoom, camX));
  camY = Math.max(0, Math.min(mapH - canvas.height/zoom, camY));
  requestChunks();
});

let brushSize = 0;
document.addEventListener('keydown', (e) => {
  if (!joined || !alive) return;
  if (e.key === 'b' || e.key === 'B') socket.emit('bpush');
  if (e.key === '+' || e.key === '=') brushSize = Math.min(brushSize + 1, 5);
  if (e.key === '-' || e.key === '_') brushSize = Math.max(brushSize - 1, 0);
  if (e.key === 'c' || e.key === 'C') {
    if (state?.cap) {
      camX = state.cap.x - canvas.width/zoom/2;
      camY = state.cap.y - canvas.height/zoom/2;
      requestChunks();
    }
  }
});

miniCanvas.addEventListener('click', (e) => {
  if (!joined) return;
  const rect = miniCanvas.getBoundingClientRect();
  camX = (e.clientX - rect.left) / rect.width * mapW - canvas.width/zoom/2;
  camY = (e.clientY - rect.top) / rect.height * mapH - canvas.height/zoom/2;
  camX = Math.max(0, Math.min(mapW - canvas.width/zoom, camX));
  camY = Math.max(0, Math.min(mapH - canvas.height/zoom, camY));
  requestChunks();
});

function openBuildPanel() {
  const panel = document.getElementById('buildPanel');
  panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  if (panel.style.display === 'block') renderBuildPanel();
}
function renderBuildPanel() {
  if (!state) return;
  const panel = document.getElementById('buildContent');
  let html = '<h3>건물</h3>';
  for (const [k, def] of Object.entries(BLDG)) {
    const b = state.b[k]; if (!b) continue;
    const building = b.e > 0;
    const remain = building ? Math.max(0, Math.ceil((b.e - Date.now()) / 1000)) : 0;
    html += `<div class="build-item"><strong>${def.n}</strong> Lv.${b.l}${b.l>=25?' (MAX)':''}
      <br><small>${def.desc}</small>`;
    if (building) html += `<br><em>건설 중... ${remain}초</em>`;
    else if (b.l < 25) html += `<br><button onclick="socket.emit('bld',{b:'${k}'})">업그레이드</button>`;
    html += '</div>';
  }
  html += '<h3>기술</h3>';
  for (const [k, def] of Object.entries(TECH)) {
    const t = state.t[k]; if (!t) continue;
    const researching = t.e > 0;
    const remain = researching ? Math.max(0, Math.ceil((t.e - Date.now()) / 1000)) : 0;
    html += `<div class="build-item"><strong>${def.n}</strong> Lv.${t.l}${t.l>=20?' (MAX)':''}
      <br><small>${def.desc}</small>`;
    if (researching) html += `<br><em>연구 중... ${remain}초</em>`;
    else if (t.l < 20) html += `<br><button onclick="socket.emit('res',{t:'${k}'})">연구</button>`;
    html += '</div>';
  }
  panel.innerHTML = html;
}

function openClanPanel() {
  const panel = document.getElementById('clanPanel');
  panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  if (panel.style.display === 'block') renderClanPanel();
}
function renderClanPanel() {
  const panel = document.getElementById('clanContent');
  let html = '<h3>클랜</h3>';
  html += `<div><input id="clanNameI" placeholder="클랜명" maxlength="20" style="width:100px">
    <input id="clanTagI" placeholder="태그" maxlength="5" style="width:50px">
    <button onclick="socket.emit('cclan',{name:document.getElementById('clanNameI').value,tag:document.getElementById('clanTagI').value})">생성</button>
    <button onclick="socket.emit('lclan')">탈퇴</button></div>`;
  html += '<h4>클랜 목록</h4>';
  for (const c of clanList) {
    html += `<div style="color:${c.color}"><strong>[${c.tag}] ${c.name}</strong> ${c.members}명 - ${c.cells}칸
      <button onclick="socket.emit('jclan',{ci:${c.id}})">가입</button></div>`;
  }
  panel.innerHTML = html;
}

function toggleHelp() {
  const h = document.getElementById('helpPanel');
  h.style.display = h.style.display === 'block' ? 'none' : 'block';
}

async function init() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    if (data.user) { discordUser = data.user; updateDiscordUI(); }
  } catch (e) {}
  connectSocket();
  render();
}

setInterval(() => {
  const panel = document.getElementById('buildPanel');
  if (panel && panel.style.display === 'block') renderBuildPanel();
}, 1000);
setInterval(requestChunks, 2000);

init();
