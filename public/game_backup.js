// ===== Territory.io v4 — Strategy Client =====
// Resources, Buildings, Tech, Barbarians, Full UI
const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const mmCanvas = document.getElementById('minimapCanvas');
const mmCtx = mmCanvas.getContext('2d', { alpha: false });
let buf = document.createElement('canvas');
let bCtx = buf.getContext('2d', { alpha: false });

// ===== STATE =====
let myPi = -1, myColor = '#fff', alive = false;
let mapW = 800, mapH = 400, chunkSz = 40;
const pColors = {};
const chunks = {};
let lb = { p: [], c: [] };
let mySt = null; // player state: resources, buildings, tech, AP
let BLDG = {}, TECH = {};
let lastMsg = '', msgTimer = 0;
let lastReward = null, rewardTimer = 0;

// Terrain colors
// 0=ocean, 1=plains, 2=forest, 3=desert, 4=mountain, 5=tundra, 6=ice, 7=shallow, 8=hills, 9=swamp
const T_RGB = [
  [16,40,68],     // 0 ocean
  [72,148,72],    // 1 plains
  [35,98,35],     // 2 forest
  [185,160,80],   // 3 desert
  [100,95,90],    // 4 mountain
  [175,190,200],  // 5 tundra
  [220,230,240],  // 6 ice
  [30,75,120],    // 7 shallow
  [130,120,80],   // 8 hills (tan-brown)
  [50,90,60]      // 9 swamp (dark green)
];
const SHALLOW = [30,80,130];
const BARB_COLOR = [180,40,40];

// Camera
let cam = { x: 0, y: 0, z: 8 };
let lastVP = '';

// Input
let mDown=false, rDown=false;
let panX=0, panY=0, mx=0, my=0;
let gameMode = 'expand'; // 'expand', 'massive'
let dragCells = []; // cells to expand during drag

