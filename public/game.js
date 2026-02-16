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
var mapW = 800, mapH = 400, chunkSz = 50;
var pColors = {};
var chunks = {};
var lb = { p: [], c: [] };
var mySt = null;
var BLDG = {}, TECH = {}, CIVS = {}, RANKS = [], STILES = {};
var UNIT_TYPES = {};
var BLDG_CODES = {};
var BLDG_FROM_CODE = {};
var lastMsg = '', msgTimer = 0;
var lastReward = null, rewardTimer = 0;

// Round system
var roundInfo = { phase: 'waiting', remaining: 0, duration: 0, roundNumber: 0 };
var roundEndData = null; // set when round ends
var PHASE_NAMES = { active: '⚔️ 전투', ending: '🏆 종료', waiting: '⏳ 대기', lobby: '🏠 로비' };
var PHASE_COLORS = { active: '#FF9800', ending: '#9C27B0', waiting: '#607D8B', lobby: '#4CAF50' };

// Lobby system
var lobbyState = null;  // { countdown, players, maxPlayers, mapName, roundNumber }
var inLobby = true;     // true when showing lobby UI
var lobbyJoined = false; // true after clicking join

// Units
var activeUnits = []; // units received from server
var deployMode = null; // null or 'scout'|'army'|'elite'
var buildPlaceMode = null; // null or building type key like 'farm'
var unitDustParticles = []; // dust trail particles
var cannonFireEffects = []; // cannon fire visual effects [{fx,fy,tx,ty,t,owner}]

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
  if (now - lastExpTime < 16) return; // ~60fps cap
  lastExpTime = now;
  // Only send if we have troops
  if (!mySt || mySt.tt < 1) return;
  socket.emit('exp', {x: x, y: y});
  // Spawn expansion particles
  for (var pi = 0; pi < 3; pi++) {
    spawnParticle(x + Math.random() - 0.5, y + Math.random() - 0.5, myColor, 'expand');
  }
}

// Terrain colors — richer palette
var TERRAIN_COLORS = [
  [14, 32, 78],    // 0 ocean (deep dark blue)
  [98, 168, 68],   // 1 plains (vibrant green)
  [28, 108, 44],   // 2 forest (rich green)
  [205, 182, 115], // 3 desert (warm sand)
  [108, 102, 112], // 4 mountain (blue-grey)
  [170, 190, 168], // 5 tundra (muted sage)
  [210, 225, 242], // 6 ice (cold blue-white)
  [42, 88, 135],   // 7 shallow (clear blue)
  [132, 152, 88],  // 8 hills (olive green)
  [52, 82, 48]     // 9 swamp (dark green)
];
var SHORE_COLOR = [185, 168, 118]; // sandy shore edge
var DEFENSE_MAP = [0,1.0,1.6,2.0,4.0,1.8,99,0,2.5,1.4];

// ===== HIGH-QUALITY TERRAIN RENDERING =====
// Deterministic noise from world coordinates (no server data needed)
function _hash(x, y, s) {
  var n = Math.sin(x * 127.1 + y * 311.7 + s * 113.5) * 43758.5453;
  return n - Math.floor(n);
}
function smoothNoise(x, y, s) {
  var ix = Math.floor(x), iy = Math.floor(y);
  var fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  var a = _hash(ix, iy, s), b = _hash(ix+1, iy, s);
  var c = _hash(ix, iy+1, s), d = _hash(ix+1, iy+1, s);
  return a*(1-fx)*(1-fy) + b*fx*(1-fy) + c*(1-fx)*fy + d*fx*fy;
}
function terrainFbm(gx, gy) {
  return smoothNoise(gx*0.015, gy*0.015, 0) * 0.50
       + smoothNoise(gx*0.040, gy*0.040, 100) * 0.30
       + smoothNoise(gx*0.100, gy*0.100, 200) * 0.20;
}
function microNoise(gx, gy) {
  return _hash(gx, gy, 42);
}

// Multi-color terrain palettes: [lowColor, highColor]
// Terrain color is interpolated between these based on noise  
var T_PAL = [
  // 0 ocean: deep to medium blue
  [[6,15,52],[22,48,105]],
  // 1 plains: varied greens (lush meadow)
  [[72,145,48],[142,195,78]],
  // 2 forest: dark canopy greens
  [[18,78,28],[55,128,48]],
  // 3 desert: warm sand tones
  [[185,168,105],[225,205,148]],
  // 4 mountain: grey rock to light stone
  [[88,85,95],[165,160,170]],
  // 5 tundra: muted grey-greens
  [[140,162,138],[185,200,180]],
  // 6 ice: cold whites with blue tint
  [[195,210,232],[235,245,255]],
  // 7 shallow: clear coastal blue
  [[30,75,120],[58,115,162]],
  // 8 hills: olive-green elevated ground
  [[102,132,65],[155,175,95]],
  // 9 swamp: dark murky greens
  [[35,65,35],[62,95,52]]
];

// Base elevation per terrain (for relief shading)
var T_ELEV = [0, 35, 50, 20, 210, 30, 5, 2, 120, 15];

// Get fake elevation at world coordinate
function getElev(t, gx, gy) {
  var base = T_ELEV[t] || 0;
  var n = terrainFbm(gx, gy);
  return base + n * 40 - 10;
}

// Compute terrain color with natural variation
function getTerrainRGB(t, gx, gy) {
  var pal = T_PAL[t];
  if (!pal) return [0,0,0];
  var lo = pal[0], hi = pal[1];
  // Large-scale noise for biome variation
  var n1 = terrainFbm(gx, gy);
  // Micro noise for pixel-level texture
  var n2 = microNoise(gx, gy);
  // Blend factor (mostly large-scale, a bit of micro)
  var f = n1 * 0.82 + n2 * 0.18;

  var r = (lo[0] + (hi[0] - lo[0]) * f)|0;
  var g = (lo[1] + (hi[1] - lo[1]) * f)|0;
  var b = (lo[2] + (hi[2] - lo[2]) * f)|0;

  // Terrain-specific enhancements
  if (t === 0) {
    // Ocean: darken near edges, add subtle wave pattern
    var wave = smoothNoise(gx * 0.008, gy * 0.012, 500) * 0.15;
    r = Math.max(0, (r + wave * 15)|0);
    g = Math.max(0, (g + wave * 20)|0);
    b = Math.min(255, (b + wave * 25)|0);
  } else if (t === 1) {
    // Plains: occasional dry patches
    if (n1 > 0.7) {
      r = (r * 1.08 + 10)|0; g = (g * 0.95)|0; b = (b * 0.9)|0;
    }
  } else if (t === 2) {
    // Forest: dark canopy variation  
    var canopy = smoothNoise(gx * 0.06, gy * 0.06, 300);
    r = (r - canopy * 12)|0;
    g = (g + canopy * 15 - 5)|0;
    b = (b - canopy * 8)|0;
  } else if (t === 3) {
    // Desert: dune patterns  
    var dune = smoothNoise(gx * 0.02, gy * 0.04, 400);
    r = (r + dune * 18 - 8)|0;
    g = (g + dune * 14 - 6)|0;
    b = (b + dune * 6 - 3)|0;
  } else if (t === 4) {
    // Mountain: snow on peaks (high noise = snow cap)
    if (n1 > 0.65) {
      var snowF = (n1 - 0.65) / 0.35;
      r = (r + (220 - r) * snowF * 0.6)|0;
      g = (g + (225 - g) * snowF * 0.6)|0;
      b = (b + (235 - b) * snowF * 0.6)|0;
    }
  } else if (t === 8) {
    // Hills: elevation-based shading
    var slope = smoothNoise(gx * 0.03, gy * 0.05, 350);
    r = (r + slope * 15 - 7)|0;
    g = (g + slope * 12 - 5)|0;
  } else if (t === 9) {
    // Swamp: muddy water patches
    if (n2 > 0.7) {
      r = (r + 8)|0; g = (g + 5)|0; b = (b - 5)|0;
    }
  }
  return [Math.max(0,Math.min(255,r)), Math.max(0,Math.min(255,g)), Math.max(0,Math.min(255,b))];
}

// Relief shading: compare neighbor elevations for 3D effect
function getReliefShading(t, gx, gy, chunk, lx, ly) {
  var e = getElev(t, gx, gy);
  // Sun from northwest (top-left)
  var tW = getNeighborTerrain(chunk, lx, ly, -1, 0); if (tW < 0) tW = t;
  var tN = getNeighborTerrain(chunk, lx, ly, 0, -1); if (tN < 0) tN = t;
  var tE = getNeighborTerrain(chunk, lx, ly, 1, 0);  if (tE < 0) tE = t;
  var tS = getNeighborTerrain(chunk, lx, ly, 0, 1);  if (tS < 0) tS = t;
  var eW = getElev(tW, gx-1, gy);
  var eN = getElev(tN, gx, gy-1);
  var eE = getElev(tE, gx+1, gy);
  var eS = getElev(tS, gx, gy+1);
  // Gradient (dx = east-west, dy = north-south)
  var dx = (eE - eW) * 0.5;
  var dy = (eS - eN) * 0.5;
  // Directional light from NW → NW is negative dx, negative dy
  var shade = (-dx * 0.7 + -dy * 0.7) * 0.012;
  // Clamp to reasonable range
  return Math.max(-0.25, Math.min(0.30, shade));
}

// Blend two terrain colors for transition effect
function blendTerrainColors(rgb1, rgb2, factor) {
  return [
    (rgb1[0] * (1-factor) + rgb2[0] * factor)|0,
    (rgb1[1] * (1-factor) + rgb2[1] * factor)|0,
    (rgb1[2] * (1-factor) + rgb2[2] * factor)|0
  ];
}

// Terrain info for tooltip
var TERRAIN_NAMES = ['바다','평원','숲','사막','산악','툰드라','빙하','얕은물','구릉','늪지'];
var TERRAIN_COST  = [99,    1,    3,   4,    10,   3,      99,    99,     5,    6   ];
var TERRAIN_DEF   = [0,     1.0,  1.6, 2.0,  4.0,  1.8,    99,    0,      2.5,  1.4 ];
var TERRAIN_RES_DESC = [
  '',
  '🌾식량+3 🪵목재+1',
  '🌾식량+1 🪵목재+4',
  '🪨석재+1 💰금+3',
  '🪨석재+4 💰금+2',
  '🌾+1 🪵+1 🪨+1',
  '',
  '',
  '🌾+1 🪨석재+3 💰금+1',
  '🌾+2 🪵+2'
];

// Number formatting
function fmtNum(n) {
  if (n >= 10000) return (n/1000).toFixed(1) + 'k';
  if (n >= 1000) return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n.toString();
}

// Smooth camera
var targetCamX = 0, targetCamY = 0;
var camLerp = 0.18;
var smoothCam = true;

