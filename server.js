// ===== Territory.io v4 — Persistent Strategy Server =====
// Rise of Kingdoms + OpenFront inspired: Resources, Buildings, Tech, Barbarians, Persistence
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { generateEarthMap } = require('./worldmap');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
app.use(express.static(path.join(__dirname, 'public')));

// ===== CONFIG =====
const W = 800, H = 400, CELLS = W * H;
const CHUNK = 40;
const CX = W / CHUNK, CY = H / CHUNK;
const TICK = 200;            // ms per game tick
const RES_INTERVAL = 60000;  // resource gather every 60s
const TROOP_INTERVAL = 20000;// troop gen every 20s (slow for longevity)
const BOT_INTERVAL = 4000;
const LB_INTERVAL = 3000;
const STATE_INTERVAL = 5000; // send player state every 5s
const SAVE_INTERVAL = 120000;// auto-save every 2 min
const BARB_SPAWN_INTERVAL = 45000;
const AP_REGEN_INTERVAL = 20000;
const BOT_N = 10;
const MAX_BARBS = 20;
const MAX_TROOP_BASE = 30;
const DEFENSE = [0, 1.0, 1.3, 0.9, 99, 1.1, 99, 0, 1.5, 0.8]; // per terrain (8=hills def+50%, 9=swamp def-20%)
const SAVE_FILE = path.join(__dirname, 'gamestate.json');

// ===== BUILDING DEFINITIONS =====
const BLDG = {
  hq:   { n:'본부',   base:{w:100,s:80,g:20},  bt:60,  desc:'최대 건물 레벨, 병력 한도 증가' },
  bar:  { n:'병영',   base:{w:80,s:40,f:60},   bt:50,  desc:'병력 생성 속도 증가' },
  farm: { n:'농장',   base:{w:60,s:20},         bt:40,  desc:'식량 생산 +12%/Lv' },
  lum:  { n:'벌목장', base:{w:40,s:30},         bt:40,  desc:'목재 생산 +12%/Lv' },
  qry:  { n:'채석장', base:{w:50,s:40},         bt:40,  desc:'석재 생산 +12%/Lv' },
  wall: { n:'성벽',   base:{s:120,w:40},        bt:70,  desc:'수도 방어력 +15%/Lv' },
  acad: { n:'학술원', base:{w:100,s:80,g:60},   bt:80,  desc:'연구 속도 증가' },
};
const BLDG_MAX = 25;

// ===== TECH DEFINITIONS =====
const TECH = {
  atk:  { n:'공격력',   base:{g:80},        bt:90,  desc:'전투 공격력 +8%/Lv', max:20 },
  def:  { n:'방어력',   base:{g:80},        bt:90,  desc:'전투 방어력 +8%/Lv', max:20 },
  spd:  { n:'행군속도', base:{g:60,f:40},   bt:70,  desc:'AP 재생 +5%/Lv', max:20 },
  gth:  { n:'채집효율', base:{g:50,w:30},   bt:70,  desc:'자원 수집 +5%/Lv', max:20 },
};

// ===== MAP DATA =====
let terrain;
const owner = new Int16Array(CELLS);  // -1=none, -2=barbarian, >=0 player
const troops = new Uint16Array(CELLS);
owner.fill(-1);

// ===== PLAYER DATA =====
let players = [];       // [{id,name,color,alive,isBot,clanId,offline, capital, resources, buildings, tech, ap, maxAp, protection, spawnTime}]
let pidMap = {};        // socketId/botId -> player index
let playerCells = [];   // [Set<flatIndex>] per player
let nextColor = 0;

const COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e84393',
  '#00cec9','#6c5ce7','#fd79a8','#00b894','#fdcb6e','#74b9ff','#a29bfe','#ff7675',
  '#55efc4','#fab1a0','#81ecec','#d63031','#0984e3','#e17055','#636e72','#ffeaa7',
  '#ff6b6b','#48dbfb','#ff9ff3','#10ac84','#ee5a24','#0abde3'
];

// ===== CLAN DATA =====
let clans = [];
// ===== BARBARIANS =====
let barbs = []; // {x, y, troops, level, spawnTime}
// ===== DIRTY CHUNKS =====
const dirtyChunks = new Set();

