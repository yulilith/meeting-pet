// Popup controller

// ── Chrome API shim (falls back to localStorage in browser preview) ───────────
const isExtension = typeof chrome !== 'undefined' && chrome.storage;

const Store = {
  async get(key) {
    if (isExtension) {
      return new Promise(res => chrome.storage.local.get(key, res));
    }
    try { return { [key]: JSON.parse(localStorage.getItem(key)) }; }
    catch { return { [key]: null }; }
  },
  async set(obj) {
    if (isExtension) {
      return new Promise(res => chrome.storage.local.set(obj, res));
    }
    Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
  },
};

function openTab(url) {
  if (isExtension) {
    chrome.tabs.create({ url: chrome.runtime.getURL(url) });
  } else {
    window.open(url, '_blank');
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let selectedPetIndex = null;
let animFrameId = null;
let timerInterval = null;
let meetingStartTime = null;

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  buildPetGrid();
  bindNavigation();

  const { currentSession } = await Store.get('currentSession');
  if (currentSession && currentSession.active) {
    showScreen('meeting');
    restoreMeetingScreen(currentSession);
  }
});

// ── Screen navigation ─────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

function bindNavigation() {
  document.getElementById('btn-choose-pet').addEventListener('click', () => showScreen('select'));

  document.getElementById('btn-settings').addEventListener('click', () => {
    if (isExtension) {
      chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
    } else {
      window.open('settings.html', '_blank');
    }
  });

  document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.target));
  });

  document.getElementById('btn-name-pet').addEventListener('click', () => {
    if (selectedPetIndex === null) return;
    showScreen('name');
    renderPreviewPet();
  });

  document.getElementById('btn-start-meeting').addEventListener('click', startMeeting);
  document.getElementById('btn-analyze').addEventListener('click', analyzeTranscript);
}

// ── Pet grid ──────────────────────────────────────────────────────────────────
function buildPetGrid() {
  const grid = document.getElementById('pet-grid');
  grid.innerHTML = '';
  PET_SPRITES.forEach((pet, index) => {
    const cell = document.createElement('div');
    cell.className = 'pet-cell';
    cell.title = pet.name;
    cell.appendChild(createPetCanvas(index, 3));
    cell.addEventListener('click', () => selectPet(index, cell));
    grid.appendChild(cell);
  });
}

function selectPet(index, cell) {
  document.querySelectorAll('.pet-cell').forEach(c => c.classList.remove('selected'));
  cell.classList.add('selected');
  selectedPetIndex = index;
  document.getElementById('selected-pet-name').textContent = PET_SPRITES[index].name.toUpperCase();
  document.getElementById('btn-name-pet').disabled = false;
}

// ── Preview ───────────────────────────────────────────────────────────────────
function renderPreviewPet() {
  const wrap = document.getElementById('preview-pet-canvas-wrap');
  wrap.innerHTML = '';
  if (selectedPetIndex === null) return;
  wrap.appendChild(createPetCanvas(selectedPetIndex, 6));
}

// ── Start meeting ─────────────────────────────────────────────────────────────
async function startMeeting() {
  const petName = document.getElementById('pet-name-input').value.trim()
    || PET_SPRITES[selectedPetIndex].name;
  const meetingTitle = document.getElementById('meeting-title-input').value.trim()
    || 'Team Meeting';

  const session = {
    active: true,
    petIndex: selectedPetIndex,
    petName,
    meetingTitle,
    startTime: Date.now(),
    treats: [],
    moments: [],
    analyzeCount: 0,
  };

  await Store.set({ currentSession: session });
  showScreen('meeting');
  restoreMeetingScreen(session);
}


