// ===== Territory.io v5 — Ultimate Strategy Server =====
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const fetch = require('node-fetch');
const fs = require('fs');
const { generateEarthMap } = require('./worldmap');

const app = express();
const server = http.createServer(app);

// ===== DISCORD OAUTH2 =====
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1472925585440374914';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'Q5DINVzUzyZ-_2y81-vESx-nPiU2oDEo';
const DISCORD_REDIRECT = process.env.DISCORD_REDIRECT || 'http://localhost:3000/auth/discord/callback';
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;

const sessionMiddleware = session({
  secret: 'territory-io-secret-' + Date.now(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600000 }
});
app.use(sessionMiddleware);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  pingInterval: 5000,
  pingTimeout: 10000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: false
});
// Share session with socket.io
io.engine.use(sessionMiddleware);

app.use(express.static('public'));

// Health check for Railway
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', round: roundNumber, phase: roundPhase, lobby: lobbyQueue.size }));

// Discord OAuth2 routes
app.get('/auth/discord', (req, res) => {
  const url = 'https://discord.com/api/oauth2/authorize?client_id=' + DISCORD_CLIENT_ID
    + '&redirect_uri=' + encodeURIComponent(DISCORD_REDIRECT)
    + '&response_type=code&scope=identify';
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');
  try {
    // Exchange code for token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: DISCORD_REDIRECT
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?error=token_fail');
    // Get user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    const user = await userRes.json();
    if (!user.id) return res.redirect('/?error=user_fail');
    req.session.discordId = user.id;
    req.session.discordName = user.global_name || user.username;
    req.session.discordAvatar = user.avatar
      ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png'
      : null;
    console.log('[Auth] Discord login:', user.username, '(' + user.id + ')');
    res.redirect('/');
  } catch (e) {
    console.error('[Auth] Error:', e.message);
    res.redirect('/?error=auth_error');
  }
});

app.get('/auth/me', (req, res) => {
  if (req.session && req.session.discordId) {
    res.json({ loggedIn: true, id: req.session.discordId, name: req.session.discordName, avatar: req.session.discordAvatar });
  } else {
    res.json({ loggedIn: false });
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ===== CONFIG =====
const W = 800, H = 400, CHUNK = 50, TICK = 16;
const TROOP_SCALE = 100; // 병력 스케일 (현실적 숫자: 천/만/십만)
const RES_INT = 10000, TROOP_INT = 5000;
const BOT_INT = 2000, CAMP_INT = 15000, LB_INT = 1000, ST_INT = 500, SAVE_INT = 120000;
const UNIT_BROADCAST_INT = 100;
const BOT_COUNT = 8;
const SAVE_FILE = './gamestate.json';

// ===== ROUND SYSTEM =====
const ROUND_DURATION = 25 * 60 * 1000;   // 25 minutes per round
const PEACE_DURATION = 2 * 60 * 1000;   // 2 min peace phase
const CONFLICT_START = 8 * 60 * 1000;   // 8 min: conflict bonuses
const STORM_START = 16 * 60 * 1000;     // 16 min: storm begins
const STORM_SHRINK_INT = 3000;           // shrink every 3s
const ROUND_END_DELAY = 12000;           // 12s scoreboard before new round
const DOMINATION_RATIO = 0.50;           // 50% of playable cells = instant win
const STORM_INITIAL_R = Math.ceil(Math.hypot(W/2, H/2)) + 10;
const STORM_FINAL_R = 25;
let roundStartTime = 0, roundNumber = 0, roundPhase = 'lobby';
let stormCenterX = Math.floor(W/2), stormCenterY = Math.floor(H/2), currentStormR = STORM_INITIAL_R;
let totalPlayableCells = 0;
let roundEndTimer = null;

// ===== LOBBY SYSTEM =====
const LOBBY_DURATION = 45000;            // 45 seconds lobby countdown
const LOBBY_MIN_PLAYERS = 1;             // min humans to start
const MAX_HUMAN_PLAYERS = 20;            // max human players per game
let lobbyStartTime = 0;
let lobbyMapName = '';
const lobbyQueue = new Map();            // socketId → { name, civ, discordId, color }
const MAP_NAMES = [
  '리스본','콘스탄티노플','카르타고','아테네','바빌론','알렉산드리아','로마','장안',
  '경주','교토','사마르칸트','쿠스코','테노치티틀란','앙코르','델리','바그다드',
  '카이로','베이징','런던','파리','이스탄불','모스크바','비엔나','프라하'
];
const DEFENSE = [0, 1.0, 1.6, 2.0, 4.0, 1.8, 99, 0, 2.5, 1.4];
// ===== CIVILIZATIONS =====
const CIVS = {
  rome:   { icon:'\uD83C\uDFDB\uFE0F', n:'\uB85C\uB9C8',     desc:'\uAC74\uC124\uC18D\uB3C4 -10%',          bonus:{ buildSpd:0.9 }},
  mongol: { icon:'\uD83C\uDFC7', n:'\uBAAD\uACE8',     desc:'\uBCD1\uB825\uC0DD\uC0B0 +15%, \uC774\uB3D9\uBE44\uC6A9 -15%',    bonus:{ troopGen:1.15, moveCost:0.85 }},
  egypt:  { icon:'\uD83C\uDFFA', n:'\uC774\uC9D1\uD2B8',   desc:'\uC790\uC6D0\uCC44\uC9D1 +20%, \uACE8\uB4DC\uC218\uC785 +15%',    bonus:{ gather:1.2, gold:1.15 }},
  viking: { icon:'\u2694\uFE0F', n:'\uBC14\uC774\uD0B9',   desc:'\uACF5\uACA9\uB825 +15%, \uC804\uD22C\uBCF4\uC0C1 +25%',       bonus:{ atk:1.15, combatReward:1.25 }},
  china:  { icon:'\uD83D\uDC09', n:'\uC911\uAD6D',     desc:'\uAE30\uC220\uC5F0\uAD6C -15%, \uCD5C\uB300\uAC74\uBB3C\uB808\uBCA8 +2',   bonus:{ techSpd:0.85, bldgBonus:2 }},
  persia: { icon:'\uD83D\uDC51', n:'\uD398\uB974\uC2DC\uC544', desc:'\uAD50\uC5ED\uBE44\uC728 +20%, \uC678\uAD50\uBC29\uC5B4 +10%',    bonus:{ trade:1.2, dipDef:1.1 }},
  aztec:  { icon:'\uD83C\uDF3F', n:'\uC544\uC988\uD14D',   desc:'\uC57C\uB9CC\uC871\uBCF4\uC0C1 +60%, \uD655\uC7A5\uBE44\uC6A9 -10%',   bonus:{ barbReward:1.6, moveCost:0.9 }},
  japan:  { icon:'\u26E9\uFE0F', n:'\uC77C\uBCF8',     desc:'\uBC29\uC5B4\uB825 +20%, \uBCD1\uB825 \uCD5C\uB300\uCE58 +15%',    bonus:{ def:1.2, troopCap:1.15 }}
};



// ===== QUESTS =====
const QUEST_TEMPLATES = [
  { type:'expand',   icon:'\uD83D\uDDFA\uFE0F', name:'\uC601\uD1A0 \uD655\uC7A5',
    gen:lv=>({target:30+lv*20, desc:'\uC140\uC744 '+(30+lv*20)+'\uCE78 \uC810\uB839', rw:{f:200+lv*50,w:200+lv*50,s:100+lv*30,g:80+lv*20}}) },
  { type:'barb',     icon:'\uD83D\uDC80', name:'\uC57C\uB9CC\uC871 \uC0AC\uB0E5',
    gen:lv=>({target:5+lv*3, desc:'\uC57C\uB9CC\uC871 '+(5+lv*3)+'\uAE30\uC9C0 \uD30C\uAD34', rw:{f:300+lv*80,w:100+lv*30,s:100+lv*30,g:150+lv*40}}) },
  { type:'build',    icon:'\uD83C\uDFD7\uFE0F', name:'\uAC74\uC124\uC655',
    gen:lv=>({target:3+lv*2, desc:'\uAC74\uBB3C\uC744 '+(3+lv*2)+'\uBC88 \uC5C5\uADF8\uB808\uC774\uB4DC', rw:{f:100+lv*30,w:300+lv*80,s:300+lv*80,g:50+lv*20}}) },
  { type:'resource', icon:'\uD83D\uDCE6', name:'\uC790\uC6D0 \uC218\uC9D1',
    gen:lv=>({target:500+lv*400, desc:'\uC790\uC6D0 '+(500+lv*400)+' \uC218\uC9D1', rw:{f:0,w:0,s:0,g:300+lv*100}}) },
  { type:'conquer',  icon:'\u2694\uFE0F', name:'\uC815\uBCF5\uC790',
    gen:lv=>({target:10+lv*10, desc:'\uC801 \uC601\uD1A0 '+(10+lv*10)+'\uCE78 \uC815\uBCF5', rw:{f:150+lv*40,w:150+lv*40,s:150+lv*40,g:200+lv*60}}) }
];

// ===== RANKS =====
const RANKS = [
  { n:'\uC2E0\uBCD1',   icon:'\uD83D\uDD30', min:0 },
  { n:'\uC774\uB4F1\uBCD1', icon:'\u2B50', min:20 },
  { n:'\uC77C\uB4F1\uBCD1', icon:'\u2B50\u2B50', min:60 },
  { n:'\uC0C1\uBCD1',   icon:'\uD83C\uDF96\uFE0F', min:150 },
  { n:'\uBCD1\uC7A5',   icon:'\uD83C\uDF96\uFE0F\uD83C\uDF96\uFE0F', min:300 },
  { n:'\uD558\uC0AC',   icon:'\uD83C\uDFC5', min:600 },
  { n:'\uC911\uC0AC',   icon:'\uD83C\uDFC5\uD83C\uDFC5', min:1200 },
  { n:'\uB300\uC704',   icon:'\u269C\uFE0F', min:2500 },
  { n:'\uC7A5\uAD70',   icon:'\uD83D\uDC51', min:5000 }
];

// ===== SPECIAL TILES =====
const STILES = {
  goldMine: { icon:'⛏️', n:'금광',   desc:'골드 +50%' },
  oasis:    { icon:'🌴', n:'오아시스', desc:'식량 +40%' },
  ruins:    { icon:'🏚️', n:'유적',   desc:'랜덤 보상' },
  volcano:  { icon:'🌋', n:'화산',   desc:'주변 대미지' },
  harbor:   { icon:'⚓', n:'항구',   desc:'교역 +30%' },
  iron:     { icon:'⚒️', n:'철광산', desc:'공격력 +5% (최대 3개)' },
  horses:   { icon:'🐎', n:'목마장', desc:'확장비용 -15% (최대 3개)' },
  shrine:   { icon:'⛩️', n:'신전',   desc:'방어력 +8% (최대 3개)' },
  fertile:  { icon:'🌾', n:'옥토',   desc:'식량 +60%' },
  watchtower:{ icon:'🗼', n:'감시탑', desc:'시야 +10' }
};
const STILE_KEYS = Object.keys(STILES);

// ===== BUILDINGS =====
const BLDG = {
  hq:     { n:'본부', icon:'🏰',   size:3, base:{f:120,w:120,s:80,g:40},  time:25, desc:'+5,000 병력캡/Lv (3×3)' },
  bar:    { n:'병영', icon:'⚔️',   size:2, base:{f:80,w:60,s:30,g:20},    time:20, desc:'+10% 병력생산/Lv (2×2)' },
  farm:   { n:'농장', icon:'🌾',   size:2, base:{f:60,w:40,s:20,g:10},    time:15, desc:'+12% 식량/Lv (2×2)' },
  lum:    { n:'벌목장', icon:'🪵', size:2, base:{f:40,w:60,s:20,g:10},    time:15, desc:'+12% 목재/Lv (2×2)' },
  qry:    { n:'채석장', icon:'⛏️', size:2, base:{f:40,w:40,s:60,g:10},    time:15, desc:'+12% 석재/Lv (2×2)' },
  wall:   { n:'성벽', icon:'🧱',   size:1, base:{f:60,w:80,s:100,g:30},   time:30, desc:'+12% 주변방어/Lv (1×1)' },
  acad:   { n:'학술원', icon:'📚', size:2, base:{f:80,w:60,s:40,g:60},    time:25, desc:'-4% 건설/연구시간/Lv (2×2)' },
  spy:    { n:'첩보기관', icon:'🕵️', size:1, base:{f:50,w:30,s:20,g:80},  time:20, desc:'스파이 정보량 증가/Lv (1×1)' },
  market: { n:'시장', icon:'🏪',   size:2, base:{f:40,w:40,s:30,g:50},    time:18, desc:'+8% 교역효율/Lv (2×2)' },
  cannon: { n:'해안포대', icon:'💣', size:2, base:{f:100,w:120,s:100,g:60}, time:28, desc:'해안 배치, 적 해상유닛 자동 포격 (2×2)' }
};

// ===== MAP BUILDINGS (placed on territory, multi-cell grid system) =====
const mapBuildings = new Map(); // anchorCellIndex → { type, level, owner, buildEnd }
const cellToAnchor = new Map(); // cellIndex → anchorCellIndex (ALL cells of multi-cell buildings)
const BLDG_CODES = { hq:1, bar:2, farm:3, lum:4, qry:5, wall:6, acad:7, spy:8, market:9, cannon:10 };
const BLDG_FROM_CODE = {};
for (const k in BLDG_CODES) BLDG_FROM_CODE[BLDG_CODES[k]] = k;

// Get all cell indices for an NxN building anchored at anchorIdx
function getBuildingCells(anchorIdx, size) {
  const ax = anchorIdx % W, ay = Math.floor(anchorIdx / W);
  const cells = [];
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const cx = ax + dx, cy = ay + dy;
      if (validCell(cx, cy)) cells.push(idx(cx, cy));
    }
  }
  return cells;
}

// Check if an NxN building can be placed at anchor position
function canPlaceBuildingAt(pi, anchorIdx, size) {
  const ax = anchorIdx % W, ay = Math.floor(anchorIdx / W);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const cx = ax + dx, cy = ay + dy;
      if (!validCell(cx, cy)) return false;
      const ci = idx(cx, cy);
      if (owner[ci] !== pi) return false;
      if (cellToAnchor.has(ci)) return false;
    }
  }
  return true;
}

// Remove a building entirely (anchor + all cells)
function removeBuilding(anchorIdx) {
  const b = mapBuildings.get(anchorIdx);
  if (!b) return;
  const size = (BLDG[b.type] || {}).size || 1;
  const cells = getBuildingCells(anchorIdx, size);
  for (const ci of cells) {
    cellToAnchor.delete(ci);
    markDirty(ci % W, Math.floor(ci / W));
  }
  mapBuildings.delete(anchorIdx);
}

function recalcPlayerBuildings(pi) {
  const p = players[pi]; if (!p) return;
  const levels = {};
  for (const k in BLDG) levels[k] = 0;
  for (const [ci, b] of mapBuildings) {
    if (b.owner === pi && b.buildEnd === 0) {
      levels[b.type] = (levels[b.type] || 0) + b.level;
    }
  }
  p.buildings = {};
  for (const k in BLDG) p.buildings[k] = { l: levels[k], e: 0 };
}

function countPlayerBuildings(pi) {
  let count = 0;
  for (const [ci, b] of mapBuildings) { if (b.owner === pi) count++; }
  return count;
}

function getHqLevel(pi) {
  let maxL = 0;
  for (const [ci, b] of mapBuildings) {
    if (b.owner === pi && b.type === 'hq' && b.buildEnd === 0) maxL = Math.max(maxL, b.level);
  }
  return maxL;
}

// Player level based on total building count
function getPlayerLevel(pi) {
  const count = countPlayerBuildings(pi);
  return Math.floor(Math.sqrt(count)) + 1;
}

// Territory-limited building slots + civ bonus
function maxPlayerBuildings(pi) {
  const cells = playerCells[pi] ? playerCells[pi].size : 0;
  let max = Math.max(5, Math.floor(cells / 10));
  // China civ bonus: +2 extra building slots
  const p = players[pi];
  if (p) { const cb = CIVS[p.civ]; if (cb && cb.bonus.bldgBonus) max += cb.bonus.bldgBonus; }
  return max;
}

function placeBuildingOnMap(pi, cellIdx, type) {
  const p = players[pi]; if (!p || !p.alive) return null;
  const def = BLDG[type]; if (!def) return null;
  const size = def.size || 1;
  // If clicking on an existing building of same type → upgrade
  if (cellToAnchor.has(cellIdx)) {
    const anchorIdx = cellToAnchor.get(cellIdx);
    const existing = mapBuildings.get(anchorIdx);
    if (existing && existing.owner === pi && existing.type === type) {
      return upgradeBuildingOnMap(pi, anchorIdx);
    }
    return null; // occupied by different building
  }
  if (owner[cellIdx] !== pi) return null;
  // Check all NxN cells are valid
  if (!canPlaceBuildingAt(pi, cellIdx, size)) return null;
  // Cannon: at least one cell must be coastal
  if (type === 'cannon') {
    let hasCoastal = false;
    const ax = cellIdx % W, ay = Math.floor(cellIdx / W);
    for (let dy = 0; dy < size && !hasCoastal; dy++)
      for (let dx = 0; dx < size && !hasCoastal; dx++)
        if (isCoastalCell(ax + dx, ay + dy)) hasCoastal = true;
    if (!hasCoastal) return null;
  }
  const c = bldgCost(type, 0);
  if (!canAfford(p, c)) return null;
  payCost(p, c);
  const buildTime = bldgTime(type, 0, p);
  const b = { type, level: 0, owner: pi, buildEnd: Date.now() + buildTime };
  mapBuildings.set(cellIdx, b);
  // Mark all NxN cells as occupied
  const cells = getBuildingCells(cellIdx, size);
  for (const ci of cells) {
    cellToAnchor.set(ci, cellIdx);
    markDirty(ci % W, Math.floor(ci / W));
  }
  return b;
}

function upgradeBuildingOnMap(pi, anchorIdx) {
  const p = players[pi]; if (!p || !p.alive) return null;
  const b = mapBuildings.get(anchorIdx);
  if (!b || b.owner !== pi) return null;
  if (b.buildEnd > 0) return null;
  const playerLv = getPlayerLevel(pi);
  const maxLv = Math.min(25, playerLv * 3);
  if (b.level >= maxLv) return null;
  const c = bldgCost(b.type, b.level);
  if (!canAfford(p, c)) return null;
  payCost(p, c);
  b.buildEnd = Date.now() + bldgTime(b.type, b.level, p);
  const size = (BLDG[b.type] || {}).size || 1;
  const cells = getBuildingCells(anchorIdx, size);
  for (const ci of cells) { markDirty(ci % W, Math.floor(ci / W)); }
  return b;
}

