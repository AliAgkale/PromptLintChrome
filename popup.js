'use strict';
(async () => {
  // Read version from manifest — single source of truth (no more hardcoded string in popup.html)
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('version-label');
  if (versionEl && manifest.version) versionEl.textContent = 'v' + manifest.version;

  const toggle  = document.getElementById('enabled-toggle');
  const statusEl= document.getElementById('status-text');
  const debugToggle = document.getElementById('debug-toggle');
  const idleMsg = document.getElementById('idle-msg');
  const scoreCard= document.getElementById('score-card');
  const scoreDot = document.getElementById('score-dot');
  const scoreNum = document.getElementById('score-num');
  const scoreLbl = document.getElementById('score-label');
  const scoreBar = document.getElementById('score-bar');
  const scoreBarFill = document.getElementById('score-bar-fill');
  const scoreTok = document.getElementById('score-tokens');
  const intentPill= document.getElementById('intent-pill');

  // Debug mode: OFF by default. When off (the normal, public-release state),
  // only a colored dot is shown — no numeric score. Showing "82" vs "78" as
  // different colors/positions implies a precision the tool can't really
  // justify to a user, and erodes trust more than a plain traffic-light
  // signal does. The number is still computed internally and available for
  // anyone who explicitly opts into debug mode.
  const { debugMode } = await chrome.storage.sync.get(['debugMode']);
  let isDebug = debugMode === true;
  debugToggle.checked = isDebug;
  applyDebugDisplay(isDebug);

  debugToggle.addEventListener('change', async () => {
    isDebug = debugToggle.checked;
    await chrome.storage.sync.set({ debugMode: isDebug });
    applyDebugDisplay(isDebug);
  });

  function applyDebugDisplay(debug) {
    scoreDot.style.display = debug ? 'none' : 'block';
    scoreNum.style.display = debug ? 'block' : 'none';
    scoreBar.style.display = debug ? 'block' : 'none';
    scoreTok.style.display = debug ? 'block' : 'none';
  }

  // Load toggle state
  const { enabled } = await chrome.storage.sync.get(['enabled']);
  const isEnabled = enabled !== false;
  toggle.checked = isEnabled;
  statusEl.textContent = isEnabled ? 'Enabled' : 'Disabled';

  toggle.addEventListener('change', async () => {
    const v = toggle.checked;
    await chrome.storage.sync.set({ enabled: v });
    statusEl.textContent = v ? 'Enabled' : 'Disabled';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled: v }).catch(() => {});
  });

  // Fetch current result from content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_RESULT' }).catch(() => null);
    if (!result || typeof result.score !== 'number') return;

    idleMsg.style.display = 'none';
    scoreCard.style.display = 'flex';
    scoreCard.className = 'score-card ' + result.label;
    scoreNum.textContent = String(result.score);
    scoreLbl.textContent = result.label.toUpperCase();
    scoreBarFill.style.width = result.score + '%';
    if (result.tokens) scoreTok.textContent = result.tokens + ' tokens';

    const INTENT_LABELS = {
      translate:'🌐 Translate', summarize:'📝 Summarize', generate_code:'💻 Code',
      analyze:'🔍 Analyze', brainstorm:'💡 Brainstorm', classify:'🏷️ Classify',
      extract:'✂️ Extract', convert:'🔄 Convert', table:'📊 Table',
      json:'{ } JSON', explain:'📖 Explain', write:'✍️ Write', question:'❓ Question',
    };
    if (result.intent && result.intent !== 'other' && INTENT_LABELS[result.intent]) {
      intentPill.textContent = INTENT_LABELS[result.intent];
      intentPill.style.display = 'inline-block';
    }
  } catch {}
})();
