// ===== Territory.io v5 — Ultimate Strategy Client =====
var socket = io();
var canvas = document.getElementById('gameCanvas');
var ctx = canvas.getContext('2d', { alpha: false });
var mmCanvas = document.getElementById('minimap');
var mmCtx = mmCanvas.getContext('2d', { alpha: false });
var buf = document.createElement('canvas');
var bCtx = buf.getContext('2d', { alpha: false });

// ===== STATE =====
var myPi = -1, myColor = '#fff', alive = false, myCiv = 'rome';
var spawnX = -1, spawnY = -1;
var respawnX = -1, respawnY = -1;
var terrainPreviewData = null;
var discordUser = null; // { id, name, avatar }
var mapW = 3000, mapH = 1500, chunkSz = 50;
var pColors = {};
var chunks = {};
var lb = { p: [], c: [] };
var mySt = null;
var BLDG = {}, TECH = {}, CIVS = {}, SKILLS = {}, RANKS = [], STILES = {};
var lastMsg = '', msgTimer = 0;
var lastReward = null, rewardTimer = 0;

// Camera
var camX = 0, camY = 0, zoom = 4;
var vpW = 0, vpH = 0;

// Input
var mouseX = 0, mouseY = 0, mouseDown = false;
var dragStartX = 0, dragStartY = 0, dragging = false;
var massAtkMode = false;
var keys = {};
var lastExpTime = 0;
function emitExp(x, y) {
  var now = Date.now();
  if (now - lastExpTime < 50) return;
  lastExpTime = now;
  socket.emit('exp', {x: x, y: y});
}

// Terrain colors
var TERRAIN_COLORS = [
  [18, 40, 90],    // 0 ocean (deep dark blue)
  [110, 185, 75],  // 1 plains (bright green)
  [34, 125, 50],   // 2 forest
  [215, 195, 130], // 3 desert
  [120, 115, 125], // 4 mountain
  [185, 205, 180], // 5 tundra
  [220, 232, 248], // 6 ice
  [55, 105, 150],  // 7 shallow (medium blue)
  [145, 165, 100], // 8 hills
  [65, 95, 55]     // 9 swamp
];
var SHORE_COLOR = [194, 178, 128]; // sandy shore edge
function isWaterTerrain(tt) { return tt === 0 || tt === 6 || tt === 7; }
function isLandTerrain(tt) { return tt >= 1 && tt <= 5 || tt === 8 || tt === 9; }
var BARB_COLOR = [80, 0, 0];
var SPECIAL_COLORS = {
  1: [255, 215, 0],    // goldMine
  2: [0, 200, 150],    // oasis
  3: [180, 140, 100],  // ruins
  4: [200, 80, 30],    // volcano
  5: [50, 150, 200]    // harbor
};

// ===== CIV GRID =====
function buildCivGrid(containerId, small) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  var civKeys = Object.keys(CIVS);
  civKeys.forEach(function(key) {
    var civ = CIVS[key];
    var card = document.createElement('div');
    card.className = 'civ-card' + (small ? ' small' : '') + (key === myCiv ? ' selected' : '');
    card.dataset.civ = key;
    card.innerHTML = '<span class="civ-icon">' + civ.icon + '</span><span class="civ-name">' + civ.n + '</span>';
    card.addEventListener('click', function() {
      myCiv = key;
      container.querySelectorAll('.civ-card').forEach(function(c) { c.classList.remove('selected'); });
      this.classList.add('selected');
      var desc = document.getElementById('civDesc');
      if (desc) desc.textContent = CIVS[key].desc;
    });
    container.appendChild(card);
  });
}

// ===== SPAWN MAP =====
function renderSpawnMap(canvasId) {
  var c = document.getElementById(canvasId);
  if (!c || !terrainPreviewData) return;
  var ctx2 = c.getContext('2d');
  var d = terrainPreviewData;
  var img = ctx2.createImageData(d.w, d.h);
  for (var i = 0; i < d.t.length; i++) {
    var tc = TERRAIN_COLORS[d.t[i]] || [0,0,0];
    var pi2 = i * 4;
    if (d.o[i] === 1) { img.data[pi2]=255; img.data[pi2+1]=255; img.data[pi2+2]=200; }
    else if (d.o[i] === 2) { img.data[pi2]=80; img.data[pi2+1]=0; img.data[pi2+2]=0; }
    else { img.data[pi2]=tc[0]; img.data[pi2+1]=tc[1]; img.data[pi2+2]=tc[2]; }
    img.data[pi2+3] = 255;
  }
  var tmpC = document.createElement('canvas');
  tmpC.width = d.w; tmpC.height = d.h;
  tmpC.getContext('2d').putImageData(img, 0, 0);
  ctx2.imageSmoothingEnabled = false;
  ctx2.drawImage(tmpC, 0, 0, d.w, d.h, 0, 0, c.width, c.height);
}

function setupSpawnMapClick(canvasId, markerId, coordId, isRespawn) {
  var c = document.getElementById(canvasId);
  if (!c) return;
  c.onclick = function(e) {
    if (!terrainPreviewData) return;
    var rect = c.getBoundingClientRect();
    var cx = e.clientX - rect.left;
    var cy = e.clientY - rect.top;
    var mapCellX = Math.floor(cx / c.width * mapW);
    var mapCellY = Math.floor(cy / c.height * mapH);
    // Check if water terrain at preview scale
    var d = terrainPreviewData;
    var px = Math.floor(cx / c.width * d.w);
    var py = Math.floor(cy / c.height * d.h);
    if (px >= 0 && px < d.w && py >= 0 && py < d.h) {
      var tt = d.t[py * d.w + px];
      if (tt === 0 || tt === 6 || tt === 7) {
        // Water — reject
        var coordEl = document.getElementById(coordId);
        if (coordEl) coordEl.textContent = '⚠ 바다에는 시작할 수 없습니다!';
        return;
      }
    }
    if (isRespawn) { respawnX = mapCellX; respawnY = mapCellY; }
    else { spawnX = mapCellX; spawnY = mapCellY; }
    // Show marker
    var marker = document.getElementById(markerId);
    if (marker) {
      marker.style.display = 'block';
      marker.style.left = cx + 'px';
      marker.style.top = cy + 'px';
    }
    var coordEl = document.getElementById(coordId);
    if (coordEl) coordEl.textContent = '위치: (' + mapCellX + ', ' + mapCellY + ')';
  };
}