// ===== TECH =====
const TECH = {
  atk:   { n:'\uACF5\uACA9\uB825',   base:{f:100,w:60,s:40,g:30},  time:30, desc:'+8% \uACF5\uACA9\uB825/Lv', max:20 },
  def:   { n:'\uBC29\uC5B4\uB825',   base:{f:60,w:80,s:100,g:30},  time:30, desc:'+8% \uBC29\uC5B4\uB825/Lv', max:20 },
  spd:   { n:'\uD589\uAD70\uC18D\uB3C4', base:{f:50,w:50,s:30,g:40},   time:25, desc:'+5% \uBCD1\uB825\uC7AC\uC0DD\uC18D\uB3C4/Lv', max:20 },
  gth:   { n:'\uCC44\uC9D1\uD6A8\uC728', base:{f:40,w:40,s:40,g:40},   time:25, desc:'+5% \uC790\uC6D0\uCC44\uC9D1/Lv', max:20 },
  siege: { n:'\uACF5\uC131\uC220',   base:{f:80,w:80,s:60,g:50},   time:35, desc:'-6% \uC131\uBCBD/\uC694\uC0C8\uD6A8\uACFC/Lv (\uCD5C\uB300 60%)', max:10 },
  diplo: { n:'\uC678\uAD50\uC220',   base:{f:30,w:30,s:20,g:80},   time:30, desc:'+5% \uCCA9\uBCF4/\uAD50\uC5ED/Lv', max:15 }
};

// ===== BARB CAMPS =====
const CAMP_TYPES = [
  { name:'\uC815\uCC30\uBCD1', size:1, troops:1500,  reward:{f:80,w:80,s:30,g:20} },
  { name:'\uC57C\uB9CC\uCD0C', size:2, troops:3500,  reward:{f:200,w:200,s:80,g:50} },
  { name:'\uC694\uC0C8',   size:3, troops:7000,  reward:{f:500,w:500,s:200,g:120} },
  { name:'\uC131\uCC44',   size:4, troops:13000, reward:{f:1200,w:1200,s:500,g:300} }
];

// ===== MAP DATA =====
let terrain, owner, troops, specialTiles;
const players = [];
const pidMap = {};
const playerCells = [];
const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63',
  '#00bcd4','#8bc34a','#ff5722','#607d8b','#795548','#cddc39','#009688','#673ab7',
  '#ff9800','#4caf50','#f44336','#2196f3'];
let nextColor = 0;
const barbs = [];
const dirtyChunks = new Set();
const MAX_DIRTY_CHUNKS_PER_FLUSH = 24;
const terrainChunkCache = new Map(); // pre-packed terrain arrays per chunk
const playerChunkIndex = []; // Set<chunkKey> per player for fast fog shortcut

// ===== UNITS SYSTEM =====
// Unit types: 'army' (claim territory), 'scout' (reveal fog, fast)
const UNIT_TYPES = {
  scout: { icon: '🔭', n: '정찰대', speed: 8, troopCost: 500, size: 0, vision: 20, hp: 3 },
  army:  { icon: '⚔️', n: '원정군', speed: 3, troopCost: 2000, size: 6, vision: 8, hp: 10 },
  elite: { icon: '🛡️', n: '정예군', speed: 2, troopCost: 5000, size: 10, vision: 10, hp: 25 }
};
let nextUnitId = 1;
const units = []; // { id, type, owner, x, y, tx, ty, strength, hp, maxHp, path:[], alive, spawnTime }

// ===== TERRAIN CHUNK CACHE =====
function buildTerrainChunkCache() {
  terrainChunkCache.clear();
  const cxMax = Math.ceil(W / CHUNK), cyMax = Math.ceil(H / CHUNK);
  for (let cy = 0; cy < cyMax; cy++) {
    for (let cx = 0; cx < cxMax; cx++) {
      const arr = new Array(CHUNK * CHUNK);
      const sx = cx * CHUNK, sy = cy * CHUNK;
      for (let ly = 0; ly < CHUNK; ly++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const gx = sx + lx, gy = sy + ly;
          arr[ly * CHUNK + lx] = (gx >= W || gy >= H) ? 0 : terrain[idx(gx, gy)];
        }
      }
      terrainChunkCache.set(cx + ',' + cy, arr);
    }
  }
  console.log('[TerrainCache] Built ' + terrainChunkCache.size + ' chunks');
}

// ===== UTILITY =====
function markDirty(x, y) { dirtyChunks.add(Math.floor(x / CHUNK) + ',' + Math.floor(y / CHUNK)); }

// Immediately flush dirty chunks to a specific player (real-time feedback)
function flushDirtyToPlayer(pi) {
  if (dirtyChunks.size === 0) return;
  const sock = findSocket(pi); if (!sock || !sock.vp) return;
  const toSend = [];
  for (const ck of dirtyChunks) {
    const [cx, cy] = ck.split(',').map(Number);
    const v = sock.vp;
    if (cx * CHUNK + CHUNK >= v.x && cx * CHUNK < v.x + v.w && cy * CHUNK + CHUNK >= v.y && cy * CHUNK < v.y + v.h)
      toSend.push(packChunkForPlayer(cx, cy, pi));
  }
  if (toSend.length > 0) sock.volatile.emit('ch', toSend);
}

// Immediately flush dirty chunks to ALL connected players in viewport
function flushDirtyToAll() {
  if (dirtyChunks.size === 0) return;
  const dirty = Array.from(dirtyChunks).slice(0, MAX_DIRTY_CHUNKS_PER_FLUSH);
  for (const [sid, pi] of Object.entries(pidMap)) {
    const sock = io.sockets.sockets.get(sid); if (!sock || !sock.vp) continue;
    const toSend = [];
    for (const ck of dirty) {
      const [cx, cy] = ck.split(',').map(Number);
      const v = sock.vp;
      if (cx * CHUNK + CHUNK >= v.x && cx * CHUNK < v.x + v.w && cy * CHUNK + CHUNK >= v.y && cy * CHUNK < v.y + v.h)
        toSend.push(packChunkForPlayer(cx, cy, pi));
    }
    if (toSend.length > 0) sock.volatile.emit('ch', toSend);
  }
  for (const ck of dirty) dirtyChunks.delete(ck);
}
function idx(x, y) { return y * W + x; }
function validCell(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
function isPlayable(t) { return t === 1 || t === 2 || t === 3 || t === 4 || t === 5 || t === 8 || t === 9; }

function claimCell(x, y, pi) {
  const i = idx(x, y), prev = owner[i];
  if (prev >= 0 && prev !== pi && playerCells[prev]) playerCells[prev].delete(i);
  // Destroy enemy buildings when capturing any cell they occupy
  if (cellToAnchor.has(i)) {
    const anchorIdx = cellToAnchor.get(i);
    const bld = mapBuildings.get(anchorIdx);
    if (bld && bld.owner !== pi) {
      const oldOwner = bld.owner;
      removeBuilding(anchorIdx);
      recalcPlayerBuildings(oldOwner);
    }
  }
  owner[i] = pi; troops[i] = 0;
  if (!playerCells[pi]) playerCells[pi] = new Set();
  playerCells[pi].add(i);
  markDirty(x, y);
}

function releaseCell(x, y) {
  const i = idx(x, y), prev = owner[i];
  if (prev >= 0 && playerCells[prev]) playerCells[prev].delete(i);
  owner[i] = -1; troops[i] = 0; markDirty(x, y);
}

// ===== COST HELPERS =====
function bldgCost(key, lv) {
  const d = BLDG[key]; if (!d) return {};
  const c = {}; for (const r in d.base) c[r] = Math.ceil(d.base[r] * Math.pow(1.3, lv)); return c;
}
function bldgTime(key, lv, p) {
  const d = BLDG[key]; if (!d) return 10000;
  let t = d.time * 1000 * (1 + lv * 0.3) * 0.33; // 3x faster for round mode
  const al = p.buildings.acad ? p.buildings.acad.l : 0;
  t *= Math.max(0.5, 1 - al * 0.04); // cap at 50% reduction
  const cb = CIVS[p.civ]; if (cb && cb.bonus.buildSpd) t *= cb.bonus.buildSpd;
  return Math.max(2000, t);
}
function techCost(key, lv) {
  const d = TECH[key]; if (!d) return {};
  const c = {}; for (const r in d.base) c[r] = Math.ceil(d.base[r] * Math.pow(1.25, lv)); return c;
}
function techTime(key, lv, p) {
  const d = TECH[key]; if (!d) return 10000;
  let t = d.time * 1000 * (1 + lv * 0.3) * 0.33; // 3x faster for round mode
  const al = p.buildings.acad ? p.buildings.acad.l : 0;
  t *= Math.max(0.5, 1 - al * 0.04); // cap at 50% reduction
  const cb = CIVS[p.civ]; if (cb && cb.bonus.techSpd) t *= cb.bonus.techSpd;
  return Math.max(2000, t);
}
function canAfford(p, c) { for (const r in c) if ((p.resources[r] || 0) < c[r]) return false; return true; }
function payCost(p, c) { for (const r in c) p.resources[r] = (p.resources[r] || 0) - c[r]; }

// ===== SUPPLY LINE =====
function supplyDist(p, x, y) {
  if (!p.capital) return 0;
  return Math.abs(x - p.capital.x) + Math.abs(y - p.capital.y);
}
function supplyPenalty(p, x, y) {
  const d = supplyDist(p, x, y);
  // Every 40 cells from capital adds +20% cost (max 3x)
  return Math.min(3.0, 1.0 + Math.floor(d / 40) * 0.2);
}

// ===== STRATEGIC RESOURCE BONUSES =====
function countSpecialTiles(pi, stType) {
  const cells = playerCells[pi]; if (!cells) return 0;
  let count = 0;
  for (const ci of cells) { if (specialTiles[ci] === stType) count++; }
  return count;
}

// ===== SNOWBALL =====
function maxTroops(p) {
  let mt = 10000 + (p.buildings.hq ? p.buildings.hq.l : 0) * 5000;
  const cb = CIVS[p.civ]; if (cb && cb.bonus.troopCap) mt = Math.floor(mt * cb.bonus.troopCap);
  return mt;
}
function attackPow(p) {
  let a = 1 + (p.tech.atk ? p.tech.atk.l : 0) * 0.08;
  const cb = CIVS[p.civ]; if (cb && cb.bonus.atk) a *= cb.bonus.atk;
  const pi = players.indexOf(p);
  // Iron mines: max 3 stacks, +5% each
  if (pi >= 0) { const ironCount = Math.min(countSpecialTiles(pi, 6), 3); a *= (1 + ironCount * 0.05); }
  // Siege tech: reduces enemy wall/fort effectiveness (applied in combat cost calc)
  return a;
}
function siegeBonus(p) {
  const lv = p.tech.siege ? p.tech.siege.l : 0;
  return Math.max(0.4, 1 - lv * 0.06); // up to 60% wall/fort reduction at Lv10
}
function defensePow(p) {
  let d = 1 + (p.tech.def ? p.tech.def.l : 0) * 0.08;
  const cb = CIVS[p.civ]; if (cb && cb.bonus.def) d *= cb.bonus.def;
  // Persia dipDef bonus
  if (cb && cb.bonus.dipDef) d *= cb.bonus.dipDef;
  const pi = players.indexOf(p);
  // Shrines: max 3 stacks, +8% each
  if (pi >= 0) { const shrineCount = Math.min(countSpecialTiles(pi, 8), 3); d *= (1 + shrineCount * 0.08); }
  return d;
}
function isProtected(p) { return p.protection && p.protection > Date.now(); }
// Wall defense: area-based defense around placed wall buildings
function wallDefenseBonus(p, x, y) {
  const pi = players.indexOf(p);
  if (pi < 0) return 1;
  let totalBonus = 1;
  for (const [ci, b] of mapBuildings) {
    if (b.owner === pi && b.type === 'wall' && b.buildEnd === 0 && b.level > 0) {
      const bx = ci % W, by = Math.floor(ci / W);
      const dist = Math.abs(x - bx) + Math.abs(y - by);
      const wallRadius = 3 + b.level * 2;
      if (dist <= wallRadius) {
        const proximity = 1 - (dist / wallRadius);
        totalBonus += b.level * 0.12 * proximity;
      }
    }
  }
  return totalBonus;
}
function terrainRes(t) {
  if (t === 1) return { f: 3, w: 1, s: 0, g: 0 };  // 평원: 식량 풍부
  if (t === 2) return { f: 1, w: 4, s: 0, g: 0 };  // 숲: 목재 풍부
  if (t === 3) return { f: 0, w: 0, s: 1, g: 3 };  // 사막: 금 풍부
  if (t === 4) return { f: 0, w: 0, s: 4, g: 2 };  // 산악: 석재+금 풍부 (난이도 보상)
  if (t === 5) return { f: 1, w: 1, s: 1, g: 0 };  // 툰드라: 균형
  if (t === 8) return { f: 1, w: 0, s: 3, g: 1 };  // 구릉: 석재 풍부
  if (t === 9) return { f: 2, w: 2, s: 0, g: 0 };  // 늪지: 식량+목재
  return { f: 0, w: 0, s: 0, g: 0 };
}
function getRank(cellCount) {
  let r = RANKS[0];
  for (let i = 0; i < RANKS.length; i++) { if (cellCount >= RANKS[i].min) r = RANKS[i]; }
  return r;
}

// ===== INIT HELPERS =====
function initBuildings() { const b = {}; for (const k in BLDG) b[k] = { l: 0, e: 0 }; return b; }
function initTech() { const t = {}; for (const k in TECH) t[k] = { l: 0, e: 0 }; return t; }
function initResources() { return { f: 500, w: 500, s: 300, g: 150 }; }

function initStats() { return { cellsClaimed: 0, barbsKilled: 0, enemyCellsTaken: 0, buildingsBuilt: 0, questsDone: 0, resourcesGathered: 0 }; }

// ===== QUESTS =====
function generateQuests(p) {
  const qs = [], used = new Set();
  for (let i = 0; i < 3; i++) {
    let ti;
    do { ti = Math.floor(Math.random() * QUEST_TEMPLATES.length); } while (used.has(ti) && used.size < QUEST_TEMPLATES.length);
    used.add(ti);
    const t = QUEST_TEMPLATES[ti], lv = p.questStreak || 0, q = t.gen(lv);
    qs.push({ type: t.type, icon: t.icon, name: t.name, desc: q.desc, target: q.target, progress: 0, rewards: { f: q.rw.f, w: q.rw.w, s: q.rw.s, g: q.rw.g } });
  }
  return qs;
}

function checkQuestProgress(p, type, amount) {
  if (!p.quests) return;
  for (let i = 0; i < p.quests.length; i++) {
    const q = p.quests[i];
    if (q.type === type && q.progress < q.target) {
      q.progress = Math.min(q.target, q.progress + amount);
      if (q.progress >= q.target) {
        p.questStreak = (p.questStreak || 0) + 1;
        const bonusGold = Math.min(p.questStreak, 5) * 20;
        p.resources.f += q.rewards.f; p.resources.w += q.rewards.w;
        p.resources.s += q.rewards.s; p.resources.g += q.rewards.g + bonusGold;
        p.stats.questsDone++;
        const sock = findSocket(players.indexOf(p));
        if (sock) sock.emit('questDone', { quest: { name: q.name }, streak: p.questStreak, bonusGold });
        const lv = p.questStreak, tmpl = QUEST_TEMPLATES[Math.floor(Math.random() * QUEST_TEMPLATES.length)];
        const nq = tmpl.gen(lv);
        p.quests[i] = { type: tmpl.type, icon: tmpl.icon, name: tmpl.name, desc: nq.desc, target: nq.target, progress: 0, rewards: { f: nq.rw.f, w: nq.rw.w, s: nq.rw.s, g: nq.rw.g } };
      }
    }
  }
}

// ===== SPECIAL TILES =====
function generateSpecialTiles() {
  specialTiles = new Uint8Array(W * H);
  let count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = terrain[idx(x, y)];
      if (!isPlayable(t)) continue;
      if (Math.random() < 0.003) {
        // Terrain-biased special tile placement
        let st;
        if (t === 8) { // hills → iron or watchtower
          st = Math.random() < 0.5 ? 6 : 10;
        } else if (t === 1) { // plains → horses or fertile
          st = Math.random() < 0.5 ? 7 : 9;
        } else if (t === 2) { // forest → shrine
          st = 8;
        } else if (t === 3) { // desert → goldMine or oasis
          st = Math.random() < 0.5 ? 1 : 2;
        } else if (t === 9) { // swamp → ruins
          st = 3;
        } else {
          st = Math.floor(Math.random() * 10) + 1;
        }
        specialTiles[idx(x, y)] = st;
        count++;
      }
    }
  }
  console.log('[MapGen] Generated ' + count + ' special tiles');
}

// ===== SPAWN =====
function findSpawn(prefX, prefY) {
  const px = prefX || Math.floor(W * 0.2 + Math.random() * W * 0.6);
  const py = prefY || Math.floor(H * 0.2 + Math.random() * H * 0.6);
  for (let r = 0; r < 200; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = px + dx, y = py + dy;
        if (!validCell(x, y)) continue;
        if (!isPlayable(terrain[idx(x, y)])) continue;
        if (terrain[idx(x, y)] === 4) continue; // don't spawn on mountains
        if (owner[idx(x, y)] !== -1) continue;
        let ok = true;
        for (let sy = -1; sy <= 1 && ok; sy++) {
          for (let sx = -1; sx <= 1 && ok; sx++) {
            const nx = x + sx, ny = y + sy;
            if (!validCell(nx, ny) || !isPlayable(terrain[idx(nx, ny)]) || owner[idx(nx, ny)] !== -1) ok = false;
          }
        }
        if (ok) return { x, y };
      }
    }
  }
  for (let i = 0; i < 50000; i++) {
    const x = Math.floor(Math.random() * W), y = Math.floor(Math.random() * H);
    if (isPlayable(terrain[idx(x, y)]) && owner[idx(x, y)] === -1) return { x, y };
  }
  // Last resort: scan entire map for any playable cell
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isPlayable(terrain[idx(x, y)]) && owner[idx(x, y)] === -1) return { x, y };
    }
  }
  return { x: Math.floor(W / 2), y: Math.floor(H / 2) };
}