// ===== PARTICLE SYSTEM =====
var particles = [];
var MAX_PARTICLES = 200;
function spawnParticle(x, y, color, type) {
  if (particles.length >= MAX_PARTICLES) particles.shift();
  var angle = Math.random() * Math.PI * 2;
  var speed = 0.3 + Math.random() * 0.8;
  particles.push({
    x: x, y: y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: 1.0,
    decay: 0.015 + Math.random() * 0.02,
    color: color,
    size: type === 'expand' ? 2 + Math.random()*2 : 1.5 + Math.random()*1.5,
    type: type
  });
}
function updateAndDrawParticles() {
  for (var i = particles.length - 1; i >= 0; i--) {
    var p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    var sx = (p.x - camX) * zoom;
    var sy = (p.y - camY) * zoom;
    if (sx < -10 || sy < -10 || sx > canvas.width+10 || sy > canvas.height+10) continue;
    ctx.globalAlpha = p.life * 0.7;
    ctx.fillStyle = p.color;
    if (p.type === 'expand') {
      ctx.beginPath();
      ctx.arc(sx, sy, p.size * zoom * 0.1, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(sx - p.size*0.5, sy - p.size*0.5, p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;
}

function isWaterTerrain(tt) { return tt === 0 || tt === 6 || tt === 7; }
function isLandTerrain(tt) { return tt >= 1 && tt <= 5 || tt === 8 || tt === 9; }
var BARB_COLOR = [80, 0, 0];
var UNKNOWN_TERRITORY_COLOR = [90, 70, 100]; // purple-grey for unknown owner territory
var SPECIAL_COLORS = {
  1: [255, 215, 0],    // goldMine
  2: [0, 200, 150],    // oasis
  3: [180, 140, 100],  // ruins
  4: [200, 80, 30],    // volcano
  5: [50, 150, 200],   // harbor
  6: [160, 160, 180],  // iron (metallic grey)
  7: [180, 130, 80],   // horses (brown)
  8: [220, 200, 100],  // shrine (golden)
  9: [60, 180, 60],    // fertile (bright green)
  10: [140, 140, 160]  // watchtower (stone grey)
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
      var desc = document.getElementById('civDesc') || document.getElementById('lobbyCivDesc');
      if (desc) desc.textContent = CIVS[key].desc;
      // If in lobby, notify server of civ change
      if (inLobby && lobbyJoined) {
        socket.emit('lobbyCiv', { civ: key });
      }
    });
    container.appendChild(card);
  });
}

// ===== SPAWN MAP =====
function renderSpawnMap(canvasId) {
  var c = document.getElementById(canvasId);
  if (!c || !terrainPreviewData) return;
  var ctx2 = c.getContext('2d');
  var dd = terrainPreviewData;
  var img = ctx2.createImageData(dd.w, dd.h);
  var scale = 10; // preview is 1:10 scale
  for (var i = 0; i < dd.t.length; i++) {
    var pi2 = i * 4;
    var px = i % dd.w, py = Math.floor(i / dd.w);
    var gx = px * scale, gy = py * scale;
    if (dd.o[i] === 1) {
      // Player territory
      img.data[pi2]=255; img.data[pi2+1]=255; img.data[pi2+2]=200;
    } else if (dd.o[i] === 2) {
      // Barbarian
      img.data[pi2]=80; img.data[pi2+1]=0; img.data[pi2+2]=0;
    } else {
      // Natural terrain — use high-quality rendering
      var tc = getTerrainRGB(dd.t[i], gx, gy);
      // Simplified relief (check neighbor pixels in preview)
      var relief2 = 0;
      if (px > 0 && px < dd.w - 1 && py > 0 && py < dd.h - 1) {
        var tW2 = dd.t[i - 1], tE2 = dd.t[i + 1];
        var tN2 = dd.t[i - dd.w], tS2 = dd.t[i + dd.w];
        var eC = T_ELEV[dd.t[i]] || 0;
        var eW2 = T_ELEV[tW2] || 0, eE2 = T_ELEV[tE2] || 0;
        var eN2 = T_ELEV[tN2] || 0, eS2 = T_ELEV[tS2] || 0;
        var dx2 = (eE2 - eW2) * 0.5, dy2 = (eS2 - eN2) * 0.5;
        relief2 = (-dx2 * 0.7 + -dy2 * 0.7) * 0.008;
        relief2 = Math.max(-0.2, Math.min(0.25, relief2));
      }
      img.data[pi2] = Math.max(0, Math.min(255, (tc[0] * (1 + relief2))|0));
      img.data[pi2+1] = Math.max(0, Math.min(255, (tc[1] * (1 + relief2))|0));
      img.data[pi2+2] = Math.max(0, Math.min(255, (tc[2] * (1 + relief2))|0));
    }
    img.data[pi2+3] = 255;
  }
  var tmpC = document.createElement('canvas');
  tmpC.width = dd.w; tmpC.height = dd.h;
  tmpC.getContext('2d').putImageData(img, 0, 0);
  ctx2.imageSmoothingEnabled = true;
  ctx2.imageSmoothingQuality = 'high';
  ctx2.drawImage(tmpC, 0, 0, dd.w, dd.h, 0, 0, c.width, c.height);
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

// ===== START / RESPAWN / LOBBY =====
function checkLogin() {
  if (!discordUser) return;
  document.getElementById('ss').style.display = 'none';
  showLobbyScreen();
}

function showLobbyScreen() {
  document.getElementById('ss').style.display = 'none';
  document.getElementById('ds').style.display = 'none';
  document.getElementById('gu').style.display = 'none';
  document.getElementById('lobbyScreen').style.display = '';
  inLobby = true;
  lobbyJoined = false;
  // Show user info
  var userEl = document.getElementById('lobbyUserInfo');
  if (userEl && discordUser) {
    userEl.innerHTML = '<span class="lobby-username">' + (discordUser.name || 'Player') + '</span>' +
      ' <a href="/auth/logout" class="lobby-logout">로그아웃</a>';
  }
  // Build civ grid for lobby
  buildCivGrid('lobbyCivGrid', false);
  // Render map preview and update lobby info
  renderLobbyMapPreview();
  updateLobbyUI();
}

function joinLobby() {
  if (!discordUser) { window.location.href = '/auth/discord'; return; }
  if (lobbyJoined) return;
  lobbyJoined = true;
  var name = discordUser.name || 'Player';
  socket.emit('joinLobby', { name: name, civ: myCiv });
  var btn = document.getElementById('lobbyJoinBtn');
  if (btn) { btn.textContent = '✅ 참가 완료'; btn.classList.add('joined'); }
}

function renderLobbyMapPreview() {
  var c = document.getElementById('lobbyMapPreview');
  if (!c || !terrainPreviewData) return;
  var ctx2 = c.getContext('2d');
  var d = terrainPreviewData;
  var img = ctx2.createImageData(d.w, d.h);
  for (var i = 0; i < d.t.length; i++) {
    var tc = TERRAIN_COLORS[d.t[i]] || [0,0,0];
    var pi2 = i * 4;
    img.data[pi2] = tc[0]; img.data[pi2+1] = tc[1]; img.data[pi2+2] = tc[2]; img.data[pi2+3] = 255;
  }
  var tmpC = document.createElement('canvas');
  tmpC.width = d.w; tmpC.height = d.h;
  tmpC.getContext('2d').putImageData(img, 0, 0);
  ctx2.imageSmoothingEnabled = true;
  ctx2.drawImage(tmpC, 0, 0, d.w, d.h, 0, 0, c.width, c.height);
}

function updateLobbyUI() {
  if (!lobbyState) return;
  var nameEl = document.getElementById('lobbyMapName');
  if (nameEl) nameEl.textContent = lobbyState.mapName || '???';
  var timerEl = document.getElementById('lobbyTimer');
  if (timerEl) timerEl.textContent = Math.ceil((lobbyState.countdown || 0) / 1000) + 's';
  var countEl = document.getElementById('lobbyPlayerCount');
  if (countEl) countEl.textContent = (lobbyState.players ? lobbyState.players.length : 0) + '/' + (lobbyState.maxPlayers || 20) + ' 👥';
  // Player list
  var listEl = document.getElementById('lobbyPlayersList');
  if (listEl && lobbyState.players) {
    var html = '';
    for (var i = 0; i < lobbyState.players.length; i++) {
      var p = lobbyState.players[i];
      var civInfo = CIVS[p.civ] || {};
      html += '<div class="lobby-player-item">' +
        '<span class="lobby-player-color" style="background:' + p.color + '"></span>' +
        '<span class="lobby-player-name">' + p.name + '</span>' +
        '<span class="lobby-player-civ">' + (civInfo.icon || '') + '</span>' +
        '</div>';
    }
    if (lobbyState.players.length === 0) {
      html = '<div class="lobby-no-players">아직 참가자가 없습니다</div>';
    }
    listEl.innerHTML = html;
  }
}

function respawnMidGame() {
  socket.emit('respawn', { civ: myCiv });
}

function startGame() {
  if (!discordUser) { window.location.href = '/auth/discord'; return; }
  var name = discordUser.name || 'Player';
  var data = { name: name, civ: myCiv };
  if (spawnX >= 0 && spawnY >= 0) { data.sx = spawnX; data.sy = spawnY; }
  socket.emit('join', data);
  spawnX = -1; spawnY = -1;
}

function respawn() {
  socket.emit('respawn', { civ: myCiv });
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
  RANKS = d.ranks || [];
  STILES = d.stiles || {};
  UNIT_TYPES = d.unitTypes || {};
  BLDG_CODES = d.bldgCodes || {};
  BLDG_FROM_CODE = {};
  for (var bk in BLDG_CODES) BLDG_FROM_CODE[BLDG_CODES[bk]] = bk;
  DEFENSE_MAP = d.defense || [0,1,1.3,2.5,99,1.2,99,0,1.5,0.9];
  buildCivGrid('civGrid', false);
  buildCivGrid('respawnCivGrid', true);
  buf.width = mapW; buf.height = mapH;
});