// ===== START / RESPAWN =====
function startGame() {
  if (!discordUser) { window.location.href = '/auth/discord'; return; }
  var name = discordUser.name || 'Player';
  var data = { name: name, civ: myCiv };
  if (spawnX >= 0 && spawnY >= 0) { data.sx = spawnX; data.sy = spawnY; }
  socket.emit('join', data);
  spawnX = -1; spawnY = -1;
}

function respawn() {
  var sel = document.querySelector('#respawnCivGrid .civ-card.selected');
  var civ = sel ? sel.dataset.civ : myCiv;
  var data = { civ: civ };
  if (respawnX >= 0 && respawnY >= 0) { data.sx = respawnX; data.sy = respawnY; }
  socket.emit('respawn', data);
  respawnX = -1; respawnY = -1;
}

// ===== TAB SWITCHING =====
function switchTab(tabId) {
  var tabs = document.querySelectorAll('.tab-content');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
  var btns = document.querySelectorAll('.tab-btn');
  for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
  var tab = document.getElementById(tabId);
  if (tab) tab.classList.add('active');
  var btn = document.querySelector('[data-tab="' + tabId + '"]');
  if (btn) btn.classList.add('active');
}

// ===== SOCKET EVENTS =====
socket.on('mi', function(d) {
  mapW = d.w; mapH = d.h; chunkSz = d.cs;
  BLDG = d.bldg || {};
  TECH = d.tech || {};
  CIVS = d.civs || {};
  SKILLS = d.skills || {};
  RANKS = d.ranks || [];
  STILES = d.stiles || {};
  buildCivGrid('civGrid', false);
  buildCivGrid('respawnCivGrid', true);
  buf.width = mapW; buf.height = mapH;
});

socket.on('joined', function(d) {
  myPi = d.pi;
  myColor = d.color;
  myCiv = d.civ || 'rome';
  alive = true;
  camX = d.sx - Math.floor(vpW / zoom / 2);
  camY = d.sy - Math.floor(vpH / zoom / 2);
  document.getElementById('ss').style.display = 'none';
  document.getElementById('ds').style.display = 'none';
  document.getElementById('gu').style.display = '';
  resize();
  sendViewport();
  updateCivBadge();
});

socket.on('pc', function(d) {
  for (var k in d) pColors[k] = d[k];
});

socket.on('ch', function(data) {
  for (var i = 0; i < data.length; i++) {
    var c = data[i];
    var k = c.cx + ',' + c.cy;
    chunks[k] = c;
    renderChunkToBuf(c);
  }
});

socket.on('st', function(d) {
  mySt = d;
  updateUI();
});

socket.on('lb', function(d) {
  lb = d;
  renderLeaderboard();
});

socket.on('cl', function(d) { renderClanList(d); });
socket.on('clu', function(d) { renderClanList(d); });
socket.on('cj', function() { if (mySt) updateUI(); });
socket.on('cl_left', function() { if (mySt) updateUI(); });

socket.on('msg', function(m) {
  lastMsg = m; msgTimer = Date.now() + 3000;
  showMsgBox(m);
});

socket.on('reward', function(r) {
  lastReward = r; rewardTimer = Date.now() + 3000;
  showRewardBox('보상! F+' + r.food + ' W+' + r.wood + ' S+' + r.stone + ' G+' + r.gold);
});

socket.on('died', function() {
  alive = false;
  respawnX = -1; respawnY = -1;
  document.getElementById('gu').style.display = 'none';
  document.getElementById('ds').style.display = '';
  showDeathStats();
  buildCivGrid('respawnCivGrid', true);
  renderSpawnMap('respawnMap');
  setupSpawnMapClick('respawnMap', 'respawnMarker', 'respawnCoordText', true);
  var rm = document.getElementById('respawnMarker');
  if (rm) rm.style.display = 'none';
  var rct = document.getElementById('respawnCoordText');
  if (rct) rct.textContent = '위치: 랜덤';
});

socket.on('tg', function() {});

socket.on('tp', function(d) {
  // Terrain preview received — render onto minimap as initial overview
  if (!d || !d.t) return;
  terrainPreviewData = d;
  var mmW = mmCanvas.width, mmH = mmCanvas.height;
  var img = mmCtx.createImageData(d.w, d.h);
  for (var i = 0; i < d.t.length; i++) {
    var tc = TERRAIN_COLORS[d.t[i]] || [0,0,0];
    var pi2 = i * 4;
    if (d.o[i] === 1) { img.data[pi2]=255; img.data[pi2+1]=255; img.data[pi2+2]=200; }
    else if (d.o[i] === 2) { img.data[pi2]=80; img.data[pi2+1]=0; img.data[pi2+2]=0; }
    else { img.data[pi2]=tc[0]; img.data[pi2+1]=tc[1]; img.data[pi2+2]=tc[2]; }
    img.data[pi2+3] = 255;
  }
  // Draw scaled to minimap
  var tmpC = document.createElement('canvas');
  tmpC.width = d.w; tmpC.height = d.h;
  tmpC.getContext('2d').putImageData(img, 0, 0);
  mmCtx.drawImage(tmpC, 0, 0, d.w, d.h, 0, 0, mmW, mmH);
  // Render spawn selection maps
  renderSpawnMap('spawnMap');
  renderSpawnMap('respawnMap');
  setupSpawnMapClick('spawnMap', 'spawnMarker', 'spawnCoordText', false);
  setupSpawnMapClick('respawnMap', 'respawnMarker', 'respawnCoordText', true);
});