function spawnPlayer(name, civ, isBot) {
  const pi = players.length;
  const color = COLORS[nextColor % COLORS.length]; nextColor++;
  const p = {
    id: pi, name, color, civ: civ || 'rome', alive: true, isBot: !!isBot,
    discordId: null, offline: false,
    capital: { x: 0, y: 0 },
    resources: initResources(),
    buildings: initBuildings(),
    tech: initTech(),
    quests: [],
    totalTroops: 8000,
    protection: Date.now() + 30000,
    spawnTime: Date.now(),
    shieldEnd: 0,
    killStreak: 0, bestStreak: 0, questStreak: 0,
    lastExpand: 0,
    stats: initStats()
  };
  const cb = CIVS[p.civ];
  players.push(p);
  playerCells.push(new Set());
  p.quests = generateQuests(p);
  return pi;
}

function placePlayerAt(pi, x, y) {
  const p = players[pi]; p.capital = { x, y };
  // Organic initial spawn: BFS outward from capital using cardinal directions
  // Creates a diamond/blob shape instead of a square
  const queue = [{ x, y }];
  const visited = new Set();
  visited.add(x + ',' + y);
  let placed = 0;
  const maxInitialCells = 20; // bigger initial claim for faster rounds
  while (queue.length > 0 && placed < maxInitialCells) {
    const c = queue.shift();
    if (validCell(c.x, c.y) && isPlayable(terrain[idx(c.x, c.y)])) {
      claimCell(c.x, c.y, pi);
      placed++;
      // Add cardinal neighbors
      for (let d = 0; d < 4; d++) {
        const nx = c.x + CARDINAL[d][0], ny = c.y + CARDINAL[d][1];
        const key = nx + ',' + ny;
        if (!visited.has(key)) {
          visited.add(key);
          queue.push({ x: nx, y: ny });
        }
      }
    }
  }
  // Place HQ building at capital (3x3 centered on capital)
  const hqSize = BLDG.hq.size || 3;
  const hqAnchorX = Math.max(0, Math.min(W - hqSize, x - Math.floor(hqSize / 2)));
  const hqAnchorY = Math.max(0, Math.min(H - hqSize, y - Math.floor(hqSize / 2)));
  const hqAnchorIdx = idx(hqAnchorX, hqAnchorY);
  // Ensure all HQ cells are owned
  for (let dy = 0; dy < hqSize; dy++) {
    for (let dx = 0; dx < hqSize; dx++) {
      const cx2 = hqAnchorX + dx, cy2 = hqAnchorY + dy;
      if (validCell(cx2, cy2) && owner[idx(cx2, cy2)] !== pi) claimCell(cx2, cy2, pi);
    }
  }
  const hqB = { type: 'hq', level: 1, owner: pi, buildEnd: 0 };
  mapBuildings.set(hqAnchorIdx, hqB);
  const hqCells = getBuildingCells(hqAnchorIdx, hqSize);
  for (const ci of hqCells) cellToAnchor.set(ci, hqAnchorIdx);
  recalcPlayerBuildings(pi);
}

function respawnPlayer(pi, civ, prefX, prefY) {
  const p = players[pi];
  if (playerCells[pi]) {
    for (const ci of playerCells[pi]) {
      const cx2 = ci % W, cy2 = Math.floor(ci / W);
      owner[ci] = -1; troops[ci] = 0; markDirty(cx2, cy2);
    }
    playerCells[pi].clear();
  }
  // Remove any remaining buildings owned by this player
  const toRemove = [];
  for (const [ci, b] of mapBuildings) { if (b.owner === pi) toRemove.push(ci); }
  for (const ci of toRemove) removeBuilding(ci);
  p.alive = true; p.offline = false; p.civ = civ || p.civ;
  p.resources = initResources(); p.buildings = initBuildings(); p.tech = initTech();
  p.totalTroops = 8000;
  p.protection = Date.now() + 30000; p.spawnTime = Date.now();
  p.shieldEnd = 0;
  p.killStreak = 0; p.questStreak = 0; p.lastExpand = 0; p.stats = initStats();
  p.quests = generateQuests(p);
  const cb = CIVS[p.civ];
  const sp = findSpawn(prefX, prefY);
  placePlayerAt(pi, sp.x, sp.y);
}

function removePlayer(pi) {
  const p = players[pi]; if (!p) return;
  if (playerCells[pi]) {
    for (const ci of playerCells[pi]) {
      const cx2 = ci % W, cy2 = Math.floor(ci / W);
      owner[ci] = -1; troops[ci] = 0; markDirty(cx2, cy2);
    }
    playerCells[pi].clear();
  }
  // Remove all buildings owned by this player
  const toRemove = [];
  for (const [ci, b] of mapBuildings) { if (b.owner === pi) toRemove.push(ci); }
  for (const ci of toRemove) removeBuilding(ci);
  p.alive = false;
  recalcPlayerBuildings(pi);
}

// ===== RESOURCE GATHERING =====
function gatherResources() {
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi]; if (!p.alive) continue;
    const cells = playerCells[pi]; if (!cells) continue;
    const rate = p.offline ? 0.3 : 1;
    const cb = CIVS[p.civ];
    const gatherMul = cb && cb.bonus.gather ? cb.bonus.gather : 1;
    const goldMul = cb && cb.bonus.gold ? cb.bonus.gold : 1;
    const gthLv = p.tech.gth ? p.tech.gth.l : 0;
    const techMul = 1 + gthLv * 0.05;
    let totalGathered = 0;
    let attritionCost = 0;
    for (const ci of cells) {
      const t = terrain[ci], r = terrainRes(t), st = specialTiles[ci];
      let fm = 1 + (p.buildings.farm ? p.buildings.farm.l * 0.12 : 0);
      let wm = 1 + (p.buildings.lum ? p.buildings.lum.l * 0.12 : 0);
      let sm = 1 + (p.buildings.qry ? p.buildings.qry.l * 0.12 : 0);
      let gm = 1;
      if (st === 1) gm *= 1.5;        // goldMine
      if (st === 2) fm *= 1.4;         // oasis
      if (st === 9) fm *= 1.6;         // fertile soil (옥토)
      // Terrain attrition: desert/tundra/swamp drain food per cell
      if (t === 3) attritionCost += 1;  // desert upkeep
      if (t === 5) attritionCost += 1;  // tundra upkeep
      if (t === 9) attritionCost += 1;  // swamp upkeep
      const df = Math.floor(r.f * fm * gatherMul * techMul * rate);
      const dw = Math.floor(r.w * wm * gatherMul * techMul * rate);
      const ds = Math.floor(r.s * sm * gatherMul * techMul * rate);
      const dg = Math.floor(r.g * gm * goldMul * techMul * rate);
      p.resources.f += df; p.resources.w += dw; p.resources.s += ds; p.resources.g += dg;
      totalGathered += df + dw + ds + dg;
    }
    // Apply terrain attrition (drain food)
    if (attritionCost > 0) p.resources.f = Math.max(0, p.resources.f - attritionCost);
    if (totalGathered > 0) checkQuestProgress(p, 'resource', totalGathered);
  }
}

// ===== TROOP GENERATION =====
function genTroops() {
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi]; if (!p.alive) continue;
    const cells = playerCells[pi]; if (!cells || cells.size === 0) continue;
    const mt = maxTroops(p);
    if (p.totalTroops >= mt) continue;
    const barLv = p.buildings.bar ? p.buildings.bar.l : 0;
    const barMul = 1 + barLv * 0.1;
    const spdLv = p.tech.spd ? p.tech.spd.l : 0;
    const spdMul = 1 + spdLv * 0.05;
    const cb = CIVS[p.civ];
    const troopMul = cb && cb.bonus.troopGen ? cb.bonus.troopGen : 1;
    const baseRaw = Math.max(2, Math.floor(Math.sqrt(cells.size) * 1.0));
    const base = baseRaw * TROOP_SCALE; // 100x scale for realistic numbers
    let gen = Math.floor(base * barMul * troopMul * spdMul);
    // Food cost stays at base scale (not 100x) to keep economy balanced
    const foodCost = Math.ceil(baseRaw * barMul * 2);
    if (p.resources.f < foodCost) {
      // Minimum generation: always produce at least 20% even without food
      gen = Math.max(Math.floor(base * 0.2), Math.floor(p.resources.f / 2) * TROOP_SCALE);
    }
    if (gen <= 0) gen = Math.floor(base * 0.1); // guaranteed minimum
    const actualFoodCost = Math.min(p.resources.f, foodCost);
    p.resources.f -= actualFoodCost;
    p.totalTroops = Math.min(mt, p.totalTroops + gen);
  }
}

// ===== CHECK BUILDINGS =====
function checkBuildings() {
  const now = Date.now();
  // Check placed map buildings
  for (const [ci, b] of mapBuildings) {
    if (b.buildEnd > 0 && now >= b.buildEnd) {
      b.level++;
      b.buildEnd = 0;
      recalcPlayerBuildings(b.owner);
      const p = players[b.owner];
      if (p) { p.stats.buildingsBuilt++; checkQuestProgress(p, 'build', 1); }
      const bSize = (BLDG[b.type] || {}).size || 1;
      const bCells = getBuildingCells(ci, bSize);
      for (const bci of bCells) markDirty(bci % W, Math.floor(bci / W));
    }
  }
  // Check tech
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi]; if (!p.alive) continue;
    for (const k in p.tech) {
      const t = p.tech[k];
      if (t.e > 0 && now >= t.e) { t.l++; t.e = 0; }
    }
  }
}

// ===== COMBAT =====
function areAllies(pi1, pi2) {
  return false;
}
// Troop cost to claim a cell (expansion = military operation)
function terrainTroopCost(t) {
  if (t === 1) return 100;    // 평원 — 가장 쉬움
  if (t === 2) return 300;    // 숲 — 수풀이 이동 방해
  if (t === 5) return 300;    // 툰드라 — 혹한
  if (t === 8) return 500;    // 구릉 — 고지대 점령 어려움
  if (t === 3) return 400;    // 사막 — 가혹한 환경
  if (t === 9) return 600;    // 늪지 — 진흙탕, 매우 어려움
  if (t === 4) return 1000;   // 산악 — 극심한 난이도, 대병력 필요
  return 9900;                // 바다/빙하 — 통과 불가
}
// Terrain weight for organic expansion scoring (lower = easier to expand through)
function terrainWeight(t) {
  if (t === 1) return 1.0;   // 평원 — 가장 쉬움
  if (t === 7) return 1.2;   // 얕은 물
  if (t === 2) return 2.5;   // 숲
  if (t === 5) return 3.0;   // 툰드라
  if (t === 3) return 3.5;   // 사막
  if (t === 8) return 4.0;   // 구릉
  if (t === 9) return 5.0;   // 늪지
  if (t === 4) return 7.0;   // 산악 — 매우 어려움
  return 99;
}
// 4-directional adjacency only (no diagonals → organic circular shapes)
const CARDINAL = [[1,0],[0,1],[-1,0],[0,-1]];
function isAdjacentTo(x, y, pi) {
  for (let d = 0; d < 4; d++) {
    const nx = x + CARDINAL[d][0], ny = y + CARDINAL[d][1];
    if (validCell(nx, ny) && owner[idx(nx, ny)] === pi) return true;
  }
  return false;
}
// Count how many cardinal neighbors are owned by pi (for gap-filling)
function friendlyNeighborCount(x, y, pi) {
  let c = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + CARDINAL[d][0], ny = y + CARDINAL[d][1];
    if (validCell(nx, ny) && owner[idx(nx, ny)] === pi) c++;
  }
  return c;
}
// Count 8-directional neighbors (includes diagonals) for cohesion scoring
function friendlyNeighborCount8(x, y, pi) {
  let c = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    const nx = x + dx, ny = y + dy;
    if (validCell(nx, ny) && owner[idx(nx, ny)] === pi) c++;
  }
  return c;
}
// Multi-octave organic noise (returns 0~1, varies per position + seed)
function organicNoise(x, y, seed) {
  const s = seed || 0;
  const n1 = Math.sin((x + s) * 0.37 + y * 0.71) * 0.5;
  const n2 = Math.sin(x * 0.13 - (y + s) * 0.53) * 0.3;
  const n3 = Math.cos((x + s * 0.7) * 0.91 + y * 0.29) * 0.2;
  const n4 = Math.sin(x * 0.07 + y * 0.11 + s * 1.3) * 0.15;
  const n5 = Math.cos(x * 0.23 - y * 0.17 + s * 0.5) * 0.1;
  return (n1 + n2 + n3 + n4 + n5) * 0.4 + 0.5;
}
// Directional noise: creates flow-like corridors toward a direction
function flowNoise(x, y, dirX, dirY) {
  // Project position onto perpendicular axis for corridor-like shapes
  const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
  const perpX = -dirY / len, perpY = dirX / len;
  const perpDist = x * perpX + y * perpY;
  // Create wavy corridors
  return Math.sin(perpDist * 0.15) * 0.5 + Math.cos(perpDist * 0.31 + x * 0.07) * 0.3;
}
// Simple positional noise for organic borders (legacy compatibility)
function posNoise(x, y) {
  return organicNoise(x, y, 0);
}
// Terrain corridor bonus: rivers/plains create natural expansion highways
function terrainCorridorBonus(x, y, pi) {
  let bonus = 0;
  // Check if surrounded by same terrain type → natural corridor
  const t = terrain[idx(x, y)];
  let sameTerrain = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + CARDINAL[d][0], ny = y + CARDINAL[d][1];
    if (validCell(nx, ny) && terrain[idx(nx, ny)] === t) sameTerrain++;
  }
  if (sameTerrain >= 3) bonus -= 1.5; // uniform terrain = easy path
  // Plains next to plains = strong corridor
  if (t === 1 && sameTerrain >= 2) bonus -= 1.0;
  // Near shore = follow coastline
  for (let d = 0; d < 4; d++) {
    const nx = x + CARDINAL[d][0], ny = y + CARDINAL[d][1];
    if (validCell(nx, ny)) {
      const nt = terrain[idx(nx, ny)];
      if (nt === 0 || nt === 7) { bonus -= 0.8; break; } // coast-following
    }
  }
  return bonus;
}

// ===== UNIT FUNCTIONS =====
function createUnit(pi, type, tx, ty) {
  const p = players[pi]; if (!p || !p.alive) return null;
  const ut = UNIT_TYPES[type]; if (!ut) return null;
  
  // Check troop cost
  const cost = ut.troopCost;
  if (p.totalTroops < cost + 500) return null; // keep minimum reserve
  
  // Unit spawns at capital
  if (!p.capital) return null;
  const sx = p.capital.x, sy = p.capital.y;
  
  p.totalTroops -= cost;
  
  const unit = {
    id: nextUnitId++,
    type: type,
    owner: pi,
    x: sx, y: sy,
    tx: tx, ty: ty,
    strength: cost,
    hp: ut.hp,
    maxHp: ut.hp,
    alive: true,
    spawnTime: Date.now(),
    trail: [] // positions visited (for scout fog reveal)
  };
  units.push(unit);
  return unit;
}

// Check if a cell is coastal (playable land adjacent to ocean/shallow)
function isCoastalCell(x, y) {
  for (let d = 0; d < 4; d++) {
    const nx = x + CARDINAL[d][0], ny = y + CARDINAL[d][1];
    if (!validCell(nx, ny)) continue;
    const t = terrain[idx(nx, ny)];
    if (t === 0 || t === 7) return true; // adjacent to ocean or shallow
  }
  return false;
}

