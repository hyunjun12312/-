// ===== World Map Generator v6 — Random Pangaea with Strategic Terrain =====
// Procedural continent using multi-octave Simplex noise
// Terrain: 0=ocean, 1=plains, 2=forest, 3=desert, 4=mountain, 5=tundra, 6=ice, 7=shallow
// NEW: 8=hills (strategic high ground), 9=swamp (slow terrain)
// Features: chokepoints, resource zones, mountain ranges, rivers, islands

// ===== SIMPLEX NOISE (2D) =====
const perm = new Uint8Array(512);
const grad2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
function seedNoise(s) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let seed = s | 0;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807 + 0) & 0x7fffffff;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}

function simplex2(x, y) {
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const s = (x + y) * F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t), y0 = y - (j - t);
  let i1, j1;
  if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  function dot(gi, px, py) { const g = grad2[gi % 8]; return g[0]*px + g[1]*py; }
  let n0, n1, n2;
  let t0 = 0.5 - x0*x0 - y0*y0;
  n0 = t0 < 0 ? 0 : (t0 *= t0, t0 * t0 * dot(perm[ii + perm[jj]], x0, y0));
  let t1 = 0.5 - x1*x1 - y1*y1;
  n1 = t1 < 0 ? 0 : (t1 *= t1, t1 * t1 * dot(perm[ii + i1 + perm[jj + j1]], x1, y1));
  let t2 = 0.5 - x2*x2 - y2*y2;
  n2 = t2 < 0 ? 0 : (t2 *= t2, t2 * t2 * dot(perm[ii + 1 + perm[jj + 1]], x2, y2));
  return 70 * (n0 + n1 + n2);
}

function fbm(x, y, octaves, lac, gain) {
  let sum = 0, amp = 1, freq = 1, mx = 0;
  for (let i = 0; i < octaves; i++) {
    sum += simplex2(x * freq, y * freq) * amp;
    mx += amp; amp *= gain; freq *= lac;
  }
  return sum / mx;
}

function ridged(x, y, octaves) {
  let sum = 0, amp = 1, freq = 1, mx = 0;
  for (let i = 0; i < octaves; i++) {
    let v = 1.0 - Math.abs(simplex2(x * freq, y * freq));
    sum += v * v * amp;
    mx += amp; amp *= 0.5; freq *= 2.0;
  }
  return sum / mx;
}