// ===== HELPERS =====
const rgbCache = {};
function hexRgb(hex) {
  if (rgbCache[hex]) return rgbCache[hex];
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return rgbCache[hex]=[r,g,b];
}
function esc(t) { const d=document.createElement('div'); d.textContent=t; return d.innerHTML; }
function fmtTime(ms) {
  if (ms <= 0) return '';
  const s = Math.ceil(ms/1000);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s/60)}분 ${s%60}초`;
  const h = Math.floor(s/3600);
  return `${h}시간 ${Math.floor((s%3600)/60)}분`;
}
function fmtNum(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1)+'M';
  if (n >= 1000) return (n/1000).toFixed(1)+'K';
  return String(Math.floor(n));
}
function bldgCost(key, level) {
  const def = BLDG[key];
  if (!def) return {};
  const costs = {};
  for (const [r,v] of Object.entries(def.base)) costs[r] = Math.ceil(v * Math.pow(1.3, level));
  return costs;
}
function techCost(key, level) {
  const def = TECH[key];
  if (!def) return {};
  const costs = {};
  for (const [r,v] of Object.entries(def.base)) costs[r] = Math.ceil(v * Math.pow(1.25, level));
  return costs;
}
function costStr(costs) {
  const m = {f:'🌾',w:'🪵',s:'🪨',g:'💰'};
  return Object.entries(costs).map(([k,v])=>`${m[k]||k}${fmtNum(v)}`).join(' ');
}
function canAffordLocal(costs) {
  if (!mySt) return false;
  const m = {f:'f',w:'w',s:'s',g:'g'};
  for (const [k,v] of Object.entries(costs)) { if ((mySt.r[m[k]||k]||0) < v) return false; }
  return true;
}

// ===== LOBBY =====
function showCreateClan() { document.getElementById('clanSection').style.display='none'; document.getElementById('createClanForm').style.display='block'; }
function hideCreateClan() { document.getElementById('clanSection').style.display='block'; document.getElementById('createClanForm').style.display='none'; }
function playSolo() { socket.emit('join',{name:document.getElementById('ni').value.trim()||'Player'}); }
function createAndPlay() {
  const name=document.getElementById('ni').value.trim()||'Player';
  const cn=document.getElementById('cni').value.trim(), ct=document.getElementById('cti').value.trim();
  if(!cn||!ct) return;
  socket.emit('join',{name}); socket.once('joined',()=>socket.emit('cclan',{name:cn,tag:ct}));
}
function joinClanPlay(ci) {
  socket.emit('join',{name:document.getElementById('ni').value.trim()||'Player'});
  socket.once('joined',()=>socket.emit('jclan',{ci}));
}
function leaveClanAction() { socket.emit('lclan'); document.getElementById('cp').style.display='none'; }
function respawn() {
  socket.emit('respawn'); document.getElementById('ds').style.display='none';
  alive=true; Object.keys(chunks).forEach(k=>delete chunks[k]); lastVP='';
}
function showTab(id) {
  document.querySelectorAll('.tc').forEach(e=>e.style.display='none');
  document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));
  document.getElementById(id).style.display='block';
  event.target.classList.add('active');
}
function showPanel(id) {
  document.querySelectorAll('.sp').forEach(e=>e.style.display='none');
  document.querySelectorAll('.ptab').forEach(e=>e.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.style.display='block';
  if (event?.target) event.target.classList.add('active');
}
document.getElementById('ni').addEventListener('keydown',e=>{if(e.key==='Enter')playSolo();});

// ===== SOCKET EVENTS =====
socket.on('mi', d => {
  mapW=d.w; mapH=d.h; chunkSz=d.cs;
  if(d.bldg) BLDG=d.bldg;
  if(d.tech) TECH=d.tech;
});
socket.on('pc', d => { Object.entries(d).forEach(([k,v])=>{pColors[k]=v;rgbCache[v]=hexRgb(v);}); });
socket.on('joined', d => {
  myPi=d.pi; myColor=d.color; alive=true;
  pColors[myPi]=myColor;
  document.getElementById('ss').style.display='none';
  document.getElementById('gs').style.display='block';
  document.getElementById('ds').style.display='none';
  resize();
  cam.z=8; // zoom in close so player can see their territory
  cam.x=d.sx-(canvas.width/cam.z/2); cam.y=d.sy-(canvas.height/cam.z/2);
  sendVP();
});
socket.on('ch', arr => {
  for(const c of arr) chunks[`${c.cx},${c.cy}`]={t:new Uint8Array(c.t),o:new Int16Array(c.o),tr:new Uint16Array(c.tr)};
});
socket.on('tg', () => {
  // Troops now tracked as totalTroops in player state
  // Request fresh state
  if (myPi >= 0) lastVP = ''; // trigger viewport refresh
});
socket.on('lb', d => { lb=d; updateLB(); checkDeath(); });
socket.on('st', d => { mySt=d; updateResPanel(); updateBldgPanel(); updateTechPanel(); updateInfoPanel(); });
socket.on('msg', m => { lastMsg=m; msgTimer=Date.now()+3000; });
socket.on('reward', r => { lastReward=r; rewardTimer=Date.now()+3000; });
socket.on('died', () => { alive=false; document.getElementById('ds').style.display='flex'; });
socket.on('cl', list => renderCL(list));
socket.on('clu', list => renderCL(list));
socket.on('cj', d => {
  if(d.clan){ myColor=d.clan.color; pColors[myPi]=myColor;
    document.getElementById('cp').style.display='block';
    document.getElementById('cpn').textContent=`[${d.clan.tag}] ${d.clan.name}`;
  }
});
socket.on('cl_left', () => { document.getElementById('cp').style.display='none'; });

function renderCL(list) {
  const el=document.getElementById('clist'); if(!el) return;
  el.innerHTML=list.map(c=>`<div class="ci" onclick="joinClanPlay(${c.id})">
    <span class="cc" style="background:${c.color}"></span>
    <span class="cn">${esc(c.name)}</span><span class="ct">[${esc(c.tag)}]</span>
    <span class="cm">${c.members}명</span></div>`).join('');
}

// ===== CANVAS =====
function resize() { canvas.width=window.innerWidth; canvas.height=window.innerHeight; }
window.addEventListener('resize', resize);

function s2w(sx,sy){return{x:sx/cam.z+cam.x,y:sy/cam.z+cam.y};}
function s2c(sx,sy){const w=s2w(sx,sy);return{x:w.x|0,y:w.y|0};}
function getCell(cx,cy){
  if(cx<0||cy<0||cx>=mapW||cy>=mapH)return null;
  const ch=chunks[`${(cx/chunkSz)|0},${(cy/chunkSz)|0}`];
  if(!ch)return null;
  const i=(cy%chunkSz)*chunkSz+(cx%chunkSz);
  return{t:ch.t[i],o:ch.o[i],tr:ch.tr[i]};
}
function isMe(cx,cy){const c=getCell(cx,cy);return c&&c.o===myPi;}

function sendVP() {
  const tl=s2w(0,0), br=s2w(canvas.width,canvas.height);
  const x=Math.max(0,tl.x|0), y=Math.max(0,tl.y|0);
  const w=Math.min(mapW,(br.x|0)+2)-x, h=Math.min(mapH,(br.y|0)+2)-y;
  const key=`${x},${y},${w},${h}`;
  if(key===lastVP)return; lastVP=key;
  socket.emit('vp',{x,y,w,h});
}

// ===== INPUT =====
canvas.addEventListener('mousedown', e => {
  e.preventDefault();
  if(e.button===2){rDown=true;panX=e.clientX;panY=e.clientY;return;}
  if(e.button===0){
    mDown=true;
    const c=s2c(e.clientX,e.clientY);
    dragCells=[];
    if(gameMode==='massive'){
      // Massive attack: click target
      socket.emit('matk',{tx:c.x,ty:c.y});
      gameMode='expand';
    } else {
      // Expand mode: click to expand single cell, or start drag
      const cell=getCell(c.x,c.y);
      if(cell && cell.o!==myPi){
        dragCells.push({x:c.x,y:c.y});
      }
    }
  }
});
canvas.addEventListener('mousemove', e => {
  mx=e.clientX;my=e.clientY;
  if(rDown){cam.x-=(e.clientX-panX)/cam.z;cam.y-=(e.clientY-panY)/cam.z;panX=e.clientX;panY=e.clientY;sendVP();return;}
  if(mDown&&gameMode==='expand'){
    const c=s2c(e.clientX,e.clientY);
    const last=dragCells.length>0?dragCells[dragCells.length-1]:null;
    if(!last||last.x!==c.x||last.y!==c.y){
      const cell=getCell(c.x,c.y);
      if(cell && cell.o!==myPi) dragCells.push({x:c.x,y:c.y});
    }
  }
});
canvas.addEventListener('mouseup', e => {
  if(e.button===2){rDown=false;return;}
  if(e.button===0){
    mDown=false;
    if(dragCells.length>0){
      socket.emit('exp',{cells:dragCells});
      dragCells=[];
    }
  }
});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const f=e.deltaY>0?0.85:1.18;
  const nz=Math.max(0.3,Math.min(14,cam.z*f));
  const wb=s2w(e.clientX,e.clientY);cam.z=nz;const wa=s2w(e.clientX,e.clientY);
  cam.x+=wb.x-wa.x;cam.y+=wb.y-wa.y;sendVP();
},{passive:false});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){gameMode='expand';dragCells=[];}
  if(e.key===' '){e.preventDefault();centerOnMe();}
  if(e.key==='f'||e.key==='F'){socket.emit('bpush');}
  if(e.key==='m'||e.key==='M'){gameMode=gameMode==='massive'?'expand':'massive';}
});
// Touch
let tDist=0;
canvas.addEventListener('touchstart',e=>{
  e.preventDefault();
  if(e.touches.length===2){const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY;tDist=Math.hypot(dx,dy);return;}
  const t=e.touches[0];mx=t.clientX;my=t.clientY;
  mDown=true;dragCells=[];
  const c=s2c(t.clientX,t.clientY);
  if(gameMode==='massive'){
    socket.emit('matk',{tx:c.x,ty:c.y});
    gameMode='expand';
  } else {
    const cell=getCell(c.x,c.y);
    if(cell && cell.o!==myPi) dragCells.push({x:c.x,y:c.y});
  }
},{passive:false});
canvas.addEventListener('touchmove',e=>{
  e.preventDefault();
  if(e.touches.length===2){const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY;const d=Math.hypot(dx,dy);if(tDist>0)cam.z=Math.max(0.3,Math.min(14,cam.z*d/tDist));tDist=d;sendVP();return;}
  const t=e.touches[0];mx=t.clientX;my=t.clientY;
  if(mDown&&gameMode==='expand'){
    const c=s2c(t.clientX,t.clientY);
    const last=dragCells.length>0?dragCells[dragCells.length-1]:null;
    if(!last||last.x!==c.x||last.y!==c.y){
      const cell=getCell(c.x,c.y);
      if(cell && cell.o!==myPi) dragCells.push({x:c.x,y:c.y});
    }
  }
},{passive:false});
canvas.addEventListener('touchend',e=>{
  e.preventDefault();tDist=0;
  if(dragCells.length>0){socket.emit('exp',{cells:dragCells});dragCells=[];}
  mDown=false;
},{passive:false});
mmCanvas.addEventListener('click',e=>{
  const r=mmCanvas.getBoundingClientRect();
  cam.x=(e.clientX-r.left)/mmCanvas.width*mapW-canvas.width/cam.z/2;
  cam.y=(e.clientY-r.top)/mmCanvas.height*mapH-canvas.height/cam.z/2;
  sendVP();
});
function centerOnMe(){
  let sx=0,sy=0,n=0;
  for(const[key,ch] of Object.entries(chunks)){const[cx,cy]=key.split(',').map(Number);
    for(let i=0;i<ch.o.length;i++)if(ch.o[i]===myPi){sx+=cx*chunkSz+(i%chunkSz);sy+=cy*chunkSz+((i/chunkSz)|0);n++;}}
  if(n>0){cam.x=sx/n-canvas.width/cam.z/2;cam.y=sy/n-canvas.height/cam.z/2;sendVP();}
}

// ===== RENDERING =====
function render() {
  if(!canvas.width){requestAnimationFrame(render);return;}
  const cw=canvas.width,ch=canvas.height,z=cam.z;
  const cellsW=Math.ceil(cw/z)+2, cellsH=Math.ceil(ch/z)+2;
  const startX=Math.floor(cam.x), startY=Math.floor(cam.y);
  const bw=cellsW,bh=cellsH;
  if(buf.width!==bw||buf.height!==bh){buf.width=bw;buf.height=bh;}
  const img=bCtx.createImageData(bw,bh);
  const d=img.data;
  for(let ly=0;ly<bh;ly++){
    const gy=startY+ly;
    for(let lx=0;lx<bw;lx++){
      const gx=startX+lx, pi=(ly*bw+lx)*4;
      if(gx<0||gy<0||gx>=mapW||gy>=mapH){d[pi]=8;d[pi+1]=16;d[pi+2]=32;d[pi+3]=255;continue;}
      const cell=getCell(gx,gy);
      if(!cell){d[pi]=8;d[pi+1]=16;d[pi+2]=32;d[pi+3]=255;continue;}
      let r,g,b;const t=cell.t;
      if(t===0){
        let coastal=false;
        if(z>0.8){for(let dy2=-1;dy2<=1&&!coastal;dy2++)for(let dx2=-1;dx2<=1&&!coastal;dx2++){const nc=getCell(gx+dx2,gy+dy2);if(nc&&nc.t>0)coastal=true;}}
        if(coastal){r=SHALLOW[0];g=SHALLOW[1];b=SHALLOW[2];}else{r=T_RGB[0][0];g=T_RGB[0][1];b=T_RGB[0][2];}
      }else if(cell.o===-2){
        // Barbarian
        const tc=T_RGB[t]||T_RGB[1];
        r=(tc[0]*0.3+BARB_COLOR[0]*0.7)|0;g=(tc[1]*0.3+BARB_COLOR[1]*0.7)|0;b=(tc[2]*0.3+BARB_COLOR[2]*0.7)|0;
      }else if(cell.o>=0){
        const tc=T_RGB[t]||T_RGB[1];
        const oc=hexRgb(pColors[cell.o]||'#888888');
        r=(tc[0]*0.35+oc[0]*0.65)|0;g=(tc[1]*0.35+oc[1]*0.65)|0;b=(tc[2]*0.35+oc[2]*0.65)|0;
      }else{
        const tc=T_RGB[t]||T_RGB[1];r=tc[0];g=tc[1];b=tc[2];
      }
      d[pi]=r;d[pi+1]=g;d[pi+2]=b;d[pi+3]=255;
    }
  }
  bCtx.putImageData(img,0,0);
  ctx.imageSmoothingEnabled=false;
  const offX=(cam.x-startX)*z, offY=(cam.y-startY)*z;
  ctx.fillStyle='#081020';ctx.fillRect(0,0,cw,ch);
  ctx.drawImage(buf,-offX,-offY,bw*z,bh*z);

  // Capital beacon — always visible, pulsing
  if(mySt?.cap){
    const capSx=(mySt.cap.x-cam.x)*z+z/2;
    const capSy=(mySt.cap.y-cam.y)*z+z/2;
    const pulse=Math.sin(Date.now()*0.004)*0.3+0.7;
    const beaconR=Math.max(6,z*1.5)*pulse;
    ctx.save();
    ctx.beginPath();ctx.arc(capSx,capSy,beaconR+4,0,Math.PI*2);
    ctx.fillStyle=`rgba(255,215,0,${0.15*pulse})`;ctx.fill();
    ctx.beginPath();ctx.arc(capSx,capSy,beaconR,0,Math.PI*2);
    ctx.fillStyle=`rgba(255,215,0,${0.3*pulse})`;ctx.fill();
    ctx.beginPath();ctx.arc(capSx,capSy,3,0,Math.PI*2);
    ctx.fillStyle='#ffd700';ctx.fill();
    // Crown icon
    ctx.font=`${Math.max(12,z*0.8)}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='bottom';
    ctx.fillText('👑',capSx,capSy-beaconR-2);
    ctx.restore();
  }

  // Overlays
  if(z>=4){
    ctx.save();ctx.scale(z,z);ctx.translate(-cam.x,-cam.y);
    // Borders
    if(z>=6){
      for(let ly=0;ly<bh;ly++){const gy=startY+ly;
        for(let lx=0;lx<bw;lx++){const gx=startX+lx;
          const cell=getCell(gx,gy);if(!cell||cell.o<0)continue;
          const c=pColors[cell.o]||'#888';
          const top=getCell(gx,gy-1),bot=getCell(gx,gy+1),lft=getCell(gx-1,gy),rgt=getCell(gx+1,gy);
          if((!top||top.o!==cell.o)||(!bot||bot.o!==cell.o)||(!lft||lft.o!==cell.o)||(!rgt||rgt.o!==cell.o)){
            ctx.strokeStyle=c;ctx.lineWidth=0.12;ctx.strokeRect(gx+0.05,gy+0.05,0.9,0.9);
          }
        }
      }
    }
    // Capital cell highlight
    if(mySt?.cap){
      const pulse2=Math.sin(Date.now()*0.003)*0.15+0.35;
      ctx.fillStyle=`rgba(255,215,0,${pulse2})`;ctx.fillRect(mySt.cap.x,mySt.cap.y,1,1);
      ctx.strokeStyle='#ffd700';ctx.lineWidth=0.18;
      ctx.strokeRect(mySt.cap.x-0.05,mySt.cap.y-0.05,1.1,1.1);
    }
    // Cursor highlight
    const mw2=s2w(mx,my);
    const hx=Math.floor(mw2.x),hy=Math.floor(mw2.y);
    if(hx>=0&&hx<W&&hy>=0&&hy<H&&myPi>=0){
      const hcell=getCell(hx,hy);
      if(hcell){
        if(hcell.o===myPi){
          // own cell - no highlight
        } else if(hcell.o<0 && hcell.o!==-2){
          // empty land
          ctx.fillStyle='rgba(0,255,100,0.25)';ctx.fillRect(hx,hy,1,1);
          ctx.strokeStyle='#00ff64';ctx.lineWidth=0.1;ctx.strokeRect(hx+0.05,hy+0.05,0.9,0.9);
        } else {
          // enemy or barbarian
          ctx.fillStyle='rgba(255,50,50,0.25)';ctx.fillRect(hx,hy,1,1);
          ctx.strokeStyle='#ff3232';ctx.lineWidth=0.1;ctx.strokeRect(hx+0.05,hy+0.05,0.9,0.9);
        }
      }
    }
    // Drag preview
    if(dragCells.length>0){
      dragCells.forEach(dc=>{
        ctx.fillStyle='rgba(255,215,0,0.3)';ctx.fillRect(dc.x,dc.y,1,1);
        ctx.strokeStyle='#ffd700';ctx.lineWidth=0.08;ctx.strokeRect(dc.x+0.05,dc.y+0.05,0.9,0.9);
      });
    }
    // Massive attack mode indicator
    if(gameMode==='massive'){
      const mw3=s2w(mx,my);
      ctx.beginPath();ctx.arc(mw3.x,mw3.y,1.5,0,Math.PI*2);
      ctx.strokeStyle='rgba(255,50,50,0.6)';ctx.lineWidth=0.15;ctx.setLineDash([0.4,0.3]);ctx.stroke();ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // Mode / troop info bar
  const si=document.getElementById('si');
  if(mySt){
    const modeText=gameMode==='massive'?'🎯 집중공격 모드 (클릭으로 대상 선택, ESC 취소)':'⚔️ 확장 모드 (클릭/드래그로 영토 확장)';
    document.getElementById('sc').textContent=modeText;
    document.getElementById('st2').textContent=`병력: ${mySt.tt||0}`;
    si.style.display='block';
  }else{si.style.display='none';}

  // Messages
  const now=Date.now();
  if(lastMsg&&now<msgTimer){
    ctx.save();ctx.fillStyle='rgba(0,0,0,0.7)';
    const tw=ctx.measureText(lastMsg).width;
    ctx.fillRect(cw/2-tw/2-16,80,tw+32,30);
    ctx.font='14px monospace';ctx.fillStyle='#ffd700';ctx.textAlign='center';
    ctx.fillText(lastMsg,cw/2,98);ctx.restore();
  }
  if(lastReward&&now<rewardTimer){
    const txt=`🎁 식량+${lastReward.food} 목재+${lastReward.wood} 석재+${lastReward.stone} 금+${lastReward.gold}`;
    ctx.save();ctx.font='14px monospace';ctx.fillStyle='#2ecc71';ctx.textAlign='center';
    ctx.fillText(txt,cw/2,60);ctx.restore();
  }

  // Protection indicator
  if(mySt&&mySt.pr>now){
    ctx.save();ctx.font='12px monospace';ctx.fillStyle='#81ecec';ctx.textAlign='left';
    ctx.fillText(`🛡 보호막: ${fmtTime(mySt.pr-now)}`,10,cw>600?canvas.height-20:canvas.height-40);ctx.restore();
  }

  requestAnimationFrame(render);
}

// ===== MINIMAP =====
let mmDirty=true;
setInterval(()=>{mmDirty=true;},2000);
function renderMM(){
  if(!mmDirty)return;mmDirty=false;
  const w=mmCanvas.width,h=mmCanvas.height;
  const img=mmCtx.createImageData(w,h);const d=img.data;
  const sx=mapW/w,sy=mapH/h;
  for(let py=0;py<h;py++)for(let px=0;px<w;px++){
    const gx=(px*sx)|0,gy=(py*sy)|0;
    const cell=getCell(gx,gy);const pi=(py*w+px)*4;
    if(!cell||cell.t===0){d[pi]=8;d[pi+1]=20;d[pi+2]=40;d[pi+3]=255;}
    else if(cell.o===-2){d[pi]=180;d[pi+1]=40;d[pi+2]=40;d[pi+3]=255;}
    else if(cell.o>=0){const c=hexRgb(pColors[cell.o]||'#888');d[pi]=c[0];d[pi+1]=c[1];d[pi+2]=c[2];d[pi+3]=255;}
    else{const tc=T_RGB[cell.t]||T_RGB[1];d[pi]=(tc[0]*0.6)|0;d[pi+1]=(tc[1]*0.6)|0;d[pi+2]=(tc[2]*0.6)|0;d[pi+3]=255;}
  }
  mmCtx.putImageData(img,0,0);
  // Player position beacon on minimap
  if(mySt?.cap){
    const px2=mySt.cap.x/mapW*w, py2=mySt.cap.y/mapH*h;
    const blink=Math.sin(Date.now()*0.005)>0;
    mmCtx.beginPath();mmCtx.arc(px2,py2,blink?4:3,0,Math.PI*2);
    mmCtx.fillStyle='#ffd700';mmCtx.fill();
    mmCtx.strokeStyle='#fff';mmCtx.lineWidth=1;mmCtx.stroke();
  }
  const rx=cam.x/mapW*w,ry=cam.y/mapH*h;
  const rw=(canvas.width/cam.z)/mapW*w,rh=(canvas.height/cam.z)/mapH*h;
  mmCtx.strokeStyle='#fff';mmCtx.lineWidth=1;mmCtx.strokeRect(rx,ry,rw,rh);
}
setInterval(renderMM,500);

// ===== UI UPDATE =====
function updateResPanel(){
  if(!mySt)return;
  document.getElementById('rFood').textContent=fmtNum(mySt.r.f);
  document.getElementById('rWood').textContent=fmtNum(mySt.r.w);
  document.getElementById('rStone').textContent=fmtNum(mySt.r.s);
  document.getElementById('rGold').textContent=fmtNum(mySt.r.g);
  document.getElementById('rAP').textContent=`${mySt.ap}/${mySt.ma}`;
}

function updateInfoPanel(){
  if(!mySt)return;
  const me=lb.p.find(e=>e.i===myPi);
  if(me){
    document.getElementById('mn').innerHTML=`<span style="color:${me.color}">■</span> ${esc(me.name)} ${me.ct||''}`;
    document.getElementById('myc').textContent=me.cells;
    document.getElementById('myt').textContent=fmtNum(mySt.tt||0);
  }
}

function updateLB(){
  document.getElementById('plb').innerHTML=lb.p.map((e,i)=>
    `<div class="le${e.i===myPi?' me':''}"><span class="lr">${i+1}</span><span class="lc" style="background:${e.color}"></span><span class="ln">${esc(e.name)}</span><span class="ls">${e.ct} ${e.cells}</span></div>`
  ).join('');
  document.getElementById('clb').innerHTML=lb.c.map((e,i)=>
    `<div class="le"><span class="lr">${i+1}</span><span class="lc" style="background:${e.color}"></span><span class="ln">[${esc(e.tag)}] ${esc(e.name)}</span><span class="ls">${e.cells}</span></div>`
  ).join('');
}

function updateBldgPanel(){
  if(!mySt)return;
  const now=Date.now();
  const el=document.getElementById('bldgList');if(!el)return;
  const anyUpgrading=Object.values(mySt.b).some(b=>b.e>0);
  let html='';
  for(const[k,def] of Object.entries(BLDG)){
    const b=mySt.b[k];if(!b)continue;
    const isUpgrading=b.e>0&&now<b.e;
    const cost=bldgCost(k,b.l);
    const afford=canAffordLocal(cost);
    const maxed=b.l>=25;
    const needHQ=k!=='hq'&&b.l>=mySt.b.hq.l;
    html+=`<div class="bi">`;
    html+=`<div class="bh"><span class="bn">${def.n}</span><span class="bl">Lv.${b.l}</span></div>`;
    html+=`<div class="bd">${def.desc}</div>`;
    if(isUpgrading){
      const remain=b.e-now;
      html+=`<div class="bt">⏱ ${fmtTime(remain)}</div>`;
    }else if(maxed){
      html+=`<div class="bt max">최대 레벨</div>`;
    }else if(needHQ){
      html+=`<div class="bt lock">🔒 본부 Lv.${b.l+1} 필요</div>`;
    }else{
      html+=`<div class="bc">${costStr(cost)}</div>`;
      html+=`<button class="bu${!afford||anyUpgrading?' dis':''}" onclick="upgradeBldg('${k}')" ${!afford||anyUpgrading?'disabled':''}>업그레이드</button>`;
    }
    html+=`</div>`;
  }
  el.innerHTML=html;
}

function updateTechPanel(){
  if(!mySt)return;
  const now=Date.now();
  const el=document.getElementById('techList');if(!el)return;
  const anyResearching=Object.values(mySt.t).some(t=>t.e>0);
  let html='';
  for(const[k,def] of Object.entries(TECH)){
    const t=mySt.t[k];if(!t)continue;
    const isRes=t.e>0&&now<t.e;
    const cost=techCost(k,t.l);
    const afford=canAffordLocal(cost);
    const maxed=t.l>=def.max;
    html+=`<div class="bi">`;
    html+=`<div class="bh"><span class="bn">${def.n}</span><span class="bl">Lv.${t.l}</span></div>`;
    html+=`<div class="bd">${def.desc}</div>`;
    if(isRes){
      html+=`<div class="bt">⏱ ${fmtTime(t.e-now)}</div>`;
    }else if(maxed){
      html+=`<div class="bt max">최대 레벨</div>`;
    }else{
      html+=`<div class="bc">${costStr(cost)}</div>`;
      html+=`<button class="bu${!afford||anyResearching?' dis':''}" onclick="researchTech('${k}')" ${!afford||anyResearching?'disabled':''}>연구 시작</button>`;
    }
    html+=`</div>`;
  }
  el.innerHTML=html;
}

function upgradeBldg(k){ socket.emit('bld',{b:k}); }
function researchTech(k){ socket.emit('res',{t:k}); }

function checkDeath(){
  if(myPi>=0&&alive){
    const me=lb.p.find(e=>e.i===myPi);
    if(!me){
      let has=false;
      for(const ch of Object.values(chunks)){for(let i=0;i<ch.o.length;i++)if(ch.o[i]===myPi){has=true;break;}if(has)break;}
      if(!has){alive=false;document.getElementById('ds').style.display='flex';}
    }
  }
}

// Auto-refresh panels
setInterval(()=>{if(mySt){updateBldgPanel();updateTechPanel();}},1000);
// Periodic VP refresh
setInterval(()=>{if(myPi>=0&&alive){lastVP='';sendVP();}},10000);
// Update coordinates display
setInterval(()=>{
  const cd=document.getElementById('coordsDisplay');
  if(cd&&mySt?.cap){
    const cx=Math.floor(cam.x+canvas.width/cam.z/2), cy=Math.floor(cam.y+canvas.height/cam.z/2);
    cd.textContent=`(${cx}, ${cy}) | 수도: (${mySt.cap.x}, ${mySt.cap.y})`;
  }
},500);

// ===== START =====
resize();
requestAnimationFrame(render);