function pathfindUnit(unit) {
  // Simple A*-like step: move 1 cell toward target, prefer playable terrain
  const dx = unit.tx - unit.x, dy = unit.ty - unit.y;
  if (dx === 0 && dy === 0) return null; // arrived
  
  const curT = terrain[idx(unit.x, unit.y)];
  // Naval: army/elite can enter ocean from coastal tiles or continue at sea
  const canNaval = (unit.type === 'army' || unit.type === 'elite');
  const atSea = (curT === 0 || curT === 7); // currently on water
  const onCoast = !atSea && isCoastalCell(unit.x, unit.y); // on land, adjacent to water
  const canEnterOcean = canNaval && (atSea || onCoast);
  
  // Try to step toward target
  const candidates = [];
  for (let d = 0; d < 4; d++) {
    const nx = unit.x + CARDINAL[d][0], ny = unit.y + CARDINAL[d][1];
    if (!validCell(nx, ny)) continue;
    const t = terrain[idx(nx, ny)];
    
    if (t === 6) continue; // ice always impassable
    
    if (t === 0) {
      // Deep ocean: only if unit can navigate water
      if (!canEnterOcean) continue;
      const dist = Math.abs(nx - unit.tx) + Math.abs(ny - unit.ty);
      candidates.push({ x: nx, y: ny, score: dist + 8 }); // heavy ocean penalty
      continue;
    }
    if (t === 7) {
      // Shallow water: army/elite can cross, scout cannot
      if (!canNaval && !isPlayable(t)) continue;
      const dist = Math.abs(nx - unit.tx) + Math.abs(ny - unit.ty);
      candidates.push({ x: nx, y: ny, score: dist + 4 });
      continue;
    }
    if (!isPlayable(t)) continue;
    
    const dist = Math.abs(nx - unit.tx) + Math.abs(ny - unit.ty);
    const tw = terrainWeight(t);
    // When at sea, prefer landing on coast (lower score for land)
    const landBonus = atSea ? -3 : 0;
    candidates.push({ x: nx, y: ny, score: dist + tw * 0.3 + landBonus });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

function moveUnits() {
  const now = Date.now();
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (!u.alive) { units.splice(i, 1); continue; }
    const p = players[u.owner];
    if (!p || !p.alive) { u.alive = false; units.splice(i, 1); continue; }
    
    const ut = UNIT_TYPES[u.type];
    // Speed check: units move every (1000/speed)ms. At sea = 3x slower
    const curT = terrain[idx(u.x, u.y)];
    const seaMul = (curT === 0 || curT === 7) ? 3 : 1;
    const moveInterval = Math.max(100, Math.floor(800 / ut.speed * seaMul));
    if (!u.lastMove) u.lastMove = now;
    if (now - u.lastMove < moveInterval) continue;
    u.lastMove = now;
    
    // Check if arrived
    const distToTarget = Math.abs(u.x - u.tx) + Math.abs(u.y - u.ty);
    if (distToTarget <= 1) {
      onUnitArrived(u);
      continue;
    }
    
    // Move one step
    const next = pathfindUnit(u);
    if (!next) {
      // Stuck, abort
      onUnitArrived(u);
      continue;
    }
    
    u.trail.push({ x: u.x, y: u.y });
    if (u.trail.length > 200) u.trail.shift();
    
    // Naval embark/disembark messages
    const prevT = terrain[idx(u.x, u.y)];
    const nextT = terrain[idx(next.x, next.y)];
    const sock = findSocket(u.owner);
    if (prevT !== 0 && prevT !== 7 && (nextT === 0 || nextT === 7)) {
      // Embarking onto water
      if (sock) sock.emit('msg', '⚓ ' + ut.n + ' 해상 항해 시작! (병력 손실 주의)');
    } else if ((prevT === 0 || prevT === 7) && nextT !== 0 && nextT !== 7 && isPlayable(nextT)) {
      // Landing on shore
      if (sock) sock.emit('msg', '🏖️ ' + ut.n + ' 상륙 완료!');
    }
    
    u.x = next.x; u.y = next.y;
    
    // Sea attrition: units lose troops while at sea
    const curTerrain = terrain[idx(u.x, u.y)];
    if (curTerrain === 0 || curTerrain === 7) {
      // Lose 1-2% of strength per step at sea (min 1)
      const attrition = Math.max(1, Math.ceil(u.strength * 0.015));
      u.strength -= attrition;
      if (u.strength <= 0) {
        u.alive = false;
        if (sock) sock.emit('msg', '💀 ' + ut.n + ' 해상에서 전멸!');
        if (sock) sock.emit('unitDied', { id: u.id, killedBy: '바다' });
        continue;
      }
    }
    
    // Scout reveal fog around current position (throttled every ~5 cells moved)
    if (u.type === 'scout') {
      const scoutGridKey = Math.floor(u.x / 5) + ',' + Math.floor(u.y / 5);
      if (scoutGridKey !== u._lastRevealPos) {
        u._lastRevealPos = scoutGridKey;
        revealFogAround(u.owner, u.x, u.y, ut.vision);
      }
    }
    
    // Army/Elite: claim territory along path (supply line) — creates connected territory
    if (u.type === 'army' || u.type === 'elite') {
      const pathRadius = u.type === 'elite' ? 2 : 1;
      for (let dy = -pathRadius; dy <= pathRadius; dy++) {
        for (let dx = -pathRadius; dx <= pathRadius; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > pathRadius) continue; // diamond shape
          const px = u.x + dx, py = u.y + dy;
          if (!validCell(px, py)) continue;
          const pi2 = idx(px, py);
          const t = terrain[pi2];
          if (!isPlayable(t)) continue;
          if (owner[pi2] === u.owner) continue;
          if (owner[pi2] >= 0 && owner[pi2] !== u.owner) continue; // don't conquer enemy on path
          if (owner[pi2] === -2) continue; // skip barbarians on path
          // Claim empty land along the path
          const cost = Math.max(100, Math.ceil(terrainTroopCost(t) * 0.3));
          if (u.strength >= cost + 200) {
            u.strength -= cost;
            claimCell(px, py, u.owner);
            const p = players[u.owner];
            if (p) p.stats.cellsClaimed++;
          }
        }
      }
    }
    
    // Collision detection with enemy units
    checkUnitCollisions(u);
    
    // Mark chunk dirty for visual update
    markDirty(u.x, u.y);
  }
}

function revealFogAround(pi, cx, cy, range) {
  // Add temporary vision source + expand chunk set
  if (!playerVisionSources[pi]) playerVisionSources[pi] = [];
  playerVisionSources[pi].push({ x: cx, y: cy, vf: range, vp: range * 2 });
  const cr = Math.ceil(range * 2 / CHUNK) + 1;
  const ccx = Math.floor(cx / CHUNK), ccy = Math.floor(cy / CHUNK);
  if (!playerVisibleChunks[pi]) playerVisibleChunks[pi] = new Set();
  for (let dy = -cr; dy <= cr; dy++) {
    for (let dx = -cr; dx <= cr; dx++) {
      if (dx * dx + dy * dy > (cr + 1) * (cr + 1)) continue;
      const nx = ccx + dx, ny = ccy + dy;
      if (nx >= 0 && ny >= 0 && nx < Math.ceil(W / CHUNK) && ny < Math.ceil(H / CHUNK)) {
        playerVisibleChunks[pi].add(nx + ',' + ny);
        dirtyChunks.add(nx + ',' + ny); // mark revealed chunks dirty for immediate push
      }
    }
  }
  // Immediately push revealed chunks to this player
  const sock = findSocket(pi);
  if (sock && sock.vp) {
    const v = sock.vp;
    const toSend = [];
    for (let dy2 = -cr; dy2 <= cr; dy2++) {
      for (let dx2 = -cr; dx2 <= cr; dx2++) {
        if (dx2 * dx2 + dy2 * dy2 > (cr + 1) * (cr + 1)) continue;
        const nx2 = ccx + dx2, ny2 = ccy + dy2;
        if (nx2 < 0 || ny2 < 0 || nx2 >= Math.ceil(W / CHUNK) || ny2 >= Math.ceil(H / CHUNK)) continue;
        if (nx2 * CHUNK + CHUNK >= v.x && nx2 * CHUNK < v.x + v.w && ny2 * CHUNK + CHUNK >= v.y && ny2 * CHUNK < v.y + v.h)
          toSend.push(packChunkForPlayer(nx2, ny2, pi));
      }
    }
    if (toSend.length > 0) sock.emit('ch', toSend);
  }
}

// ===== COASTAL DEFENSE (해안포대 자동 포격) =====
function coastalDefenseTick() {
  const cannonList = [];
  for (const [ci, b] of mapBuildings) {
    if (b.type === 'cannon' && b.buildEnd === 0 && b.level > 0) {
      const bx = ci % W, by = Math.floor(ci / W);
      const range = 4 + b.level * 2;
      const damage = 8 + b.level * 4;
      cannonList.push({ ci, bx, by, range, damage, owner: b.owner, level: b.level });
    }
  }
  if (cannonList.length === 0) return;

  for (const cannon of cannonList) {
    let fired = false;
    for (const u of units) {
      if (!u.alive) continue;
      if (u.owner === cannon.owner) continue;
      if (areAllies(cannon.owner, u.owner)) continue;
      // Check if unit is at sea
      const ut = terrain[idx(u.x, u.y)];
      if (ut !== 0 && ut !== 7) continue; // only target naval units
      // Check range (Manhattan distance)
      const dist = Math.abs(u.x - cannon.bx) + Math.abs(u.y - cannon.by);
      if (dist > cannon.range) continue;
      // Deal damage — closer = more damage
      const proximity = 1 - (dist / (cannon.range + 1));
      const dmg = Math.max(1, Math.ceil(cannon.damage * (0.5 + 0.5 * proximity)));
      u.strength -= dmg;
      u.hp -= Math.max(1, Math.ceil(dmg * 0.3));
      fired = true;

      // Notify unit owner
      const unitSock = findSocket(u.owner);
      if (unitSock) unitSock.emit('msg', '💣 해안포대 포격! ' + UNIT_TYPES[u.type].n + ' 피해 -' + dmg);
      
      // Check if unit destroyed
      if (u.strength <= 0 || u.hp <= 0) {
        u.alive = false;
        if (unitSock) unitSock.emit('msg', '💀 ' + UNIT_TYPES[u.type].n + ' 해안포대에 격침!');
        if (unitSock) unitSock.emit('unitDied', { id: u.id, killedBy: '해안포대' });
        const cannonSock = findSocket(cannon.owner);
        if (cannonSock) cannonSock.emit('msg', '💣 해안포대가 적 ' + UNIT_TYPES[u.type].n + ' 격침!');
      }
      
      // Emit cannon fire event for client visual
      io.emit('cannonFire', { fx: cannon.bx, fy: cannon.by, tx: u.x, ty: u.y, owner: cannon.owner });
      markDirty(u.x, u.y);
    }
    if (fired) markDirty(cannon.bx, cannon.by);
  }
}

function checkUnitCollisions(u) {
  for (let i = 0; i < units.length; i++) {
    const other = units[i];
    if (!other.alive || other.id === u.id) continue;
    if (other.owner === u.owner) continue;
    if (areAllies(u.owner, other.owner)) continue;
    
    // Collision: same cell or adjacent
    const dist = Math.abs(u.x - other.x) + Math.abs(other.y - u.y);
    if (dist > 1) continue;
    
    // Combat!
    unitCombat(u, other);
    break;
  }
}

function unitCombat(a, b) {
  const aPow = a.strength * attackPow(players[a.owner]);
  const bPow = b.strength * defensePow(players[b.owner]);
  
  // Both take damage
  const aDmg = Math.max(1, Math.ceil(bPow * 0.5));
  const bDmg = Math.max(1, Math.ceil(aPow * 0.5));
  
  a.hp -= aDmg;
  b.hp -= bDmg;
  
  // Notify owners
  const sockA = findSocket(a.owner);
  const sockB = findSocket(b.owner);
  
  if (a.hp <= 0) {
    a.alive = false;
    if (sockA) sockA.emit('unitDied', { id: a.id, killedBy: players[b.owner].name });
    if (sockB) sockB.emit('msg', '🗡️ 적 ' + UNIT_TYPES[a.type].n + ' 격파!');
  }
  if (b.hp <= 0) {
    b.alive = false;
    if (sockB) sockB.emit('unitDied', { id: b.id, killedBy: players[a.owner].name });
    if (sockA) sockA.emit('msg', '🗡️ 적 ' + UNIT_TYPES[b.type].n + ' 격파!');
  }
  
  // Mark dirty
  markDirty(a.x, a.y);
  markDirty(b.x, b.y);
}

function onUnitArrived(u) {
  const p = players[u.owner]; if (!p || !p.alive) { u.alive = false; return; }
  const ut = UNIT_TYPES[u.type];
  const sock = findSocket(u.owner);
  
  if (u.type === 'scout') {
    // Scout completed mission: reveal area and return info
    revealFogAround(u.owner, u.x, u.y, ut.vision * 2);
    if (sock) sock.emit('scoutReport', { x: u.x, y: u.y, terrain: terrain[idx(u.x, u.y)], owner: owner[idx(u.x, u.y)] });
    // Scout returns partial troops
    p.totalTroops = Math.min(maxTroops(p), p.totalTroops + Math.floor(u.strength * 0.5));
    if (sock) sock.emit('msg', '🔭 정찰 완료! 병력 ' + Math.floor(u.strength * 0.5) + ' 복귀');
    u.alive = false;
    return;
  }
  
  // Army/Elite arrived: AREA CONQUEST
  const radius = ut.size;
  let claimed = 0;
  const atkP = attackPow(p);
  
  // BFS area claim around arrival point
  const visited = new Set();
  const queue = [{ x: u.x, y: u.y, d: 0 }];
  visited.add(u.x + ',' + u.y);
  let budget = u.strength;
  
  while (queue.length > 0 && budget > 0) {
    const c = queue.shift();
    if (c.d > radius) continue;
    if (!validCell(c.x, c.y)) continue;
    
    const ci = idx(c.x, c.y);
    const t = terrain[ci];
    if (!isPlayable(t)) { 
      // Still explore neighbors even if not playable
      if (c.d < radius) {
        for (let d = 0; d < 4; d++) {
          const nx = c.x + CARDINAL[d][0], ny = c.y + CARDINAL[d][1];
          const nk = nx + ',' + ny;
          if (!visited.has(nk)) { visited.add(nk); queue.push({ x: nx, y: ny, d: c.d + 1 }); }
        }
      }
      continue;
    }
    
    const cur = owner[ci];
    if (cur === u.owner) {
      // Already ours, pass through
    } else if (cur === -1) {
      // Empty land: claim
      const cost = Math.max(100, Math.ceil(terrainTroopCost(t) * 0.5));
      if (budget >= cost) {
        budget -= cost;
        claimCell(c.x, c.y, u.owner);
        claimed++;
      }
    } else if (cur === -2) {
      // Barbarian
      const barbTr = troops[ci];
      const cost = Math.ceil(barbTr / (atkP * 1.5)) + 100;
      if (budget >= cost) {
        budget -= cost;
        claimCell(c.x, c.y, u.owner);
        claimed++;
        checkCampClear(u.owner, c.x, c.y);
      }
    } else if (cur >= 0 && cur !== u.owner) {
      // Enemy territory
      const enemy = players[cur];
      if (enemy && enemy.alive && !areAllies(u.owner, cur) && !isProtected(enemy) && !(enemy.shieldEnd && enemy.shieldEnd > Date.now())) {
        const defT = DEFENSE[t] || 1;
        const defP = defensePow(enemy) * defT;
        const cost = Math.ceil(300 * defP / atkP) + 100;
        if (budget >= cost) {
          budget -= cost;
          const wasCapital = (enemy.capital && enemy.capital.x === c.x && enemy.capital.y === c.y);
          claimCell(c.x, c.y, u.owner);
          claimed++;
          p.stats.enemyCellsTaken++;
          if (wasCapital) {
            p.resources.f += 200; p.resources.w += 200; p.resources.s += 100; p.resources.g += 100;
            if (sock) sock.emit('reward', { food: 200, wood: 200, stone: 100, gold: 100 });
          }
          checkDeath(cur, u.owner);
        }
      }
    }
    
    // Expand BFS
    if (c.d < radius) {
      // Shuffle directions for organic shape
      const dirs = [[1,0],[0,1],[-1,0],[0,-1]];
      for (let i2 = dirs.length - 1; i2 > 0; i2--) {
        const j2 = Math.floor(Math.random() * (i2 + 1));
        [dirs[i2], dirs[j2]] = [dirs[j2], dirs[i2]];
      }
      for (let d = 0; d < 4; d++) {
        const nx = c.x + dirs[d][0], ny = c.y + dirs[d][1];
        const nk = nx + ',' + ny;
        if (!visited.has(nk)) { visited.add(nk); queue.push({ x: nx, y: ny, d: c.d + 1 }); }
      }
    }
  }
  
  // Station remaining troops as garrison
  const remainingTroops = Math.floor(budget * 0.3);
  p.totalTroops = Math.min(maxTroops(p), p.totalTroops + remainingTroops);
  
  p.stats.cellsClaimed += claimed;
  checkQuestProgress(p, 'expand', claimed);
  checkQuestProgress(p, 'conquer', claimed);
  
  if (sock) sock.emit('unitArrived', { id: u.id, type: u.type, claimed, x: u.x, y: u.y, returned: remainingTroops });
  u.alive = false;
}

function getUnitStates(pi) {
  // Get all units visible to this player
  const result = [];
  const vis = playerVisibleChunks[pi];
  const now = Date.now();
  for (const u of units) {
    if (!u.alive) continue;
    // Compute velocity direction for client interpolation
    const ut = UNIT_TYPES[u.type];
    const moveInt = ut ? Math.max(100, Math.floor(800 / ut.speed)) : 300;
    const spd = ut ? ut.speed : 3;
    // Always show own units
    if (u.owner === pi) {
      result.push({ id: u.id, type: u.type, owner: u.owner, x: u.x, y: u.y, tx: u.tx, ty: u.ty, hp: u.hp, maxHp: u.maxHp, strength: u.strength, mine: true, spd: spd, mi: moveInt });
      continue;
    }
    // Show ally units
    if (areAllies(pi, u.owner)) {
      result.push({ id: u.id, type: u.type, owner: u.owner, x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, mine: false, ally: true, spd: spd, mi: moveInt });
      continue;
    }
    // Show enemy units only in full vision (not partial)
    if (vis) {
      const ck = Math.floor(u.x / CHUNK) + ',' + Math.floor(u.y / CHUNK);
      if (vis.has(ck)) {
        const vl = cellVisLevel(u.x, u.y, pi);
        if (vl === 0) {
          result.push({ id: u.id, type: u.type, owner: u.owner, x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, mine: false, enemy: true, spd: spd, mi: moveInt });
        }
        // In partial vision (vl === 2), enemy units are NOT visible
      }
    }
  }
  return result;
}