socket.on('combo', function(d) { showCombo(d.count); });
socket.on('streak', function(d) { showStreak(d.count, d.reward); });
socket.on('questDone', function(d) { showQuestDone(d); });
socket.on('skillFx', function(d) { showSkillEffect(d.skill, d.claimed); });
socket.on('spyInfo', function(d) { showSpyModal(d); });

// ===== RENDERING =====
function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

// Helper: get terrain of a neighbor cell, looking into adjacent chunks
function getNeighborTerrain(c, lx, ly, dx, dy) {
  var nx = lx + dx, ny = ly + dy;
  // Inside same chunk
  if (nx >= 0 && nx < chunkSz && ny >= 0 && ny < chunkSz) {
    return c.t[ny * chunkSz + nx];
  }
  // Look into neighbor chunk
  var ncx = c.cx + (nx < 0 ? -1 : nx >= chunkSz ? 1 : 0);
  var ncy = c.cy + (ny < 0 ? -1 : ny >= chunkSz ? 1 : 0);
  var nk = ncx + ',' + ncy;
  var nc = chunks[nk];
  if (!nc) return -1;
  var nnx = ((nx % chunkSz) + chunkSz) % chunkSz;
  var nny = ((ny % chunkSz) + chunkSz) % chunkSz;
  return nc.t[nny * chunkSz + nnx];
}

function renderChunkToBuf(c) {
  var sx = c.cx * chunkSz, sy = c.cy * chunkSz;
  var imgData = bCtx.createImageData(chunkSz, chunkSz);
  var d = imgData.data;
  for (var ly = 0; ly < chunkSz; ly++) {
    for (var lx = 0; lx < chunkSz; lx++) {
      var li = ly * chunkSz + lx;
      var pi = li * 4;
      var t = c.t[li], o = c.o[li], sp = c.sp ? c.sp[li] : 0;
      var r, g, b;
      var gx = sx + lx, gy = sy + ly;
      if (o >= 0 && pColors[o]) {
        var pc = hexToRgb(pColors[o]);
        var tc = TERRAIN_COLORS[t] || [0,0,0];
        r = (pc[0]*0.7 + tc[0]*0.3)|0;
        g = (pc[1]*0.7 + tc[1]*0.3)|0;
        b = (pc[2]*0.7 + tc[2]*0.3)|0;
      } else if (o === -2) {
        var tc2 = TERRAIN_COLORS[t] || [0,0,0];
        r = (BARB_COLOR[0]*0.6 + tc2[0]*0.4)|0;
        g = (BARB_COLOR[1]*0.6 + tc2[1]*0.4)|0;
        b = (BARB_COLOR[2]*0.6 + tc2[2]*0.4)|0;
      } else {
        var tc3 = TERRAIN_COLORS[t] || [0,0,0];
        r = tc3[0]; g = tc3[1]; b = tc3[2];
        // Water depth variation
        if (t === 0) {
          var wv = ((gx * 7 + gy * 13) % 17) / 17;
          r = (r + wv * 8 - 4)|0;
          g = (g + wv * 10 - 5)|0;
          b = (b + wv * 14 - 7)|0;
        } else if (t === 7) {
          var sv = ((gx * 11 + gy * 7) % 13) / 13;
          r = (r + sv * 10 - 5)|0;
          g = (g + sv * 12 - 6)|0;
          b = (b + sv * 15 - 7)|0;
        }
      }
      // Shore edge: land pixel next to water → sandy tint on the land side
      if (isLandTerrain(t) && o < 0) {
        var nearWater = false;
        for (var dd = 0; dd < 4; dd++) {
          var ddx = dd===0?-1:dd===1?1:0;
          var ddy = dd===2?-1:dd===3?1:0;
          var nt = getNeighborTerrain(c, lx, ly, ddx, ddy);
          if (nt === 0 || nt === 7) { nearWater = true; break; }
        }
        if (nearWater) {
          r = (r * 0.45 + SHORE_COLOR[0] * 0.55)|0;
          g = (g * 0.45 + SHORE_COLOR[1] * 0.55)|0;
          b = (b * 0.45 + SHORE_COLOR[2] * 0.55)|0;
        }
      }
      // Water pixel next to land → darker edge for contrast
      if (isWaterTerrain(t) && o < 0) {
        var nearLand = false;
        for (var dd2 = 0; dd2 < 4; dd2++) {
          var ddx2 = dd2===0?-1:dd2===1?1:0;
          var ddy2 = dd2===2?-1:dd2===3?1:0;
          var nt2 = getNeighborTerrain(c, lx, ly, ddx2, ddy2);
          if (isLandTerrain(nt2)) { nearLand = true; break; }
        }
        if (nearLand) {
          r = (r * 0.6 + 30 * 0.4)|0;
          g = (g * 0.6 + 80 * 0.4)|0;
          b = (b * 0.6 + 120 * 0.4)|0;
        }
      }
      if (sp > 0 && o < 0) {
        var sc = SPECIAL_COLORS[sp];
        if (sc) { r = (r*0.5+sc[0]*0.5)|0; g = (g*0.5+sc[1]*0.5)|0; b = (b*0.5+sc[2]*0.5)|0; }
      } else if (sp > 0 && o >= 0) {
        r = Math.min(255, r+20); g = Math.min(255, g+20); b = Math.min(255, b+10);
      }
      d[pi] = r; d[pi+1] = g; d[pi+2] = b; d[pi+3] = 255;
    }
  }
  bCtx.putImageData(imgData, sx, sy);
}