function markDirty(x, y) { dirtyChunks.add(`${Math.floor(x/CHUNK)},${Math.floor(y/CHUNK)}`); }
function idx(x, y) { return y * W + x; }
function validCell(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
function isPlayable(t) { return t === 1 || t === 2 || t === 3 || t === 5 || t === 8 || t === 9; }

// ===== CELL HELPERS =====
function claimCell(pi, x, y) {
  const i = idx(x, y);
  const prev = owner[i];
  if (prev >= 0 && playerCells[prev]) playerCells[prev].delete(i);
  owner[i] = pi;
  troops[i] = 0;
  if (pi >= 0) {
    if (!playerCells[pi]) playerCells[pi] = new Set();
    playerCells[pi].add(i);
  }
  markDirty(x, y);
}
function releaseCell(x, y) {
  const i = idx(x, y);
  const prev = owner[i];
  if (prev >= 0 && playerCells[prev]) playerCells[prev].delete(i);
  owner[i] = -1; troops[i] = 0;
  markDirty(x, y);
}

// ===== BUILDING/TECH COST HELPERS =====
function bldgCost(key, level) {
  const def = BLDG[key];
  const costs = {};
  for (const [r, v] of Object.entries(def.base)) costs[r] = Math.ceil(v * Math.pow(1.3, level));
  return costs;
}
function bldgTime(key, level, p) {
  const base = BLDG[key].bt;
  const acadBonus = p.buildings.acad ? (1 - p.buildings.acad.l * 0.04) : 1;
  return Math.ceil(base * Math.pow(level + 1, 2) * Math.max(0.3, acadBonus));
}
function techCost(key, level) {
  const def = TECH[key];
  const costs = {};
  for (const [r, v] of Object.entries(def.base)) costs[r] = Math.ceil(v * Math.pow(1.25, level));
  return costs;
}
function techTime(key, level, p) {
  const base = TECH[key].bt;
  const acadBonus = p.buildings.acad ? (1 - p.buildings.acad.l * 0.04) : 1;
  return Math.ceil(base * Math.pow(level + 1, 2) * Math.max(0.3, acadBonus));
}
function canAfford(p, costs) {
  const m = { f:'food', w:'wood', s:'stone', g:'gold' };
  for (const [k, v] of Object.entries(costs)) { if ((p.resources[m[k]] || 0) < v) return false; }
  return true;
}
function payCost(p, costs) {
  const m = { f:'food', w:'wood', s:'stone', g:'gold' };
  for (const [k, v] of Object.entries(costs)) p.resources[m[k]] -= v;
}
function maxTroops(pi) {
  if (pi < 0 || !players[pi]) return 50;
  const cells = playerCells[pi]?.size || 1;
  return 50 + (players[pi].buildings.hq?.l || 0) * 20 + cells * 2;
}
function attackPower(pi) { return 1 + (players[pi]?.tech?.atk?.l || 0) * 0.08; }
function defensePower(pi) { return 1 + (players[pi]?.tech?.def?.l || 0) * 0.08; }
function isProtected(pi) {
  return players[pi] && players[pi].protection > Date.now();
}

// ===== TERRAIN RESOURCE YIELD =====
function terrainResources(t) {
  if (t === 1) return { food: 2, wood: 0, stone: 0, gold: 0 };  // plains
  if (t === 2) return { food: 1, wood: 2, stone: 0, gold: 0 };  // forest
  if (t === 3) return { food: 0, wood: 0, stone: 0, gold: 1 };  // desert (gold)
  if (t === 5) return { food: 0, wood: 1, stone: 1, gold: 0 };  // tundra
  if (t === 8) return { food: 0, wood: 0, stone: 2, gold: 1 };  // hills (stone+gold)
  if (t === 9) return { food: 3, wood: 1, stone: 0, gold: 0 };  // swamp (high food)
  return { food: 0, wood: 0, stone: 0, gold: 0 };
}

// ===== PLAYER CREATION =====
function initBuildings() {
  const b = {};
  for (const k of Object.keys(BLDG)) b[k] = { l: 0, e: 0 };
  b.hq.l = 1; // Start with HQ level 1
  return b;
}
function initTech() {
  const t = {};
  for (const k of Object.keys(TECH)) t[k] = { l: 0, e: 0 };
  return t;
}
function initResources() { return { food: 500, wood: 500, stone: 200, gold: 100 }; }

// ===== SPAWN =====
function findSpawn() {
  for (let attempt = 0; attempt < 800; attempt++) {
    const x = 10 + Math.floor(Math.random() * (W - 20));
    const y = 10 + Math.floor(Math.random() * (H - 20));
    if (!isPlayable(terrain[idx(x, y)])) continue;
    if (owner[idx(x, y)] >= 0) continue;
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++)
      for (let dx = -1; dx <= 1 && ok; dx++) {
        const nx = x+dx, ny = y+dy;
        if (!validCell(nx,ny) || !isPlayable(terrain[idx(nx,ny)]) || owner[idx(nx,ny)] >= 0) ok = false;
      }
    if (ok) return { x, y };
  }
  for (let y = 10; y < H-10; y++)
    for (let x = 10; x < W-10; x++)
      if (isPlayable(terrain[idx(x,y)]) && owner[idx(x,y)] < 0) return {x,y};
  return { x: W/2|0, y: H/2|0 };
}

function spawnPlayer(id, name, isBot = false) {
  const pi = players.length;
  const color = COLORS[nextColor++ % COLORS.length];
  const now = Date.now();
  players.push({
    id, name, color, alive: true, isBot, clanId: -1, offline: false,
    capital: null,
    resources: initResources(),
    buildings: initBuildings(),
    tech: initTech(),
    ap: 50, maxAp: 55,
    totalTroops: 50,
    protection: isBot ? 0 : now + 8 * 3600 * 1000,
    spawnTime: now,
  });
  pidMap[id] = pi;
  playerCells[pi] = new Set();
  const pos = findSpawn();
  players[pi].capital = { x: pos.x, y: pos.y };
  claimCell(pi, pos.x, pos.y);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = pos.x+dx, ny = pos.y+dy;
      if (validCell(nx,ny) && isPlayable(terrain[idx(nx,ny)]) && owner[idx(nx,ny)] < 0)
        claimCell(pi, nx, ny);
    }
  return pos;
}

function respawnPlayer(pi) {
  if (playerCells[pi]) {
    for (const i of playerCells[pi]) {
      owner[i] = -1; troops[i] = 0;
      markDirty(i % W, (i / W)|0);
    }
    playerCells[pi].clear();
  }
  players[pi].alive = true;
  players[pi].resources = initResources();
  players[pi].buildings = initBuildings();
  players[pi].tech = initTech();
  players[pi].ap = 50;
  players[pi].totalTroops = 50;
  players[pi].protection = Date.now() + 8 * 3600 * 1000;
  const pos = findSpawn();
  players[pi].capital = { x: pos.x, y: pos.y };
  claimCell(pi, pos.x, pos.y);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = pos.x+dx, ny = pos.y+dy;
      if (validCell(nx,ny) && isPlayable(terrain[idx(nx,ny)]) && owner[idx(nx,ny)] < 0)
        claimCell(pi, nx, ny);
    }
  return pos;
}