// ===== GENERATE =====
function generateEarthMap(w, h) {
  const T0 = Date.now();
  const seed = (Date.now() % 100000) | 0;
  seedNoise(seed);
  console.log(`[MapGen] Seed=${seed} Size=${w}x${h}`);

  const map = new Uint8Array(w * h);
  const cx = w * 0.5, cy = h * 0.5;
  const maxR = Math.min(w, h) * 0.48;

  // ---- Continent blobs ----
  const blobN = 4 + Math.floor(Math.random() * 3);
  const blobs = [{ x: cx, y: cy, r: maxR * (0.7 + Math.random() * 0.2) }];
  for (let i = 1; i < blobN; i++) {
    const a = (Math.PI * 2 * i / blobN) + (Math.random() - 0.5) * 1.2;
    const d = maxR * (0.2 + Math.random() * 0.25);
    blobs.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: maxR * (0.4 + Math.random() * 0.25) });
  }

  // ---- Peninsulas ----
  const penN = 4 + Math.floor(Math.random() * 5);
  const pens = [];
  for (let i = 0; i < penN; i++) {
    const a = Math.random() * Math.PI * 2;
    const sd = maxR * (0.3 + Math.random() * 0.3);
    pens.push({
      sx: cx + Math.cos(a) * sd, sy: cy + Math.sin(a) * sd,
      a, len: maxR * (0.15 + Math.random() * 0.25), wid: maxR * (0.04 + Math.random() * 0.08)
    });
  }

  // ---- Landmask ----
  const landMask = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let mv = 0;
      for (const b of blobs) {
        const v = 1.0 - Math.sqrt((x-b.x)**2 + (y-b.y)**2) / b.r;
        if (v > mv) mv = v;
      }
      for (const p of pens) {
        const dx = x - p.sx, dy = y - p.sy;
        const along = dx * Math.cos(p.a) + dy * Math.sin(p.a);
        const across = -dx * Math.sin(p.a) + dy * Math.cos(p.a);
        if (along > 0 && along < p.len) {
          const tp = 1.0 - along / p.len;
          const pv = Math.max(0, 1.0 - Math.abs(across) / (p.wid * tp)) * 0.6;
          if (pv > mv) mv = pv;
        }
      }
      const cn = fbm(x / w * 3 + 13.7, y / h * 3 + 7.3, 6, 2.0, 0.55) * 0.35;
      const edx = Math.min(x, w - 1 - x) / (w * 0.07);
      const edy = Math.min(y, h - 1 - y) / (h * 0.07);
      landMask[i] = (mv + cn) * Math.min(1, Math.min(edx, edy));
    }
  }

  // ---- Noise layers ----
  const elevN = new Float32Array(w * h);
  const moistN = new Float32Array(w * h);
  const tempN = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const nx = x / w, ny = y / h;
      elevN[i] = fbm(nx * 5, ny * 5, 5, 2.0, 0.5);
      moistN[i] = fbm(nx * 4 + 100, ny * 4 + 200, 4, 2.0, 0.6);
      const lat = 1.0 - Math.abs(y / h - 0.5) * 2;
      tempN[i] = lat + fbm(nx * 3 + 50, ny * 3 + 50, 3, 2.0, 0.5) * 0.3;
    }
  }

  // ---- Mountain ranges (curves) — scaled for map size ----
  const mapScale = w / 800; // scale factor relative to base 800px wide map
  const rangeN = 5 + Math.floor(Math.random() * 5);
  const rangeMask = new Float32Array(w * h);
  for (let r = 0; r < rangeN; r++) {
    let rx = cx + (Math.random() - 0.5) * maxR * 1.2;
    let ry = cy + (Math.random() - 0.5) * maxR * 1.2;
    const ra = Math.random() * Math.PI * 2;
    const segs = Math.floor((8 + Math.floor(Math.random() * 12)) * mapScale);
    const rw = (3 + Math.random() * 5) * mapScale;
    const pts = [];
    const stepLen = (8 + Math.random() * 6) * mapScale;
    for (let s = 0; s < segs; s++) {
      pts.push({ x: rx, y: ry });
      const a2 = ra + (Math.random() - 0.5) * 1.0;
      rx += Math.cos(a2) * stepLen;
      ry += Math.sin(a2) * stepLen;
    }
    // Bounding box optimization: only compute distance near the range
    let bbMinX = Infinity, bbMaxX = -Infinity, bbMinY = Infinity, bbMaxY = -Infinity;
    for (const p of pts) {
      bbMinX = Math.min(bbMinX, p.x); bbMaxX = Math.max(bbMaxX, p.x);
      bbMinY = Math.min(bbMinY, p.y); bbMaxY = Math.max(bbMaxY, p.y);
    }
    const margin = rw + 2;
    bbMinX = Math.max(0, Math.floor(bbMinX - margin));
    bbMaxX = Math.min(w - 1, Math.ceil(bbMaxX + margin));
    bbMinY = Math.max(0, Math.floor(bbMinY - margin));
    bbMaxY = Math.min(h - 1, Math.ceil(bbMaxY + margin));
    // Distance field (bounded)
    for (let y = bbMinY; y <= bbMaxY; y++) {
      for (let x = bbMinX; x <= bbMaxX; x++) {
        let md = Infinity;
        for (let s = 0; s < pts.length - 1; s++) {
          const p1 = pts[s], p2 = pts[s + 1];
          const ddx = p2.x - p1.x, ddy = p2.y - p1.y;
          const l2 = ddx*ddx + ddy*ddy;
          let t = l2 > 0 ? ((x-p1.x)*ddx + (y-p1.y)*ddy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.sqrt((x - (p1.x+t*ddx))**2 + (y - (p1.y+t*ddy))**2);
          if (d < md) md = d;
        }
        if (md < rw) {
          const v = 1.0 - md / rw;
          const i = y * w + x;
          if (v * v > rangeMask[i]) rangeMask[i] = v * v;
        }
      }
    }
  }

  // ---- Rivers ----
  const riverCells = new Set();
  const riverN = 5 + Math.floor(Math.random() * 6);
  for (let r = 0; r < riverN; r++) {
    let best = -1, bx = 0, by = 0;
    for (let a = 0; a < 120; a++) {
      const rx2 = Math.floor(Math.random() * w);
      const ry2 = Math.floor(Math.random() * h);
      const ri = ry2 * w + rx2;
      if (landMask[ri] > 0.3 && (rangeMask[ri] + elevN[ri]) > best) {
        best = rangeMask[ri] + elevN[ri]; bx = rx2; by = ry2;
      }
    }
    let rx = bx, ry = by;
    const rWidth = Math.random() < 0.3 ? Math.ceil(mapScale) : Math.max(1, Math.floor(mapScale * 0.5));
    const maxRiverSteps = Math.floor(250 * mapScale);
    for (let step = 0; step < maxRiverSteps; step++) {
      const fx = Math.floor(rx), fy = Math.floor(ry);
      if (fx < 0 || fx >= w || fy < 0 || fy >= h) break;
      const ri = fy * w + fx;
      if (landMask[ri] < 0.15) break;
      riverCells.add(ri);
      if (rWidth > 0 && fx + 1 < w) riverCells.add(fy * w + fx + 1);

      let minE = Infinity, bdx = 0, bdy = 0;
      const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
      for (const [dx, dy] of dirs) {
        const nx = fx + dx * 2, ny = fy + dy * 2;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const e = landMask[ny * w + nx] + elevN[ny * w + nx] * 0.3;
        if (e < minE) { minE = e; bdx = dx; bdy = dy; }
      }
      rx += bdx + (Math.random() - 0.5) * 0.5;
      ry += bdy + (Math.random() - 0.5) * 0.5;
    }
  }

  // ---- Resource zones ----
  const resZones = [];
  const zt = ['gold', 'fertile', 'quarry', 'forest'];
  for (let z = 0; z < 8 + Math.floor(Math.random() * 6); z++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * maxR * 0.6;
    resZones.push({
      x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d,
      r: (8 + Math.random() * 15) * mapScale,
      type: zt[Math.floor(Math.random() * zt.length)]
    });
  }

  // ---- Assign terrain ----
  const LT = 0.10, SB = 0.03;
  let landCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const land = landMask[i], elev = elevN[i], moist = moistN[i], temp = tempN[i], mtn = rangeMask[i];

      if (riverCells.has(i) && land > LT) { map[i] = 7; continue; }
      if (land < LT - SB) { map[i] = 0; continue; }
      if (land < LT) { map[i] = 7; continue; }

      landCount++;

      // Mountains — wider range, more of them (산맥)
      if (mtn > 0.4 || (mtn > 0.25 && elev > 0.25)) { map[i] = 4; continue; }
      // Hills — broader belt around mountains (구릉)
      if (mtn > 0.10 || (elev > 0.28 && mtn > 0.03) || (elev > 0.4)) { map[i] = 8; continue; }

      // Resource zone check
      let zt2 = null;
      for (const z of resZones) {
        if ((x-z.x)**2 + (y-z.y)**2 < z.r * z.r) { zt2 = z.type; break; }
      }

      // Biomes — balanced thresholds for terrain diversity
      if (temp < 0.30) {
        if (temp < 0.12) { map[i] = 6; landCount--; } // ice (빙하)
        else map[i] = 5; // tundra (툰드라)
      } else if (temp > 0.72 && moist < 0.12) {
        map[i] = 3; // desert (사막) — hot + dry
      } else if (moist > 0.45 && temp > 0.38) {
        if (elev < 0.08) map[i] = 9; // swamp (늪지) — wet lowland
        else map[i] = 2; // forest (숲) — wet highland
      } else if (moist > 0.25) {
        map[i] = 2; // forest (숲) — moderate moisture
      } else if (moist > 0.08) {
        if (zt2 === 'quarry') map[i] = 8; // hilly quarry
        else if (temp > 0.68 && moist < 0.15) map[i] = 3; // semi-arid desert
        else map[i] = 1; // plains (평원)
      } else {
        map[i] = temp > 0.58 ? 3 : 1; // desert or dry plains
      }
    }
  }

  // ---- Islands ----
  const islGN = 3 + Math.floor(Math.random() * 4);
  for (let ig = 0; ig < islGN; ig++) {
    const a = Math.random() * Math.PI * 2;
    const d = maxR * (0.85 + Math.random() * 0.15);
    const gx = cx + Math.cos(a) * d, gy = cy + Math.sin(a) * d;
    const iN = 1 + Math.floor(Math.random() * 3);
    for (let isl = 0; isl < iN; isl++) {
      const ix = gx + (Math.random() - 0.5) * 20;
      const iy = gy + (Math.random() - 0.5) * 20;
      const ir = 3 + Math.random() * 6;
      for (let dy = -Math.ceil(ir); dy <= Math.ceil(ir); dy++) {
        for (let dx = -Math.ceil(ir); dx <= Math.ceil(ir); dx++) {
          const ax = Math.floor(ix + dx), ay = Math.floor(iy + dy);
          if (ax < 1 || ax >= w - 1 || ay < 1 || ay >= h - 1) continue;
          const dd = Math.sqrt(dx * dx + dy * dy);
          if (dd > ir) continue;
          const ai = ay * w + ax;
          if (map[ai] === 0 || map[ai] === 7) {
            const n = fbm(ax / 10 + 500, ay / 10 + 500, 3, 2, 0.5);
            if (dd < ir * 0.7 + n * ir * 0.3) {
              map[ai] = moistN[ai] > 0.3 ? 2 : 1;
              landCount++;
            }
          }
        }
      }
    }
  }

  // ---- Coastal shallow ring ----
  const shallow = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (map[i] !== 0) continue;
      let near = false;
      outer: for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const t = map[ny * w + nx];
            if (t >= 1 && t <= 9 && t !== 7) { near = true; break outer; }
          }
        }
      }
      if (near) shallow[i] = 1;
    }
  }
  for (let i = 0; i < w * h; i++) if (shallow[i]) map[i] = 7;

  const elapsed = Date.now() - T0;
  console.log(`[MapGen] Done ${elapsed}ms — ${(landCount/(w*h)*100).toFixed(1)}% land, ${riverCells.size} river, ${rangeN} ranges`);
  return map;
}

module.exports = { generateEarthMap };