function draw() {
  var w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, w, h);

  var srcX = Math.max(0, camX);
  var srcY = Math.max(0, camY);
  var srcW = Math.min(mapW - srcX, Math.ceil(w / zoom));
  var srcH = Math.min(mapH - srcY, Math.ceil(h / zoom));
  if (srcW > 0 && srcH > 0) {
    ctx.imageSmoothingEnabled = zoom < 4;
    ctx.drawImage(buf, srcX, srcY, srcW, srcH,
      Math.max(0, -camX * zoom), Math.max(0, -camY * zoom),
      srcW * zoom, srcH * zoom);
  }

  // Grid lines at high zoom
  if (zoom >= 8) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    var gx0 = Math.floor(camX), gx1 = Math.ceil(camX + w/zoom);
    var gy0 = Math.floor(camY), gy1 = Math.ceil(camY + h/zoom);
    for (var gx = gx0; gx <= gx1; gx++) {
      var px = (gx - camX) * zoom;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    }
    for (var gy = gy0; gy <= gy1; gy++) {
      var py = (gy - camY) * zoom;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
    }
  }

  // Capital icon
  if (mySt && mySt.cap && zoom >= 4) {
    var cx = (mySt.cap.x - camX) * zoom + zoom/2;
    var cy = (mySt.cap.y - camY) * zoom + zoom/2;
    ctx.font = Math.max(10, zoom) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('\uD83C\uDFF0', cx, cy);
  }

  // Special tile icons at high zoom
  if (zoom >= 12) {
    var vx0 = Math.floor(camX), vy0 = Math.floor(camY);
    var vx1 = Math.ceil(camX + w/zoom), vy1 = Math.ceil(camY + h/zoom);
    var stKeys = Object.keys(STILES);
    for (var vy = vy0; vy < vy1; vy++) {
      for (var vx = vx0; vx < vx1; vx++) {
        var ck = (Math.floor(vx/chunkSz)) + ',' + (Math.floor(vy/chunkSz));
        var ch = chunks[ck];
        if (!ch || !ch.sp) continue;
        var slx = ((vx%chunkSz)+chunkSz)%chunkSz;
        var sly = ((vy%chunkSz)+chunkSz)%chunkSz;
        var spv = ch.sp[sly*chunkSz+slx];
        if (spv > 0 && stKeys[spv-1]) {
          var stD = STILES[stKeys[spv-1]];
          if (stD) {
            ctx.font = Math.max(8, zoom*0.7) + 'px sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(stD.icon, (vx-camX)*zoom+zoom/2, (vy-camY)*zoom+zoom/2);
          }
        }
      }
    }
  }

  // Hover highlight
  if (alive && zoom >= 4) {
    var hx = Math.floor(mouseX/zoom + camX);
    var hy = Math.floor(mouseY/zoom + camY);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect((hx-camX)*zoom, (hy-camY)*zoom, zoom, zoom);
    if (zoom >= 10) {
      var hck = (Math.floor(hx/chunkSz))+','+(Math.floor(hy/chunkSz));
      var hch = chunks[hck];
      if (hch) {
        var hlx = ((hx%chunkSz)+chunkSz)%chunkSz;
        var hly = ((hy%chunkSz)+chunkSz)%chunkSz;
        var hli = hly*chunkSz+hlx;
        var ho = hch.o[hli];
        if (ho === -2) {
          var htr = hch.tr ? hch.tr[hli] : 0;
          ctx.font = '11px sans-serif';
          ctx.fillStyle = 'rgba(255,100,100,0.9)';
          ctx.fillText('\u2620 Lv'+(htr>30?3:htr>18?2:1), (hx-camX)*zoom+zoom+3, (hy-camY)*zoom+zoom/2);
        }
      }
    }
  }

  // Mass attack overlay
  if (massAtkMode) {
    ctx.fillStyle = 'rgba(231,76,60,0.15)';
    ctx.fillRect(0, 0, w, h);
    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = '#e74c3c'; ctx.textAlign = 'center';
    ctx.fillText('\u2694\uFE0F 목표 지점을 클릭하세요 (ESC 취소)', w/2, 70);
  }

  drawMinimap();
  requestAnimationFrame(draw);
}

function drawMinimap() {
  var mmW = mmCanvas.width, mmH = mmCanvas.height;
  mmCtx.fillStyle = '#111';
  mmCtx.fillRect(0, 0, mmW, mmH);
  mmCtx.drawImage(buf, 0, 0, mapW, mapH, 0, 0, mmW, mmH);
  var sx = mmW/mapW, sy = mmH/mapH;
  mmCtx.strokeStyle = '#fff'; mmCtx.lineWidth = 1;
  mmCtx.strokeRect(camX*sx, camY*sy, (vpW/zoom)*sx, (vpH/zoom)*sy);
}