function removePlayer(pi) {
  if (playerCells[pi]) {
    for (const i of playerCells[pi]) {
      owner[i] = -1; troops[i] = 0;
      markDirty(i % W, (i / W)|0);
    }
    playerCells[pi].clear();
  }
  players[pi].alive = false;
  if (players[pi].clanId >= 0 && clans[players[pi].clanId]) {
    clans[players[pi].clanId].members.delete(pi);
    if (clans[players[pi].clanId].members.size === 0) clans[players[pi].clanId] = null;
  }
}

// ===== RESOURCE GATHERING =====
function gatherResources() {
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi];
    if (!p?.alive || !playerCells[pi]) continue;
    const farmB = 1 + (p.buildings.farm?.l || 0) * 0.12;
    const lumB = 1 + (p.buildings.lum?.l || 0) * 0.12;
    const qryB = 1 + (p.buildings.qry?.l || 0) * 0.12;
    const mktB = 1; // no market building anymore, use tech
    const gthB = 1 + (p.tech.gth?.l || 0) * 0.05;
    const offlinePenalty = p.offline ? 0.3 : 1;
    for (const i of playerCells[pi]) {
      const tr = terrainResources(terrain[i]);
      p.resources.food  += tr.food  * farmB * gthB * offlinePenalty;
      p.resources.wood  += tr.wood  * lumB  * gthB * offlinePenalty;
      p.resources.stone += tr.stone * qryB  * gthB * offlinePenalty;
      p.resources.gold  += tr.gold  * mktB  * gthB * offlinePenalty;
    }
    // Cap resources
    const cap = 5000 + (p.buildings.hq?.l || 0) * 2000;
    p.resources.food = Math.min(p.resources.food, cap);
    p.resources.wood = Math.min(p.resources.wood, cap);
    p.resources.stone = Math.min(p.resources.stone, cap);
    p.resources.gold = Math.min(p.resources.gold, cap);
  }
}

// ===== TROOP GENERATION =====
function genTroops() {
  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi];
    if (!p?.alive || !playerCells[pi]) continue;
    const barBonus = 1 + (p.buildings.bar?.l || 0) * 0.1;
    const offlinePenalty = p.offline ? 0.5 : 1;
    const foodCost = playerCells[pi].size * 0.1;
    if (p.resources.food < foodCost) continue;
    p.resources.food -= foodCost;
    const gen = Math.max(1, Math.floor(playerCells[pi].size * 0.5 * barBonus * offlinePenalty));
    const mt = maxTroops(pi);
    p.totalTroops = Math.min((p.totalTroops || 0) + gen, mt);
  }
}

// ===== BUILDING SYSTEM =====
function checkBuildings() {
  const now = Date.now();
  for (const p of players) {
    if (!p?.alive) continue;
    for (const [k, b] of Object.entries(p.buildings)) {
      if (b.e > 0 && now >= b.e) {
        b.l++;
        b.e = 0;
        // Recalc derived stats
        if (k === 'hq') p.maxAp = 50 + b.l * 5;
      }
    }
    for (const [k, t] of Object.entries(p.tech)) {
      if (t.e > 0 && now >= t.e) {
        t.l++;
        t.e = 0;
      }
    }
  }
}

// ===== COMBAT =====
function areAllies(pi1, pi2) {
  if (pi1 === pi2) return true;
  const c1 = players[pi1]?.clanId, c2 = players[pi2]?.clanId;
  return c1 >= 0 && c1 === c2;
}

function terrainExpandCost(t) {
  if (t === 1) return 2;  // plains
  if (t === 2) return 3;  // forest
  if (t === 3) return 3;  // desert
  if (t === 5) return 4;  // tundra
  if (t === 8) return 4;  // hills (hard to take but defensible)
  if (t === 9) return 3;  // swamp
  return 2;
}

function isAdjacentTo(pi, x, y) {
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (validCell(nx, ny) && owner[idx(nx, ny)] === pi) return true;
    }
  return false;
}

function expandCell(pi, tx, ty) {
  if (!validCell(tx, ty)) return { ok: false };
  const ti = idx(tx, ty);
  if (!isPlayable(terrain[ti])) return { ok: false };
  if (owner[ti] === pi) return { ok: false };
  if (!isAdjacentTo(pi, tx, ty)) return { ok: false, msg: '인접한 영토가 없습니다' };
  const p = players[pi];

  // Unclaimed land
  if (owner[ti] === -1) {
    const cost = terrainExpandCost(terrain[ti]);
    if ((p.totalTroops || 0) < cost) return { ok: false, msg: '병력 부족' };
    p.totalTroops -= cost;
    claimCell(pi, tx, ty);
    return { ok: true };
  }

  // Barbarian
  if (owner[ti] === -2) {
    const barbTr = troops[ti];
    const atkCost = Math.ceil(barbTr * 1.5 / attackPower(pi));
    if ((p.totalTroops || 0) < atkCost) return { ok: false, msg: '병력 부족' };
    p.totalTroops -= Math.ceil(atkCost * 0.7);
    const bIdx = barbs.findIndex(b => b.x === tx && b.y === ty);
    if (bIdx >= 0) {
      const bLevel = barbs[bIdx].level;
      const reward = { food: 50+bLevel*40, wood: 50+bLevel*40, stone: 20+bLevel*15, gold: 10+bLevel*10 };
      p.resources.food += reward.food; p.resources.wood += reward.wood;
      p.resources.stone += reward.stone; p.resources.gold += reward.gold;
      barbs.splice(bIdx, 1);
      const sock = findSocket(pi);
      if (sock) sock.emit('reward', reward);
    }
    claimCell(pi, tx, ty);
    return { ok: true };
  }

  // Enemy player
  const to = owner[ti];
  if (areAllies(pi, to)) return { ok: false, msg: '동맹 영토' };
  if (isProtected(to)) return { ok: false, msg: '보호막 활성화' };
  if (isProtected(pi)) p.protection = 0;

  const enemy = players[to];
  if (!enemy) return { ok: false };
  const enemyCells = Math.max(1, playerCells[to]?.size || 1);
  const enemyPerCell = (enemy.totalTroops || 0) / enemyCells * defensePower(to) * DEFENSE[terrain[ti]];
  const wallBonus = (enemy.capital && tx === enemy.capital.x && ty === enemy.capital.y)
    ? 1 + (enemy.buildings.wall?.l || 0) * 0.15 : 1;
  const defCost = Math.ceil(Math.max(3, enemyPerCell * wallBonus * 2.5));

  if ((p.totalTroops || 0) < defCost) return { ok: false, msg: '병력 부족' };
  p.totalTroops -= defCost;
  enemy.totalTroops = Math.max(0, (enemy.totalTroops || 0) - Math.ceil(defCost * 0.4));
  claimCell(pi, tx, ty);
  checkDeath(to);
  return { ok: true };
}