function restoreMeetingScreen(session) {
  document.getElementById('meeting-title-display').textContent = session.meetingTitle || 'Team Meeting';
  document.getElementById('active-pet-name-display').textContent = session.petName || '';
  meetingStartTime = session.startTime;
  startTimer();
  startPetAnimation(session.petIndex);
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  clearInterval(timerInterval);
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

function updateTimer() {
  const el = document.getElementById('meeting-timer');
  const elapsed = Math.floor((Date.now() - meetingStartTime) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  el.textContent = `${m}:${s}`;
}

// ── Pet animation ─────────────────────────────────────────────────────────────
function startPetAnimation(petIndex) {
  cancelAnimationFrame(animFrameId);
  const canvas = document.getElementById('active-pet-canvas');
  let frame = 0;
  function loop() {
    renderPetAnimated(canvas, petIndex, 5, frame++);
    animFrameId = requestAnimationFrame(loop);
  }
  loop();
}

// ── Analyze transcript ────────────────────────────────────────────────────────
let _analyzing = false;

async function analyzeTranscript() {
  if (_analyzing) return;
  _analyzing = true;

  const textarea = document.getElementById('transcript-input');
  const transcript = textarea.value.trim();
  if (!transcript) { _analyzing = false; return; }

  const btn = document.getElementById('btn-analyze');
  const status = document.getElementById('analysis-status');
  btn.disabled = true;
  btn.textContent = '🐾 Analyzing...';
  status.textContent = '';
  status.className = 'analysis-status';

  try {
    let result;

    if (isExtension) {
      // Use background service worker in extension
      result = await chrome.runtime.sendMessage({ type: 'ANALYZE_TRANSCRIPT', transcript });
    } else {
      // Run analysis directly in preview mode
      result = await runAnalysisLocally(transcript);
    }

    if (result.error) {
      status.textContent = `Error: ${result.error}`;
      status.className = 'analysis-status error';
      btn.disabled = false;
      btn.textContent = '🐾 SUBMIT TO PET';
      _analyzing = false;
    } else {
      await endMeeting();
    }
  } catch (e) {
    status.textContent = 'Analysis failed — try again.';
    status.className = 'analysis-status error';
    btn.disabled = false;
    btn.textContent = '🐾 SUBMIT TO PET';
    _analyzing = false;
  }
}

async function runAnalysisLocally(transcript) {
  // Keyword-based analysis for preview mode (mirrors analyzer.js logic)
  const lower = transcript.toLowerCase();
  const patterns = [
    { treat: 'apple',     kws: [
      'what do you mean by', 'what do we mean by', 'what exactly do we mean',
      'does that mean', 'do you mean', 'what counts as', 'when we say',
      'does it include', 'does it mean no', 'just to clarify',
      'can you clarify', 'what exactly are we', 'can you explain',
    ]},
    { treat: 'cake',      kws: [
      'deadline', 'cutoff date', 'cutoff for', 'by when', 'when does the new',
      'when does this', 'when do we', 'how long do we have', 'target date',
      'go into effect', 'when are we', 'when is the', "when's the",
    ]},
    { treat: 'cookie',    kws: [
      "what's the process", 'how does the', 'who signs off', 'approval process',
      'how do we handle', 'who gets looped in', 'different approval path',
      'walk me through how', 'in parallel', 'sequentially', 'who owns',
    ]},
    { treat: 'carrot',    kws: [
      'let me translate', 'for this call,', "let's agree:",
      'standardize', 'two different things', 'in this context,',
      'from now on,', 'means the same', 'in other words',
      'what we mean by', 'to clarify for the whole group',
    ]},
    { treat: 'star',      kws: [
      'action item', "i'll take an action item", "i'll update", "i'll send",
      "i'll schedule", "i'll compile", "i'll draft", "i'll have that done",
      'will have that done by', 'by end of', 'by thursday', 'by friday',
      'by monday', 'sends qa', 'action item for me',
    ]},
    { treat: 'candy',     kws: [
      'both teams aligned', 'are both aligned', 'are aligned on',
      'are aligned —', 'are aligned.', 'both aligned', 'shared understanding',
      'no ambiguity', 'hard go-live', 'same page', 'we are aligned',
      'everyone aligned', 'both clear on',
    ]},
    { treat: 'blueberry', kws: [
      "let's schedule", "schedule a", "i'll send the invite",
      "let's do a follow-up", "let's set up", "i'll set up the meeting",
      "i'll send it today", 'schedule that for', 'follow-up review',
      "let's meet", 'circle back',
    ]},
    { treat: 'gem',       kws: [
      'we just resolved', 'just resolved', "i've corrected it",
      'stable now', 'this resolves', 'problem solved', 'we solved',
      'that solves it', 'resolved the', 'just realized',
      'pipeline is stable', 'fixed that right now',
    ]},
  ];

  const found = [];
  const moments = [];

  // Count all keyword occurrences per treat type across the transcript
  for (const { treat, kws } of patterns) {
    // Find all positions where any keyword matches
    const hits = [];
    for (const kw of kws) {
      let idx = 0;
      while ((idx = lower.indexOf(kw, idx)) !== -1) {
        hits.push({ kw, idx });
        idx += kw.length;
      }
    }
    if (hits.length === 0) continue;

    // Deduplicate: one treat per speaker line (different lines = different moments)
    hits.sort((a, b) => a.idx - b.idx);
    const seenLines = new Set();
    const deduped = [];
    for (const hit of hits) {
      const lineStart = transcript.lastIndexOf('\n', hit.idx);
      if (!seenLines.has(lineStart)) {
        seenLines.add(lineStart);
        deduped.push(hit);
      }
    }

    for (const { kw, idx } of deduped) {
      found.push(treat);
      // Extract the full line containing this keyword hit
      const lineStart = transcript.lastIndexOf('\n', idx);
      const lineEnd = transcript.indexOf('\n', idx + kw.length);
      const quote = transcript.slice(
        lineStart === -1 ? 0 : lineStart + 1,
        lineEnd === -1 ? transcript.length : lineEnd
      ).trim();
      moments.push({ treat, quote });
    }
  }

  // Save into session — replace, not append (submit = end meeting, one analysis per session)
  const { currentSession } = await Store.get('currentSession');
  if (currentSession) {
    currentSession.treats = found;
    currentSession.moments = moments;
    currentSession.analyzeCount = (currentSession.analyzeCount || 0) + 1;
    await Store.set({ currentSession });
  }

  return {
    ok: true,
    message: found.length > 0 ? 'Your pet noticed something interesting! 🐾' : 'Your pet is listening...',
  };
}

// ── End meeting ───────────────────────────────────────────────────────────────
async function endMeeting() {
  clearInterval(timerInterval);
  cancelAnimationFrame(animFrameId);

  const { currentSession } = await Store.get('currentSession');
  if (currentSession) {
    currentSession.active = false;
    currentSession.endTime = Date.now();
    await Store.set({ currentSession });
  }

  if (isExtension) {
    chrome.runtime.sendMessage({ type: 'OPEN_REVEAL' });
    window.close();
  } else {
    window.location.href = 'reveal.html';
  }
}
