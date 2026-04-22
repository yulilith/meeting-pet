// ─────────────────────────────────────────────────────────────────────────────
// Feeding Room — interactive real-time pet feeding
// ─────────────────────────────────────────────────────────────────────────────

// URL params: ?projectId=xxx&sessionId=xxx (or demo mode with mock data)
const params = new URLSearchParams(window.location.search);
const PROJECT_ID  = params.get('projectId') || 'demo';
const SESSION_ID  = params.get('sessionId') || 'demo_session';

// ── State ─────────────────────────────────────────────────────────────────────
let project = null;
let roomState = null;
let petX = 0, petY = 0;
let petTargetX = 0, petTargetY = 0;
let petFrame = 0;
let petFacingRight = true;
let petHappy = 0;       // frames of happy animation remaining
let petEating = 0;      // frames of eating animation
let animRafId = null;
let unsubscribeRoom = null;
let prevHealth = 0;
let celebrationShown = false;

const SCENE_W = () => sceneCanvas.clientWidth  || 700;
const SCENE_H = () => sceneCanvas.clientHeight || 400;

// ── Elements ──────────────────────────────────────────────────────────────────
const sceneCanvas    = document.getElementById('scene-canvas');
const ctx            = sceneCanvas.getContext('2d');
const treatOverlay   = document.getElementById('treat-overlay');
const treatShelf     = document.getElementById('treat-shelf');
const fedList        = document.getElementById('fed-list');
const feedZone       = document.getElementById('feed-zone');
const petReaction    = document.getElementById('pet-reaction');
const healthFill     = document.getElementById('health-bar-fill');
const healthPct      = document.getElementById('health-pct');
const stageBadge     = document.getElementById('stage-badge');
const growthToast    = document.getElementById('growth-toast');
const celebration    = document.getElementById('celebration');

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await DB.loadCurrentUser();
  if (!DB.currentUser) {
    await DB.signInDemo('Guest');
  }

  if (PROJECT_ID === 'demo') {
    await loadDemoProject();
  } else {
    project = await DB.getProject(PROJECT_ID);
    if (!project) { alert('Project not found.'); return; }
  }

  initScene();
  subscribeToRoom();

  document.getElementById('btn-done-feeding').addEventListener('click', doneFeedingRoom);
  document.getElementById('btn-copy-invite').addEventListener('click', copyInviteCode);
  document.getElementById('btn-cele-close').addEventListener('click', closeCelebration);
});

// ── Demo project ──────────────────────────────────────────────────────────────
async function loadDemoProject() {
  // Create or load a demo project with some treats to feed
  const stored = DEMO_STORE.getProjects();
  let demo = Object.values(stored).find(p => p.name === 'Demo Project');

  if (!demo) {
    await DB.signInDemo('Demo User');
    demo = await DB.createProject({
      name: 'Demo Project',
      petIndex: 7, // Shiba Inu
      petName: 'Biscuit',
      background: 'meadow',
    });
  }

  project = demo;

  // Open a demo feeding room if not already open
  const existingRoom = DEMO_STORE.getFeedingRoom(demo.id);
  if (!existingRoom || existingRoom.status === 'done') {
    const treats = [
      { id: 't1', type: 'apple' }, { id: 't2', type: 'apple' }, { id: 't3', type: 'apple' },
      { id: 't4', type: 'cake'  }, { id: 't5', type: 'cake'  },
      { id: 't6', type: 'cookie'},
      { id: 't7', type: 'carrot'},
      { id: 't8', type: 'star'  }, { id: 't9', type: 'star'  },
      { id: 't10', type: 'candy'},
      { id: 't11', type: 'blueberry'},
      { id: 't12', type: 'gem'  },
    ];
    await DB.openFeedingRoom(demo.id, 'demo_session', treats);
  }

  // Override PROJECT_ID for the rest of runtime
  Object.defineProperty(window, '_projectId', { value: demo.id, writable: true });
}

function getProjectId() {
  return window._projectId || PROJECT_ID;
}