function borderPush(pi) {
  const p = players[pi];
  if (!p?.alive || !playerCells[pi]) return 0;
  const targets = new Set();
  for (const i of playerCells[pi]) {
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (!validCell(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (owner[ni] === -1 && isPlayable(terrain[ni])) targets.add(ni);
      }
  }
  if (targets.size === 0) return 0;
  const totalCost = targets.size * 2;
  const apCost = Math.max(3, Math.ceil(targets.size * 0.3));
  if ((p.totalTroops || 0) < totalCost || p.ap < apCost) return 0;
  p.totalTroops -= totalCost;
  p.ap -= apCost;
  let claimed = 0;
  for (const ni of targets) {
    claimCell(pi, ni % W, (ni / W) | 0);
    claimed++;
  }
  return claimed;
}

function massiveAttack(pi, targetX, targetY) {
  const p = players[pi];
  if (!p?.alive || !playerCells[pi]) return 0;
  if ((p.totalTroops || 0) < 30 || p.ap < 10) return 0;
  const investTroops = Math.floor(p.totalTroops * 0.25);
  p.totalTroops -= investTroops;
  p.ap -= 10;
  let remaining = investTroops;
  let claimed = 0;
  const maxCells = Math.min(30, Math.floor(investTroops / 2));
  const visited = new Set();
  const queue = [];
  // Find border cells closest to target
  const borders = [];
  for (const i of playerCells[pi]) {
    const x = i % W, y = (i / W) | 0;
    let isBorder = false;
    for (let dy = -1; dy <= 1 && !isBorder; dy++)
      for (let dx = -1; dx <= 1 && !isBorder; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (validCell(nx, ny) && owner[idx(nx, ny)] !== pi) isBorder = true;
      }
    if (isBorder) borders.push({ x, y, dist: Math.hypot(x - targetX, y - targetY) });
  }
  borders.sort((a, b) => a.dist - b.dist);
  for (const b of borders.slice(0, 5)) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = b.x + dx, ny = b.y + dy;
        if (!validCell(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (owner[ni] !== pi && isPlayable(terrain[ni]) && !visited.has(ni)) {
          visited.add(ni);
          queue.push({ x: nx, y: ny, dist: Math.hypot(nx - targetX, ny - targetY) });
        }
      }
  }
  queue.sort((a, b) => a.dist - b.dist);
  while (queue.length > 0 && claimed < maxCells && remaining > 0) {
    const { x, y } = queue.shift();
    const ti = idx(x, y);
    if (owner[ti] === pi) continue;
    if (!isPlayable(terrain[ti])) continue;
    if (!isAdjacentTo(pi, x, y)) continue;
    let cost = 3;
    const to = owner[ti];
    if (to >= 0) {
      const enemy = players[to];
      if (!enemy || isProtected(to) || areAllies(pi, to)) continue;
      const eCells = Math.max(1, playerCells[to]?.size || 1);
      cost = Math.ceil(3 + (enemy.totalTroops || 0) / eCells * defensePower(to));
      if (remaining < cost) continue;
      enemy.totalTroops = Math.max(0, (enemy.totalTroops || 0) - Math.ceil(cost * 0.3));
      checkDeath(to);
    } else if (to === -2) {
      cost = Math.ceil(troops[ti] * 1.2);
      if (remaining < cost) continue;
      const bIdx = barbs.findIndex(b => b.x === x && b.y === y);
      if (bIdx >= 0) barbs.splice(bIdx, 1);
    }
    remaining -= cost;
    claimCell(pi, x, y);
    claimed++;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx2 = x + dx, ny2 = y + dy;
        if (!validCell(nx2, ny2)) continue;
        const ni2 = idx(nx2, ny2);
        if (owner[ni2] !== pi && !visited.has(ni2) && isPlayable(terrain[ni2])) {
          visited.add(ni2);
          queue.push({ x: nx2, y: ny2, dist: Math.hypot(nx2 - targetX, ny2 - targetY) });
          queue.sort((a, b) => a.dist - b.dist);
        }
      }
  }
  return claimed;
}

function checkDeath(pi) {
  if (pi < 0 || !players[pi]) return;
  if (!playerCells[pi] || playerCells[pi].size === 0) {
    players[pi].alive = false;
    if (players[pi].isBot) {
      setTimeout(() => {
        if (players[pi]) respawnPlayer(pi);
      }, 10000);
    } else {
      const sock = findSocket(pi);
      if (sock) sock.emit('died');
    }
  }
}