// ===== UI UPDATES =====
function updateUI() {
  if (!mySt) return;
  var s = mySt;
  document.getElementById('rFood').textContent = '\uD83C\uDF3E ' + s.r.f;
  document.getElementById('rWood').textContent = '\uD83E\uDEB5 ' + s.r.w;
  document.getElementById('rStone').textContent = '\uD83E\uDEA8 ' + s.r.s;
  document.getElementById('rGold').textContent = '\uD83D\uDCB0 ' + s.r.g;
  document.getElementById('rAP').textContent = '\u26A1 ' + s.ap + '/' + s.ma;
  document.getElementById('rTroop').textContent = '\uD83D\uDDE1\uFE0F ' + s.tt + '/' + s.mt;

  // Rank badge
  var rankEl = document.getElementById('rankBadge');
  if (rankEl) rankEl.textContent = (s.rankIcon||'') + ' ' + (s.rank||'');

  // Shield indicator
  var shieldEl = document.getElementById('shieldIndicator');
  if (shieldEl) {
    if (s.shieldEnd && s.shieldEnd > Date.now()) {
      shieldEl.style.display = '';
      shieldEl.textContent = '\uD83D\uDEE1\uFE0F 철벽 방어 ' + Math.ceil((s.shieldEnd - Date.now())/1000) + '초';
    } else {
      shieldEl.style.display = 'none';
    }
  }

  // Kill streak HUD
  var streakHud = document.getElementById('streakHud');
  if (streakHud) {
    if (s.killStreak >= 3) {
      streakHud.style.display = '';
      streakHud.textContent = '\uD83D\uDD25 연속 처치: ' + s.killStreak;
    } else {
      streakHud.style.display = 'none';
    }
  }

  // Protection timer
  var protEl = document.getElementById('protTimer');
  if (protEl) {
    if (s.pr && s.pr > Date.now()) {
      protEl.style.display = '';
      var hrs = Math.floor((s.pr-Date.now())/3600000);
      var mins = Math.floor(((s.pr-Date.now())%3600000)/60000);
      protEl.textContent = '\uD83D\uDEE1\uFE0F 보호막: '+hrs+'시간 '+mins+'분';
    } else { protEl.style.display = 'none'; }
  }

  updateSkillBar();
  renderBuildings();
  renderTech();
  renderQuests();
  updateTradeRate();
}

function updateCivBadge() {
  var el = document.getElementById('civBadge');
  var civ = CIVS[myCiv];
  if (civ && el) el.textContent = civ.icon + ' ' + civ.n;
}

function updateSkillBar() {
  if (!mySt || !mySt.skills) return;
  var skillKeys = Object.keys(SKILLS);
  for (var i = 0; i < skillKeys.length; i++) {
    var key = skillKeys[i];
    var btn = document.querySelector('[data-skill="'+key+'"]');
    if (!btn) continue;
    var cd = mySt.skills[key];
    if (!cd) continue;
    var overlay = btn.querySelector('.skill-cd-overlay');
    if (cd.ready) {
      btn.classList.remove('on-cd'); btn.classList.add('ready');
      if (overlay) overlay.style.height = '0%';
    } else {
      btn.classList.add('on-cd'); btn.classList.remove('ready');
      var totalCd = SKILLS[key].cd;
      if (overlay) overlay.style.height = Math.min(100, (cd.remaining/totalCd)*100) + '%';
    }
  }
}