function expandToward(pi, tx, ty) {
  const p = players[pi]; if (!p || !p.alive) return;
  if (p.totalTroops < 100) return;
  const now = Date.now();
  // No throttle — real-time expansion
  p.lastExpand = now;
  const cb = CIVS[p.civ];
  const expandSeed = (p.capital ? p.capital.x * 137 + p.capital.y * 311 : pi * 997) + (now % 10000);

  const cells = playerCells[pi];
  if (!cells || cells.size === 0) return;

  // Direction vector from center-of-mass to target
  let cmx = 0, cmy = 0, cc = 0;
  for (const ci of cells) { cmx += ci % W; cmy += Math.floor(ci / W); cc++; }
  cmx = cc > 0 ? cmx / cc : tx; cmy = cc > 0 ? cmy / cc : ty;
  const dirX = tx - cmx, dirY = ty - cmy;

  // Phase 1: Priority gap-fill — cells surrounded by 3+ friendly neighbors (concavities)
  const gapFills = [];
  const borderSet = new Set();
  const maxRange = 35;
  for (const ci of cells) {
    const cx2 = ci % W, cy2 = Math.floor(ci / W);
    if (Math.abs(cx2 - tx) > maxRange || Math.abs(cy2 - ty) > maxRange) continue;
    for (let d = 0; d < 4; d++) {
      const nx = cx2 + CARDINAL[d][0], ny = cy2 + CARDINAL[d][1];
      if (!validCell(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (owner[ni] === pi) continue;
      if (!isPlayable(terrain[ni])) continue;
      borderSet.add(ci);
      const fn = friendlyNeighborCount(nx, ny, pi);
      const fn8 = friendlyNeighborCount8(nx, ny, pi);
      if (fn >= 3 || fn8 >= 5) {
        gapFills.push({ x: nx, y: ny, fn });
      }
    }
  }
  if (borderSet.size === 0) return;

  // Claim gap-fills first (they create smooth borders cheaply)
  let claimed = 0;
  const claimedSet = new Set();
  for (const g of gapFills) {
    if (p.totalTroops < 100) break;
    const gi = idx(g.x, g.y);
    if (owner[gi] === pi) continue;
    const gk = g.x + ',' + g.y;
    if (claimedSet.has(gk)) continue;
    const t = terrain[gi];
    let tc = terrainTroopCost(t);
    if (cb && cb.bonus.moveCost) tc = Math.max(100, Math.ceil(tc * cb.bonus.moveCost));
    // Gap fills cost half troops (natural infill)
    tc = Math.max(100, Math.ceil(tc * 0.5));
    if (owner[gi] === -1) {
      if (p.totalTroops < tc) continue;
      p.totalTroops -= tc;
      claimCell(g.x, g.y, pi);
      p.stats.cellsClaimed++;
      checkQuestProgress(p, 'expand', 1);
      claimedSet.add(gk);
      claimed++;
      if (claimed >= 12) break; // max 12 gap fills per tick
    }
  }

  // Phase 2: Multi-wave organic expansion toward target
  // Collect all expansion candidates with rich scoring
  const candidateMap = new Map();
  for (const ci of borderSet) {
    const bx = ci % W, by = Math.floor(ci / W);
    for (let d = 0; d < 4; d++) {
      const nx = bx + CARDINAL[d][0], ny = by + CARDINAL[d][1];
      if (!validCell(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (owner[ni] === pi) continue;
      if (!isPlayable(terrain[ni])) continue;
      const key = nx + ',' + ny;
      if (candidateMap.has(key) || claimedSet.has(key)) continue;

      const distToTarget = Math.hypot(nx - tx, ny - ty);
      const tw = terrainWeight(terrain[ni]);
      const friendlyN = friendlyNeighborCount(nx, ny, pi);
      const friendlyN8 = friendlyNeighborCount8(nx, ny, pi);
      // Gap bonus: strongly prefer filling concavities
      const gapBonus = friendlyN >= 3 ? -8 : friendlyN >= 2 ? -3 : friendlyN8 >= 4 ? -2 : 0;
      // Organic noise: multi-octave for irregular borders
      const noise = organicNoise(nx, ny, expandSeed) * 5;
      // Flow noise: create corridor-like expansion along movement direction
      const flow = flowNoise(nx, ny, dirX, dirY) * 2.5;
      // Terrain corridor: prefer natural paths
      const corridor = terrainCorridorBonus(nx, ny, pi);
      // Distance from capital penalty (less aggressive than supply line, used here for shape)
      const capDist = p.capital ? Math.hypot(nx - p.capital.x, ny - p.capital.y) : 0;
      const spreadPenalty = capDist * 0.08; // prevents thin long tentacles
      // Random jitter for each candidate (prevents identical expansion every tick)
      const jitter = (Math.sin(nx * 73 + ny * 137 + expandSeed) * 0.5 + 0.5) * 2;

      // Width check: penalize cells that would create thin (1-wide) strips
      const widthPenalty = friendlyN <= 1 && friendlyN8 <= 2 ? 4.0 : friendlyN <= 1 ? 2.0 : 0;
      const score = distToTarget * 0.4 + tw * 1.8 + noise + flow + gapBonus + corridor + spreadPenalty + jitter + widthPenalty;
      candidateMap.set(key, { x: nx, y: ny, score, dist: distToTarget });
    }
  }

  if (candidateMap.size === 0) return;

  const candidates = Array.from(candidateMap.values());
  candidates.sort((a, b) => a.score - b.score);

  // Dynamic max cells: based on troop count, expand more when strong
  const baseCells = 5;
  const troopBonus = Math.floor(p.totalTroops / 2500);
  const maxCells = Math.min(baseCells + troopBonus, 15);
  
  // Weighted random from top candidates (not always best → organic irregularity)
  const topN = Math.min(candidates.length, maxCells * 3);
  const pool = candidates.slice(0, topN);
  for (let attempts = 0; attempts < topN && claimed < maxCells && p.totalTroops >= 100; attempts++) {
    // Weighted selection: index^0.7 bias toward top of list but with randomness
    const r = Math.pow(Math.random(), 0.7);
    const pickIdx = Math.min(pool.length - 1, Math.floor(r * pool.length));
    const c = pool[pickIdx];
    if (!c) continue;
    pool.splice(pickIdx, 1); // don't re-pick

    const i = idx(c.x, c.y);
    if (owner[i] === pi) continue;
    const t = terrain[i], cur = owner[i];
    let troopCost = terrainTroopCost(t);
    if (cb && cb.bonus.moveCost) troopCost = Math.max(100, Math.ceil(troopCost * cb.bonus.moveCost));
    // Supply line penalty
    troopCost = Math.max(100, Math.ceil(troopCost * supplyPenalty(p, c.x, c.y)));
    // Horse bonus
    const horseCount = Math.min(countSpecialTiles(pi, 7), 3);
    if (horseCount > 0) troopCost = Math.max(100, Math.ceil(troopCost * Math.max(0.55, 1 - horseCount * 0.15)));

    if (cur === -1) {
      if (p.totalTroops < troopCost) continue;
      p.totalTroops -= troopCost;
      claimCell(c.x, c.y, pi);
      p.stats.cellsClaimed++;
      checkQuestProgress(p, 'expand', 1);
      claimedSet.add(c.x + ',' + c.y);
      claimed++;
      const st = specialTiles[i];
      if (st === 3) {
        const rf = Math.floor(Math.random() * 300) + 50, rg = Math.floor(Math.random() * 100) + 20;
        p.resources.f += rf; p.resources.g += rg;
        const sock = findSocket(pi);
        if (sock) sock.emit('reward', { food: rf, wood: 0, stone: 0, gold: rg });
      }
    } else if (cur === -2) {
      const barbTr = troops[i];
      const needed = troopCost + Math.ceil(barbTr / (attackPow(p) * 1.5));
      if (p.totalTroops < needed + 100) continue;
      p.totalTroops -= needed;
      claimCell(c.x, c.y, pi);
      p.stats.cellsClaimed++;
      checkQuestProgress(p, 'expand', 1);
      checkCampClear(pi, c.x, c.y);
      claimedSet.add(c.x + ',' + c.y);
      claimed++;
    } else {
      // Enemy territory — military conquest
      const enemy = players[cur];
      if (!enemy || !enemy.alive) {
        if (p.totalTroops < troopCost) continue;
        p.totalTroops -= troopCost;
        claimCell(c.x, c.y, pi); p.stats.cellsClaimed++; p.stats.enemyCellsTaken++;
        checkQuestProgress(p, 'expand', 1); checkQuestProgress(p, 'conquer', 1);
        claimedSet.add(c.x + ',' + c.y);
        claimed++; continue;
      }
      if (areAllies(pi, cur)) continue;
      if (isProtected(enemy)) continue;
      if (enemy.shieldEnd && enemy.shieldEnd > Date.now()) continue;
      const defT = DEFENSE[t] || 1;
      const wallBonus = wallDefenseBonus(enemy, c.x, c.y);
      const capDist2 = enemy.capital ? Math.abs(c.x - enemy.capital.x) + Math.abs(c.y - enemy.capital.y) : 999;
      const fortBonus = capDist2 <= 5 ? 1.5 : capDist2 <= 15 ? 1.3 : capDist2 <= 30 ? 1.15 : 1.0;
      const sBonus = siegeBonus(p); // siege tech reduces wall/fort effect
      const defP = defensePow(enemy) * defT * (1 + (wallBonus - 1) * sBonus) * (1 + (fortBonus - 1) * sBonus);
      const combatCost = troopCost + Math.ceil(300 * defP / attackPow(p));
      if (p.totalTroops < combatCost + 100) continue;
      p.totalTroops -= combatCost;
      const combatRwdMul = cb && cb.bonus.combatReward ? cb.bonus.combatReward : 1;
      const plunderAmt = Math.ceil(12 * combatRwdMul);
      p.resources.f += Math.min(plunderAmt, enemy.resources.f); enemy.resources.f = Math.max(0, enemy.resources.f - plunderAmt);
      p.resources.w += Math.min(plunderAmt, enemy.resources.w); enemy.resources.w = Math.max(0, enemy.resources.w - plunderAmt);
      const wasCapital = (enemy.capital && enemy.capital.x === c.x && enemy.capital.y === c.y);
      claimCell(c.x, c.y, pi);
      p.stats.cellsClaimed++; p.stats.enemyCellsTaken++;
      checkQuestProgress(p, 'expand', 1); checkQuestProgress(p, 'conquer', 1);
      if (wasCapital) {
        p.resources.f += 200; p.resources.w += 200; p.resources.s += 100; p.resources.g += 100;
        const sock = findSocket(pi);
        if (sock) sock.emit('reward', { food: 200, wood: 200, stone: 100, gold: 100 });
      }
      checkDeath(cur, pi);
      claimedSet.add(c.x + ',' + c.y);
      claimed++;
    }
  }
}

function borderPush(pi) {
  const p = players[pi]; if (!p || !p.alive) return;
  const cells = playerCells[pi]; if (!cells) return;
  const cb = CIVS[p.civ];
  const pushSeed = Date.now() % 100000 + pi * 137;

  // Phase 1: Collect all border candidates with organic scoring
  const targets = [];
  const gapTargets = [];
  const seen = new Set();
  for (const ci of cells) {
    const cx2 = ci % W, cy2 = Math.floor(ci / W);
    for (let d = 0; d < 4; d++) {
      const nx = cx2 + CARDINAL[d][0], ny = cy2 + CARDINAL[d][1];
      if (!validCell(nx, ny)) continue;
      const ni = idx(nx, ny);
      const key = nx + ',' + ny;
      if (seen.has(key)) continue;
      seen.add(key);
      if (owner[ni] === -1 && isPlayable(terrain[ni])) {
        let tc = terrainTroopCost(terrain[ni]);
        if (cb && cb.bonus.moveCost) tc = Math.max(1, Math.ceil(tc * cb.bonus.moveCost));
        const fn = friendlyNeighborCount(nx, ny, pi);
        const fn8 = friendlyNeighborCount8(nx, ny, pi);
        // Gap-fill cells get priority (they smooth borders)
        if (fn >= 3 || fn8 >= 5) {
          gapTargets.push({ x: nx, y: ny, cost: Math.max(1, Math.ceil(tc * 0.5)), fn });
        }
        // Organic noise filter: only expand ~65% of border cells per push (creates irregular blobs)
        const noiseVal = organicNoise(nx, ny, pushSeed);
        if (noiseVal > 0.35) {
          // Terrain corridor bonus
          const corr = terrainCorridorBonus(nx, ny, pi);
          const score = tc + noiseVal * 3 + corr - fn * 1.5;
          targets.push({ x: nx, y: ny, cost: tc, score });
        }
      }
    }
  }
  if (targets.length === 0 && gapTargets.length === 0) return;

  let claimed = 0;
  // Phase 2: Gap-fill first (cheap, makes borders smooth)
  gapTargets.sort((a, b) => b.fn - a.fn);
  for (const t of gapTargets) {
    if (p.totalTroops < t.cost) continue;
    if (owner[idx(t.x, t.y)] === -1) {
      p.totalTroops -= t.cost;
      claimCell(t.x, t.y, pi);
      claimed++;
    }
  }
  // Phase 3: Organic border expansion (noise-filtered subset)
  targets.sort((a, b) => a.score - b.score);
  for (const t of targets) {
    if (p.totalTroops < t.cost) break;
    if (owner[idx(t.x, t.y)] === -1) {
      p.totalTroops -= t.cost;
      claimCell(t.x, t.y, pi);
      claimed++;
    }
  }
  if (claimed === 0) { const sock = findSocket(pi); if (sock) sock.emit('msg', '병력 부족!'); return; }
  p.stats.cellsClaimed += claimed;
  checkQuestProgress(p, 'expand', claimed);
}

function massiveAttack(pi, tx, ty) {
  const p = players[pi]; if (!p || !p.alive) return;
  if (p.totalTroops < 2000) { const sock = findSocket(pi); if (sock) sock.emit('msg', '\uBCD1\uB825 \uBD80\uC871! (2,000\uD544\uC694)'); return; }
  const cells = playerCells[pi]; if (!cells || cells.size === 0) return;
  let budget = Math.floor(p.totalTroops * 0.3);
  p.totalTroops -= budget;
  const visited = new Set(), queue = [];
  let bestDist = Infinity, bestCell = null;
  for (const ci of cells) {
    const cx2 = ci % W, cy2 = Math.floor(ci / W);
    for (let d = 0; d < 4; d++) {
      const nx = cx2 + CARDINAL[d][0], ny = cy2 + CARDINAL[d][1];
      if (!validCell(nx, ny) || owner[idx(nx, ny)] === pi) continue;
      const dist = Math.abs(nx - tx) + Math.abs(ny - ty);
      if (dist < bestDist) { bestDist = dist; bestCell = { x: nx, y: ny }; }
    }
  }
  if (!bestCell) return;
  queue.push(bestCell); visited.add(bestCell.x + ',' + bestCell.y);
  let claimed = 0;
  while (queue.length > 0 && budget > 0) {
    const c = queue.shift();
    const ci = idx(c.x, c.y), t = terrain[ci];
    if (!isPlayable(t)) continue;
    const cur = owner[ci];
    if (cur === -1) { claimCell(c.x, c.y, pi); budget -= 100; claimed++; }
    else if (cur === -2) {
      const cost = Math.ceil(troops[ci] / attackPow(p));
      if (budget >= cost) { budget -= cost; claimCell(c.x, c.y, pi); claimed++; checkCampClear(pi, c.x, c.y); } else continue;
    } else if (cur >= 0 && cur !== pi && !areAllies(pi, cur)) {
      const enemy = players[cur];
      if (enemy && enemy.alive && !isProtected(enemy) && !(enemy.shieldEnd && enemy.shieldEnd > Date.now())) {
        const defT = DEFENSE[t] || 1;
        const wallBonus = wallDefenseBonus(enemy, c.x, c.y);
        const capDist2 = enemy.capital ? Math.abs(c.x - enemy.capital.x) + Math.abs(c.y - enemy.capital.y) : 999;
        const fortBonus = capDist2 <= 5 ? 1.5 : capDist2 <= 15 ? 1.3 : capDist2 <= 30 ? 1.15 : 1.0;
        const sBonus = siegeBonus(p);
        const cost = Math.ceil(300 * defensePow(enemy) * defT * (1 + (wallBonus - 1) * sBonus) * (1 + (fortBonus - 1) * sBonus) / attackPow(p));
        if (budget >= cost) {
          budget -= cost;
          const wasCapital = enemy.capital && enemy.capital.x === c.x && enemy.capital.y === c.y;
          claimCell(c.x, c.y, pi); claimed++; p.stats.enemyCellsTaken++;
          if (wasCapital) {
            p.resources.f += 200; p.resources.w += 200; p.resources.s += 100; p.resources.g += 100;
            const sock = findSocket(pi); if (sock) sock.emit('reward', { food: 200, wood: 200, stone: 100, gold: 100 });
          }
          checkDeath(cur, pi);
        } else continue;
      } else continue;
    } else continue;
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    dirs.sort((a, b) => (Math.abs(c.x + a[0] - tx) + Math.abs(c.y + a[1] - ty)) - (Math.abs(c.x + b[0] - tx) + Math.abs(c.y + b[1] - ty)));
    for (const d of dirs) {
      const nx = c.x + d[0], ny = c.y + d[1], k = nx + ',' + ny;
      if (!visited.has(k) && validCell(nx, ny)) { visited.add(k); queue.push({ x: nx, y: ny }); }
    }
  }
  p.stats.cellsClaimed += claimed;
  checkQuestProgress(p, 'expand', claimed); checkQuestProgress(p, 'conquer', claimed);
}

// ===== DEATH =====
function checkDeath(pi, killerPi) {
  const p = players[pi]; if (!p || !p.alive) return;
  const cells = playerCells[pi];
  if (!cells || cells.size === 0) {
    p.alive = false;
    const sock = findSocket(pi); if (sock) sock.emit('died');
    if (p.isBot) setTimeout(() => respawnPlayer(pi), 10000);
    if (killerPi !== undefined && killerPi >= 0) {
      const killer = players[killerPi];
      if (killer && killer.alive) {
        killer.killStreak++;
        if (killer.killStreak > killer.bestStreak) killer.bestStreak = killer.killStreak;
        let reward = null;
        if (killer.killStreak === 10) reward = '10 KILLS! \uACE8\uB4DC +500';
        else if (killer.killStreak === 25) reward = '25 KILLS! \uACE8\uB4DC +1500';
        else if (killer.killStreak === 50) reward = '50 KILLS! \uACE8\uB4DC +5000';
        if (reward) {
          const bonus = killer.killStreak === 10 ? 500 : killer.killStreak === 25 ? 1500 : 5000;
          killer.resources.g += bonus;
          const ks = findSocket(killerPi); if (ks) ks.emit('streak', { count: killer.killStreak, reward });
        }
      }
    }
  }
}

function findSocket(pi) {
  for (const [sid, i] of Object.entries(pidMap)) {
    if (i === pi) return io.sockets.sockets.get(sid);
  }
  return null;
}

// ===== BARB CAMPS =====
function spawnCamp() {
  const typeIdx = Math.random() < 0.4 ? 0 : Math.random() < 0.6 ? 1 : Math.random() < 0.8 ? 2 : 3;
  const ct = CAMP_TYPES[typeIdx];
  for (let tries = 0; tries < 100; tries++) {
    const cx = Math.floor(Math.random() * W), cy = Math.floor(Math.random() * H);
    let ok = true; const campCells = [];
    for (let dy = 0; dy < ct.size && ok; dy++) {
      for (let dx = 0; dx < ct.size && ok; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (!validCell(nx, ny) || !isPlayable(terrain[idx(nx, ny)]) || owner[idx(nx, ny)] !== -1) ok = false;
        else campCells.push({ x: nx, y: ny });
      }
    }
    if (!ok) continue;
    barbs.push({ cx, cy, type: typeIdx, cells: campCells, troops: ct.troops, spawnTime: Date.now() });
    for (const c of campCells) { const ci = idx(c.x, c.y); owner[ci] = -2; troops[ci] = ct.troops; markDirty(c.x, c.y); }
    return;
  }
}

function checkCampClear(killerPi, x, y) {
  for (let bi = barbs.length - 1; bi >= 0; bi--) {
    const b = barbs[bi];
    let allCleared = true;
    for (const c of b.cells) { if (owner[idx(c.x, c.y)] === -2) { allCleared = false; break; } }
    if (allCleared) {
      const ct = CAMP_TYPES[b.type], p = players[killerPi];
      if (p && p.alive) {
        const cb = CIVS[p.civ], mul = cb && cb.bonus.barbReward ? cb.bonus.barbReward : 1;
        const rf = Math.floor(ct.reward.f * mul), rw = Math.floor(ct.reward.w * mul);
        const rs = Math.floor(ct.reward.s * mul), rg = Math.floor(ct.reward.g * mul);
        p.resources.f += rf; p.resources.w += rw; p.resources.s += rs; p.resources.g += rg;
        p.stats.barbsKilled++;
        checkQuestProgress(p, 'barb', 1);
        const sock = findSocket(killerPi);
        if (sock) sock.emit('reward', { food: rf, wood: rw, stone: rs, gold: rg });
      }
      barbs.splice(bi, 1);
    }
  }
}

function updateCamps() {
  for (let bi = barbs.length - 1; bi >= 0; bi--) {
    const b = barbs[bi]; let alive = false;
    for (const c of b.cells) { if (owner[idx(c.x, c.y)] === -2) { alive = true; break; } }
    if (!alive) barbs.splice(bi, 1);
  }
}




// ===== TRADE =====
function tradeResources(pi, from, to, amount) {
  const p = players[pi]; if (!p || !p.alive) return;
  const resMap = { food: 'f', wood: 'w', stone: 's', gold: 'g' };
  const fk = resMap[from], tk = resMap[to];
  if (!fk || !tk || fk === tk) return;
  if (amount < 10 || amount > 10000) return;
  if ((p.resources[fk] || 0) < amount) { const sock = findSocket(pi); if (sock) sock.emit('msg', '\uC790\uC6D0 \uBD80\uC871!'); return; }
  const ml = p.buildings.market ? p.buildings.market.l : 0;
  const mb = 1 + ml * 0.08;
  const cb = CIVS[p.civ], tb = cb && cb.bonus.trade ? cb.bonus.trade : 1;
  const dl = p.tech.diplo ? p.tech.diplo.l : 0, db = 1 + dl * 0.05;
  let harbors = 0;
  if (playerCells[pi]) { for (const ci of playerCells[pi]) { if (specialTiles[ci] === 5) harbors++; } }
  const hb = 1 + Math.min(harbors, 10) * 0.03;
  let rate = from === 'gold' ? 2.0 : (to === 'gold' ? 0.4 : 0.7);
  rate *= mb * tb * db * hb;
  const received = Math.floor(amount * rate);
  p.resources[fk] -= amount; p.resources[tk] += received;
  const sock = findSocket(pi);
  if (sock) sock.emit('msg', '\uAD50\uD658: ' + amount + ' ' + from + ' \u2192 ' + received + ' ' + to);
}

// ===== SPY =====
function spyOnPlayer(pi, targetPi) {
  const p = players[pi]; if (!p || !p.alive) return;
  const target = players[targetPi]; if (!target || !target.alive) return;
  const spyLv = p.buildings.spy ? p.buildings.spy.l : 0;
  const diploLv = p.tech.diplo ? p.tech.diplo.l : 0;
  const infoLevel = spyLv + Math.floor(diploLv * 0.5);
  const cells = playerCells[targetPi] ? playerCells[targetPi].size : 0;
  const rank = getRank(cells);
  const civDef = CIVS[target.civ] || CIVS.rome;
  const info = { name: target.name, civName: civDef.n, cells, rank: { icon: rank.icon, n: rank.n } };
  if (infoLevel >= 2) info.troops = target.totalTroops;
  if (infoLevel >= 5) info.resources = { food: target.resources.f, wood: target.resources.w, stone: target.resources.s, gold: target.resources.g };
  if (infoLevel >= 8) { info.buildings = {}; for (const k in target.buildings) info.buildings[k] = target.buildings[k].l; }
  if (infoLevel >= 12) { info.tech = {}; for (const k in target.tech) info.tech[k] = target.tech[k].l; }
  const sock = findSocket(pi);
  if (sock) sock.emit('spyInfo', info);
}

// ===== MINIMAP PREVIEW =====
function buildTerrainPreview() {
  const scale = 10, pw = Math.floor(W / scale), ph = Math.floor(H / scale);
  const t = new Uint8Array(pw * ph), o = new Uint8Array(pw * ph);
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      const mx = px * scale, my = py * scale;
      t[py * pw + px] = terrain[idx(mx, my)];
      const ow = owner[idx(mx, my)];
      o[py * pw + px] = ow >= 0 ? 1 : (ow === -2 ? 2 : 0);
    }
  }
  return { w: pw, h: ph, t: Array.from(t), o: Array.from(o) };
}

// ===== BOT AI =====
function spawnBots() {
  const civKeys = Object.keys(CIVS);
  for (let i = 0; i < BOT_COUNT; i++) {
    const pi = spawnPlayer('Bot-' + (i + 1), civKeys[i % civKeys.length], true);
    const sp = findSpawn();
    placePlayerAt(pi, sp.x, sp.y);
  }
}

function botAI() {
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi]; if (!p.alive || !p.isBot) continue;
    // Bot building placement: try to place or upgrade buildings
    const botBldgKeys = Object.keys(BLDG);
    const currentCount = countPlayerBuildings(pi);
    const maxCount = maxPlayerBuildings(pi);
    const cells = playerCells[pi];
    if (cells && cells.size > 0) {
      // Try to upgrade existing buildings first
      let upgraded = false;
      for (const [ci, b] of mapBuildings) {
        if (b.owner === pi && b.buildEnd === 0) {
          const playerLv = getPlayerLevel(pi);
          const maxLv = Math.min(25, playerLv * 3);
          if (b.level < maxLv) {
            const c = bldgCost(b.type, b.level);
            if (canAfford(p, c)) { upgradeBuildingOnMap(pi, ci); upgraded = true; break; }
          }
        }
      }
      // Try to place new buildings if slots available
      if (!upgraded && currentCount < maxCount) {
        const typeToPlace = botBldgKeys[Math.floor(Math.random() * botBldgKeys.length)];
        const bSize = (BLDG[typeToPlace] || {}).size || 1;
        const c = bldgCost(typeToPlace, 0);
        if (canAfford(p, c)) {
          // Find a random owned cell where NxN area fits
          const cellArr = Array.from(cells);
          for (let tries = 0; tries < 15; tries++) {
            const rci = cellArr[Math.floor(Math.random() * cellArr.length)];
            if (canPlaceBuildingAt(pi, rci, bSize)) {
              placeBuildingOnMap(pi, rci, typeToPlace);
              break;
            }
          }
        }
      }
    }
    for (const k in p.tech) {
      const t = p.tech[k]; if (t.e > 0) continue;
      const d = TECH[k]; if (!d || t.l >= d.max) continue;
      const c = techCost(k, t.l);
      if (canAfford(p, c)) { payCost(p, c); t.e = Date.now() + techTime(k, t.l, p); break; }
    }
    if (p.totalTroops >= 10) borderPush(pi);
    // Bot unit deployment
    if (units.filter(x => x.alive && x.owner === pi).length < 2 && p.totalTroops > 30 && Math.random() < 0.15) {
      const targets2 = [];
      for (const ci of playerCells[pi]) {
        const cx2 = ci % W, cy2 = Math.floor(ci / W);
        for (let d = 0; d < 4; d++) {
          const nx = cx2 + CARDINAL[d][0], ny = cy2 + CARDINAL[d][1];
          if (validCell(nx, ny) && owner[idx(nx, ny)] !== pi && owner[idx(nx, ny)] !== -1) {
            targets2.push({ x: nx, y: ny });
          }
        }
      }
      if (targets2.length > 0) {
        const tgt = targets2[Math.floor(Math.random() * targets2.length)];
        createUnit(pi, p.totalTroops > 60 ? 'elite' : 'army', tgt.x, tgt.y);
      }
    }
    // Bot expand toward random direction
    if (p.totalTroops >= 5) {
      const targets3 = [];
      let cnt = 0;
      for (const ci of playerCells[pi]) {
        if (cnt > 60) break;
        const cx2 = ci % W, cy2 = Math.floor(ci / W);
        for (let d = 0; d < 4; d++) {
          const nx = cx2 + CARDINAL[d][0], ny = cy2 + CARDINAL[d][1];
          if (validCell(nx, ny) && isPlayable(terrain[idx(nx, ny)]) && owner[idx(nx, ny)] !== pi) {
            targets3.push({ x: nx, y: ny }); cnt++;
          }
        }
      }
      if (targets3.length > 0) {
        const n = Math.min(3, targets3.length);
        for (let j = 0; j < n && p.totalTroops >= 3; j++) {
          const tgt = targets3[Math.floor(Math.random() * targets3.length)];
          expandToward(pi, tgt.x, tgt.y);
        }
      }
    }
  }
}