// ── Scene setup ───────────────────────────────────────────────────────────────
function initScene() {
  document.getElementById('tb-pet-name').textContent = project.petName || 'Your Pet';
  document.getElementById('tb-project-name').textContent = (project.name || '').toUpperCase();
  document.getElementById('invite-code').textContent = project.inviteCode || '——';

  // Set canvas resolution
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Init pet position (center of scene)
  petX = SCENE_W() / 2;
  petY = SCENE_H() / 2;
  petTargetX = petX;
  petTargetY = petY;

  updateHealthBar(project.health || 0);
  startAnimation();
}

function resizeCanvas() {
  sceneCanvas.width  = sceneCanvas.clientWidth  || 700;
  sceneCanvas.height = sceneCanvas.clientHeight || 400;
}

// ── Subscribe to room ─────────────────────────────────────────────────────────
function subscribeToRoom() {
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = DB.onFeedingRoom(getProjectId(), (room) => {
    roomState = room;
    renderTreats(room);
    updateFedList(room);
    checkAllFed(room);
  });
}

// ── Render treat shelf (panel) ────────────────────────────────────────────────
function renderTreats(room) {
  if (!room) return;

  // Count unfed treats by type
  const counts = {};
  Object.values(room.treats || {}).forEach(t => {
    if (!t.fed) counts[t.type] = (counts[t.type] || 0) + 1;
  });

  // Update shelf
  treatShelf.innerHTML = '';
  TREAT_ORDER.forEach(tid => {
    const count = counts[tid] || 0;
    const treat = TREATS[tid];
    const stack = document.createElement('div');
    stack.className = `treat-stack${count === 0 ? ' depleted' : ''}`;
    stack.dataset.treatType = tid;
    stack.innerHTML = `
      <span class="stack-emoji">${treat.emoji}</span>
      <span class="stack-count">${count > 0 ? `×${count}` : '✓'}</span>
      <span class="stack-name">${treat.name}</span>
    `;

    if (count > 0) {
      // Make draggable from shelf
      stack.addEventListener('mousedown', (e) => startDragFromShelf(e, tid, treat.emoji));
      stack.addEventListener('touchstart', (e) => startDragFromShelf(e, tid, treat.emoji), { passive: false });
    }
    treatShelf.appendChild(stack);
  });
}

// ── Drag to feed ──────────────────────────────────────────────────────────────
let activeDrag = null;