function findSocket(pi) {
  if (!players[pi] || players[pi].isBot) return null;
  for (const [, s] of io.sockets.sockets) {
    if (pidMap[s.id] === pi) return s;
  }
  return null;
}

// ===== CLAN =====
function createClan(pi, name, tag) {
  const ci = clans.length;
  clans.push({ name: name.slice(0,20), tag: tag.slice(0,5).toUpperCase(),
    color: players[pi].color, leaderId: pi, members: new Set([pi]) });
  players[pi].clanId = ci;
  return ci;
}
function joinClan(pi, ci) {
  if (ci < 0 || ci >= clans.length || !clans[ci]) return false;
  if (players[pi].clanId >= 0) leaveClan(pi);
  clans[ci].members.add(pi);
  players[pi].clanId = ci;
  players[pi].color = clans[ci].color;
  return true;
}
function leaveClan(pi) {
  const ci = players[pi].clanId;
  if (ci < 0 || !clans[ci]) return;
  clans[ci].members.delete(pi);
  if (clans[ci].members.size === 0) clans[ci] = null;
  else if (clans[ci].leaderId === pi) clans[ci].leaderId = [...clans[ci].members][0];
  players[pi].clanId = -1;
}
function clanList() {
  return clans.filter(c => c).map((c,i) => ({
    id: i, name: c.name, tag: c.tag, color: c.color,
    members: c.members.size, leader: players[c.leaderId]?.name || '?'
  }));
}

// ===== BARBARIANS =====
function spawnBarb() {
  if (barbs.length >= MAX_BARBS) return;
  for (let i = 0; i < 300; i++) {
    const x = Math.floor(Math.random() * W);
    const y = Math.floor(Math.random() * H);
    const ii = idx(x, y);
    if (isPlayable(terrain[ii]) && owner[ii] < 0) {
      const level = 1;
      const tr = 10 + level * 8;
      barbs.push({ x, y, troops: tr, level, spawnTime: Date.now() });
      owner[ii] = -2;
      troops[ii] = tr;
      markDirty(x, y);
      return;
    }
  }
}
function updateBarbs() {
  const now = Date.now();
  // Level up existing barbs
  for (const b of barbs) {
    if (b.level < 5 && now - b.spawnTime > 300000 * b.level) {
      b.level++;
      b.troops = 10 + b.level * 8;
      const i = idx(b.x, b.y);
      if (owner[i] === -2) { troops[i] = b.troops; markDirty(b.x, b.y); }
    }
  }
  // Remove barbs whose cells were taken
  barbs = barbs.filter(b => owner[idx(b.x, b.y)] === -2);
}

// ===== AP REGEN =====
function regenAP() {
  for (const p of players) {
    if (!p?.alive) continue;
    const spdBonus = 1 + (p.tech.spd?.l || 0) * 0.05;
    p.ap = Math.min(p.ap + Math.ceil(spdBonus), p.maxAp);
  }
}

// ===== BOT AI =====
const BOT_NAMES = [
  'Roman Empire','Mongol Horde','British Empire','Ottoman Empire',
  'Ming Dynasty','Viking Raiders','Persian Empire','Zulu Nation',
  'Aztec Empire','Greek Alliance'
];

function spawnBots() {
  for (let i = 0; i < BOT_N; i++) {
    spawnPlayer(`bot_${i}`, BOT_NAMES[i % BOT_NAMES.length], true);
  }
  // Pair bots into clans
  for (let i = 0; i < BOT_N - 1; i += 3) {
    const ci = createClan(i, BOT_NAMES[i].split(' ')[0]+' Alliance', BOT_NAMES[i].slice(0,3).toUpperCase());
    if (i+1 < BOT_N) joinClan(i+1, ci);
  }
}