// ===== ROUND MANAGEMENT =====
function getRoundElapsed() { return Date.now() - roundStartTime; }
function getRoundRemaining() { return Math.max(0, ROUND_DURATION - getRoundElapsed()); }

function getRoundPhase() {
  if (roundPhase === 'ending' || roundPhase === 'waiting') return roundPhase;
  return 'active';
}

function countPlayableCells() {
  let c = 0;
  for (let i = 0; i < W * H; i++) { if (isPlayable(terrain[i])) c++; }
  return c;
}

function getStormRadius() {
  const e = getRoundElapsed();
  if (e < STORM_START) return STORM_INITIAL_R;
  const elapsed = e - STORM_START;
  const total = ROUND_DURATION - STORM_START;
  const t = Math.min(1, elapsed / total);
  // Ease-in: starts slow, gets faster
  const eased = t * t;
  return Math.floor(STORM_INITIAL_R - (STORM_INITIAL_R - STORM_FINAL_R) * eased);
}

function applyStorm() {
  if (getRoundPhase() !== 'active') return;  // storm runs during active phase
  currentStormR = getStormRadius();
  const r2 = currentStormR * currentStormR;
  let decayed = 0;
  for (let pi = 0; pi < players.length; pi++) {
    const cells = playerCells[pi]; if (!cells || cells.size === 0) continue;
    const toRemove = [];
    for (const ci of cells) {
      const cx = ci % W, cy = Math.floor(ci / W);
      const dx = cx - stormCenterX, dy = cy - stormCenterY;
      if (dx * dx + dy * dy > r2) toRemove.push(ci);
    }
    for (const ci of toRemove) {
      const cx = ci % W, cy = Math.floor(ci / W);
      releaseCell(cx, cy);
      decayed++;
    }
    // Check if player died from storm
    if (cells.size === 0 && players[pi].alive) checkDeath(pi);
  }
  // Also remove barbarian camps outside storm
  for (let i = 0; i < W * H; i++) {
    if (owner[i] === -2) {
      const cx = i % W, cy = Math.floor(i / W);
      const dx = cx - stormCenterX, dy = cy - stormCenterY;
      if (dx * dx + dy * dy > r2) { owner[i] = -1; troops[i] = 0; markDirty(cx, cy); }
    }
  }
}

function checkWinConditions() {
  if (roundPhase === 'ending' || roundPhase === 'waiting') return;
  // Domination check (all alive players including bots)
  const liveCells = totalPlayableCells > 0 ? totalPlayableCells : countPlayableCells();
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi]; if (!p.alive) continue;
    const cells = playerCells[pi] ? playerCells[pi].size : 0;
    if (cells >= liveCells * DOMINATION_RATIO) {
      endRound(pi, 'domination');
      return;
    }
  }
  // Elimination: last alive (only counts if >3 min played)
  if (getRoundElapsed() > 180000) {
    const alive2 = [];
    for (let pi = 0; pi < players.length; pi++) {
      if (players[pi].alive) alive2.push(pi);
    }
    if (alive2.length === 1) { endRound(alive2[0], 'elimination'); return; }
    if (alive2.length === 0) { endRound(-1, 'draw'); return; }
  }
  // Time's up
  if (getRoundElapsed() >= ROUND_DURATION) {
    let best = -1, bestCells = 0;
    for (let pi = 0; pi < players.length; pi++) {
      if (!players[pi].alive) continue;
      const c = playerCells[pi] ? playerCells[pi].size : 0;
      if (c > bestCells) { bestCells = c; best = pi; }
    }
    endRound(best, 'timeout');
  }
}

function buildScoreboard() {
  const scores = [];
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi];
    const cells = playerCells[pi] ? playerCells[pi].size : 0;
    scores.push({
      pi, name: p.name, color: p.color, cells,
      kills: p.killStreak || 0, isBot: p.isBot,
      claimed: p.stats ? p.stats.cellsClaimed : 0,
      enemyTaken: p.stats ? p.stats.enemyCellsTaken : 0,
      alive: p.alive,
      score: cells * 2 + (p.stats ? p.stats.enemyCellsTaken * 3 : 0) + (p.killStreak || 0) * 50
    });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

function endRound(winnerPi, reason) {
  if (roundPhase === 'ending') return;
  roundPhase = 'ending';
  const winner = winnerPi >= 0 ? players[winnerPi] : null;
  const scoreboard = buildScoreboard();
  const reasonText = reason === 'domination' ? '영토 지배' : reason === 'elimination' ? '최후의 생존자' : reason === 'timeout' ? '시간 종료' : '무승부';
  console.log('[Round ' + roundNumber + '] Ended: ' + reasonText + (winner ? ' — Winner: ' + winner.name : ''));
  io.emit('roundEnd', {
    winner: winner ? { pi: winnerPi, name: winner.name, color: winner.color } : null,
    reason: reasonText,
    roundNumber,
    scoreboard,
    nextRoundIn: ROUND_END_DELAY
  });
  roundEndTimer = setTimeout(() => enterLobby(), ROUND_END_DELAY);
}

// ===== LOBBY SYSTEM =====
function enterLobby() {
  roundNumber++;
  console.log('[Lobby] Entering lobby for round ' + roundNumber + '...');
  // Clear ALL game state
  units.length = 0;
  nextUnitId = 1;
  for (let i = 0; i < W * H; i++) { owner[i] = -1; troops[i] = 0; }
  for (let pi = 0; pi < players.length; pi++) {
    if (playerCells[pi]) playerCells[pi].clear();
  }
  players.length = 0;
  playerCells.length = 0;
  playerVisibleChunks.length = 0;
  playerVisionSources.length = 0;
  playerVisionRange.length = 0;
  playerChunkIndex.length = 0;
  for (const sid in pidMap) delete pidMap[sid];
  barbs.length = 0;
  mapBuildings.clear();
  cellToAnchor.clear();
  dirtyChunks.clear();
  nextColor = 0;
  // Generate new map
  terrain = generateEarthMap(W, H);
  specialTiles = new Uint8Array(W * H);
  generateSpecialTiles();
  totalPlayableCells = countPlayableCells();
  buildTerrainChunkCache();
  // Lobby state
  roundPhase = 'lobby';
  lobbyStartTime = Date.now();
  lobbyMapName = MAP_NAMES[Math.floor(Math.random() * MAP_NAMES.length)];
  lobbyQueue.clear();
  // Auto-add currently connected players back to lobby queue
  for (const [sid, sock] of io.sockets.sockets) {
    // Only queue players who have entered a name
    const name = sock._playerName;
    if (!name) continue;
    lobbyQueue.set(sid, {
      name,
      civ: 'rome',
      color: COLORS[lobbyQueue.size % COLORS.length]
    });
  }
  // Broadcast lobby state
  const tp = buildTerrainPreview();
  io.emit('tp', tp);
  io.emit('enterLobby', getLobbyState());
  console.log('[Lobby] Map: ' + lobbyMapName + ', ' + lobbyQueue.size + ' players queued');
}

function getLobbyState() {
  const elapsed = Date.now() - lobbyStartTime;
  const remaining = Math.max(0, LOBBY_DURATION - elapsed);
  const playerList = [];
  for (const [sid, data] of lobbyQueue) {
    playerList.push({ name: data.name, color: data.color, civ: data.civ });
  }
  return {
    phase: 'lobby',
    roundNumber,
    mapName: lobbyMapName,
    countdown: remaining,
    players: playerList,
    maxPlayers: MAX_HUMAN_PLAYERS,
    totalPlayable: totalPlayableCells
  };
}

function startGameFromLobby() {
  console.log('[Round ' + roundNumber + '] Starting from lobby...');
  roundPhase = 'active';
  roundStartTime = Date.now();
  // Create players from lobby queue
  const civKeys = Object.keys(CIVS);
  for (const [sid, data] of lobbyQueue) {
    const pi = spawnPlayer(data.name, data.civ, false);
    pidMap[sid] = pi;
  }
  // Add bots
  let botIdx = 0;
  while (players.filter(p => p.isBot).length < BOT_COUNT) {
    spawnPlayer('Bot-' + (++botIdx), civKeys[botIdx % civKeys.length], true);
  }
  // Place everyone
  for (let pi = 0; pi < players.length; pi++) {
    if (!players[pi].alive) continue;
    const sp = findSpawn();
    placePlayerAt(pi, sp.x, sp.y);
  }
  // Spawn camps
  for (let i = 0; i < 30; i++) spawnCamp();
  // Compute visibility
  updateAllVisibility();
  // Build color map
  const pc = {};
  for (let pi = 0; pi < players.length; pi++) { if (players[pi].alive) pc[pi] = players[pi].color; }
  // Notify all clients
  io.emit('gameStart', { roundNumber, mapName: lobbyMapName, duration: ROUND_DURATION });
  io.emit('mi', { w: W, h: H, cs: CHUNK, bldg: BLDG, tech: TECH, civs: CIVS, ranks: RANKS, stiles: STILES, defense: DEFENSE, unitTypes: UNIT_TYPES, bldgCodes: BLDG_CODES });
  io.emit('pc', pc);
  io.emit('tp', buildTerrainPreview());
  // Send joined to each lobby player
  for (const [sid, data] of lobbyQueue) {
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;
    const pi = pidMap[sid];
    if (pi === undefined) continue;
    const p = players[pi];
    playerVisibleChunks[pi] = computeVisibility(pi);
    sock.emit('joined', { pi, color: p.color, sx: p.capital.x, sy: p.capital.y, civ: p.civ });
    const st = playerState(pi);
    if (st) sock.emit('st', st);
  }
  const humans = players.filter(p => !p.isBot).length;
  const bots = players.filter(p => p.isBot).length;
  console.log('[Round ' + roundNumber + '] Started: ' + humans + ' humans, ' + bots + ' bots on ' + lobbyMapName);
}