function startDragFromShelf(e, treatType, emoji) {
  e.preventDefault();
  if (!roomState) return;

  // Find an unfed treat of this type
  const treatEntry = Object.entries(roomState.treats || {}).find(
    ([, t]) => t.type === treatType && !t.fed
  );
  if (!treatEntry) return;

  const [treatId] = treatEntry;

  // Create floating drag element
  const el = document.createElement('div');
  el.className = 'treat-draggable dragging';
  el.innerHTML = `<span>${emoji}</span><span class="treat-label">${TREATS[treatType].name}</span>`;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  el.style.left = `${clientX - 20}px`;
  el.style.top  = `${clientY - 20}px`;
  el.style.position = 'fixed';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);

  // Show feed zone around pet
  showFeedZone();

  activeDrag = { el, treatId, treatType, emoji };

  function onMove(ev) {
    const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
    el.style.left = `${cx - 20}px`;
    el.style.top  = `${cy - 20}px`;
    checkNearPet(cx, cy);
  }

  function onUp(ev) {
    const cx = ev.changedTouches ? ev.changedTouches[0].clientX : ev.clientX;
    const cy = ev.changedTouches ? ev.changedTouches[0].clientY : ev.clientY;
    el.remove();
    hideFeedZone();
    activeDrag = null;

    if (isNearPet(cx, cy)) {
      feedTreat(treatId, treatType);
    }
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

function getCanvasRect() {
  return sceneCanvas.getBoundingClientRect();
}

function isNearPet(clientX, clientY) {
  const rect = getCanvasRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const stage = getPetStage(project.health || 0);
  const petSize = 16 * stage.scale;
  const dx = cx - (petX + petSize / 2);
  const dy = cy - (petY + petSize / 2);
  return Math.sqrt(dx * dx + dy * dy) < 70;
}

function checkNearPet(clientX, clientY) {
  if (isNearPet(clientX, clientY)) {
    feedZone.style.borderColor = '#40E080';
  } else {
    feedZone.style.borderColor = 'var(--accent)';
  }
}

function showFeedZone() {
  const stage = getPetStage(project.health || 0);
  const petSize = 16 * stage.scale;
  const rect = getCanvasRect();
  const zoneSz = 80;
  feedZone.style.width  = `${zoneSz}px`;
  feedZone.style.height = `${zoneSz}px`;
  feedZone.style.left   = `${rect.left + petX + petSize / 2 - zoneSz / 2}px`;
  feedZone.style.top    = `${rect.top  + petY + petSize / 2 - zoneSz / 2}px`;
  feedZone.style.position = 'fixed';
  feedZone.classList.remove('hidden');
}

function hideFeedZone() { feedZone.classList.add('hidden'); }

// ── Actually feed the treat ───────────────────────────────────────────────────
async function feedTreat(treatId, treatType) {
  const ok = await DB.feedTreat(getProjectId(), treatId);
  if (!ok) return; // already fed (race condition)

  // Reload project for updated health
  project = await DB.getProject(getProjectId());

  // Happy animation
  petHappy  = 60;
  petEating = 30;

  // Show reaction
  showReaction(TREATS[treatType].emoji);

  // Update health bar
  const newHealth = project.health || 0;
  updateHealthBar(newHealth);

  // Check for growth stage change
  const prevStage = getPetStage(prevHealth);
  const newStage  = getPetStage(newHealth);
  if (newStage.stage > prevStage.stage) {
    showGrowthToast(newStage);
  }
  prevHealth = newHealth;
}

function showReaction(emoji) {
  const stage = getPetStage(project.health || 0);
  const petSize = 16 * stage.scale;
  const rect = getCanvasRect();
  petReaction.textContent = emoji;
  petReaction.style.left = `${rect.left + petX + petSize / 2 - 12}px`;
  petReaction.style.top  = `${rect.top  + petY - 10}px`;
  petReaction.style.position = 'fixed';
  petReaction.classList.remove('hidden');
  petReaction.style.animation = 'none';
  void petReaction.offsetWidth;
  petReaction.style.animation = '';
  setTimeout(() => petReaction.classList.add('hidden'), 1300);
}

// ── Fed list ──────────────────────────────────────────────────────────────────
function updateFedList(room) {
  if (!room) return;
  const fedTreats = Object.values(room.treats || {}).filter(t => t.fed);
  fedList.innerHTML = '';
  fedTreats.slice(-6).reverse().forEach(t => {
    const treat = TREATS[t.type];
    if (!treat) return;
    const item = document.createElement('div');
    item.className = 'fed-item';
    item.innerHTML = `
      <span class="fed-emoji">${treat.emoji}</span>
      <span>${treat.name} — <span class="fed-by">${t.fedBy || 'Someone'}</span></span>
    `;
    fedList.appendChild(item);
  });
}

// ── Check all fed ─────────────────────────────────────────────────────────────
function checkAllFed(room) {
  if (!room || celebrationShown) return;
  const treats = Object.values(room.treats || {});
  if (treats.length > 0 && treats.every(t => t.fed)) {
    celebrationShown = true;
    setTimeout(showCelebration, 600);
  }
}

function showCelebration() {
  const stage = getPetStage(project.health || 0);
  const celebCanvas = document.getElementById('cele-pet-canvas');
  celebCanvas.width  = 16 * 10;
  celebCanvas.height = 16 * 10;
  renderPet(celebCanvas.getContext('2d'), project.petIndex ?? 0, 0, 0, 10);
  celebration.classList.remove('hidden');
}

async function closeCelebration() {
  celebration.classList.add('hidden');
  cancelAnimationFrame(animRafId);
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  await DB.closeFeedingRoom(getProjectId());
  window.close();
}

// ── Health bar ────────────────────────────────────────────────────────────────
const MAX_HEALTH = 300;

function updateHealthBar(health) {
  const pct = Math.min(100, Math.round((health / MAX_HEALTH) * 100));
  healthFill.style.width = `${pct}%`;
  healthPct.textContent = pct;
  const stage = getPetStage(health);
  stageBadge.textContent = stage.label.toUpperCase();
  stageBadge.style.background = ['#C060FF','#40E080','#FFD040','#FF8040','#FF4060'][stage.stage] || '#C060FF';
}

// ── Growth toast ──────────────────────────────────────────────────────────────
function showGrowthToast(stage) {
  growthToast.querySelector('.toast-text').innerHTML =
    `${project.petName} grew into a<br>${stage.name} pet! 🌟`;
  growthToast.classList.remove('hidden');
  setTimeout(() => growthToast.classList.add('hidden'), 3500);
}

// ── Canvas backgrounds ────────────────────────────────────────────────────────
const BACKGROUNDS = {
  meadow:  drawMeadow,
  forest:  drawForest,
  beach:   drawBeach,
  office:  drawOffice,
  library: drawLibrary,
  city:    drawCity,
};

function drawBackground() {
  const bg = project?.background || 'meadow';
  const draw = BACKGROUNDS[bg] || drawMeadow;
  draw(ctx, sceneCanvas.width, sceneCanvas.height);
}

function drawMeadow(c, W, H) {
  const px = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  // Sky gradient (pixelated bands)
  const sky = ['#5090E0','#60A0F0','#70B0FF','#88C0FF'];
  const bandH = Math.floor(H * 0.55 / sky.length);
  sky.forEach((col, i) => px(0, i * bandH, W, bandH + 1, col));
  // Clouds (pixel rectangles)
  const clouds = [[60,30],[200,50],[380,20],[520,45],[650,35]];
  clouds.forEach(([cx,cy]) => {
    px(cx,    cy+4, 32, 8, '#FFFFFF'); px(cx+8,  cy,   24, 12,'#FFFFFF');
    px(cx+4,  cy+2, 32, 8, '#F0F0F0');
  });
  // Sun
  px(W-80, 20, 28, 28, '#FFE040'); px(W-86, 26, 8, 8, '#FFE040'); px(W-74, 14, 8, 8, '#FFE040');
  // Ground - dark and light green bands
  const gY = Math.floor(H * 0.55);
  px(0, gY,      W, 6,      '#3A8030'); // dark grass line
  px(0, gY+6,    W, H-gY-6, '#50A040'); // main grass
  // Grass tufts (small pixel groups)
  for (let gx = 0; gx < W; gx += 28) {
    px(gx,   gY-4, 4, 6, '#3A9030');
    px(gx+8, gY-6, 4, 8, '#2A8020');
    px(gx+16,gY-3, 4, 5, '#3A9030');
  }
  // Flowers
  const flowers = [[80,gY+20],[180,gY+35],[300,gY+15],[450,gY+28],[580,gY+22],[680,gY+40]];
  flowers.forEach(([fx,fy]) => {
    px(fx, fy, 4, 4, '#FF8040'); px(fx+4, fy-4, 4, 4, '#FF8040');
    px(fx+4, fy+4, 4, 4, '#FF8040'); px(fx-4, fy, 4, 4, '#FF8040');
    px(fx+4, fy, 4, 4, '#FFFF40');
  });
  // Path
  px(W/2-24, gY+8, 48, H-gY-8, '#C8A870');
  px(W/2-20, gY+8, 40, H-gY-8, '#D4B880');
}

function drawForest(c, W, H) {
  const px = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  // Sky (darker, through trees)
  px(0, 0, W, H * 0.5, '#1A3060');
  // Moon
  px(W - 100, 20, 24, 24, '#F0E8C0'); px(W - 96, 22, 16, 20, '#1A3060'); // crescent
  // Stars
  [[50,15],[120,30],[250,10],[400,25],[550,8],[650,20]].forEach(([x,y]) => px(x,y,3,3,'#FFFFFF'));
  // Trees (pixel art firs)
  const trees = [0, 80, 160, 300, 400, 520, 640, W-80];
  trees.forEach(tx => {
    const tH = 120 + Math.floor(Math.random() * 60);
    const tY = H * 0.45 - tH;
    // Trunk
    px(tx + 20, tY + tH - 20, 12, 20, '#5A3010');
    // Layers of branches (pyramid)
    for (let l = 0; l < 5; l++) {
      const lw = 8 + l * 12; const lh = 20;
      const ly = tY + l * 18;
      px(tx + 26 - lw/2, ly, lw, lh, l % 2 === 0 ? '#1A6020' : '#206828');
    }
  });
  // Ground
  const gY = Math.floor(H * 0.55);
  px(0, gY, W, H - gY, '#1A4018');
  px(0, gY, W, 8, '#103010');
  // Mushrooms
  [[140,gY+20],[380,gY+30],[520,gY+18]].forEach(([mx,my]) => {
    px(mx+4, my+8, 4, 10, '#C8B090'); px(mx,my,12,10,'#E03020'); px(mx+4,my+2,3,3,'#FFFFFF');
  });
}

function drawBeach(c, W, H) {
  const px = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  // Sky
  ['#F0A040','#F4B060','#F8C080','#FCD0A0'].forEach((col,i) => px(0,i*H*0.12,W,H*0.12+2,col));
  // Sun on horizon
  px(W/2-20, H*0.38, 40, 40, '#FFE040');
  // Ocean (bands)
  const oY = H * 0.5;
  px(0, oY,    W, 8,  '#2080C0');
  px(0, oY+8,  W, 10, '#3090D0');
  px(0, oY+18, W, 12, '#40A0E0');
  px(0, oY+30, W, H-oY-30, '#50B0F0');
  // Waves
  for (let wx = 0; wx < W; wx += 40) {
    px(wx, oY, 20, 4, '#80D0FF');
  }
  // Sand
  px(0, oY - 4, W, H - oY + 4, '#E8D090');
  px(0, oY - 4, W, 6, '#D4B870');
  // Palm tree
  px(80, H*0.25, 8, H*0.4, '#6A4010');
  [[-30,-20],[-20,-40],[0,-50],[20,-35],[30,-15]].forEach(([lx,ly]) => {
    px(84+lx, H*0.25+ly, 30, 12, '#2A8020');
    px(84+lx+4, H*0.25+ly-6, 20, 8, '#3A9030');
  });
  // Shells
  [[180,oY-10],[320,oY-6],[500,oY-8]].forEach(([sx,sy]) => {
    px(sx,sy,8,6,'#F0A080'); px(sx+3,sy+2,4,2,'#FFFFFF');
  });
}

function drawOffice(c, W, H) {
  const px = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  // Wall
  px(0, 0, W, H, '#E8E0D8');
  px(0, 0, W, 12, '#D0C8C0'); // ceiling
  // Window
  px(W-200, 20, 160, 120, '#A8D0F0');
  px(W-204, 16, 168, 128, '#6090A8'); // frame
  px(W-124, 16, 4, 128, '#6090A8');   // divider
  px(W-200, 76, 160, 4, '#6090A8');
  // Window view (city outside)
  px(W-199, 21, 158, 119, '#90C8E8');
  [[W-180,60,20,80],[W-155,80,16,60],[W-130,50,22,90]].forEach(([bx,by,bw,bh]) =>
    px(bx,by,bw,bh,'#5A7090')
  );
  // Floor
  px(0, H-40, W, 40, '#C0A878');
  for (let fx = 0; fx < W; fx += 60) px(fx, H-40, 3, 40, '#B09868');
  // Desk
  px(40, H-120, 280, 12, '#8B5E3C');
  px(40, H-108, 280, 80, '#A07040');
  px(40, H-28, 20, 28, '#6A4020'); px(280, H-28, 20, 28, '#6A4020');
  // Monitor
  px(120, H-200, 80, 60, '#1A1A2A');
  px(124, H-196, 72, 52, '#304060');
  px(156, H-140, 12, 32, '#3A3A3A'); px(144, H-108, 36, 6, '#3A3A3A');
  // Plant
  px(W-100, H-160, 20, 50, '#5A3010');
  [[W-112,H-200],[W-90,H-210],[W-104,H-220],[W-88,H-195]].forEach(([lx,ly]) =>
    px(lx,ly,24,18,'#2A8030')
  );
  // Coffee mug
  px(280, H-132, 20, 24, '#E0E0E0');
  px(300, H-128, 6, 14, '#E0E0E0');
  px(282, H-130, 16, 4, '#C03020');
}

function drawLibrary(c, W, H) {
  const px = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  px(0, 0, W, H, '#2A1E0E'); // dark wood walls
  px(0, H-30, W, 30, '#3A2A10'); // floor
  // Bookshelves
  const shelfCols = ['#8B2020','#204080','#208040','#804020','#602060','#606020'];
  [0, W/2].forEach(sx => {
    px(sx, 0, W/2, H-30, '#5A3A18');
    [0, 1, 2, 3].forEach(row => {
      const ry = row * (H/4);
      px(sx, ry + H/4 - 8, W/2, 8, '#3A2210'); // shelf plank
      let bx = sx + 8;
      for (let b = 0; b < 12; b++) {
        const bw = 14 + (b % 3) * 4;
        px(bx, ry + 10, bw, H/4 - 20, shelfCols[(b + row) % shelfCols.length]);
        px(bx+1, ry+12, bw-2, 6, 'rgba(255,255,255,0.08)'); // spine highlight
        bx += bw + 2;
        if (bx > sx + W/2 - 20) break;
      }
    });
  });
  // Warm lamp
  px(W/2 - 40, H - 200, 80, 8, '#FFD080');
  px(W/2 - 60, H - 192, 120, 6, '#E8B860');
  px(W/2 - 4, H - 186, 8, 156, '#5A3A18');
  px(W/2 - 24, H - 30, 48, 8, '#3A2210');
  // Reading area glow
  c.fillStyle = 'rgba(255,200,80,0.08)';
  c.fillRect(W/2 - 120, H - 220, 240, 190);
}

function drawCity(c, W, H) {
  const px = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  // Night sky
  px(0, 0, W, H, '#0A0818');
  // Stars
  for (let i = 0; i < 40; i++) {
    px(Math.floor(i*W/40), Math.floor(Math.sin(i*1.7)*30+40), 2, 2, '#E0D8FF');
  }
  // Moon
  px(W-80, 30, 36, 36, '#E8E0C0'); px(W-73, 33, 28, 30, '#0A0818'); // crescent
  // Buildings (skyline)
  const buildings = [
    [0,  180,80, '#1A1830'],[80, 140,60, '#201C3A'],[140,100,90, '#161428'],
    [230,160,70, '#201C3A'],[300,80, 100,'#1A1830'],[400,120,80, '#161428'],
    [480,150,90, '#201C3A'],[570,90, 80, '#1A1830'],[650,130,80, '#161428'],
    [W-80,160,80,'#201C3A'],
  ];
  buildings.forEach(([bx,by,bw,col]) => {
    px(bx, by, bw, H-by, col);
    // Windows
    for (let wy = by+10; wy < H-20; wy += 18) {
      for (let wx = bx+8; wx < bx+bw-8; wx += 16) {
        if (Math.random() > 0.4) px(wx, wy, 8, 10, '#FFD04055');
      }
    }
    // Antenna / water tower
    px(bx+bw/2-2, by-20, 4, 20, '#303048');
    px(bx+bw/2-1, by-24, 3, 3, '#FF2020');
  });
  // Street / rooftop edge
  px(0, H-40, W, 40, '#181620');
  px(0, H-42, W, 4, '#2A2838');
  // Street lights
  [100,300,500,700].forEach(lx => {
    px(lx, H-120, 4, 80, '#2A2838');
    px(lx-12, H-124, 28, 8, '#2A2838');
    px(lx-8, H-118, 8, 8, '#FFE08080');
    px(lx+8, H-118, 8, 8, '#FFE08080');
  });
}

// ── Draw pet (canvas) ─────────────────────────────────────────────────────────
function drawPetOnScene() {
  const stage = getPetStage(project?.health || 0);
  const scale = stage.scale;
  const petW  = 16 * scale;
  const petH  = 16 * scale;
  const pidx  = project?.petIndex ?? 0;

  ctx.save();

  // Happy bounce
  let offsetY = 0;
  if (petHappy > 0) {
    offsetY = -Math.abs(Math.sin((petHappy / 60) * Math.PI * 4)) * 10;
    petHappy--;
  } else {
    // Normal idle bob
    offsetY = Math.sin(petFrame * 0.04) * 3;
  }

  // Eating flash
  if (petEating > 0) {
    ctx.globalAlpha = 0.6 + Math.sin(petEating * 0.5) * 0.4;
    petEating--;
  }

  // Flip if facing left
  if (!petFacingRight) {
    ctx.translate(petX + petW, petY + offsetY);
    ctx.scale(-1, 1);
    renderPet(ctx, pidx, 0, 0, scale);
  } else {
    renderPet(ctx, pidx, petX, petY + offsetY, scale);
  }

  ctx.restore();

  // Stage label above pet
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(petX, petY + offsetY - 14, petW, 12);
  ctx.fillStyle = '#C060FF';
  ctx.font = '6px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(stage.label, petX + petW / 2, petY + offsetY - 4);
  ctx.textAlign = 'left';
}

// ── Pet AI movement ───────────────────────────────────────────────────────────
let petMoveTimer = 0;

function updatePetMovement() {
  const W = sceneCanvas.width;
  const H = sceneCanvas.height;
  const stage = getPetStage(project?.health || 0);
  const petSz = 16 * stage.scale;
  const margin = 40;
  const gY = Math.floor(H * 0.52); // ground level
  const maxY = H - petSz - 30;

  petMoveTimer--;
  if (petMoveTimer <= 0) {
    petMoveTimer = 80 + Math.floor(Math.random() * 120);
    petTargetX = margin + Math.random() * (W - margin * 2 - petSz);
    petTargetY = gY + Math.random() * (maxY - gY);
  }

  const speed = petHappy > 0 ? 4 : 1.5;
  const dx = petTargetX - petX;
  const dy = petTargetY - petY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > 2) {
    petFacingRight = dx > 0;
    petX += (dx / dist) * Math.min(speed, dist);
    petY += (dy / dist) * Math.min(speed, dist);
  }
}

// ── Main animation loop ───────────────────────────────────────────────────────
function startAnimation() {
  function loop() {
    petFrame++;
    sceneCanvas.width  = sceneCanvas.clientWidth  || 700;
    sceneCanvas.height = sceneCanvas.clientHeight || 400;

    drawBackground();
    updatePetMovement();
    drawPetOnScene();

    animRafId = requestAnimationFrame(loop);
  }
  loop();
}

// ── Done feeding ──────────────────────────────────────────────────────────────
async function doneFeedingRoom() {
  cancelAnimationFrame(animRafId);
  if (unsubscribeRoom) unsubscribeRoom();
  await DB.closeFeedingRoom(getProjectId());
  window.close();
}

// ── Copy invite code ──────────────────────────────────────────────────────────
function copyInviteCode() {
  const code = project?.inviteCode || '';
  const url  = `${location.origin}${location.pathname}?projectId=${getProjectId()}`;
  navigator.clipboard.writeText(`Join our Meeting Pet room! Code: ${code}\n${url}`).then(() => {
    const btn = document.getElementById('btn-copy-invite');
    btn.textContent = 'COPIED!';
    setTimeout(() => btn.textContent = 'COPY', 2000);
  });
}