function botAI(pi) {
  const p = players[pi];
  if (!p?.alive || !playerCells[pi] || playerCells[pi].size === 0) return;

  // Bot auto-upgrade buildings
  const now = Date.now();
  const upgrading = Object.values(p.buildings).some(b => b.e > 0);
  if (!upgrading) {
    for (const k of ['hq','bar','farm','lum','qry','wall','acad']) {
      const b = p.buildings[k];
      if (b.l >= BLDG_MAX) continue;
      if (k !== 'hq' && b.l >= p.buildings.hq.l) continue;
      const cost = bldgCost(k, b.l);
      if (canAfford(p, cost)) {
        payCost(p, cost);
        b.e = now + bldgTime(k, b.l, p) * 1000;
        break;
      }
    }
  }
  // Bot auto-research
  const researching = Object.values(p.tech).some(t => t.e > 0);
  if (!researching) {
    for (const k of ['atk','def','gth','spd']) {
      const t = p.tech[k];
      if (t.l >= TECH[k].max) continue;
      const cost = techCost(k, t.l);
      if (canAfford(p, cost)) {
        payCost(p, cost);
        t.e = now + techTime(k, t.l, p) * 1000;
        break;
      }
    }
  }

  // Bot expand/attack AI
  if (p.ap < 2 || (p.totalTroops || 0) < 5) return;

  // Try border push if enough troops
  if ((p.totalTroops || 0) > 30 && p.ap > 10 && Math.random() < 0.3) {
    borderPush(pi);
    return;
  }

  // Find expandable cells
  const targets = [];
  let count = 0;
  for (const i of playerCells[pi]) {
    if (count > 60) break;
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (!validCell(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (!isPlayable(terrain[ni])) continue;
        if (owner[ni] !== pi && !areAllies(pi, owner[ni])) {
          const priority = owner[ni] === -1 ? 10 : (owner[ni] === -2 ? 5 : 1);
          targets.push({ x: nx, y: ny, priority });
          count++;
        }
      }
  }
  if (targets.length === 0) return;
  targets.sort((a, b) => b.priority - a.priority);
  const n = Math.min(5, targets.length);
  for (let i = 0; i < n && p.ap >= 1; i++) {
    const t = targets[i];
    p.ap--;
    expandCell(pi, t.x, t.y);
  }
}

// ===== CHUNK PACKING =====
function packChunk(cx, cy) {
  const sx = cx*CHUNK, sy = cy*CHUNK, n = CHUNK*CHUNK;
  const t = new Uint8Array(n), o = new Int16Array(n), tr = new Uint16Array(n);
  for (let ly = 0; ly < CHUNK; ly++)
    for (let lx = 0; lx < CHUNK; lx++) {
      const gi = idx(sx+lx, sy+ly), li = ly*CHUNK+lx;
      t[li] = terrain[gi]; o[li] = owner[gi]; tr[li] = troops[gi];
    }
  return { cx, cy, t: Array.from(t), o: Array.from(o), tr: Array.from(tr) };
}

// ===== LEADERBOARD =====
function leaderboard() {
  const pLB = [];
  for (let i = 0; i < players.length; i++) {
    if (!players[i]?.alive) continue;
    const cells = playerCells[i]?.size || 0;
    if (cells === 0) continue;
    let tr = Math.floor(players[i].totalTroops || 0);
    const ct = players[i].clanId >= 0 && clans[players[i].clanId] ? `[${clans[players[i].clanId].tag}]` : '';
    pLB.push({ i, name: players[i].name, color: players[i].color, cells, troops: tr, ct });
  }
  pLB.sort((a,b) => b.cells - a.cells);
  const cLB = [];
  for (let i = 0; i < clans.length; i++) {
    if (!clans[i]) continue;
    let cells = 0;
    for (const m of clans[i].members) cells += playerCells[m]?.size || 0;
    cLB.push({ name: clans[i].name, tag: clans[i].tag, color: clans[i].color, cells, members: clans[i].members.size });
  }
  cLB.sort((a,b) => b.cells - a.cells);
  return { p: pLB.slice(0,15), c: cLB.slice(0,10) };
}

// ===== PLAYER STATE (resources, buildings, tech, AP) =====
function playerState(pi) {
  const p = players[pi];
  if (!p) return null;
  return {
    r: { f: Math.floor(p.resources.food), w: Math.floor(p.resources.wood),
         s: Math.floor(p.resources.stone), g: Math.floor(p.resources.gold) },
    b: Object.fromEntries(Object.entries(p.buildings).map(([k,v]) => [k, {l:v.l, e:v.e}])),
    t: Object.fromEntries(Object.entries(p.tech).map(([k,v]) => [k, {l:v.l, e:v.e}])),
    ap: Math.floor(p.ap), ma: p.maxAp,
    tt: Math.floor(p.totalTroops || 0),
    mt: maxTroops(pi),
    pr: p.protection,
    cap: p.capital,
  };
}

// ===== SAVE / LOAD =====
function saveGame() {
  try {
    const ownedCells = [];
    for (let i = 0; i < CELLS; i++) {
      if (owner[i] !== -1) ownedCells.push([i, owner[i], troops[i]]);
    }
    const state = {
      timestamp: Date.now(),
      players: players.map(p => p ? {
        ...p,
        // Convert Sets aren't serializable
      } : null),
      clans: clans.map(c => c ? { ...c, members: [...c.members] } : null),
      ownedCells,
      barbs,
      nextColor,
    };
    // Remove circular refs
    state.players.forEach(p => { if (p) delete p.id; }); // Don't save socket ids
    fs.writeFileSync(SAVE_FILE, JSON.stringify(state));
    console.log(`[SAVE] Saved ${ownedCells.length} cells, ${players.filter(p=>p?.alive).length} alive players`);
  } catch (e) { console.error('Save error:', e.message); }
}

function loadGame() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return false;
    const state = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    console.log(`[LOAD] Loading save from ${new Date(state.timestamp).toLocaleString()}`);

    // Restore players (without socket connections)
    players = state.players.map((p, i) => {
      if (!p) return null;
      return {
        ...p,
        id: p.isBot ? `bot_${i}` : `offline_${i}`,
        offline: !p.isBot,
        alive: p.alive,
      };
    });

    // Restore clans
    clans = state.clans.map(c => c ? { ...c, members: new Set(c.members) } : null);

    // Setup pidMap and playerCells
    pidMap = {};
    playerCells = players.map(() => new Set());
    players.forEach((p, i) => { if (p) pidMap[p.id] = i; });

    // Restore cells
    owner.fill(-1);
    troops.fill(0);
    for (const [i, o, t] of state.ownedCells) {
      owner[i] = o;
      troops[i] = t;
      if (o >= 0 && playerCells[o]) playerCells[o].add(i);
    }

    // Restore barbs
    barbs = state.barbs || [];
    nextColor = state.nextColor || players.length;

    // Complete any buildings/tech that should have finished
    const now = Date.now();
    const elapsed = now - state.timestamp;
    for (const p of players) {
      if (!p) continue;
      for (const b of Object.values(p.buildings)) {
        if (b.e > 0 && now >= b.e) { b.l++; b.e = 0; }
      }
      for (const t of Object.values(p.tech)) {
        if (t.e > 0 && now >= t.e) { t.l++; t.e = 0; }
      }
      // Generate resources for offline time
      if (p.alive && !p.isBot) {
        const cycles = Math.min(Math.floor(elapsed / RES_INTERVAL), 60); // max 1 hour of offline resources
        const cells = playerCells[players.indexOf(p)];
        if (cells) {
          for (let c = 0; c < cycles; c++) {
            for (const ci of cells) {
              const tr = terrainResources(terrain[ci]);
              p.resources.food += tr.food * 0.3;
              p.resources.wood += tr.wood * 0.3;
              p.resources.stone += tr.stone * 0.3;
              p.resources.gold += tr.gold * 0.3;
            }
          }
        }
      }
    }

    console.log(`[LOAD] Restored ${players.filter(p=>p?.alive).length} players, ${state.ownedCells.length} cells`);
    return true;
  } catch (e) {
    console.error('Load error:', e.message);
    return false;
  }
}