function getRoundInfo() {
  if (roundPhase === 'lobby') return getLobbyState();
  return {
    roundNumber,
    phase: getRoundPhase(),
    elapsed: getRoundElapsed(),
    remaining: getRoundRemaining(),
    duration: ROUND_DURATION
  };
}

// ===== VISIBILITY (2-tier circular) =====
const VISION_FULL_BASE = 10;     // base inner circle at 0 territory
const VISION_PARTIAL_BASE = 18;  // base outer circle at 0 territory
const WATCHTOWER_BONUS = 10;     // extra vision range per watchtower

// Per-player visibility data
const playerVisibleChunks = [];   // chunks that MAY contain visible cells (broad filter)
const playerVisionSources = [];   // sampled border positions for distance check [{x,y},...]
const playerVisionRange = [];     // [fullRange, partialRange] per player

function computeVisibility(pi) {
  const cells = playerCells[pi];
  const visible = new Set();
  if (!cells || cells.size === 0) return visible;
  // Territory-scaled vision: grows with sqrt of territory size
  const tSize = cells.size;
  const sizeBonus = Math.floor(Math.sqrt(tSize) * 0.6); // ~100cells→6, ~400→12, ~1000→19, ~2500→30
  let vFull = VISION_FULL_BASE + sizeBonus;
  let vPartial = VISION_PARTIAL_BASE + Math.floor(sizeBonus * 1.6);
  // Watchtower bonus
  let wtCount = 0;
  for (const ci of cells) { if (specialTiles[ci] === 10) wtCount++; }
  const wtBonus = Math.min(wtCount * WATCHTOWER_BONUS, 40);
  vFull += wtBonus; vPartial += wtBonus;
  // Cap
  vFull = Math.min(vFull, 120); vPartial = Math.min(vPartial, 200);
  playerVisionRange[pi] = [vFull, vPartial];

  // Sample border cells as vision sources (every Nth border cell for perf)
  const sources = [];
  let count = 0;
  const maxSources = Math.min(600, 200 + Math.floor(Math.sqrt(cells.size) * 4)); // scale source cap with territory
  const step = Math.max(1, Math.floor(cells.size / maxSources));
  for (const ci of cells) {
    const cx2 = ci % W, cy2 = Math.floor(ci / W);
    // Check if border cell
    let isBorder = false;
    for (let d = 0; d < 4; d++) {
      const nx = cx2 + CARDINAL[d][0], ny = cy2 + CARDINAL[d][1];
      if (!validCell(nx, ny) || owner[idx(nx, ny)] !== pi) { isBorder = true; break; }
    }
    if (isBorder) {
      count++;
      if (count % step === 0) sources.push({ x: cx2, y: cy2 });
    }
  }
  // Add unit positions as vision sources
  for (const u of units) {
    if (!u.alive || u.owner !== pi) continue;
    const ut = UNIT_TYPES[u.type];
    sources.push({ x: u.x, y: u.y, vf: ut.vision, vp: ut.vision * 2 });
  }
  playerVisionSources[pi] = sources;

  // Broad chunk filter: any chunk within partial range
  const vrChunks = Math.ceil(vPartial / CHUNK) + 1;
  const ownedChunks = new Set();
  for (const ci of cells) {
    ownedChunks.add(Math.floor((ci % W) / CHUNK) + ',' + Math.floor(Math.floor(ci / W) / CHUNK));
  }
  for (const ck of ownedChunks) {
    const [ccx, ccy] = ck.split(',').map(Number);
    for (let dy = -vrChunks; dy <= vrChunks; dy++) {
      for (let dx = -vrChunks; dx <= vrChunks; dx++) {
        const r2 = dx * dx + dy * dy;
        if (r2 > (vrChunks + 1) * (vrChunks + 1)) continue; // circular chunk filter
        const nx = ccx + dx, ny = ccy + dy;
        if (nx >= 0 && ny >= 0 && nx < Math.ceil(W / CHUNK) && ny < Math.ceil(H / CHUNK)) {
          visible.add(nx + ',' + ny);
        }
      }
    }
  }
  // Also include unit vision chunks
  for (const u of units) {
    if (!u.alive || u.owner !== pi) continue;
    const ut = UNIT_TYPES[u.type];
    const ur = Math.ceil(ut.vision * 2 / CHUNK) + 1;
    const ucx = Math.floor(u.x / CHUNK), ucy = Math.floor(u.y / CHUNK);
    for (let dy = -ur; dy <= ur; dy++) {
      for (let dx = -ur; dx <= ur; dx++) {
        if (dx * dx + dy * dy > (ur + 1) * (ur + 1)) continue;
        const nx = ucx + dx, ny = ucy + dy;
        if (nx >= 0 && ny >= 0 && nx < Math.ceil(W / CHUNK) && ny < Math.ceil(H / CHUNK)) {
          visible.add(nx + ',' + ny);
        }
      }
    }
  }
  return visible;
}

// Get cell visibility level: 0=full, 1=fog, 2=partial
function cellVisLevel(gx, gy, pi) {
  const sources = playerVisionSources[pi];
  if (!sources || sources.length === 0) return 1;
  const ranges = playerVisionRange[pi] || [VISION_FULL_BASE, VISION_PARTIAL_BASE];
  const fullR2 = ranges[0] * ranges[0];
  const partR2 = ranges[1] * ranges[1];
  let minDist = Infinity;
  let unitPartial = false;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const ddx = gx - s.x, ddy = gy - s.y;
    const d2 = ddx * ddx + ddy * ddy;
    if (s.vf !== undefined) {
      if (d2 <= s.vf * s.vf) return 0;
      if (d2 <= s.vp * s.vp) unitPartial = true;
      continue;
    }
    if (d2 <= fullR2) return 0; // Early exit — source within full range
    if (d2 < minDist) minDist = d2;
  }
  if (unitPartial) return 2;
  if (minDist <= partR2) return 2;
  return 1;
}

// Update visibility for all players periodically
function updateAllVisibility() {
  playerVisibleChunks.length = players.length;
  playerVisionSources.length = players.length;
  playerVisionRange.length = players.length;
  playerChunkIndex.length = players.length;
  for (let pi = 0; pi < players.length; pi++) {
    if (!players[pi].alive) { playerVisibleChunks[pi] = new Set(); playerVisionSources[pi] = []; playerChunkIndex[pi] = null; continue; }
    playerVisibleChunks[pi] = computeVisibility(pi);
    // Build chunk index for fast fog shortcut
    const cells = playerCells[pi];
    if (cells && cells.size > 0) {
      const ci = new Set();
      for (const c of cells) {
        ci.add(Math.floor((c % W) / CHUNK) + ',' + Math.floor(Math.floor(c / W) / CHUNK));
      }
      playerChunkIndex[pi] = ci;
    } else {
      playerChunkIndex[pi] = null;
    }
  }
  // Push refreshed fog to all connected players in their viewport
  for (const [sid, pi] of Object.entries(pidMap)) {
    const sock = io.sockets.sockets.get(sid);
    if (!sock || !sock.vp) continue;
    const v = sock.vp;
    const cx0 = Math.max(0, Math.floor(v.x / CHUNK));
    const cy0 = Math.max(0, Math.floor(v.y / CHUNK));
    const cx1 = Math.min(Math.ceil(W / CHUNK) - 1, Math.floor((v.x + v.w) / CHUNK));
    const cy1 = Math.min(Math.ceil(H / CHUNK) - 1, Math.floor((v.y + v.h) / CHUNK));
    const toSend = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        toSend.push(packChunkForPlayer(cx, cy, pi));
      }
    }
    if (toSend.length > 0) sock.emit('ch', toSend);
  }
}

// ===== CHUNK PACKING =====
function packChunk(cx, cy) {
  const ck = cx + ',' + cy;
  const t = terrainChunkCache.get(ck);
  const o = [], tr = [], sp = [];
  const sx = cx * CHUNK, sy = cy * CHUNK;
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const gx = sx + lx, gy = sy + ly;
      if (gx >= W || gy >= H) { o.push(-1); tr.push(0); sp.push(0); continue; }
      const i = idx(gx, gy);
      o.push(owner[i]); tr.push(troops[i]); sp.push(specialTiles[i] || 0);
    }
  }
  return { cx, cy, t, o, tr, sp };
}

// ===== FOG OF WAR (2-tier circular system) =====
// fog values: 0=full vision, 1=total fog, 2=partial vision (territory visible, owner unknown)
function packChunkForPlayer(cx, cy, pi) {
  const ck = cx + ',' + cy;
  const vis = playerVisibleChunks[pi];
  const inRange = vis && vis.has(ck);

  // Full-fog shortcut: chunk not in vision range AND player has no cells here
  if (!inRange) {
    const pci = playerChunkIndex[pi];
    if (!pci || !pci.has(ck)) {
      return { cx, cy, ff: 1, t: terrainChunkCache.get(ck) };
    }
  }

  const t = terrainChunkCache.get(ck);
  const o = [], tr = [], sp = [], fog = [];
  const sx = cx * CHUNK, sy = cy * CHUNK;

  // Chunk-level full-visibility optimization: if entire chunk is well within full vision range, skip per-cell checks
  let allVisible = false;
  if (inRange) {
    const sources = playerVisionSources[pi];
    const ranges = playerVisionRange[pi];
    if (sources && sources.length > 0 && ranges) {
      const ccx = sx + CHUNK * 0.5, ccy = sy + CHUNK * 0.5;
      const chunkDiag = CHUNK * 0.72; // ~sqrt(2)/2 * CHUNK
      let minD2 = Infinity;
      for (let si = 0; si < sources.length; si++) {
        const s = sources[si];
        if (s.vf !== undefined) continue; // skip unit sources
        const ddx = ccx - s.x, ddy = ccy - s.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < minD2) minD2 = d2;
      }
      const fullR = ranges[0] - chunkDiag;
      if (fullR > 0 && minD2 < fullR * fullR) allVisible = true;
    }
  }

  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const gx = sx + lx, gy = sy + ly;
      if (gx >= W || gy >= H) { o.push(-1); tr.push(0); sp.push(0); fog.push(1); continue; }
      const i = idx(gx, gy);
      // Own cells always fully visible
      if (owner[i] === pi) {
        o.push(owner[i]); tr.push(troops[i]); sp.push(specialTiles[i] || 0); fog.push(0);
        continue;
      }
      // If chunk not even in broad range -> total fog
      if (!inRange) {
        o.push(-1); tr.push(0); sp.push(0); fog.push(1);
        continue;
      }
      // If entire chunk is within full vision, skip per-cell distance check
      if (allVisible) {
        o.push(owner[i]); tr.push(troops[i]); sp.push(specialTiles[i] || 0); fog.push(0);
        continue;
      }
      // Per-cell circular distance check
      const vl = cellVisLevel(gx, gy, pi);
      if (vl === 0) {
        o.push(owner[i]); tr.push(troops[i]); sp.push(specialTiles[i] || 0); fog.push(0);
      } else if (vl === 2) {
        const ow = owner[i];
        o.push(ow >= 0 ? -3 : (ow === -2 ? -3 : -1));
        tr.push(0); sp.push(0); fog.push(2);
      } else {
        o.push(-1); tr.push(0); sp.push(0); fog.push(1);
      }
    }
  }
  // Build building data for chunk (multi-cell aware)
  const bl = [];
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const gx = sx + lx, gy = sy + ly;
      if (gx >= W || gy >= H) { bl.push(0); continue; }
      const i = idx(gx, gy);
      const fogLevel = fog[ly * CHUNK + lx];
      if (fogLevel === 1) { bl.push(0); continue; }
      if (!cellToAnchor.has(i)) { bl.push(0); continue; }
      const anchorIdx = cellToAnchor.get(i);
      const bld = mapBuildings.get(anchorIdx);
      if (!bld) { bl.push(0); continue; }
      const isAnchor = (anchorIdx === i);
      const code = (BLDG_CODES[bld.type] || 0) * 100 + bld.level;
      const val = isAnchor ? code : (code + 2000);
      bl.push(bld.buildEnd > 0 ? -val : val);
    }
  }
  return { cx, cy, t, o, tr, sp, fog, bl };
}

// ===== LEADERBOARD =====
function leaderboard() {
  const pList = [];
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi]; if (!p.alive) continue;
    const cells = playerCells[pi] ? playerCells[pi].size : 0;
    const civDef = CIVS[p.civ] || CIVS.rome;
    const rank = getRank(cells);
    pList.push({ i: pi, name: p.name, color: p.color, cells, ct: '', civIcon: civDef.icon, rankIcon: rank.icon });
  }
  pList.sort((a, b) => b.cells - a.cells);
  return { p: pList.slice(0, 15) };
}

// ===== PLAYER STATE =====
function playerState(pi) {
  const p = players[pi]; if (!p) return null;
  const cells = playerCells[pi] ? playerCells[pi].size : 0;
  const rank = getRank(cells);
  const questData = p.quests ? p.quests.map(q => ({
    type: q.type, icon: q.icon, name: q.name, desc: q.desc,
    target: q.target, progress: q.progress, rewards: q.rewards
  })) : [];
  return {
    r: { f: p.resources.f, w: p.resources.w, s: p.resources.s, g: p.resources.g },
    b: p.buildings, t: p.tech,
    tt: p.totalTroops, mt: maxTroops(p),
    cap: p.capital, pr: p.protection,
    rank: rank.n, rankIcon: rank.icon,
    quests: questData,
    killStreak: p.killStreak, bestStreak: p.bestStreak,
    questStreak: p.questStreak || 0,
    shieldEnd: p.shieldEnd || 0,
    stats: p.stats,
    // Unit info
    activeUnits: units.filter(u => u.alive && u.owner === pi).length,
    maxUnits: 5,
    // Building placement info
    bCount: countPlayerBuildings(pi),
    bMax: maxPlayerBuildings(pi),
    pLv: getPlayerLevel(pi),
    // Strategic bonuses
    atkPow: Math.round(attackPow(p) * 100) / 100,
    defPow: Math.round(defensePow(p) * 100) / 100,
    ironCount: countSpecialTiles(pi, 6),
    horseCount: countSpecialTiles(pi, 7),
    shrineCount: countSpecialTiles(pi, 8),
    fertileCount: countSpecialTiles(pi, 9),
    towerCount: countSpecialTiles(pi, 10)
  };
}

// Quick state: lightweight immediate update (just critical numbers)
function sendQuickState(pi) {
  const sock = findSocket(pi);
  if (!sock) return;
  const p = players[pi]; if (!p) return;
  sock.emit('qs', {
    tt: p.totalTroops, mt: maxTroops(p),
    r: { f: p.resources.f, w: p.resources.w, s: p.resources.s, g: p.resources.g },
    activeUnits: units.filter(u => u.alive && u.owner === pi).length,
    bCount: countPlayerBuildings(pi),
    bMax: maxPlayerBuildings(pi),
    pLv: getPlayerLevel(pi)
  });
}

// ===== SAVE / LOAD =====
let saveInProgress = false;
function saveGame() {
  if (saveInProgress) return;
  saveInProgress = true;
  const cells = [];
  for (let i = 0; i < W * H; i++) { if (owner[i] !== -1) cells.push([i, owner[i], troops[i]]); }
  const pData = players.map(p => ({ ...p, quests: p.quests, stats: p.stats }));
  // Save map buildings
  const bldgData = [];
  for (const [ci, b] of mapBuildings) { bldgData.push([ci, b.type, b.level, b.owner, b.buildEnd]); }
  const data = { cells, players: pData, barbs, nextColor, specialTiles: Array.from(specialTiles), mapBuildings: bldgData };
  fs.writeFile(SAVE_FILE, JSON.stringify(data), (e) => {
    saveInProgress = false;
    if (e) console.error('[Save] Error:', e.message);
    else console.log('[Save] OK');
  });
}