socket.on('joined', function(d) {
  myPi = d.pi;
  myColor = d.color;
  myCiv = d.civ || 'rome';
  alive = true;
  inLobby = false;
  camX = d.sx - Math.floor(vpW / zoom / 2);
  camY = d.sy - Math.floor(vpH / zoom / 2);
  targetCamX = camX;
  targetCamY = camY;
  document.getElementById('ss').style.display = 'none';
  document.getElementById('ds').style.display = 'none';
  document.getElementById('lobbyScreen').style.display = 'none';
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

// Quick state: immediate lightweight update for critical numbers
socket.on('qs', function(d) {
  if (!mySt) return;
  mySt.tt = d.tt; mySt.mt = d.mt;
  mySt.r = d.r;
  if (d.activeUnits !== undefined) mySt.activeUnits = d.activeUnits;
  if (d.bCount !== undefined) mySt.bCount = d.bCount;
  if (d.bMax !== undefined) mySt.bMax = d.bMax;
  // Immediate UI refresh for resource bar only
  document.getElementById('rTroop').textContent = '\u2694\uFE0F ' + fmtNum(d.tt) + '/' + fmtNum(d.mt);
  document.getElementById('rFood').textContent = '\uD83C\uDF3E ' + fmtNum(d.r.f);
  document.getElementById('rWood').textContent = '\uD83E\uDEB5 ' + fmtNum(d.r.w);
  document.getElementById('rStone').textContent = '\uD83E\uDEA8 ' + fmtNum(d.r.s);
  document.getElementById('rGold').textContent = '\uD83D\uDCB0 ' + fmtNum(d.r.g);
  var countEl = document.getElementById('unitCount');
  if (countEl) {
    countEl.textContent = (d.activeUnits || 0) + '/' + (mySt.maxUnits || 5);
  }
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
  document.getElementById('gu').style.display = 'none';
  document.getElementById('ds').style.display = '';
  showDeathStats();
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
  // Render lobby map preview if in lobby
  renderLobbyMapPreview();
});

socket.on('combo', function(d) { showCombo(d.count); });
socket.on('streak', function(d) { showStreak(d.count, d.reward); });
socket.on('questDone', function(d) { showQuestDone(d); });
socket.on('skillFx', function(d) { showSkillEffect(d.skill, d.claimed); });
socket.on('spyInfo', function(d) { showSpyModal(d); });

// ===== ROUND SYSTEM EVENTS =====
socket.on('roundInfo', function(d) {
  roundInfo = d;
  updateRoundUI();
});

socket.on('roundEnd', function(d) {
  roundEndData = d;
  showRoundEndScreen(d);
});

// Lobby events
socket.on('enterLobby', function(d) {
  lobbyState = d;
  lobbyJoined = false;
  // Clear game state
  roundEndData = null;
  chunks = {};
  activeUnits = [];
  unitInterp = {};
  unitDustParticles = [];
  lb = { p: [], c: [] };
  mySt = null;
  myPi = -1;
  alive = false;
  bCtx.fillStyle = '#000';
  bCtx.fillRect(0, 0, buf.width, buf.height);
  // Hide round end overlay
  var reo = document.getElementById('roundEndOverlay');
  if (reo) reo.style.display = 'none';
  // Show lobby
  if (discordUser) {
    showLobbyScreen();
    updateLobbyUI();
  }
});

socket.on('lobbyState', function(d) {
  lobbyState = d;
  if (inLobby) updateLobbyUI();
});

socket.on('gameStart', function(d) {
  // Game is starting from lobby
  roundInfo.roundNumber = d.roundNumber;
  roundInfo.duration = d.duration;
  roundEndData = null;
  inLobby = false;
  var reo = document.getElementById('roundEndOverlay');
  if (reo) reo.style.display = 'none';
});

socket.on('roundReset', function(d) {
  // Legacy round reset — handled by enterLobby now
  roundEndData = null;
  chunks = {};
  activeUnits = [];
  unitInterp = {};
  unitDustParticles = [];
  lb = { p: [], c: [] };
  mySt = null;
  bCtx.fillStyle = '#000';
  bCtx.fillRect(0, 0, buf.width, buf.height);
  var reo = document.getElementById('roundEndOverlay');
  if (reo) reo.style.display = 'none';
  roundInfo.roundNumber = d.roundNumber;
});

function updateRoundUI() {
  var el = document.getElementById('roundTimer');
  if (!el) return;
  var rem = roundInfo.remaining || 0;
  var min = Math.floor(rem / 60000);
  var sec = Math.floor((rem % 60000) / 1000);
  var phase = roundInfo.phase || 'waiting';
  var pname = PHASE_NAMES[phase] || phase;
  var pcolor = PHASE_COLORS[phase] || '#fff';
  el.innerHTML = '<span style="color:' + pcolor + '">' + pname + '</span> <span class="round-time">' + pad2(min) + ':' + pad2(sec) + '</span> <span class="round-num">R' + (roundInfo.roundNumber || 1) + '</span>';
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function showRoundEndScreen(d) {
  var overlay = document.getElementById('roundEndOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'roundEndOverlay';
    overlay.className = 'round-end-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  var winnerText = d.winner ? d.winner.name : '무승부';
  var winnerColor = d.winner ? d.winner.color : '#888';
  var html = '<div class="round-end-box">';
  html += '<h1>🏆 라운드 ' + d.roundNumber + ' 종료</h1>';
  html += '<h2 style="color:' + winnerColor + '">' + winnerText + '</h2>';
  html += '<p class="round-reason">' + d.reason + '</p>';
  html += '<div class="scoreboard">';
  html += '<table><tr><th>#</th><th>이름</th><th>점수</th><th>영토</th><th>정복</th><th>처치</th></tr>';
  var sb = d.scoreboard || [];
  var myRank = -1;
  for (var i = 0; i < Math.min(sb.length, 12); i++) {
    var s = sb[i];
    var isMe = s.pi === myPi;
    if (isMe) myRank = i + 1;
    var rowClass = isMe ? 'my-row' : (s.isBot ? 'bot-row' : '');
    html += '<tr class="' + rowClass + '"><td>' + (i+1) + '</td>';
    html += '<td style="color:' + s.color + '">' + s.name + '</td>';
    html += '<td>' + s.score + '</td>';
    html += '<td>' + s.cells + '</td>';
    html += '<td>' + s.enemyTaken + '</td>';
    html += '<td>' + s.kills + '</td></tr>';
  }
  html += '</table></div>';
  var nextIn = Math.ceil((d.nextRoundIn || 10000) / 1000);
  html += '<p class="next-round-timer" id="nextRoundTimer">다음 라운드: ' + nextIn + '초</p>';
  html += '</div>';
  overlay.innerHTML = html;
  // Countdown timer
  var countEl = document.getElementById('nextRoundTimer');
  if (countEl) {
    var remaining = d.nextRoundIn || 10000;
    var countInterval = setInterval(function() {
      remaining -= 1000;
      if (remaining <= 0) { clearInterval(countInterval); countEl.textContent = '새 라운드 시작...'; return; }
      countEl.textContent = '다음 라운드: ' + Math.ceil(remaining / 1000) + '초';
    }, 1000);
  }
}

// Unit events — with time-based interpolation for smooth movement
// Each entry: { prevX, prevY, targetX, targetY, renderX, renderY, updateTime, moveInterval, speed }
var unitInterp = {};
socket.on('units', function(d) {
  var newUnits = d || [];
  var now = performance.now();
  var newIds = {};
  for (var i = 0; i < newUnits.length; i++) {
    var u = newUnits[i];
    newIds[u.id] = true;
    var interp = unitInterp[u.id];
    if (!interp) {
      // First time seeing this unit
      interp = {
        prevX: u.x, prevY: u.y,
        targetX: u.x, targetY: u.y,
        renderX: u.x, renderY: u.y,
        updateTime: now,
        moveInterval: u.mi || 300,
        speed: u.spd || 3,
        lastDx: 0, lastDy: 0
      };
      unitInterp[u.id] = interp;
    } else {
      // If server position changed, set up new interpolation
      if (u.x !== interp.targetX || u.y !== interp.targetY) {
        interp.prevX = interp.renderX;
        interp.prevY = interp.renderY;
        interp.lastDx = u.x - interp.targetX;
        interp.lastDy = u.y - interp.targetY;
        interp.targetX = u.x;
        interp.targetY = u.y;
        interp.updateTime = now;
        interp.moveInterval = u.mi || interp.moveInterval;
        interp.speed = u.spd || interp.speed;
      }
    }
    // Stash server data, use render position
    u._sx = u.x; u._sy = u.y;
    u.x = interp.renderX;
    u.y = interp.renderY;
    u._dx = interp.lastDx;
    u._dy = interp.lastDy;
  }
  // Clean up old entries
  for (var uid in unitInterp) {
    if (!newIds[uid]) delete unitInterp[uid];
  }
  activeUnits = newUnits;
});
socket.on('unitDeployed', function(d) {
  showMsgBox(UNIT_TYPES[d.type] ? UNIT_TYPES[d.type].icon + ' ' + UNIT_TYPES[d.type].n + ' 출발!' : '유닛 배치!');
});
socket.on('unitArrived', function(d) {
  var ut = UNIT_TYPES[d.type];
  showMsgBox((ut ? ut.icon : '⚔️') + ' 도착! ' + d.claimed + '칸 점령, 병력 +' + d.returned);
  // Spawn particles at arrival
  for (var i2 = 0; i2 < 15; i2++) spawnParticle(d.x + Math.random()*6-3, d.y + Math.random()*6-3, myColor, 'expand');
});
socket.on('unitDied', function(d) {
  showMsgBox('💀 유닛 격파됨! (by ' + d.killedBy + ')');
});
socket.on('scoutReport', function(d) {
  var tNames = ['바다','평원','숲','사막','산','툰드라','강','얕은물','언덕','늪'];
  showMsgBox('🔭 정찰 보고: (' + d.x + ',' + d.y + ') ' + (tNames[d.terrain]||'?') + (d.owner >= 0 ? ' [적 영토]' : ' [비어있음]'));
});

// Cannon fire visual effect
socket.on('cannonFire', function(d) {
  cannonFireEffects.push({ fx: d.fx, fy: d.fy, tx: d.tx, ty: d.ty, t: Date.now(), owner: d.owner });
  // Keep max 30 effects
  if (cannonFireEffects.length > 30) cannonFireEffects.shift();
});

// ===== RENDERING =====
function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

// Helper: get terrain at world coordinates from chunk cache
function getTerrainAtWorld(wx, wy) {
  var cx = Math.floor(wx / chunkSz), cy = Math.floor(wy / chunkSz);
  var c = chunks[cx + ',' + cy];
  if (!c || !c.t) return -1;
  var lx = Math.floor(wx) - cx * chunkSz, ly = Math.floor(wy) - cy * chunkSz;
  if (lx < 0 || ly < 0 || lx >= chunkSz || ly >= chunkSz) return -1;
  return c.t[ly * chunkSz + lx];
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

      // Compute high-quality base terrain color
      var baseRGB = getTerrainRGB(t, gx, gy);

      // Apply relief shading for 3D depth
      var relief = getReliefShading(t, gx, gy, c, lx, ly);
      var shadedR = Math.max(0, Math.min(255, (baseRGB[0] * (1 + relief))|0));
      var shadedG = Math.max(0, Math.min(255, (baseRGB[1] * (1 + relief))|0));
      var shadedB = Math.max(0, Math.min(255, (baseRGB[2] * (1 + relief))|0));

      // Terrain transition blending: if neighbor has different terrain, blend slightly
      if (o < 0 && isLandTerrain(t)) {
        for (var bd = 0; bd < 4; bd++) {
          var bdx = bd===0?-1:bd===1?1:0;
          var bdy = bd===2?-1:bd===3?1:0;
          var nt = getNeighborTerrain(c, lx, ly, bdx, bdy);
          if (nt >= 0 && nt !== t && isLandTerrain(nt)) {
            var nRGB = getTerrainRGB(nt, gx+bdx, gy+bdy);
            // Subtle 15% blend toward neighbor
            shadedR = (shadedR * 0.85 + nRGB[0] * 0.15)|0;
            shadedG = (shadedG * 0.85 + nRGB[1] * 0.15)|0;
            shadedB = (shadedB * 0.85 + nRGB[2] * 0.15)|0;
          }
        }
      }

      if (o >= 0 && pColors[o]) {
        // Player territory: blend player color with terrain
        var pc = hexToRgb(pColors[o]);
        r = (pc[0]*0.60 + shadedR*0.40)|0;
        g = (pc[1]*0.60 + shadedG*0.40)|0;
        b = (pc[2]*0.60 + shadedB*0.40)|0;
        // Territory edge depth
        var borderDist = 3;
        for (var ed = 0; ed < 4; ed++) {
          var edx = ed===0?-1:ed===1?1:0;
          var edy = ed===2?-1:ed===3?1:0;
          var elx = lx + edx, ely = ly + edy;
          if (elx >= 0 && elx < chunkSz && ely >= 0 && ely < chunkSz) {
            if (c.o[ely*chunkSz+elx] !== o) { borderDist = 0; break; }
          } else { borderDist = 0; break; }
        }
        if (borderDist > 0) {
          for (var ed2 = 0; ed2 < 4; ed2++) {
            var edx2 = ed2===0?-2:ed2===1?2:0;
            var edy2 = ed2===2?-2:ed2===3?2:0;
            var elx2 = lx + edx2, ely2 = ly + edy2;
            if (elx2 >= 0 && elx2 < chunkSz && ely2 >= 0 && ely2 < chunkSz) {
              if (c.o[ely2*chunkSz+elx2] !== o) { borderDist = Math.min(borderDist, 1); }
            }
          }
          for (var ed3 = 0; ed3 < 4; ed3++) {
            var edx3 = (ed3<2?-1:1), edy3 = (ed3%2===0?-1:1);
            var elx3 = lx + edx3, ely3 = ly + edy3;
            if (elx3 >= 0 && elx3 < chunkSz && ely3 >= 0 && ely3 < chunkSz) {
              if (c.o[ely3*chunkSz+elx3] !== o) { borderDist = Math.min(borderDist, 1); }
            }
          }
        }
        if (borderDist === 0) {
          r = (r * 0.72)|0; g = (g * 0.72)|0; b = (b * 0.72)|0;
        } else if (borderDist === 1) {
          r = (r * 0.88)|0; g = (g * 0.88)|0; b = (b * 0.88)|0;
        }
        // Subtle texture noise within territory
        var texN = microNoise(gx, gy) * 6 - 3;
        r = Math.min(255, Math.max(0, (r + texN)|0));
        g = Math.min(255, Math.max(0, (g + texN)|0));
        b = Math.min(255, Math.max(0, (b + texN * 0.7)|0));
      } else if (o === -3) {
        // Unknown territory
        r = (UNKNOWN_TERRITORY_COLOR[0]*0.50 + shadedR*0.50)|0;
        g = (UNKNOWN_TERRITORY_COLOR[1]*0.50 + shadedG*0.50)|0;
        b = (UNKNOWN_TERRITORY_COLOR[2]*0.50 + shadedB*0.50)|0;
        var uBorder = false;
        for (var ud = 0; ud < 4; ud++) {
          var udx = ud===0?-1:ud===1?1:0;
          var udy = ud===2?-1:ud===3?1:0;
          var ulx2 = lx + udx, uly2 = ly + udy;
          if (ulx2 >= 0 && ulx2 < chunkSz && uly2 >= 0 && uly2 < chunkSz) {
            if (c.o[uly2*chunkSz+ulx2] !== -3) { uBorder = true; break; }
          } else { uBorder = true; break; }
        }
        if (uBorder) { r = (r * 0.75)|0; g = (g * 0.75)|0; b = (b * 0.75)|0; }
      } else if (o === -2) {
        // Barbarian territory
        r = (BARB_COLOR[0]*0.55 + shadedR*0.45)|0;
        g = (BARB_COLOR[1]*0.55 + shadedG*0.45)|0;
        b = (BARB_COLOR[2]*0.55 + shadedB*0.45)|0;
      } else {
        // Unowned terrain — use full shaded colors
        r = shadedR; g = shadedG; b = shadedB;
      }

      // Shore edge: land pixel next to water → sandy tint (wider, 2-cell check)
      if (isLandTerrain(t) && o < 0) {
        var shoreLevel = 0;
        for (var dd = 0; dd < 4; dd++) {
          var ddx = dd===0?-1:dd===1?1:0;
          var ddy = dd===2?-1:dd===3?1:0;
          var nt3 = getNeighborTerrain(c, lx, ly, ddx, ddy);
          if (nt3 === 0 || nt3 === 7) { shoreLevel = 2; break; }
        }
        if (shoreLevel === 0) {
          // Check 2-cell distance for subtle shore gradient
          for (var dd3 = 0; dd3 < 4; dd3++) {
            var ddx3 = dd3===0?-2:dd3===1?2:0;
            var ddy3 = dd3===2?-2:dd3===3?2:0;
            var nt4 = getNeighborTerrain(c, lx, ly, ddx3, ddy3);
            if (nt4 === 0 || nt4 === 7) { shoreLevel = 1; break; }
          }
        }
        if (shoreLevel === 2) {
          r = (r * 0.35 + SHORE_COLOR[0] * 0.65)|0;
          g = (g * 0.35 + SHORE_COLOR[1] * 0.65)|0;
          b = (b * 0.35 + SHORE_COLOR[2] * 0.65)|0;
        } else if (shoreLevel === 1) {
          r = (r * 0.70 + SHORE_COLOR[0] * 0.30)|0;
          g = (g * 0.70 + SHORE_COLOR[1] * 0.30)|0;
          b = (b * 0.70 + SHORE_COLOR[2] * 0.30)|0;
        }
      }

      // Water pixel next to land → shallow tint for natural coastline
      if (isWaterTerrain(t) && o < 0) {
        var coastDist = 0;
        for (var dd2 = 0; dd2 < 4; dd2++) {
          var ddx2 = dd2===0?-1:dd2===1?1:0;
          var ddy2 = dd2===2?-1:dd2===3?1:0;
          var nt2 = getNeighborTerrain(c, lx, ly, ddx2, ddy2);
          if (isLandTerrain(nt2)) { coastDist = 2; break; }
        }
        if (coastDist === 0) {
          for (var dd4 = 0; dd4 < 4; dd4++) {
            var ddx4 = dd4===0?-2:dd4===1?2:0;
            var ddy4 = dd4===2?-2:dd4===3?2:0;
            var nt5 = getNeighborTerrain(c, lx, ly, ddx4, ddy4);
            if (isLandTerrain(nt5)) { coastDist = 1; break; }
          }
        }
        if (coastDist === 2) {
          // Very close to coast: turquoise shallow
          r = (r * 0.4 + 35 * 0.6)|0;
          g = (g * 0.4 + 100 * 0.6)|0;
          b = (b * 0.4 + 140 * 0.6)|0;
        } else if (coastDist === 1) {
          // Near coast: lighter blue
          r = (r * 0.65 + 28 * 0.35)|0;
          g = (g * 0.65 + 85 * 0.35)|0;
          b = (b * 0.65 + 130 * 0.35)|0;
        }
      }

      // Special tiles
      if (sp > 0 && o < 0) {
        var sc = SPECIAL_COLORS[sp];
        if (sc) { r = (r*0.5+sc[0]*0.5)|0; g = (g*0.5+sc[1]*0.5)|0; b = (b*0.5+sc[2]*0.5)|0; }
      } else if (sp > 0 && o >= 0) {
        r = Math.min(255, r+20); g = Math.min(255, g+20); b = Math.min(255, b+10);
      }

      // Fog of war
      var fogLevel = c.fog ? c.fog[li] : 0;
      if (fogLevel === 1) {
        r = (r * 0.22)|0; g = (g * 0.22)|0; b = (b * 0.25)|0;
      } else if (fogLevel === 2) {
        r = (r * 0.50)|0; g = (g * 0.48)|0; b = (b * 0.55 + 12)|0;
      }
      d[pi] = r; d[pi+1] = g; d[pi+2] = b; d[pi+3] = 255;
    }
  }
  bCtx.putImageData(imgData, sx, sy);
}

function draw() {
  var w = canvas.width, h = canvas.height;

  // Smooth camera lerp
  if (smoothCam && !dragging) {
    camX += (targetCamX - camX) * camLerp;
    camY += (targetCamY - camY) * camLerp;
  }

  // Dark background with subtle gradient
  var bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#08081a');
  bg.addColorStop(1, '#0a0a14');
  ctx.fillStyle = bg;
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

  // Grid lines at high zoom — subtler
  if (zoom >= 10) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
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

  // Territory border outlines
  if (zoom >= 3) {
    drawTerritoryBorders(w, h);
  }

  // Capital icon with glow
  if (mySt && mySt.cap && zoom >= 3) {
    var cx = (mySt.cap.x - camX) * zoom + zoom/2;
    var cy = (mySt.cap.y - camY) * zoom + zoom/2;
    // Glow effect
    ctx.save();
    ctx.shadowColor = myColor;
    ctx.shadowBlur = zoom * 1.5;
    ctx.font = Math.max(12, zoom * 1.2) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('\uD83C\uDFF0', cx, cy);
    ctx.restore();
  }

  // Player name labels on territories
  if (zoom >= 2 && zoom < 20) {
    drawPlayerLabels(w, h);
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

  // ===== BUILDING ICONS ON MAP =====
  if (zoom >= 6) {
    var bvx0 = Math.floor(camX), bvy0 = Math.floor(camY);
    var bvx1 = Math.ceil(camX + canvas.width/zoom), bvy1 = Math.ceil(camY + canvas.height/zoom);
    for (var bvy = bvy0; bvy < bvy1; bvy++) {
      for (var bvx = bvx0; bvx < bvx1; bvx++) {
        var bck = (Math.floor(bvx/chunkSz)) + ',' + (Math.floor(bvy/chunkSz));
        var bch = chunks[bck];
        if (!bch || !bch.bl) continue;
        var blx = ((bvx%chunkSz)+chunkSz)%chunkSz;
        var bly = ((bvy%chunkSz)+chunkSz)%chunkSz;
        var blv = bch.bl[bly*chunkSz+blx];
        if (blv === 0) continue;
        var isConstructing = blv < 0;
        var absVal = Math.abs(blv);
        var bTypeCode = Math.floor(absVal / 100);
        var bLevel = absVal % 100;
        var bTypeKey = BLDG_FROM_CODE[bTypeCode];
        if (!bTypeKey || !BLDG[bTypeKey]) continue;
        var bDef = BLDG[bTypeKey];
        var bpx = (bvx - camX) * zoom + zoom/2;
        var bpy = (bvy - camY) * zoom + zoom/2;
        // Building icon
        ctx.save();
        if (isConstructing) { ctx.globalAlpha = 0.5 + Math.sin(Date.now()/300) * 0.2; }
        ctx.font = Math.max(10, zoom * 0.8) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(bDef.icon || '\ud83c\udfd7', bpx, bpy);
        // Level badge
        if (bLevel > 0 && zoom >= 10) {
          ctx.font = 'bold ' + Math.max(7, zoom * 0.35) + 'px sans-serif';
          ctx.fillStyle = isConstructing ? '#ffaa00' : '#fff';
          ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
          ctx.strokeText(bLevel, bpx + zoom*0.35, bpy + zoom*0.35);
          ctx.fillText(bLevel, bpx + zoom*0.35, bpy + zoom*0.35);
        }
        // Cannon range ring (show for own cannons when zoomed in)
        if (bTypeKey === 'cannon' && !isConstructing && bLevel > 0 && zoom >= 3) {
          var cRng = (4 + bLevel * 2) * zoom;
          var cPulse = 0.3 + Math.sin(Date.now()/800) * 0.1;
          ctx.beginPath();
          ctx.arc(bpx, bpy, cRng, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,80,0,' + cPulse + ')';
          ctx.setLineDash([zoom*0.3, zoom*0.3]);
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
          // Inner danger zone fill
          ctx.beginPath();
          ctx.arc(bpx, bpy, cRng, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,60,0,0.04)';
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  // ===== BUILDING PLACEMENT PREVIEW =====
  if (buildPlaceMode && alive && zoom >= 4) {
    var phx = Math.floor(mouseX/zoom + camX);
    var phy = Math.floor(mouseY/zoom + camY);
    var ppx = (phx - camX) * zoom;
    var ppy = (phy - camY) * zoom;
    // Check if this is our territory
    var pck = (Math.floor(phx/chunkSz)) + ',' + (Math.floor(phy/chunkSz));
    var pch = chunks[pck];
    var pValid = false;
    if (pch) {
      var plx = ((phx%chunkSz)+chunkSz)%chunkSz;
      var ply = ((phy%chunkSz)+chunkSz)%chunkSz;
      var po = pch.o[ply*chunkSz+plx];
      pValid = (po === myPi);
    }
    // Green = valid, red = invalid
    ctx.fillStyle = pValid ? 'rgba(0,255,0,0.3)' : 'rgba(255,0,0,0.3)';
    ctx.fillRect(ppx, ppy, zoom, zoom);
    ctx.strokeStyle = pValid ? 'rgba(0,255,0,0.8)' : 'rgba(255,0,0,0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(ppx, ppy, zoom, zoom);
    // Show building icon at cursor
    if (BLDG[buildPlaceMode]) {
      ctx.font = Math.max(12, zoom * 0.9) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.7;
      ctx.fillText(BLDG[buildPlaceMode].icon || '\ud83c\udfd7', ppx + zoom/2, ppy + zoom/2);
      ctx.globalAlpha = 1;
    }
    // Cannon range preview
    if (buildPlaceMode === 'cannon' && pValid) {
      var cRange = 6; // level 1 range preview (4 + 1*2)
      ctx.save();
      ctx.strokeStyle = 'rgba(255,80,0,0.6)';
      ctx.setLineDash([4,4]);
      ctx.lineWidth = 2;
      // Draw diamond range
      ctx.beginPath();
      for (var ri = 0; ri <= cRange * 4; ri++) {
        var rAngle = (ri / (cRange * 4)) * Math.PI * 2;
        var rdx = Math.cos(rAngle) * cRange * zoom;
        var rdy = Math.sin(rAngle) * cRange * zoom;
        if (ri === 0) ctx.moveTo(ppx + zoom/2 + rdx, ppy + zoom/2 + rdy);
        else ctx.lineTo(ppx + zoom/2 + rdx, ppy + zoom/2 + rdy);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,80,0,0.08)';
      ctx.fill();
      ctx.setLineDash([]);
      ctx.restore();
      // Label
      ctx.font = 'bold ' + Math.max(9, zoom * 0.4) + 'px sans-serif';
      ctx.fillStyle = '#ff5500';
      ctx.textAlign = 'center';
      ctx.fillText('사거리 ' + cRange, ppx + zoom/2, ppy - zoom * 0.3);
    }
  }

  // Hover highlight + terrain tooltip
  if (alive && zoom >= 4) {
    var hx = Math.floor(mouseX/zoom + camX);
    var hy = Math.floor(mouseY/zoom + camY);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect((hx-camX)*zoom, (hy-camY)*zoom, zoom, zoom);

    // Terrain info tooltip
    var hck = (Math.floor(hx/chunkSz))+','+(Math.floor(hy/chunkSz));
    var hch = chunks[hck];
    if (hch) {
      var hlx = ((hx%chunkSz)+chunkSz)%chunkSz;
      var hly = ((hy%chunkSz)+chunkSz)%chunkSz;
      var hli = hly*chunkSz+hlx;
      var ht = hch.t[hli];
      var ho = hch.o[hli];

      // Barbarian label
      if (ho === -2 && zoom >= 10) {
        var htr = hch.tr ? hch.tr[hli] : 0;
        ctx.font = '11px sans-serif';
        ctx.fillStyle = 'rgba(255,100,100,0.9)';
        ctx.fillText('\u2620 Lv'+(htr>30?3:htr>18?2:1), (hx-camX)*zoom+zoom+3, (hy-camY)*zoom+zoom/2);
      }

      // Terrain tooltip (show when zoomed in enough)
      if (zoom >= 6 && ht !== undefined) {
        var tName = TERRAIN_NAMES[ht] || '알 수 없음';
        var tCost = TERRAIN_COST[ht];
        var tDef  = TERRAIN_DEF[ht];
        var tRes  = TERRAIN_RES_DESC[ht] || '';

        var tipX = mouseX + 16;
        var tipY = mouseY - 10;

        // Build tooltip lines
        var lines = [];
        lines.push('【' + tName + '】');
        if (tCost < 99) {
          lines.push('⚔ 점령비용: ' + tCost + '병력');
          lines.push('🛡 방어배율: x' + tDef.toFixed(1));
          if (tRes) lines.push(tRes);
        } else {
          lines.push('통과 불가');
        }

        // Building info on this cell
        if (hch.bl) {
          var hbi = hch.bl[hli];
          if (hbi && hbi !== 0) {
            var hbConst = hbi < 0;
            var hbAbs = Math.abs(hbi);
            var hbCode = Math.floor(hbAbs / 100);
            var hbLv = hbAbs % 100;
            var hbType = BLDG_FROM_CODE[hbCode];
            if (hbType && BLDG[hbType]) {
              var hbInfo = BLDG[hbType];
              lines.push('');
              lines.push((hbInfo.icon||'🏗') + ' ' + hbInfo.n + ' Lv.' + hbLv);
              if (hbConst) lines.push('⏳ 건설 중...');
              if (ho === myPi) lines.push('👤 내 건물');
              else if (ho > 0) lines.push('⚠ 적 건물');
            }
          }
        }

        // Measure tooltip size
        ctx.font = '12px "Noto Sans KR", sans-serif';
        var maxTW = 0;
        for (var li = 0; li < lines.length; li++) {
          var lw = ctx.measureText(lines[li]).width;
          if (lw > maxTW) maxTW = lw;
        }
        var tipW = maxTW + 16;
        var tipH = lines.length * 18 + 10;

        // Keep on screen
        if (tipX + tipW > w) tipX = mouseX - tipW - 8;
        if (tipY + tipH > h) tipY = h - tipH - 4;
        if (tipY < 0) tipY = 4;

        // Background
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tipX, tipY, tipW, tipH, 4);
        ctx.fill();
        ctx.stroke();

        // Text
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (var li = 0; li < lines.length; li++) {
          if (li === 0) ctx.fillStyle = '#ffd700';
          else ctx.fillStyle = '#ddd';
          ctx.fillText(lines[li], tipX + 8, tipY + 6 + li * 18);
        }
      }
    }
  }

  // ===== INTERPOLATE + RENDER UNITS ON MAP =====
  // Time-based interpolation with prediction
  var nowPerf = performance.now();
  for (var ui = 0; ui < activeUnits.length; ui++) {
    var u = activeUnits[ui];
    var interp = unitInterp[u.id];
    if (interp && u._sx !== undefined) {
      var elapsed = nowPerf - interp.updateTime;
      // Duration to interpolate over (slightly longer than move interval for overlap smoothing)
      var duration = interp.moveInterval * 1.1;
      // Smoothstep easing: t goes from 0 to 1
      var t = Math.min(1.0, elapsed / duration);
      // Smoothstep function for easing
      t = t * t * (3.0 - 2.0 * t);
      // Interpolate between previous and target
      var rx = interp.prevX + (interp.targetX - interp.prevX) * t;
      var ry = interp.prevY + (interp.targetY - interp.prevY) * t;
      // After arriving at target, add small prediction overshoot
      if (t >= 1.0 && (interp.lastDx !== 0 || interp.lastDy !== 0)) {
        var overT = Math.min(1.0, (elapsed - duration) / duration) * 0.3;
        rx += interp.lastDx * overT;
        ry += interp.lastDy * overT;
      }
      interp.renderX = rx;
      interp.renderY = ry;
      u.x = rx;
      u.y = ry;
      // Spawn dust particles when moving
      if (t > 0.05 && t < 0.95 && (interp.lastDx !== 0 || interp.lastDy !== 0)) {
        if (Math.random() < 0.3) {
          unitDustParticles.push({
            x: rx, y: ry,
            vx: (Math.random() - 0.5) * 0.3,
            vy: (Math.random() - 0.5) * 0.3,
            life: 1.0,
            decay: 0.02 + Math.random() * 0.02,
            size: 0.3 + Math.random() * 0.4,
            color: u.mine ? myColor : (u.ally ? '#3498db' : '#e74c3c')
          });
        }
      }
    }
  }
  // Update and draw dust particles
  drawUnitDust(w, h);
  drawUnits(w, h);

  // ===== CANNON FIRE EFFECTS =====
  var cfNow = Date.now();
  for (var cfi = cannonFireEffects.length - 1; cfi >= 0; cfi--) {
    var cf = cannonFireEffects[cfi];
    var cfAge = cfNow - cf.t;
    if (cfAge > 1200) { cannonFireEffects.splice(cfi, 1); continue; }
    var cfProgress = Math.min(1, cfAge / 400); // projectile travel time 400ms
    var cfFade = cfAge > 800 ? 1 - (cfAge - 800) / 400 : 1;
    // Screen positions
    var cfsx = (cf.fx - camX + 0.5) * zoom;
    var cfsy = (cf.fy - camY + 0.5) * zoom;
    var cfex = (cf.tx - camX + 0.5) * zoom;
    var cfey = (cf.ty - camY + 0.5) * zoom;
    // Current projectile position
    var cfcx = cfsx + (cfex - cfsx) * cfProgress;
    var cfcy = cfsy + (cfey - cfsy) * cfProgress - Math.sin(cfProgress * Math.PI) * zoom * 2; // arc
    ctx.save();
    ctx.globalAlpha = cfFade;
    // Muzzle flash at cannon (first 200ms)
    if (cfAge < 200) {
      var mFlash = 1 - cfAge / 200;
      ctx.beginPath();
      ctx.arc(cfsx, cfsy, zoom * 0.8 * mFlash, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,200,50,' + (mFlash * 0.8) + ')';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cfsx, cfsy, zoom * 0.4 * mFlash, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,200,' + mFlash + ')';
      ctx.fill();
    }
    // Projectile trail
    if (cfProgress < 1) {
      ctx.beginPath();
      ctx.arc(cfcx, cfcy, zoom * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ff4400';
      ctx.fill();
      // Trail line
      ctx.beginPath();
      ctx.moveTo(cfsx, cfsy);
      ctx.lineTo(cfcx, cfcy);
      ctx.strokeStyle = 'rgba(255,100,0,0.4)';
      ctx.lineWidth = zoom * 0.1;
      ctx.stroke();
    }
    // Impact explosion at target (after projectile arrives)
    if (cfAge > 300) {
      var expAge = (cfAge - 300) / 900;
      var expR = zoom * (0.5 + expAge * 1.5);
      var expAlpha = Math.max(0, 1 - expAge);
      ctx.beginPath();
      ctx.arc(cfex, cfey, expR, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,80,0,' + (expAlpha * 0.5) + ')';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cfex, cfey, expR * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,200,50,' + (expAlpha * 0.7) + ')';
      ctx.fill();
      // Water splash
      if (expAge < 0.5) {
        for (var si = 0; si < 6; si++) {
          var sAngle = (si / 6) * Math.PI * 2 + cfAge * 0.003;
          var sDist = expR * (0.8 + expAge);
          ctx.beginPath();
          ctx.arc(cfex + Math.cos(sAngle) * sDist, cfey + Math.sin(sAngle) * sDist, zoom * 0.12, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(100,180,220,' + (expAlpha * 0.6) + ')';
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // Deploy mode overlay
  if (deployMode) {
    ctx.fillStyle = 'rgba(52,152,219,0.08)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(52,152,219,' + (0.3 + Math.sin(Date.now()/300)*0.2) + ')';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, w-4, h-4);
    var ut = UNIT_TYPES[deployMode];
    ctx.font = 'bold 16px "Noto Sans KR", sans-serif';
    ctx.fillStyle = '#3498db'; ctx.textAlign = 'center';
    ctx.fillText((ut ? ut.icon : '') + ' 목표 지점을 클릭하세요 (ESC 취소)', w/2, 70);
    // Draw deployment radius preview at cursor
    if (ut && ut.size > 0) {
      var dHx = Math.floor(mouseX/zoom + camX);
      var dHy = Math.floor(mouseY/zoom + camY);
      var dRadius = ut.size;
      var dScreenX = (dHx - camX) * zoom;
      var dScreenY = (dHy - camY) * zoom;
      ctx.strokeStyle = 'rgba(52,152,219,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(dScreenX + zoom/2, dScreenY + zoom/2, dRadius * zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Mass attack overlay
  if (massAtkMode) {
    ctx.fillStyle = 'rgba(231,76,60,0.1)';
    ctx.fillRect(0, 0, w, h);
    // Pulsing red border
    ctx.strokeStyle = 'rgba(231,76,60,' + (0.3 + Math.sin(Date.now()/300)*0.2) + ')';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w-4, h-4);
    ctx.font = 'bold 16px "Noto Sans KR", sans-serif';
    ctx.fillStyle = '#e74c3c'; ctx.textAlign = 'center';
    ctx.fillText('\u2694\uFE0F 목표 지점을 클릭하세요 (ESC 취소)', w/2, 70);
  }

  // Particles
  updateAndDrawParticles();

  // Coord HUD with terrain info
  var coordHud = document.getElementById('coordHud');
  if (coordHud && alive) {
    var hx2 = Math.floor(mouseX/zoom + camX);
    var hy2 = Math.floor(mouseY/zoom + camY);
    var tInfo = '';
    var hck2 = (Math.floor(hx2/chunkSz))+','+(Math.floor(hy2/chunkSz));
    var hch2 = chunks[hck2];
    if (hch2) {
      var hlx2 = ((hx2%chunkSz)+chunkSz)%chunkSz;
      var hly2 = ((hy2%chunkSz)+chunkSz)%chunkSz;
      var hli2 = hly2*chunkSz+hlx2;
      var ht2 = hch2.t[hli2];
      var ho2 = hch2.o[hli2];
      var hsp2 = hch2.sp ? hch2.sp[hli2] : 0;
      var hfog2 = hch2.fog ? hch2.fog[hli2] : 0;
      var tNames = ['해양','평원','숲','사막','산맥','툰드라','빙하','얕은물','구릉','늪'];
      var tDefense = DEFENSE_MAP || [0,1,1.3,2.5,99,1.2,99,0,1.5,0.9];
      tInfo = ' | ' + (tNames[ht2]||'?');
      if (tDefense[ht2] > 1) tInfo += ' 🛡️' + tDefense[ht2] + 'x';
      if (hfog2 === 1) tInfo += ' | 🌫️ 완전안개';
      else if (hfog2 === 2) {
        tInfo += ' | 🔍 부분시야';
        if (ho2 === -3) tInfo += ' | ❓ 미확인 영토';
      }
      if (hsp2 > 0 && hfog2 === 0) {
        var stKeys2 = Object.keys(STILES);
        var stDef = STILES[stKeys2[hsp2-1]];
        if (stDef) tInfo += ' | ' + stDef.icon + ' ' + stDef.n;
      }
      // Supply line distance from my capital
      if (mySt && mySt.cap && hfog2 === 0) {
        var sd = Math.abs(hx2 - mySt.cap.x) + Math.abs(hy2 - mySt.cap.y);
        var sp2 = sd <= 40 ? '1.0x' : sd <= 80 ? '1.' + (Math.floor(sd/40)*2) + 'x' : Math.min(3.0, 1.0 + Math.floor(sd/40)*0.2).toFixed(1) + 'x';
        if (sd > 40) tInfo += ' | 📦' + sp2;
      }
    }
    coordHud.textContent = hx2 + ', ' + hy2 + ' | zoom ' + zoom.toFixed(1) + 'x' + tInfo;
  }

  drawMinimap();
  requestAnimationFrame(draw);
}

// ===== DRAW UNITS ON MAP =====
function drawUnitDust(w, h) {
  for (var i = unitDustParticles.length - 1; i >= 0; i--) {
    var p = unitDustParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    if (p.life <= 0) { unitDustParticles.splice(i, 1); continue; }
    var sx = (p.x - camX) * zoom;
    var sy = (p.y - camY) * zoom;
    if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) { unitDustParticles.splice(i, 1); continue; }
    var rgb = hexToRgb(p.color);
    ctx.globalAlpha = p.life * 0.5;
    ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (p.life * 0.4) + ')';
    ctx.beginPath();
    ctx.arc(sx, sy, p.size * zoom * 0.5 * p.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Cap particles
  if (unitDustParticles.length > 200) unitDustParticles.splice(0, unitDustParticles.length - 200);
}

function drawUnits(w, h) {
  if (!activeUnits || activeUnits.length === 0) return;
  var now = Date.now();
  for (var i = 0; i < activeUnits.length; i++) {
    var u = activeUnits[i];
    var ut = UNIT_TYPES[u.type];
    if (!ut) continue;
    var sx = (u.x - camX) * zoom;
    var sy = (u.y - camY) * zoom;
    // Skip if off screen
    if (sx < -zoom*3 || sy < -zoom*3 || sx > w + zoom*3 || sy > h + zoom*3) continue;

    var unitSize = Math.max(14, zoom * 1.8);
    var cx = sx + zoom / 2;
    var cy = sy + zoom / 2;

    // Check if unit is at sea
    var unitTerrain = getTerrainAtWorld(Math.floor(u.x), Math.floor(u.y));
    var atSea = (unitTerrain === 0 || unitTerrain === 7);

    // Determine color
    var unitColor = u.mine ? myColor : (u.ally ? '#3498db' : '#e74c3c');
    var rgb = hexToRgb(unitColor);

    // Check if moving
    var isMoving = (u._dx !== undefined && (u._dx !== 0 || u._dy !== 0));

    // Bobbing motion: bigger and slower wave-bob at sea, quick march-bob on land
    var bobY = 0;
    if (atSea) {
      bobY = Math.sin(now / 400 + u.id * 2.3) * zoom * 0.25;
    } else if (isMoving) {
      bobY = Math.sin(now / 120 + u.id * 1.7) * zoom * 0.15;
    }

    // === WAKE / WAVE EFFECT for naval units ===
    if (atSea) {
      // Water ripple rings under the ship
      var rippleCount = 3;
      for (var ri = 0; ri < rippleCount; ri++) {
        var ripplePhase = (now / 600 + ri * 2.1 + u.id) % 1;
        var rippleR = unitSize * (0.4 + ripplePhase * 0.8);
        var rippleAlpha = (1 - ripplePhase) * 0.25;
        ctx.beginPath();
        ctx.arc(cx, cy + bobY + unitSize * 0.1, rippleR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(150,210,255,' + rippleAlpha + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Wake trail behind moving naval unit
      if (isMoving) {
        var wakeAngle = Math.atan2(u._dy, u._dx);
        var wakeLen = unitSize * 1.8;
        // V-shaped wake
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = '#a0d8ef';
        ctx.lineWidth = 1.5;
        for (var ws = -1; ws <= 1; ws += 2) {
          ctx.beginPath();
          ctx.moveTo(cx - Math.cos(wakeAngle) * unitSize * 0.3, cy + bobY - Math.sin(wakeAngle) * unitSize * 0.3);
          ctx.lineTo(
            cx - Math.cos(wakeAngle - ws * 0.35) * wakeLen,
            cy + bobY - Math.sin(wakeAngle - ws * 0.35) * wakeLen
          );
          ctx.stroke();
        }
        ctx.restore();

        // Spawn water splash particles instead of dust
        if (Math.random() < 0.4) {
          unitDustParticles.push({
            x: u.x - u._dx * 0.5 + (Math.random() - 0.5) * 0.8,
            y: u.y - u._dy * 0.5 + (Math.random() - 0.5) * 0.8,
            vx: -u._dx * 0.02 + (Math.random() - 0.5) * 0.04,
            vy: -u._dy * 0.02 + (Math.random() - 0.5) * 0.04,
            life: 1, decay: 0.025, size: 1.5 + Math.random(),
            color: '#70b8db'
          });
        }
      }
    }

    // Movement trail (dashed line to target) — own units only
    if (u.mine && u.tx !== undefined) {
      var txS = (u.tx - camX) * zoom + zoom / 2;
      var tyS = (u.ty - camY) * zoom + zoom / 2;
      ctx.save();
      // Animated dash offset
      ctx.lineDashOffset = -(now / 80) % 16;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = atSea
        ? 'rgba(100,180,230,0.4)'
        : 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.3)';
      ctx.lineWidth = atSea ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy + bobY);
      ctx.lineTo(txS, tyS);
      ctx.stroke();
      ctx.setLineDash([]);
      // Target marker pulsing
      var tPulse = 3 + Math.sin(now / 300) * 2;
      ctx.beginPath();
      ctx.arc(txS, tyS, tPulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Inner dot
      ctx.beginPath();
      ctx.arc(txS, tyS, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.7)';
      ctx.fill();
      ctx.restore();
    }

    // Direction indicator (small arrow ahead of unit when moving) — land only
    if (isMoving && !atSea) {
      var dirLen = unitSize * 0.6;
      var dirAngle = Math.atan2(u._dy, u._dx);
      var arrowX = cx + Math.cos(dirAngle) * dirLen;
      var arrowY = cy + bobY + Math.sin(dirAngle) * dirLen;
      ctx.save();
      ctx.globalAlpha = 0.4 + Math.sin(now / 200) * 0.15;
      ctx.strokeStyle = unitColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(dirAngle) * unitSize * 0.35, cy + bobY + Math.sin(dirAngle) * unitSize * 0.35);
      ctx.lineTo(arrowX, arrowY);
      ctx.stroke();
      // Arrowhead
      var aSize = 3;
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX - Math.cos(dirAngle - 0.5) * aSize, arrowY - Math.sin(dirAngle - 0.5) * aSize);
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX - Math.cos(dirAngle + 0.5) * aSize, arrowY - Math.sin(dirAngle + 0.5) * aSize);
      ctx.stroke();
      ctx.restore();
    }

    // Pulsing glow
    var pulse = 0.6 + Math.sin(now / 400 + u.id) * 0.3;
    ctx.save();
    ctx.shadowColor = atSea ? '#4fc3f7' : unitColor;
    ctx.shadowBlur = unitSize * 0.5 * pulse;

    // Unit body (ship hull at sea, circle on land)
    if (atSea) {
      // Ship hull shape (elongated oval)
      var hullW = unitSize * 0.75;
      var hullH = unitSize * 0.4;
      var hullAngle = isMoving ? Math.atan2(u._dy, u._dx) : 0;
      ctx.save();
      ctx.translate(cx, cy + bobY);
      ctx.rotate(hullAngle);
      // Hull body
      ctx.beginPath();
      ctx.ellipse(0, 0, hullW, hullH, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(60,40,30,0.7)';
      ctx.fill();
      ctx.strokeStyle = '#8d6e4a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Deck line
      ctx.beginPath();
      ctx.moveTo(-hullW * 0.6, 0);
      ctx.lineTo(hullW * 0.6, 0);
      ctx.strokeStyle = 'rgba(160,120,70,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    } else {
      // Regular land circle
      ctx.beginPath();
      if (isMoving) {
        var stretchDir = Math.atan2(u._dy, u._dx);
        ctx.save();
        ctx.translate(cx, cy + bobY);
        ctx.rotate(stretchDir);
        ctx.scale(1.12, 0.92);
        ctx.arc(0, 0, unitSize / 2, 0, Math.PI * 2);
        ctx.restore();
      } else {
        ctx.arc(cx, cy + bobY, unitSize / 2, 0, Math.PI * 2);
      }
      ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.25)';
      ctx.fill();
      ctx.strokeStyle = unitColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.shadowBlur = 0;

    // Unit icon: ship emoji at sea, normal icon on land
    var displayIcon = atSea ? '⛵' : ut.icon;
    ctx.font = Math.max(10, unitSize * 0.7) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(displayIcon, cx, cy + bobY);

    // Small original icon badge at top-right when at sea (so you know what unit type)
    if (atSea) {
      ctx.font = Math.max(7, unitSize * 0.32) + 'px sans-serif';
      ctx.fillText(ut.icon, cx + unitSize * 0.38, cy + bobY - unitSize * 0.32);
    }
    ctx.restore();

    // HP bar (below unit)
    if (u.hp !== undefined && u.maxHp !== undefined) {
      var barW = unitSize * 1.2;
      var barH = Math.max(2, zoom * 0.2);
      var barX = cx - barW / 2;
      var barY = cy + bobY + unitSize / 2 + 3;
      var hpRatio = u.hp / u.maxHp;
      // BG rounded
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(barX, barY, barW, barH);
      // Fill: blue tint at sea
      if (atSea) {
        ctx.fillStyle = hpRatio > 0.6 ? '#4fc3f7' : hpRatio > 0.3 ? '#f39c12' : '#e74c3c';
      } else {
        ctx.fillStyle = hpRatio > 0.6 ? '#2ecc71' : hpRatio > 0.3 ? '#f39c12' : '#e74c3c';
      }
      ctx.fillRect(barX, barY, barW * hpRatio, barH);
    }

    // Strength indicator at sea (shows remaining troops)
    if (atSea && u.mine && u.strength !== undefined) {
      ctx.font = Math.max(8, unitSize * 0.35) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#a0d8ef';
      ctx.fillText('⚓' + u.strength, cx, cy + bobY + unitSize / 2 + 14);
    }

    // Owner label for enemy/ally
    if (!u.mine) {
      var ownerColor = pColors[u.owner] || '#aaa';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = ownerColor;
      ctx.fillText(u.enemy ? '적' : '동맹', cx, cy + bobY - unitSize / 2 - 5);
    }
  }
}

function drawMinimap() {
  var mmW = mmCanvas.width, mmH = mmCanvas.height;
  mmCtx.fillStyle = '#0a0a14';
  mmCtx.fillRect(0, 0, mmW, mmH);
  mmCtx.drawImage(buf, 0, 0, mapW, mapH, 0, 0, mmW, mmH);
  var sx = mmW/mapW, sy = mmH/mapH;
  mmCtx.strokeStyle = 'rgba(255,255,255,0.85)'; mmCtx.lineWidth = 1.5;
  mmCtx.shadowColor = 'rgba(255,255,255,0.4)'; mmCtx.shadowBlur = 4;
  mmCtx.strokeRect(camX*sx, camY*sy, (vpW/zoom)*sx, (vpH/zoom)*sy);
  mmCtx.shadowBlur = 0;
}

// ===== STORM OVERLAY =====
function drawStormOverlay(w, h) {
  var scx = roundInfo.stormCX || 400;
  var scy = roundInfo.stormCY || 200;
  var sr = roundInfo.stormR || 9999;
  // Convert storm center and radius to screen space
  var ssx = (scx - camX) * zoom;
  var ssy = (scy - camY) * zoom;
  var ssr = sr * zoom;
  // Draw the storm as a dark red overlay OUTSIDE the safe circle
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.arc(ssx, ssy, ssr, 0, Math.PI * 2, true); // cut out the safe zone
  ctx.closePath();
  ctx.fillStyle = 'rgba(180,20,20,0.18)';
  ctx.fill();
  // Pulsing storm border ring
  var pulse = 0.4 + Math.sin(Date.now() / 400) * 0.2;
  ctx.beginPath();
  ctx.arc(ssx, ssy, ssr, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,60,60,' + pulse + ')';
  ctx.lineWidth = Math.max(2, zoom * 0.5);
  ctx.stroke();
  // Inner warning ring
  ctx.beginPath();
  ctx.arc(ssx, ssy, ssr + zoom * 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,100,40,0.15)';
  ctx.lineWidth = zoom * 2;
  ctx.stroke();
  ctx.restore();
}

// ===== TERRITORY BORDERS =====
function drawTerritoryBorders(w, h) {
  var vx0 = Math.floor(camX), vy0 = Math.floor(camY);
  var vx1 = Math.ceil(camX + w/zoom), vy1 = Math.ceil(camY + h/zoom);
  var baseWidth = Math.max(1.2, zoom * 0.22);
  
  // Pass 1: Outer glow (wider, transparent)
  ctx.lineWidth = baseWidth + Math.max(1, zoom * 0.12);
  for (var vy = vy0; vy < vy1; vy++) {
    for (var vx = vx0; vx < vx1; vx++) {
      var ck = (Math.floor(vx/chunkSz)) + ',' + (Math.floor(vy/chunkSz));
      var ch = chunks[ck];
      if (!ch) continue;
      var lx = ((vx%chunkSz)+chunkSz)%chunkSz;
      var ly = ((vy%chunkSz)+chunkSz)%chunkSz;
      var o = ch.o[ly*chunkSz+lx];
      if (o < 0) continue;
      var color = pColors[o];
      if (!color) continue;
      var rgb = hexToRgb(color);
      var screenX = (vx - camX) * zoom;
      var screenY = (vy - camY) * zoom;
      var dirs = [[1,0],[0,1],[-1,0],[0,-1]];
      for (var di = 0; di < 4; di++) {
        var nx = vx+dirs[di][0], ny = vy+dirs[di][1];
        var nOwner = -1;
        if (nx >= 0 && ny >= 0 && nx < mapW && ny < mapH) {
          var nck = (Math.floor(nx/chunkSz))+','+(Math.floor(ny/chunkSz));
          var nch = chunks[nck];
          if (nch) {
            var nlx = ((nx%chunkSz)+chunkSz)%chunkSz;
            var nly = ((ny%chunkSz)+chunkSz)%chunkSz;
            nOwner = nch.o[nly*chunkSz+nlx];
          }
        }
        if (nOwner !== o) {
          ctx.strokeStyle = 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+',0.2)';
          ctx.beginPath();
          if (di === 0) { ctx.moveTo(screenX+zoom, screenY); ctx.lineTo(screenX+zoom, screenY+zoom); }
          else if (di === 1) { ctx.moveTo(screenX, screenY+zoom); ctx.lineTo(screenX+zoom, screenY+zoom); }
          else if (di === 2) { ctx.moveTo(screenX, screenY); ctx.lineTo(screenX, screenY+zoom); }
          else { ctx.moveTo(screenX, screenY); ctx.lineTo(screenX+zoom, screenY); }
          ctx.stroke();
        }
      }
    }
  }
  
  // Pass 2: Main border (crisp, bright)
  ctx.lineWidth = baseWidth;
  for (var vy2 = vy0; vy2 < vy1; vy2++) {
    for (var vx2 = vx0; vx2 < vx1; vx2++) {
      var ck2 = (Math.floor(vx2/chunkSz)) + ',' + (Math.floor(vy2/chunkSz));
      var ch2 = chunks[ck2];
      if (!ch2) continue;
      var lx2 = ((vx2%chunkSz)+chunkSz)%chunkSz;
      var ly2 = ((vy2%chunkSz)+chunkSz)%chunkSz;
      var o2 = ch2.o[ly2*chunkSz+lx2];
      if (o2 < 0) continue;
      var color2 = pColors[o2];
      if (!color2) continue;
      var screenX2 = (vx2 - camX) * zoom;
      var screenY2 = (vy2 - camY) * zoom;
      var dirs2 = [[1,0],[0,1],[-1,0],[0,-1]];
      for (var di2 = 0; di2 < 4; di2++) {
        var nx2 = vx2+dirs2[di2][0], ny2 = vy2+dirs2[di2][1];
        var nOwner2 = -1;
        if (nx2 >= 0 && ny2 >= 0 && nx2 < mapW && ny2 < mapH) {
          var nck2 = (Math.floor(nx2/chunkSz))+','+(Math.floor(ny2/chunkSz));
          var nch2 = chunks[nck2];
          if (nch2) {
            var nlx2 = ((nx2%chunkSz)+chunkSz)%chunkSz;
            var nly2 = ((ny2%chunkSz)+chunkSz)%chunkSz;
            nOwner2 = nch2.o[nly2*chunkSz+nlx2];
          }
        }
        if (nOwner2 !== o2) {
          ctx.strokeStyle = color2;
          ctx.globalAlpha = 0.85;
          ctx.beginPath();
          if (di2 === 0) { ctx.moveTo(screenX2+zoom, screenY2); ctx.lineTo(screenX2+zoom, screenY2+zoom); }
          else if (di2 === 1) { ctx.moveTo(screenX2, screenY2+zoom); ctx.lineTo(screenX2+zoom, screenY2+zoom); }
          else if (di2 === 2) { ctx.moveTo(screenX2, screenY2); ctx.lineTo(screenX2, screenY2+zoom); }
          else { ctx.moveTo(screenX2, screenY2); ctx.lineTo(screenX2+zoom, screenY2); }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
  }
}

// ===== PLAYER LABELS ON MAP =====
var labelCache = {};
var lastLabelUpdate = 0;
function drawPlayerLabels(w, h) {
  var now = Date.now();
  if (now - lastLabelUpdate > 2000) {
    lastLabelUpdate = now;
    labelCache = {};
    for (var i = 0; i < lb.p.length; i++) {
      var p = lb.p[i];
      labelCache[p.i] = { name: p.name, color: p.color, icon: p.civIcon || '', cells: p.cells };
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  var fontSize = Math.max(10, Math.min(18, zoom * 2.5));
  ctx.font = '700 ' + fontSize + 'px "Noto Sans KR", sans-serif';
  var vx0 = Math.floor(camX), vy0 = Math.floor(camY);
  var vx1 = Math.ceil(camX + w/zoom), vy1 = Math.ceil(camY + h/zoom);
  for (var pi2 in labelCache) {
    var lbl = labelCache[pi2];
    var sumX = 0, sumY = 0, count = 0;
    var step = Math.max(1, Math.floor(1/zoom * 10));
    for (var sy = vy0; sy < vy1; sy += step) {
      for (var sx = vx0; sx < vx1; sx += step) {
        var sck = (Math.floor(sx/chunkSz))+','+(Math.floor(sy/chunkSz));
        var sch = chunks[sck];
        if (!sch) continue;
        var slx = ((sx%chunkSz)+chunkSz)%chunkSz;
        var sly = ((sy%chunkSz)+chunkSz)%chunkSz;
        if (sch.o[sly*chunkSz+slx] == pi2) {
          sumX += sx; sumY += sy; count++;
        }
      }
    }
    if (count < 2) continue;
    var centerX = (sumX/count - camX) * zoom;
    var centerY = (sumY/count - camY) * zoom;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = lbl.color;
    ctx.globalAlpha = 0.9;
    ctx.fillText(lbl.icon + ' ' + lbl.name, centerX, centerY);
    ctx.font = '600 ' + Math.max(8, fontSize*0.55) + 'px "Orbitron", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(fmtNum(lbl.cells), centerX, centerY + fontSize * 0.85);
    ctx.restore();
    ctx.font = '700 ' + fontSize + 'px "Noto Sans KR", sans-serif';
  }
}

// ===== UI UPDATES =====
function updateUI() {
  if (!mySt) return;
  var s = mySt;
  document.getElementById('rTroop').textContent = '⚔️ ' + fmtNum(s.tt) + '/' + fmtNum(s.mt);
  document.getElementById('rFood').textContent = '\uD83C\uDF3E ' + fmtNum(s.r.f);
  document.getElementById('rWood').textContent = '\uD83E\uDEB5 ' + fmtNum(s.r.w);
  document.getElementById('rStone').textContent = '\uD83E\uDEA8 ' + fmtNum(s.r.s);
  document.getElementById('rGold').textContent = '\uD83D\uDCB0 ' + fmtNum(s.r.g);

  // Strategic bonuses panel
  var bonusEl = document.getElementById('strategicBonuses');
  if (bonusEl) {
    var parts = [];
    parts.push('⚔️' + (s.atkPow||1).toFixed(2));
    parts.push('🛡️' + (s.defPow||1).toFixed(2));
    if (s.ironCount) parts.push('⛏️' + s.ironCount);
    if (s.horseCount) parts.push('🐎' + s.horseCount);
    if (s.shrineCount) parts.push('⛩️' + s.shrineCount);
    if (s.fertileCount) parts.push('🌾' + s.fertileCount);
    if (s.towerCount) parts.push('🗼' + s.towerCount);
    bonusEl.textContent = parts.join(' ');
  }

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

  renderBuildings();
  renderTech();
  renderQuests();
  updateTradeRate();
  updateUnitPanel();
}

function updateCivBadge() {
  var el = document.getElementById('civBadge');
  var civ = CIVS[myCiv];
  if (civ && el) el.textContent = civ.icon + ' ' + civ.n;
}

function renderBuildings() {
  if (!mySt) return;
  var el = document.getElementById('bldList');
  if (!el) return;
  var html = '', now = Date.now();
  var bCount = mySt.bCount || 0, bMax = mySt.bMax || 4;
  html += '<div class="bld-header">\ud83c\udfd7\ufe0f \uac74\ubb3c \ubc30\uce58 <span class="bld-count">' + bCount + '/' + bMax + '</span></div>';
  if (buildPlaceMode) {
    html += '<div class="bld-placing">\ud83d\udea7 <b>' + (BLDG[buildPlaceMode] ? BLDG[buildPlaceMode].n : '') + '</b> \ubc30\uce58\uc911 - \uc601\ud1a0\ub97c \ud074\ub9ad! <span class="bld-cancel" onclick="cancelBuildPlace()">\u2716 \ucde8\uc18c</span></div>';
  }
  var bk = Object.keys(BLDG);
  for (var i = 0; i < bk.length; i++) {
    var k = bk[i], def = BLDG[k];
    if (!def) continue;
    var totalLv = mySt.b && mySt.b[k] ? mySt.b[k].l : 0;
    var costs = getBldgCost(k, 0); // cost to place a new level 1
    var can = canLocalAfford(costs) && bCount < bMax;
    var isSelected = buildPlaceMode === k;
    html += '<div class="bld-item' + (isSelected ? ' selected' : '') + '" onclick="buildItem(\'' + k + '\')">';
    html += '<div class="item-header"><span class="item-name">' + (def.icon || '') + ' ' + def.n + '</span>';
    html += '<span class="item-level">\u2211 Lv.' + totalLv + '</span></div>';
    html += '<div class="item-desc">' + def.desc + '</div>';
    html += '<div class="item-cost">\uc2e0\uaddc: ' + formatCost(costs, can) + '</div>';
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
    html += '<span class="lb-cells">'+(p.rankIcon||'')+fmtNum(p.cells)+'</span></div>';
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

function updateUnitPanel() {
  // Unit count
  var countEl = document.getElementById('unitCount');
  if (countEl && mySt) {
    var au = mySt.activeUnits || 0;
    var mu = mySt.maxUnits || 5;
    countEl.textContent = au + '/' + mu;
    countEl.style.color = au >= mu ? '#e74c3c' : '#3498db';
  }
  // Active units list
  var listEl = document.getElementById('activeUnitsList');
  if (!listEl) return;
  var myUnits = activeUnits.filter(function(u) { return u.mine; });
  if (myUnits.length === 0) {
    listEl.innerHTML = '';
    return;
  }
  var html = '';
  for (var i = 0; i < myUnits.length; i++) {
    var u = myUnits[i];
    var ut = UNIT_TYPES[u.type] || {};
    var hpRatio = u.maxHp > 0 ? u.hp / u.maxHp : 1;
    var hpColor = hpRatio > 0.6 ? '#2ecc71' : hpRatio > 0.3 ? '#f39c12' : '#e74c3c';
    html += '<div class="active-unit-item">';
    html += '<div class="au-info">';
    html += '<span>' + (ut.icon || '?') + '</span>';
    html += '<span>' + (ut.n || u.type) + '</span>';
    html += '<div class="au-hp"><div class="au-hp-fill" style="width:' + (hpRatio*100) + '%;background:' + hpColor + '"></div></div>';
    html += '</div>';
    html += '<span class="au-cancel" onclick="cancelUnit(' + u.id + ')" title="회수 (30% 병력 반환)">✕</span>';
    html += '</div>';
  }
  listEl.innerHTML = html;
}

// ===== ACTIONS =====
function buildItem(k) {
  if (buildPlaceMode === k) { buildPlaceMode = null; } // toggle off
  else { buildPlaceMode = k; deployMode = null; massAtkMode = false; }
  renderBuildings();
}
function cancelBuildPlace() { buildPlaceMode = null; renderBuildings(); }
function researchItem(k) { socket.emit('res', {t:k}); }
function useSkill(sk) { /* skills removed */ }
function doTrade() {
  var from = document.getElementById('tradeFrom').value;
  var to = document.getElementById('tradeTo').value;
  var amt = parseInt(document.getElementById('tradeAmount').value) || 100;
  socket.emit('trade', {from:from, to:to, amount:amt});
}
function doBorderPush() { socket.emit('bpush'); }
function startMassAtk() { massAtkMode = true; }
function deployUnit(type) {
  if (!alive) return;
  deployMode = type;
  massAtkMode = false;
}
function cancelUnit(uid) {
  socket.emit('cancelUnit', { id: uid });
}
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
  if (now - vpTimer > 100) { vpTimer = now; sendViewport(); }
}

window.addEventListener('resize', function() { resize(); throttledVP(); });

canvas.addEventListener('mousedown', function(e) {
  if (e.button === 2) { dragging = true; dragStartX = e.clientX; dragStartY = e.clientY; return; }
  mouseDown = true;
  var tx = Math.floor(e.clientX/zoom + camX);
  var ty = Math.floor(e.clientY/zoom + camY);
  if (buildPlaceMode) {
    socket.emit('bld', {b: buildPlaceMode, x: tx, y: ty});
    // Don't clear buildPlaceMode so user can keep placing
    return;
  }
  if (deployMode) {
    socket.emit('deployUnit', {type: deployMode, tx: tx, ty: ty});
    deployMode = null;
    return;
  }
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
    targetCamX -= (e.clientX - dragStartX)/zoom;
    targetCamY -= (e.clientY - dragStartY)/zoom;
    camX = targetCamX; camY = targetCamY;
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
  targetCamX = mx - mouseX/zoom;
  targetCamY = my - mouseY/zoom;
  camX = targetCamX; camY = targetCamY;
  throttledVP();
}, { passive: false });

canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });

document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys[e.key] = true;
  if (e.key === 'Escape') { massAtkMode = false; deployMode = null; buildPlaceMode = null; renderBuildings(); closeSpyModal(); }
  if (e.key === '5') deployUnit('scout');
  if (e.key === '6') deployUnit('army');
  if (e.key === '7') deployUnit('elite');
  if (e.key === 'Home' || e.key === 'h') { // Center on capital
    if (mySt && mySt.cap) { targetCamX = mySt.cap.x - Math.floor(canvas.width / zoom / 2); targetCamY = mySt.cap.y - Math.floor(canvas.height / zoom / 2); throttledVP(); }
  }
  if (e.key === 'w' || e.key === 'ArrowUp') { targetCamY -= 5; throttledVP(); }
  if (e.key === 'a' || e.key === 'ArrowLeft') { targetCamX -= 5; throttledVP(); }
  if (e.key === 'd' || e.key === 'ArrowRight') { targetCamX += 5; throttledVP(); }
  if (e.key === 's' || e.key === 'ArrowDown') { targetCamY += 5; throttledVP(); }
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
  var tx = Math.floor(t.clientX/zoom+camX);
  var ty = Math.floor(t.clientY/zoom+camY);
  if (buildPlaceMode) {
    socket.emit('bld', {b: buildPlaceMode, x: tx, y: ty});
    buildPlaceMode = null;
    renderBuildings();
    return;
  }
  if (deployMode) {
    socket.emit('deployUnit', {type: deployMode, tx: tx, ty: ty});
    deployMode = null;
    return;
  }
  if (alive) emitExp(tx, ty);
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
setInterval(function() { if (alive && mySt) { /* periodic update */ } }, 500);

// Check Discord login status
fetch('/auth/me').then(function(r) { return r.json(); }).then(function(d) {
  if (d.loggedIn) {
    discordUser = { id: d.id, name: d.name, avatar: d.avatar };
    // Transition to lobby screen
    checkLogin();
  }
}).catch(function() {});