// ===== GAME LOOP =====
let lastRes = Date.now(), lastTroop = Date.now(), lastBot = Date.now();
let lastLB = Date.now(), lastSave = Date.now(), lastState = Date.now();
let lastBarb = Date.now(), lastAP = Date.now();

function tick() {
  const now = Date.now();

  // Check building/tech completion
  checkBuildings();

  // Resource gathering
  if (now - lastRes >= RES_INTERVAL) {
    gatherResources();
    lastRes = now;
  }

  // Troop generation
  if (now - lastTroop >= TROOP_INTERVAL) {
    genTroops();
    io.emit('tg');
    lastTroop = now;
  }

  // AP regen
  if (now - lastAP >= AP_REGEN_INTERVAL) {
    regenAP();
    lastAP = now;
  }

  // Bot AI
  if (now - lastBot >= BOT_INTERVAL) {
    for (let i = 0; i < players.length; i++) {
      if (players[i]?.isBot && players[i]?.alive) botAI(i);
    }
    lastBot = now;
  }

  // Barbarian spawning
  if (now - lastBarb >= BARB_SPAWN_INTERVAL) {
    spawnBarb();
    updateBarbs();
    lastBarb = now;
  }

  // Broadcast dirty chunks
  if (dirtyChunks.size > 0) {
    for (const [, s] of io.sockets.sockets) {
      if (!s.subs) continue;
      const toSend = [];
      for (const cid of dirtyChunks) {
        if (s.subs.has(cid)) {
          const [cx,cy] = cid.split(',').map(Number);
          toSend.push(packChunk(cx, cy));
        }
      }
      if (toSend.length > 0) s.emit('ch', toSend);
    }
    dirtyChunks.clear();
  }

  // Leaderboard
  if (now - lastLB >= LB_INTERVAL) {
    io.emit('lb', leaderboard());
    lastLB = now;
  }

  // Player state updates
  if (now - lastState >= STATE_INTERVAL) {
    for (const [, s] of io.sockets.sockets) {
      const pi = pidMap[s.id];
      if (pi !== undefined && players[pi]?.alive) {
        s.emit('st', playerState(pi));
      }
    }
    lastState = now;
  }

  // Auto-save
  if (now - lastSave >= SAVE_INTERVAL) {
    saveGame();
    lastSave = now;
  }
}