function renderBuildings() {
  if (!mySt) return;
  var el = document.getElementById('bldList');
  if (!el) return;
  var html = '', now = Date.now();
  var bk = Object.keys(BLDG);
  for (var i = 0; i < bk.length; i++) {
    var k = bk[i], def = BLDG[k], b = mySt.b[k];
    if (!b) continue;
    var building = b.e > 0 && now < b.e;
    var costs = getBldgCost(k, b.l);
    var can = canLocalAfford(costs);
    var maxL = k === 'hq' ? 25 : (mySt.b.hq ? mySt.b.hq.l : 1);
    var atMax = b.l >= 25 || (k !== 'hq' && b.l >= maxL);
    html += '<div class="bld-item'+(building?' building':'')+'" onclick="buildItem(\''+k+'\')">';
    html += '<div class="item-header"><span class="item-name">'+def.n+'</span>';
    html += '<span class="item-level">Lv.'+b.l+(atMax?' MAX':'')+'</span></div>';
    html += '<div class="item-desc">'+def.desc+'</div>';
    if (building) html += '<div class="item-timer">\uD83D\uDD28 건설중 '+Math.ceil((b.e-now)/1000)+'초</div>';
    else if (!atMax) html += '<div class="item-cost">'+formatCost(costs,can)+'</div>';
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderTech() {
  if (!mySt) return;
  var el = document.getElementById('techList');
  if (!el) return;
  var html = '', now = Date.now();
  var tk = Object.keys(TECH);
  for (var i = 0; i < tk.length; i++) {
    var k = tk[i], def = TECH[k], t = mySt.t[k];
    if (!t) continue;
    var researching = t.e > 0 && now < t.e;
    var costs = getTechCost(k, t.l);
    var can = canLocalAfford(costs);
    var atMax = t.l >= def.max;
    html += '<div class="tech-item'+(researching?' researching':'')+'" onclick="researchItem(\''+k+'\')">';
    html += '<div class="item-header"><span class="item-name">'+def.n+'</span>';
    html += '<span class="item-level">Lv.'+t.l+'/'+def.max+'</span></div>';
    html += '<div class="item-desc">'+def.desc+'</div>';
    if (researching) html += '<div class="item-timer">\uD83D\uDCD6 연구중 '+Math.ceil((t.e-now)/1000)+'초</div>';
    else if (!atMax) html += '<div class="item-cost">'+formatCost(costs,can)+'</div>';
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderQuests() {
  if (!mySt || !mySt.quests) return;
  var el = document.getElementById('questList');
  if (!el) return;
  var streakEl = document.getElementById('questStreak');
  if (streakEl) {
    streakEl.textContent = mySt.questStreak > 0 ? ('\uD83D\uDD25 퀘스트 연속: '+mySt.questStreak+'회 (골드+'+Math.min(mySt.questStreak,5)*20+')') : '';
  }
  var html = '';
  var rm = {f:'\uD83C\uDF3E',w:'\uD83E\uDEB5',s:'\uD83E\uDEA8',g:'\uD83D\uDCB0'};
  for (var i = 0; i < mySt.quests.length; i++) {
    var q = mySt.quests[i];
    var pct = Math.min(100, (q.progress/q.target)*100);
    var rw = [];
    for (var rk in q.rewards) { if (rm[rk]) rw.push(rm[rk]+'+'+q.rewards[rk]); }
    html += '<div class="quest-item">';
    html += '<div class="quest-header"><span class="quest-icon">'+q.icon+'</span>';
    html += '<span class="quest-name">'+q.name+'</span></div>';
    html += '<div class="quest-desc">'+q.desc+'</div>';
    html += '<div class="quest-progress-bar"><div class="quest-progress-fill" style="width:'+pct+'%"></div></div>';
    html += '<div class="quest-progress-text">'+q.progress+'/'+q.target+'</div>';
    html += '<div class="quest-rewards">보상: '+rw.join(' ')+'</div></div>';
  }
  el.innerHTML = html;
}

function renderLeaderboard() {
  var pEl = document.getElementById('plb');
  if (!pEl) return;
  var html = '<div style="font-size:0.85em;color:#888;margin-bottom:5px;font-weight:bold">\uD83D\uDC51 순위</div>';
  for (var i = 0; i < lb.p.length; i++) {
    var p = lb.p[i];
    var isMe = p.i === myPi;
    html += '<div class="lb-item" style="'+(isMe?'background:rgba(52,152,219,0.15)':'')+';cursor:pointer"';
    if (p.i !== myPi) html += ' onclick="spyOn('+p.i+')"';
    html += '>';
    html += '<span class="lb-rank">'+(i+1)+'</span>';
    html += '<span class="lb-color" style="background:'+p.color+'"></span>';
    html += '<span class="lb-civ">'+(p.civIcon||'')+'</span>';
    html += '<span class="lb-name">'+(p.ct||'')+p.name+'</span>';
    html += '<span class="lb-cells">'+(p.rankIcon||'')+p.cells+'</span></div>';
  }
  pEl.innerHTML = html;
  var cEl = document.getElementById('clb');
  if (cEl && lb.c && lb.c.length > 0) {
    var ch = '<div class="lb-clan">\uD83C\uDFF4 클랜 순위</div>';
    for (var j = 0; j < lb.c.length; j++) {
      var c = lb.c[j];
      ch += '<div class="lb-item"><span class="lb-color" style="background:'+c.color+'"></span>';
      ch += '<span class="lb-name">['+c.tag+'] '+c.name+'</span>';
      ch += '<span class="lb-cells">'+c.cells+'</span></div>';
    }
    cEl.innerHTML = ch;
  }
}

function renderClanList(clans) {
  var el = document.getElementById('clanPanel');
  if (!el) return;
  var html = '<div class="clan-list">';
  if (clans && clans.length > 0) {
    for (var i = 0; i < clans.length; i++) {
      html += '<div class="clan-item" onclick="joinClan('+clans[i].id+')">';
      html += '<span>['+clans[i].tag+'] '+clans[i].name+'</span>';
      html += '<span style="color:#888;font-size:0.8em">'+clans[i].members+'명</span></div>';
    }
  } else {
    html += '<div style="color:#666;font-size:0.85em">클랜이 없습니다</div>';
  }
  html += '</div><div class="clan-create">';
  html += '<input id="clanName" placeholder="클랜 이름" maxlength="20">';
  html += '<input id="clanTag" placeholder="태그 (3글자)" maxlength="5">';
  html += '<button onclick="createClan()">클랜 생성</button>';
  html += '<button onclick="leaveClan()" style="margin-top:4px;background:#e74c3c">클랜 탈퇴</button></div>';
  el.innerHTML = html;
}

function showDeathStats() {
  var el = document.getElementById('deathStats');
  if (!el || !mySt) return;
  var s = mySt.stats || {};
  el.innerHTML = '<div>점령칸: <b>'+(s.cellsClaimed||0)+'</b></div>'
    +'<div>야만족처치: <b>'+(s.barbsKilled||0)+'</b></div>'
    +'<div>적영토점령: <b>'+(s.enemyCellsTaken||0)+'</b></div>'
    +'<div>건물건설: <b>'+(s.buildingsBuilt||0)+'</b></div>'
    +'<div>퀘스트완료: <b>'+(s.questsDone||0)+'</b></div>'
    +'<div>최고연속처치: <b>'+(mySt.bestStreak||0)+'</b></div>';
}

// ===== COST HELPERS =====
function getBldgCost(key, level) {
  var def = BLDG[key]; if (!def) return {};
  var costs = {};
  for (var r in def.base) costs[r] = Math.ceil(def.base[r] * Math.pow(1.3, level));
  return costs;
}

function getTechCost(key, level) {
  var def = TECH[key]; if (!def) return {};
  var costs = {};
  for (var r in def.base) costs[r] = Math.ceil(def.base[r] * Math.pow(1.25, level));
  return costs;
}

function canLocalAfford(costs) {
  if (!mySt) return false;
  for (var k in costs) { if ((mySt.r[k]||0) < costs[k]) return false; }
  return true;
}

function formatCost(costs) {
  var icons = {f:'\uD83C\uDF3E',w:'\uD83E\uDEB5',s:'\uD83E\uDEA8',g:'\uD83D\uDCB0'};
  var parts = [];
  for (var k in costs) {
    var has = mySt ? ((mySt.r[k]||0) >= costs[k]) : false;
    parts.push('<span class="'+(has?'cost-ok':'cost-bad')+'">'+(icons[k]||k)+costs[k]+'</span>');
  }
  return parts.join(' ');
}

function updateTradeRate() {
  var el = document.getElementById('tradeRate');
  if (!el || !mySt) return;
  var from = (document.getElementById('tradeFrom')||{}).value || 'food';
  var to = (document.getElementById('tradeTo')||{}).value || 'wood';
  var ml = (mySt.b && mySt.b.market) ? mySt.b.market.l : 0;
  var mb = 1 + ml * 0.08;
  var rate = from==='gold' ? 2.0*mb : (to==='gold' ? 0.4*mb : 0.7*mb);
  el.textContent = '교환비율: 1 '+from+' \u2192 '+rate.toFixed(2)+' '+to+' (시장Lv.'+ml+')';
}

// ===== ACTIONS =====
function buildItem(k) { socket.emit('bld', {b:k}); }
function researchItem(k) { socket.emit('res', {t:k}); }
function useSkill(sk) { socket.emit('skill', {skill:sk}); }
function doTrade() {
  var from = document.getElementById('tradeFrom').value;
  var to = document.getElementById('tradeTo').value;
  var amt = parseInt(document.getElementById('tradeAmount').value) || 100;
  socket.emit('trade', {from:from, to:to, amount:amt});
}
function doBorderPush() { socket.emit('bpush'); }
function startMassAtk() { massAtkMode = true; }
function createClan() {
  var n = (document.getElementById('clanName')||{}).value || 'Clan';
  var t = (document.getElementById('clanTag')||{}).value || 'CLN';
  socket.emit('cclan', {name:n, tag:t});
}
function joinClan(ci) { socket.emit('jclan', {ci:ci}); }
function leaveClan() { socket.emit('lclan'); }
function spyOn(pi) { if (pi !== myPi) socket.emit('spy', {target:pi}); }
function closeSpyModal() { document.getElementById('spyModal').style.display='none'; }

// ===== NOTIFICATIONS =====
function showMsgBox(msg) {
  var el = document.getElementById('msgBox');
  if (!el) return;
  el.textContent = msg; el.style.display = '';
  setTimeout(function() { el.style.display='none'; }, 3000);
}

function showRewardBox(msg) {
  var el = document.getElementById('rewardBox');
  if (!el) return;
  el.textContent = msg; el.style.display = '';
  setTimeout(function() { el.style.display='none'; }, 3000);
}

function showCombo(count) {
  var el = document.getElementById('comboNotif');
  if (!el) return;
  el.textContent = count + 'x COMBO! \uD83D\uDD25';
  el.style.display = ''; el.style.animation = 'none';
  void el.offsetHeight; el.style.animation = '';
  setTimeout(function() { el.style.display='none'; }, 1200);
  var flash = document.createElement('div');
  flash.className = 'screen-flash';
  document.body.appendChild(flash);
  setTimeout(function() { flash.remove(); }, 400);
}

function showStreak(count, reward) {
  var el = document.getElementById('streakNotif');
  if (!el) return;
  el.textContent = '\uD83D\uDD25 '+count+' KILL STREAK! '+reward;
  el.style.display=''; el.style.animation='none';
  void el.offsetHeight; el.style.animation='';
  setTimeout(function() { el.style.display='none'; }, 2500);
}

function showQuestDone(d) {
  var el = document.getElementById('questDoneNotif');
  if (!el) return;
  el.innerHTML = '\uD83D\uDCDC 퀘스트 완료! <b>'+d.quest.name+'</b><br>연속: '+d.streak+'회 | 보너스 골드: +'+d.bonusGold;
  el.style.display=''; el.style.animation='none';
  void el.offsetHeight; el.style.animation='';
  setTimeout(function() { el.style.display='none'; }, 2500);
}

function showSkillEffect(skill) {
  var flash = document.createElement('div');
  flash.className = 'screen-flash';
  if (skill==='lightning') flash.style.background='rgba(255,255,100,0.3)';
  else if (skill==='shield') flash.style.background='rgba(52,152,219,0.2)';
  else if (skill==='conscript') flash.style.background='rgba(46,204,113,0.2)';
  else if (skill==='plunder') flash.style.background='rgba(243,156,18,0.2)';
  document.body.appendChild(flash);
  setTimeout(function() { flash.remove(); }, 400);
}

function showSpyModal(info) {
  var el = document.getElementById('spyModal');
  var cnt = document.getElementById('spyInfo');
  if (!el || !cnt) return;
  var h = '<div><span class="spy-label">이름</span><span class="spy-val">'+info.name+'</span></div>';
  h += '<div><span class="spy-label">문명</span><span class="spy-val">'+info.civName+'</span></div>';
  h += '<div><span class="spy-label">영토</span><span class="spy-val">'+info.cells+'칸</span></div>';
  h += '<div><span class="spy-label">계급</span><span class="spy-val">'+(info.rank?info.rank.icon:'')+' '+(info.rank?info.rank.n:'')+'</span></div>';
  if (info.troops !== undefined) {
    h += '<div><span class="spy-label">병력</span><span class="spy-val">'+info.troops+'</span></div>';
  }
  if (info.resources) {
    h += '<div><span class="spy-label">식량</span><span class="spy-val">'+info.resources.food+'</span></div>';
    h += '<div><span class="spy-label">목재</span><span class="spy-val">'+info.resources.wood+'</span></div>';
    h += '<div><span class="spy-label">석재</span><span class="spy-val">'+info.resources.stone+'</span></div>';
    h += '<div><span class="spy-label">골드</span><span class="spy-val">'+info.resources.gold+'</span></div>';
  }
  if (info.buildings) {
    h += '<div style="margin-top:8px;color:#3498db;font-weight:bold">건물</div>';
    for (var bk in info.buildings) {
      if (BLDG[bk]) h += '<div><span class="spy-label">'+BLDG[bk].n+'</span><span class="spy-val">Lv.'+info.buildings[bk]+'</span></div>';
    }
  }
  if (info.tech) {
    h += '<div style="margin-top:8px;color:#9b59b6;font-weight:bold">기술</div>';
    for (var tk in info.tech) {
      if (TECH[tk]) h += '<div><span class="spy-label">'+TECH[tk].n+'</span><span class="spy-val">Lv.'+info.tech[tk]+'</span></div>';
    }
  }
  cnt.innerHTML = h;
  el.style.display = '';
}

// ===== INPUT HANDLING =====
function resize() {
  vpW = window.innerWidth;
  vpH = window.innerHeight;
  canvas.width = vpW;
  canvas.height = vpH;
}

function sendViewport() {
  socket.emit('vp', {
    x: Math.max(0, Math.floor(camX)),
    y: Math.max(0, Math.floor(camY)),
    w: Math.ceil(vpW/zoom) + chunkSz,
    h: Math.ceil(vpH/zoom) + chunkSz
  });
}

var vpTimer = 0;
function throttledVP() {
  var now = Date.now();
  if (now - vpTimer > 200) { vpTimer = now; sendViewport(); }
}

window.addEventListener('resize', function() { resize(); throttledVP(); });

canvas.addEventListener('mousedown', function(e) {
  if (e.button === 2) { dragging = true; dragStartX = e.clientX; dragStartY = e.clientY; return; }
  mouseDown = true;
  var tx = Math.floor(e.clientX/zoom + camX);
  var ty = Math.floor(e.clientY/zoom + camY);
  if (massAtkMode) {
    massAtkMode = false;
    socket.emit('matk', {tx:tx, ty:ty});
    return;
  }
  if (alive) emitExp(tx, ty);
});

canvas.addEventListener('mouseup', function(e) {
  if (e.button === 2) { dragging = false; return; }
  mouseDown = false;
});

canvas.addEventListener('mousemove', function(e) {
  mouseX = e.clientX; mouseY = e.clientY;
  if (dragging) {
    camX -= (e.clientX - dragStartX)/zoom;
    camY -= (e.clientY - dragStartY)/zoom;
    dragStartX = e.clientX; dragStartY = e.clientY;
    throttledVP();
    return;
  }
  if (mouseDown && alive) {
    emitExp(Math.floor(e.clientX/zoom+camX), Math.floor(e.clientY/zoom+camY));
  }
});

canvas.addEventListener('wheel', function(e) {
  e.preventDefault();
  var mx = mouseX/zoom + camX;
  var my = mouseY/zoom + camY;
  if (e.deltaY < 0) zoom = Math.min(32, zoom * 1.15);
  else zoom = Math.max(1, zoom / 1.15);
  zoom = Math.round(zoom * 100) / 100;
  camX = mx - mouseX/zoom;
  camY = my - mouseY/zoom;
  throttledVP();
}, { passive: false });

canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });

document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys[e.key] = true;
  if (e.key === '1') useSkill('lightning');
  if (e.key === '2') useSkill('shield');
  if (e.key === '3') useSkill('conscript');
  if (e.key === '4') useSkill('plunder');
  if (e.key === 'Escape') { massAtkMode = false; closeSpyModal(); }
  if (e.key === 'w' || e.key === 'ArrowUp') { camY -= 5; throttledVP(); }
  if (e.key === 'a' || e.key === 'ArrowLeft') { camX -= 5; throttledVP(); }
  if (e.key === 'd' || e.key === 'ArrowRight') { camX += 5; throttledVP(); }
  if (e.key === 's' || e.key === 'ArrowDown') { camY += 5; throttledVP(); }
});