function loadGame() {
  if (!fs.existsSync(SAVE_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    const now = Date.now();
    for (const pd of data.players) {
      const p = { ...pd };
      if (!p.isBot) p.offline = true;
      if (!p.quests) p.quests = [];

      if (!p.stats) p.stats = initStats();
      if (!p.civ) p.civ = 'rome';
      if (p.shieldEnd === undefined) p.shieldEnd = 0;
      if (p.killStreak === undefined) p.killStreak = 0;
      if (p.bestStreak === undefined) p.bestStreak = 0;
      if (p.questStreak === undefined) p.questStreak = 0;
      if (p.discordId === undefined) p.discordId = null;
      players.push(p);
      playerCells.push(new Set());
    }
    for (const [i, o, t] of data.cells) { owner[i] = o; troops[i] = t || 0; if (o >= 0 && playerCells[o]) playerCells[o].add(i); }
    if (data.barbs) barbs.push(...data.barbs);
    if (data.nextColor) nextColor = data.nextColor;
    if (data.specialTiles) { for (let i = 0; i < Math.min(data.specialTiles.length, W * H); i++) specialTiles[i] = data.specialTiles[i]; }
    for (let pi = 0; pi < players.length; pi++) {
      const p = players[pi]; if (!p.alive || p.isBot) continue;
      const elapsed = Math.min(now - (p.spawnTime || now), 8 * 3600000);
      const cycles = Math.floor(elapsed / RES_INT);
      if (cycles > 0) {
        const cells = playerCells[pi]; if (!cells) continue;
        for (let c = 0; c < cycles; c++) {
          for (const ci of cells) {
            const t = terrain[ci], r = terrainRes(t);
            p.resources.f += Math.floor(r.f * 0.3); p.resources.w += Math.floor(r.w * 0.3);
            p.resources.s += Math.floor(r.s * 0.3); p.resources.g += Math.floor(r.g * 0.3);
          }
        }
        const troopCycles = Math.floor(elapsed / TROOP_INT);
        for (let c = 0; c < troopCycles; c++) {
          const mt = maxTroops(p);
          if (p.totalTroops < mt) { const base = Math.max(100, Math.floor(Math.sqrt(cells.size) * 20)); p.totalTroops = Math.min(mt, p.totalTroops + base); }
        }
      }
      for (const k in p.buildings) { const b = p.buildings[k]; if (b.e > 0 && now >= b.e) { b.l++; b.e = 0; } }
      for (const k in p.tech) { const t = p.tech[k]; if (t.e > 0 && now >= t.e) { t.l++; t.e = 0; } }
    }
    // Restore map buildings + reconstruct cellToAnchor
    cellToAnchor.clear();
    if (data.mapBuildings) {
      for (const bd of data.mapBuildings) {
        mapBuildings.set(bd[0], { type: bd[1], level: bd[2], owner: bd[3], buildEnd: bd[4] || 0 });
        const bSize = (BLDG[bd[1]] || {}).size || 1;
        const bCells = getBuildingCells(bd[0], bSize);
        for (const ci of bCells) cellToAnchor.set(ci, bd[0]);
      }
    }
    // Recalc all player building aggregates
    for (let pi = 0; pi < players.length; pi++) recalcPlayerBuildings(pi);
    console.log('[Load] Restored ' + players.length + ' players, ' + mapBuildings.size + ' buildings');
    return true;
  } catch (e) { console.error('[Load] Error:', e.message); return false; }
}

// ===== TICK =====
let lastRes = 0, lastTroop = 0, lastBot = 0, lastCamp = 0, lastLB = 0, lastST = 0, lastSave = 0, lastVis = 0, lastUnitBroadcast = 0, lastCannon = 0;
let lastFullST = 0;
let lastStorm = 0, lastRoundInfo = 0;
const VIS_INT = 600;
const CANNON_INT = 1000;
const ROUND_INFO_INT = 1000;
const FULL_ST_INT = 2000;

function tick() {
  try {
  const now = Date.now();
  // Lobby phase: just broadcast countdown, check if time to start
  if (roundPhase === 'lobby') {
    if (now - lastRoundInfo >= 1000) {
      lastRoundInfo = now;
      io.emit('lobbyState', getLobbyState());
    }
    const elapsed = now - lobbyStartTime;
    if (elapsed >= LOBBY_DURATION && lobbyQueue.size >= LOBBY_MIN_PLAYERS) {
      startGameFromLobby();
    }
    return;
  }
  if (roundPhase === 'ending' || roundPhase === 'waiting') return;
  checkBuildings();
  moveUnits();
  if (now - lastRes >= RES_INT) { lastRes = now; gatherResources(); }
  if (now - lastTroop >= TROOP_INT) { lastTroop = now; genTroops(); io.emit('tg'); }
  if (now - lastBot >= BOT_INT) { lastBot = now; botAI(); }
  if (now - lastCamp >= CAMP_INT) { lastCamp = now; spawnCamp(); updateCamps(); }
  if (now - lastVis >= VIS_INT) { lastVis = now; updateAllVisibility(); }
  if (now - lastCannon >= CANNON_INT) { lastCannon = now; coastalDefenseTick(); }
  // Round info broadcast
  if (now - lastRoundInfo >= ROUND_INFO_INT) { lastRoundInfo = now; io.emit('roundInfo', getRoundInfo()); }
  // Win conditions
  checkWinConditions();
  // Flush any remaining dirty chunks from non-action sources (bots, camps, etc.)
  if (dirtyChunks.size > 0) { flushDirtyToAll(); }
  if (now - lastLB >= LB_INT) { lastLB = now; io.emit('lb', leaderboard()); }
  if (now - lastST >= ST_INT) {
    lastST = now;
    for (const [sid, pi] of Object.entries(pidMap)) {
      sendQuickState(pi);
    }
  }
  if (now - lastFullST >= FULL_ST_INT) {
    lastFullST = now;
    for (const [sid, pi] of Object.entries(pidMap)) {
      const sock = io.sockets.sockets.get(sid); if (!sock) continue;
      const st = playerState(pi); if (st) sock.volatile.emit('st', st);
    }
  }
  if (now - lastUnitBroadcast >= UNIT_BROADCAST_INT) {
    lastUnitBroadcast = now;
    for (const [sid, pi] of Object.entries(pidMap)) {
      const sock = io.sockets.sockets.get(sid); if (!sock) continue;
      sock.volatile.emit('units', getUnitStates(pi));
    }
  }
  if (!IS_RAILWAY && now - lastSave >= SAVE_INT) { lastSave = now; saveGame(); }
  } catch (e) { console.error('[TickError]', e.stack || e); }
}

// ===== SOCKET HANDLERS =====
io.on('connection', (socket) => {
  socket.emit('mi', { w: W, h: H, cs: CHUNK, bldg: BLDG, tech: TECH, civs: CIVS, ranks: RANKS, stiles: STILES, defense: DEFENSE, unitTypes: UNIT_TYPES, bldgCodes: BLDG_CODES });
  const pc = {};
  for (let pi = 0; pi < players.length; pi++) { if (players[pi].alive) pc[pi] = players[pi].color; }
  socket.emit('pc', pc);
  socket.emit('tp', buildTerrainPreview());
  // Send current phase state
  if (roundPhase === 'lobby') {
    socket.emit('enterLobby', getLobbyState());
  } else {
    socket.emit('roundInfo', getRoundInfo());
  }

  // Lobby join
  socket.on('joinLobby', (d) => {
    if (roundPhase !== 'lobby') return;
    if (lobbyQueue.size >= MAX_HUMAN_PLAYERS) { socket.emit('msg', '로비가 가득 찼습니다!'); return; }
    if (lobbyQueue.has(socket.id)) { socket.emit('msg', '이미 참가했습니다!'); return; }
    const sess = socket.request.session;
    const discordId = (sess && sess.discordId) ? sess.discordId : null;
    const name = (d && d.name) ? String(d.name).substring(0, 20) : (sess && sess.discordName ? sess.discordName : 'Player');
    socket._playerName = name; // remember for auto-rejoin
    const civ = (d && d.civ && CIVS[d.civ]) ? d.civ : 'rome';
    const color = COLORS[lobbyQueue.size % COLORS.length];
    lobbyQueue.set(socket.id, { name, civ, discordId, color });
    io.emit('lobbyState', getLobbyState());
    console.log('[Lobby] ' + name + ' joined (' + lobbyQueue.size + '/' + MAX_HUMAN_PLAYERS + ')');
  });

  // Lobby leave  
  socket.on('leaveLobby', () => {
    if (lobbyQueue.has(socket.id)) {
      lobbyQueue.delete(socket.id);
      io.emit('lobbyState', getLobbyState());
    }
  });

  // Lobby civ change
  socket.on('lobbyCiv', (d) => {
    if (!d || !d.civ || !CIVS[d.civ]) return;
    const entry = lobbyQueue.get(socket.id);
    if (entry) { entry.civ = d.civ; io.emit('lobbyState', getLobbyState()); }
  });

  socket.on('join', (d) => {
    if (roundPhase === 'lobby') return; // must use joinLobby during lobby phase
    if (!d || !d.name) return;
    const sess = socket.request.session;
    const discordId = (sess && sess.discordId) ? sess.discordId : null;
    const name = String(d.name).substring(0, 20);
    const civ = d.civ && CIVS[d.civ] ? d.civ : 'rome';
    let existPi = -1;
    // Try to find existing player by discordId first
    if (discordId) {
      for (let pi = 0; pi < players.length; pi++) {
        if (players[pi].discordId === discordId && !players[pi].isBot) { existPi = pi; break; }
      }
    }
    // Fallback: find by name if offline
    if (existPi < 0) {
      for (let pi = 0; pi < players.length; pi++) {
        if (players[pi].name === name && !players[pi].isBot && players[pi].alive && players[pi].offline) { existPi = pi; break; }
      }
    }
    let pi;
    if (existPi >= 0) {
      pi = existPi;
      players[pi].offline = false;
      if (discordId) players[pi].discordId = discordId;
      // If player was dead, respawn them
      if (!players[pi].alive) {
        respawnPlayer(pi, civ);
      }
    } else {
      pi = spawnPlayer(name, civ, false);
      if (discordId) players[pi].discordId = discordId;
      const prefX = (d.sx >= 0 && d.sx < W) ? d.sx : undefined;
      const prefY = (d.sy >= 0 && d.sy < H) ? d.sy : undefined;
      const sp = findSpawn(prefX, prefY);
      placePlayerAt(pi, sp.x, sp.y);
    }
    pidMap[socket.id] = pi;
    // Compute visibility for new/returning player
    playerVisibleChunks[pi] = computeVisibility(pi);
    io.emit('pc', { [pi]: players[pi].color });
    socket.emit('joined', { pi, color: players[pi].color, sx: players[pi].capital.x, sy: players[pi].capital.y, civ: players[pi].civ });
    const st = playerState(pi); if (st) socket.emit('st', st);
  });

  // Ping measurement (simple echo for round-trip timing)
  socket.on('ping_check', (_, cb) => { if (typeof cb === 'function') cb(); });

  socket.on('vp', (d) => {
    if (!d) return;
    const pi = pidMap[socket.id];
    socket.vp = { x: d.x || 0, y: d.y || 0, w: d.w || 40, h: d.h || 40 };
    const chunks = [];
    const cx0 = Math.max(0, Math.floor(d.x / CHUNK));
    const cy0 = Math.max(0, Math.floor(d.y / CHUNK));
    const cx1 = Math.min(Math.ceil(W / CHUNK) - 1, Math.floor((d.x + d.w) / CHUNK));
    const cy1 = Math.min(Math.ceil(H / CHUNK) - 1, Math.floor((d.y + d.h) / CHUNK));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        chunks.push(pi !== undefined ? packChunkForPlayer(cx, cy, pi) : packChunk(cx, cy));
      }
    }
    if (chunks.length > 0) socket.emit('ch', chunks);
  });

  socket.on('exp', (d) => { if (!d) return; const pi = pidMap[socket.id]; if (pi !== undefined) { expandToward(pi, d.x, d.y); flushDirtyToAll(); sendQuickState(pi); } });
  socket.on('bpush', () => { const pi = pidMap[socket.id]; if (pi !== undefined) { borderPush(pi); flushDirtyToAll(); sendQuickState(pi); } });
  socket.on('matk', (d) => { if (!d) return; const pi = pidMap[socket.id]; if (pi !== undefined) { massiveAttack(pi, d.tx, d.ty); flushDirtyToAll(); sendQuickState(pi); } });

  // Building placement: place new building on territory (multi-cell grid system)
  socket.on('bld', (d) => {
    if (!d || !d.b || d.x === undefined || d.y === undefined) return;
    const pi = pidMap[socket.id]; if (pi === undefined) return;
    const p = players[pi]; if (!p || !p.alive) return;
    const key = d.b, def = BLDG[key]; if (!def) return;
    const size = def.size || 1;
    const tx = Math.floor(d.x), ty = Math.floor(d.y);
    if (!validCell(tx, ty)) return;
    const cellIdx = idx(tx, ty);
    if (owner[cellIdx] !== pi) { socket.emit('msg', '\ub0b4 \uc601\ud1a0\uc5d0\ub9cc \uac74\uc124 \uac00\ub2a5!'); return; }
    // If clicking on an existing building of same type → upgrade
    if (cellToAnchor.has(cellIdx)) {
      const anchorIdx = cellToAnchor.get(cellIdx);
      const existing = mapBuildings.get(anchorIdx);
      if (!existing) return;
      if (existing.owner !== pi) { socket.emit('msg', '\ub0b4 \uac74\ubb3c\ub9cc \uc5c5\uadf8\ub808\uc774\ub4dc \uac00\ub2a5!'); return; }
      if (existing.type !== key) { socket.emit('msg', '\ub2e4\ub978 \uac74\ubb3c\uc774 \uc874\uc7ac! \uac19\uc740 \uc885\ub958\ub9cc \uc5c5\uadf8\ub808\uc774\ub4dc \uac00\ub2a5!'); return; }
      if (existing.buildEnd > 0) { socket.emit('msg', '\uc774\ubbf8 \uac74\uc124\uc911!'); return; }
      const result = upgradeBuildingOnMap(pi, anchorIdx);
      if (result) {
        socket.emit('msg', def.icon + ' ' + def.n + ' Lv.' + result.level + '\u2192' + (result.level+1) + ' \uc5c5\uadf8\ub808\uc774\ub4dc \uc2dc\uc791!');
        flushDirtyToAll(); sendQuickState(pi);
      } else { socket.emit('msg', '\uc5c5\uadf8\ub808\uc774\ub4dc \ubd88\uac00! (\uc790\uc6d0/\ub808\ubca8 \ud655\uc778)'); }
      return;
    }
    // Check NxN area validity
    if (!canPlaceBuildingAt(pi, cellIdx, size)) {
      socket.emit('msg', size + '\u00d7' + size + ' \uc601\uc5ed\uc774 \ubaa8\ub450 \ub0b4 \uc601\ud1a0\uc5ec\uc57c \ud569\ub2c8\ub2e4!'); return;
    }
    // Place new building
    const current = countPlayerBuildings(pi), max = maxPlayerBuildings(pi);
    if (current >= max) { socket.emit('msg', '\uac74\ubb3c \ucd5c\ub300 \uc218 \ucd08\uacfc! (' + current + '/' + max + ') \uc601\ud1a0\ub97c \ub354 \ud655\uc7a5\ud558\uc138\uc694!'); return; }
    const result = placeBuildingOnMap(pi, cellIdx, key);
    if (result) {
      socket.emit('msg', def.icon + ' ' + def.n + ' (' + size + '\u00d7' + size + ') \uac74\uc124 \uc2dc\uc791!');
      flushDirtyToAll(); sendQuickState(pi);
    } else { socket.emit('msg', '\uac74\uc124 \ubd88\uac00! (\uc790\uc6d0/\uc870\uac74 \ud655\uc778)'); }
  });

  socket.on('res', (d) => {
    if (!d || !d.t) return;
    const pi = pidMap[socket.id]; if (pi === undefined) return;
    const p = players[pi]; if (!p || !p.alive) return;
    const key = d.t, def = TECH[key]; if (!def) return;
    const t = p.tech[key]; if (!t) return;
    if (t.e > 0) { socket.emit('msg', '\uC774\uBBF8 \uC5F0\uAD6C\uC911!'); return; }
    if (t.l >= def.max) { socket.emit('msg', '\uCD5C\uB300 \uB808\uBCA8!'); return; }
    const c = techCost(key, t.l);
    if (!canAfford(p, c)) { socket.emit('msg', '\uC790\uC6D0 \uBD80\uC871!'); return; }
    payCost(p, c); t.e = Date.now() + techTime(key, t.l, p);
    sendQuickState(pi);
  });

  socket.on('trade', (d) => { if (!d) return; const pi = pidMap[socket.id]; if (pi !== undefined) { tradeResources(pi, d.from, d.to, d.amount); sendQuickState(pi); } });
  socket.on('spy', (d) => { if (!d || d.target === undefined) return; const pi = pidMap[socket.id]; if (pi !== undefined) spyOnPlayer(pi, d.target); });

  // Unit deployment
  socket.on('deployUnit', (d) => {
    if (!d || !d.type || d.tx === undefined || d.ty === undefined) return;
    const pi = pidMap[socket.id]; if (pi === undefined) return;
    const p = players[pi]; if (!p || !p.alive) return;
    const ut = UNIT_TYPES[d.type]; if (!ut) { socket.emit('msg', '알 수 없는 유닛!'); return; }
    if (p.totalTroops < ut.troopCost + 5) { socket.emit('msg', '병력 부족! (' + ut.troopCost + ' 필요)'); return; }
    // Max units per player
    const myUnits = units.filter(u => u.alive && u.owner === pi);
    if (myUnits.length >= 5) { socket.emit('msg', '최대 유닛 수 초과! (5개)'); return; }
    const unit = createUnit(pi, d.type, Math.floor(d.tx), Math.floor(d.ty));
    if (unit) {
      socket.emit('unitDeployed', { id: unit.id, type: d.type, x: unit.x, y: unit.y, tx: unit.tx, ty: unit.ty });
      socket.emit('msg', ut.icon + ' ' + ut.n + ' 출발! (' + ut.troopCost + ' 병력)');
      sendQuickState(pi);
    }
  });

  socket.on('cancelUnit', (d) => {
    if (!d || !d.id) return;
    const pi = pidMap[socket.id]; if (pi === undefined) return;
    const u = units.find(u2 => u2.id === d.id && u2.owner === pi && u2.alive);
    if (u) {
      // Return partial troops
      const returned = Math.floor(u.strength * 0.3);
      players[pi].totalTroops = Math.min(maxTroops(players[pi]), players[pi].totalTroops + returned);
      u.alive = false;
      socket.emit('msg', '유닛 회수! 병력 +' + returned);
      sendQuickState(pi);
    }
  });

  socket.on('respawn', (d) => {
    const pi = pidMap[socket.id]; if (pi === undefined) return;
    const p = players[pi]; if (!p || p.alive) return;
    const civ = d && d.civ && CIVS[d.civ] ? d.civ : p.civ;
    const prefX = (d && d.sx >= 0 && d.sx < W) ? d.sx : undefined;
    const prefY = (d && d.sy >= 0 && d.sy < H) ? d.sy : undefined;
    respawnPlayer(pi, civ, prefX, prefY);
    io.emit('pc', { [pi]: p.color });
    socket.emit('joined', { pi, color: p.color, sx: p.capital.x, sy: p.capital.y, civ: p.civ });
    const st = playerState(pi); if (st) socket.emit('st', st);
  });

  socket.on('disconnect', () => {
    const pi = pidMap[socket.id];
    if (pi !== undefined) { const p = players[pi]; if (p && !p.isBot) p.offline = true; delete pidMap[socket.id]; }
    // Remove from lobby queue if in lobby
    if (lobbyQueue.has(socket.id)) {
      lobbyQueue.delete(socket.id);
      if (roundPhase === 'lobby') io.emit('lobbyState', getLobbyState());
    }
  });
});

// ===== STARTUP =====
console.log('[Territory.io v5 — Lobby Mode] Starting...');
owner = new Int16Array(W * H).fill(-1);
troops = new Uint16Array(W * H);
// Generate initial map for first lobby
terrain = generateEarthMap(W, H);
specialTiles = new Uint8Array(W * H);
generateSpecialTiles();
totalPlayableCells = countPlayableCells();
buildTerrainChunkCache();
// Enter lobby instead of starting directly
roundNumber = 1;
roundPhase = 'lobby';
lobbyStartTime = Date.now();
lobbyMapName = MAP_NAMES[Math.floor(Math.random() * MAP_NAMES.length)];
console.log('[Lobby] First lobby — Map: ' + lobbyMapName + ', ' + totalPlayableCells + ' playable cells');

process.on('uncaughtException', (err) => {
  console.error('[CRASH]', err.stack || err);
  if (err.code === 'EADDRINUSE') {
    console.error('[Server] Port in use. Exiting.');
    process.exit(1);
  }
});
process.on('unhandledRejection', (err) => { console.error('[REJECT]', err); });

setInterval(tick, TICK);
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('[Server] Listening on http://0.0.0.0:' + PORT));