// ===== SOCKET.IO =====
io.on('connection', (s) => {
  s.subs = new Set();
  s.emit('mi', { w: W, h: H, cs: CHUNK, bldg: BLDG, tech: TECH });

  const colors = {};
  players.forEach((p,i) => { if (p?.alive) colors[i] = p.color; });
  s.emit('pc', colors);
  s.emit('cl', clanList());

  s.on('join', (d) => {
    const name = (d.name||'').trim().slice(0,16) || 'Player';
    // Check if reconnecting
    let pi = -1;
    for (let i = 0; i < players.length; i++) {
      if (players[i] && players[i].name === name && players[i].offline && players[i].alive) {
        pi = i;
        break;
      }
    }
    let pos;
    if (pi >= 0) {
      // Reconnect
      delete pidMap[players[pi].id];
      players[pi].id = s.id;
      players[pi].offline = false;
      pidMap[s.id] = pi;
      pos = players[pi].capital || { x: W/2, y: H/2 };
      console.log(`[REJOIN] ${name} reconnected (pi=${pi})`);
    } else {
      pos = spawnPlayer(s.id, name);
      pi = pidMap[s.id];
      console.log(`[JOIN] ${name} spawned at (${pos.x},${pos.y})`);
    }
    s.emit('joined', { pi, color: players[pi].color, sx: pos.x, sy: pos.y });
    s.emit('st', playerState(pi));
    io.emit('pc', { [pi]: players[pi].color });
    s.emit('cl', clanList());
  });

  s.on('vp', (d) => {
    const newSubs = new Set();
    const scx = Math.max(0, Math.floor(d.x / CHUNK));
    const scy = Math.max(0, Math.floor(d.y / CHUNK));
    const ecx = Math.min(CX - 1, Math.floor((d.x + d.w) / CHUNK));
    const ecy = Math.min(CY - 1, Math.floor((d.y + d.h) / CHUNK));
    const toSend = [];
    for (let cy = scy; cy <= ecy; cy++)
      for (let cx = scx; cx <= ecx; cx++) {
        const cid = `${cx},${cy}`;
        newSubs.add(cid);
        if (!s.subs.has(cid)) toSend.push(packChunk(cx, cy));
      }
    if (toSend.length > 0) s.emit('ch', toSend);
    s.subs = newSubs;
  });

  s.on('exp', (d) => {
    const pi = pidMap[s.id];
    if (pi === undefined || !players[pi]?.alive) return;
    if (players[pi].ap < 1) return s.emit('msg', 'AP 부족');
    const cells = d.cells || [{ x: d.x, y: d.y }];
    const apCost = Math.max(1, Math.ceil(cells.length / 3));
    if (players[pi].ap < apCost) return s.emit('msg', 'AP 부족');
    players[pi].ap -= apCost;
    let ok = 0;
    for (const c of cells) {
      const res = expandCell(pi, c.x, c.y);
      if (res.ok) ok++;
      else if (res.msg && cells.length === 1) s.emit('msg', res.msg);
    }
    if (ok > 0) s.emit('st', playerState(pi));
  });

  s.on('bpush', () => {
    const pi = pidMap[s.id];
    if (pi === undefined || !players[pi]?.alive) return;
    const claimed = borderPush(pi);
    if (claimed > 0) { s.emit('msg', `${claimed}칸 확장!`); s.emit('st', playerState(pi)); }
    else s.emit('msg', '확장 불가 (병력/AP 부족)');
  });

  s.on('matk', (d) => {
    const pi = pidMap[s.id];
    if (pi === undefined || !players[pi]?.alive) return;
    const claimed = massiveAttack(pi, d.tx, d.ty);
    if (claimed > 0) { s.emit('msg', `집중 공격: ${claimed}칸 점령!`); s.emit('st', playerState(pi)); }
    else s.emit('msg', '공격 불가 (병력 30+, AP 10 필요)');
  });

  s.on('bld', (d) => {
    const pi = pidMap[s.id];
    if (pi === undefined || !players[pi]?.alive) return;
    const p = players[pi];
    const k = d.b;
    if (!BLDG[k]) return;
    const b = p.buildings[k];
    if (b.e > 0) return s.emit('msg', '이미 건설 중입니다');
    if (b.l >= BLDG_MAX) return s.emit('msg', '최대 레벨입니다');
    if (k !== 'hq' && b.l >= p.buildings.hq.l) return s.emit('msg', `본부 레벨 ${b.l+1} 필요`);
    // Check no other building upgrading
    if (Object.values(p.buildings).some(bb => bb.e > 0)) return s.emit('msg', '다른 건물이 건설 중입니다');
    const cost = bldgCost(k, b.l);
    if (!canAfford(p, cost)) return s.emit('msg', '자원이 부족합니다');
    payCost(p, cost);
    b.e = Date.now() + bldgTime(k, b.l, p) * 1000;
    s.emit('st', playerState(pi));
    s.emit('msg', `${BLDG[k].n} 건설 시작!`);
  });

  s.on('res', (d) => {
    const pi = pidMap[s.id];
    if (pi === undefined || !players[pi]?.alive) return;
    const p = players[pi];
    const k = d.t;
    if (!TECH[k]) return;
    const t = p.tech[k];
    if (t.e > 0) return s.emit('msg', '이미 연구 중입니다');
    if (t.l >= TECH[k].max) return s.emit('msg', '최대 레벨입니다');
    if (Object.values(p.tech).some(tt => tt.e > 0)) return s.emit('msg', '다른 연구가 진행 중입니다');
    const cost = techCost(k, t.l);
    if (!canAfford(p, cost)) return s.emit('msg', '자원이 부족합니다');
    payCost(p, cost);
    t.e = Date.now() + techTime(k, t.l, p) * 1000;
    s.emit('st', playerState(pi));
    s.emit('msg', `${TECH[k].n} 연구 시작!`);
  });

  s.on('cclan', (d) => {
    const pi = pidMap[s.id];
    if (pi === undefined) return;
    const ci = createClan(pi, d.name||'Clan', d.tag||'CLN');
    s.emit('cj', { ci, clan: clans[ci] ? { name:clans[ci].name, tag:clans[ci].tag, color:clans[ci].color } : null });
    io.emit('pc', { [pi]: players[pi].color });
    io.emit('clu', clanList());
  });

  s.on('jclan', (d) => {
    const pi = pidMap[s.id];
    if (pi === undefined) return;
    if (joinClan(pi, d.ci)) {
      s.emit('cj', { ci: d.ci, clan: clans[d.ci] ? { name:clans[d.ci].name, tag:clans[d.ci].tag, color:clans[d.ci].color } : null });
      io.emit('pc', { [pi]: players[pi].color });
      io.emit('clu', clanList());
    }
  });

  s.on('lclan', () => {
    const pi = pidMap[s.id];
    if (pi === undefined) return;
    leaveClan(pi);
    s.emit('cl_left');
    io.emit('clu', clanList());
  });

  s.on('respawn', () => {
    const pi = pidMap[s.id];
    if (pi === undefined) return;
    const pos = respawnPlayer(pi);
    s.emit('joined', { pi, color: players[pi].color, sx: pos.x, sy: pos.y });
    s.emit('st', playerState(pi));
  });

  s.on('disconnect', () => {
    const pi = pidMap[s.id];
    if (pi !== undefined && players[pi]) {
      if (players[pi].isBot) {
        removePlayer(pi);
      } else {
        // Mark offline — territory persists
        players[pi].offline = true;
        console.log(`[OFFLINE] ${players[pi].name} went offline (territory persists)`);
      }
    }
  });
});

// ===== START =====
terrain = generateEarthMap(W, H);
if (!loadGame()) {
  console.log('[INIT] No save found, fresh start');
  spawnBots();
  // Spawn initial barbs
  for (let i = 0; i < 10; i++) spawnBarb();
} else {
  // Re-init bot AI for loaded bots
  for (let i = 0; i < players.length; i++) {
    if (players[i]?.isBot) pidMap[players[i].id] = i;
  }
}

setInterval(tick, TICK);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌍 Territory.io v4 on http://localhost:${PORT}`));