document.addEventListener('keyup', function(e) { keys[e.key] = false; });

var tradeFrom = document.getElementById('tradeFrom');
var tradeTo = document.getElementById('tradeTo');
if (tradeFrom) tradeFrom.addEventListener('change', updateTradeRate);
if (tradeTo) tradeTo.addEventListener('change', updateTradeRate);

// Touch support
canvas.addEventListener('touchstart', function(e) {
  e.preventDefault();
  var t = e.touches[0];
  mouseX = t.clientX; mouseY = t.clientY; mouseDown = true;
  if (alive) emitExp(Math.floor(t.clientX/zoom+camX), Math.floor(t.clientY/zoom+camY));
}, { passive: false });

canvas.addEventListener('touchmove', function(e) {
  e.preventDefault();
  var t = e.touches[0];
  if (e.touches.length === 1 && mouseDown && alive) {
    mouseX = t.clientX; mouseY = t.clientY;
    emitExp(Math.floor(t.clientX/zoom+camX), Math.floor(t.clientY/zoom+camY));
  }
}, { passive: false });

canvas.addEventListener('touchend', function() { mouseDown = false; });

// ===== BOOT =====
resize();
requestAnimationFrame(draw);
setInterval(function() { if (alive && mySt) updateSkillBar(); }, 500);

// Check Discord login status
fetch('/auth/me').then(function(r) { return r.json(); }).then(function(d) {
  if (d.loggedIn) {
    discordUser = { id: d.id, name: d.name, avatar: d.avatar };
    var loginSec = document.getElementById('loginSection');
    var afterSec = document.getElementById('afterLogin');
    if (loginSec) loginSec.style.display = 'none';
    if (afterSec) afterSec.style.display = '';
    var userEl = document.getElementById('discordUser');
    if (userEl) {
      var avatarHtml = d.avatar
        ? '<img src="' + d.avatar + '?size=32" class="discord-avatar">'
        : '<span class="discord-avatar-placeholder">\uD83D\uDC7E</span>';
      userEl.innerHTML = avatarHtml + '<span class="discord-name">' + d.name + '</span>';
    }
  }
}).catch(function() {});
