/**
 * PromptLint — codice del pannello (interfaccia del content script).
 *
 * ESTRATTO DA content.js. Fino a questo momento queste 900 righe esistevano
 * soltanto dentro il bundle compilato: non c'era nessun sorgente, in nessun
 * archivio. Chiunque avesse ricostruito content.js dal core con un normale
 * `tsup` le avrebbe cancellate senza accorgersene, e non sarebbero state
 * recuperabili.
 *
 * Questo file è ora IL sorgente. Si modifica qui, non dentro content.js.
 * Poi si esegue `node build.mjs`, che rifà il bundle unendo il motore
 * compilato a questo codice.
 *
 * Il frammento è volutamente privo di import/export e della chiusura della
 * IIFE: build.mjs lo incolla dentro `(function () { 'use strict'; … })();`
 * subito dopo il motore, così le funzioni del motore sono già in scope.
 */




  // ─── Platform adapters ──────────────────────────────────────────────────────
  const PLATFORMS = [
    {
      name: 'ChatGPT',
      // #prompt-textarea confirmed still in use as of July 2026 (referenced in
      // active forum threads/userscripts), despite the June 2026 "superapp"
      // redesign — kept as primary. Added common data-testid/aria hints as a
      // hedge in case that redesign reaches the composer itself; the scored
      // findBestInput() picker is the ultimate safety net either way.
      inputSelector: '#prompt-textarea, div[contenteditable="true"][data-slate-editor], [data-testid*="composer" i] [contenteditable="true"], textarea[aria-label*="message" i]',
      getText: el => el.tagName === 'TEXTAREA' ? el.value : (el.textContent ?? ''),
      matches: () => location.hostname.includes('chatgpt.com') || location.hostname.includes('chat.openai.com'),
      costModelId: 'gpt-4o',
      messageSelector: '[data-message-author-role]',
    },
    {
      name: 'Claude',
      inputSelector: '[contenteditable="true"].ProseMirror, div[contenteditable="true"][data-placeholder]',
      getText: el => el.textContent ?? '',
      matches: () => location.hostname.includes('claude.ai'),
      costModelId: 'claude-sonnet',
      messageSelector: '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-message',
    },
    {
      name: 'Gemini',
      // Broadened beyond the specific 'rich-textarea .ql-editor' class hint
      // (which may be stale after a redesign) — now also includes generic
      // contenteditable/textbox patterns. The shadow-DOM-aware queryAllDeep()
      // is what actually matters here: Gemini's <rich-textarea> is a custom
      // element that likely encapsulates its real input in a shadow root,
      // invisible to a plain document.querySelectorAll — found via user
      // testing ("Gemini doesn't work at all", not just "wrong element").
      inputSelector: 'rich-textarea .ql-editor, [contenteditable="true"].ql-editor, rich-textarea [contenteditable="true"], div[contenteditable="true"][aria-label], [role="textbox"]',
      getText: el => el.textContent ?? '',
      matches: () => location.hostname.includes('gemini.google.com') || location.hostname.includes('aistudio.google.com'),
      costModelId: 'gemini-flash',
      messageSelector: 'user-query, model-response',
    },
    {
      name: 'Perplexity',
      // Broadened further: rely primarily on the shadow-DOM-aware scored
      // picker rather than the "ask" placeholder hint, which may no longer
      // match if the composer's placeholder text changed — found via user
      // testing ("Perplexity doesn't work").
      inputSelector: 'textarea[placeholder*="ask" i], textarea, [contenteditable="true"][aria-label*="ask" i], div[contenteditable="true"], [role="textbox"]',
      getText: el => el.tagName === 'TEXTAREA' ? el.value : (el.textContent ?? ''),
      matches: () => location.hostname.includes('perplexity.ai'),
      costModelId: 'gpt-4o',
      messageSelector: '[class*="query"], [class*="answer"]',
    },
    {
      name: 'Copilot',
      // Previous selectors (#searchbox, textarea[name="q"]) were stale Bing
      // search-box IDs, unrelated to the modern Copilot chat composer — found
      // via user testing. Broadened to attribute/role-based hints; the scored
      // findBestInput() picker (see below) is the real safety net now, so this
      // selector doesn't need to be exact.
      inputSelector: 'textarea[placeholder*="Copilot" i], textarea[aria-label*="Copilot" i], textarea[placeholder*="ask" i], [contenteditable="true"][aria-label*="message" i], textarea, [contenteditable="true"]',
      getText: el => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : (el.textContent ?? ''),
      // m365.cloud.microsoft/chat is the current canonical URL for
      // Microsoft 365 Copilot Chat (enterprise) — it replaced
      // office.com/microsoft365.com in 2026 as part of Microsoft's
      // cloud.microsoft domain unification. copilot.microsoft.com still
      // redirects there but some tenants land directly on the new domain.
      matches: () => location.hostname.includes('copilot.microsoft.com')
        || location.hostname.includes('bing.com')
        || location.hostname.endsWith('cloud.microsoft'),
      costModelId: 'gpt-4o',
      messageSelector: null,
    },
    {
      name: 'Poe',
      inputSelector: 'textarea[class*="GrowingTextArea"], textarea[placeholder]',
      getText: el => el.value,
      matches: () => location.hostname.includes('poe.com'),
      costModelId: 'claude-sonnet',
      messageSelector: '[class*="Message_"]',
    },
    {
      name: 'Generic',
      inputSelector: 'textarea[rows], div[contenteditable="true"]',
      getText: el => el.tagName === 'TEXTAREA' ? el.value : (el.textContent ?? ''),
      matches: () => true,
      costModelId: 'claude-sonnet',
      messageSelector: null,
    },
  ];

  // ─── Conversation-turn detection ────────────────────────────────────────────
  // Count existing chat messages in the DOM to know whether the current input
  // is the FIRST message (fresh task — full structure rules apply) or a
  // FOLLOW-UP reply (rules for "missing role/format/length/example/context"
  // don't apply — see AnalyzeOptions.conversationTurn in promptlint-core).
  // Falls back to text-pattern auto-detection (isConversationalReply) when the
  // platform has no reliable message selector or none matched yet.
  function getConversationTurn() {
    if (!platform || !platform.messageSelector) return undefined;
    try {
      const count = document.querySelectorAll(platform.messageSelector).length;
      return count > 0 ? 'followup' : 'first';
    } catch {
      return undefined;
    }
  }

  function detectPlatform() {
    for (const p of PLATFORMS) if (p.name !== 'Generic' && p.matches()) return p;
    return PLATFORMS[PLATFORMS.length - 1];
  }

  // ─── Chrome language → SupportedLanguage ────────────────────────────────────
  function getDefaultLang() {
    const lang = (navigator.language || navigator.languages?.[0] || 'en').toLowerCase();
    return lang.startsWith('it') ? 'it' : 'en';
  }

  // uiLocale: the language EXPLANATIONS are shown in, driven by Chrome's own
  // UI language setting (chrome.i18n.getUILanguage()) — separate from
  // getDefaultLang() above, which only forces the PROMPT's own detected
  // content language. If Chrome's UI is Italian, explanations are Italian;
  // otherwise English. Falls back to navigator.language if the chrome.i18n
  // API isn't available for some reason.
  function getUILocale() {
    try {
      const lang = (chrome.i18n?.getUILanguage?.() || navigator.language || 'en').toLowerCase();
      return lang.startsWith('it') ? 'it' : 'en';
    } catch {
      return 'en';
    }
  }

  // ─── Robust input picking ───────────────────────────────────────────────────
  // Site-specific selectors are fragile: they break on every redesign (found via
  // user testing — Copilot's selector was stale Bing search-box IDs, Perplexity's
  // was too broad and could grab the wrong element). Instead of trusting the
  // FIRST DOM match, gather all visible candidates and score them by properties
  // that are stable across redesigns: size, position, placeholder wording,
  // whether they sit inside a header/nav (site search, not the chat composer).
  // Platform selectors are still used as a fast, high-confidence hint; this is
  // the safety net when they miss or a page changes its markup.
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 16) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) === 0) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  const INPUT_HINT_WORDS = /ask|message|chat|prompt|question|search|type|write|domanda|chiedi|scrivi|messaggio/i;

  function scoreCandidate(el) {
    const rect = el.getBoundingClientRect();
    let score = 0;
    // Larger elements are more likely the main composer than a tiny search box.
    score += Math.min((rect.width * rect.height) / 800, 150);
    // Chat composers usually sit in the lower half of the viewport.
    if (rect.top > window.innerHeight * 0.35) score += 60;
    // Elements inside header/nav are almost always site search, not the chat.
    if (el.closest('header, nav, [role="navigation"], [role="banner"]')) score -= 200;
    const hint = [
      el.getAttribute('placeholder'), el.getAttribute('aria-label'),
      el.getAttribute('data-placeholder'), el.getAttribute('title'),
    ].filter(Boolean).join(' ').toLowerCase();
    if (INPUT_HINT_WORDS.test(hint)) score += 100;
    if (el.tagName === 'TEXTAREA') {
      const rows = parseInt(el.getAttribute('rows') || '1', 10);
      score += Math.min(rows * 6, 40);
    }
    return score;
  }

  /** Recursively query selectors across the whole document AND into any open
   *  shadow roots. Modern web-component UIs (Gemini's `rich-textarea` custom
   *  element, and similar Angular/Lit-based composers) frequently encapsulate
   *  their real input inside a shadow root — plain document.querySelectorAll
   *  simply cannot see inside it, so the element is invisible to us even
   *  though it's on the page. This was a likely root cause for platforms
   *  reported as "not working at all" (as opposed to "wrong element picked",
   *  which the scored picker already handled) — found via user testing.
   *  Closed shadow roots (rare, used defensively by a few sites) genuinely
   *  cannot be pierced from a content script; that's a real, unavoidable
   *  limitation, not a bug in this code. */
  function queryAllDeep(selector, root = document) {
    let found = [];
    try { found = Array.from(root.querySelectorAll(selector)); } catch (e) { /* invalid selector on this root, skip */ }
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        found = found.concat(queryAllDeep(selector, el.shadowRoot));
      }
    }
    return found;
  }

  /** Pick the best visible candidate matching `selector`. Falls back through a
   *  broad generic selector set if the platform-specific one finds nothing
   *  visible — this is what lets an unlisted/redesigned site still work. */
  function findBestInput(selector) {
    const tryPick = (sel) => {
      const candidates = queryAllDeep(sel).filter(isVisible);
      if (candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0];
      return candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0];
    };
    return tryPick(selector)
      ?? tryPick('textarea, [contenteditable="true"], [role="textbox"]');
  }

  function waitForElement(selector, timeout = 12000) {
    return new Promise(resolve => {
      const el = findBestInput(selector);
      if (el) { resolve(el); return; }
      const obs = new MutationObserver(() => {
        const found = findBestInput(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
    });
  }

  // ─── State ──────────────────────────────────────────────────────────────────
  let lastResult   = null;
  let panelOpen    = false;
  let enabled      = true;
  let platform     = null;
  let debounceTimer = null;

  // ─── Intent labels ──────────────────────────────────────────────────────────
  const INTENT_LABELS = {
    translate: '🌐 Translate', summarize: '📝 Summarize',
    generate_code: '💻 Code',  analyze: '🔍 Analyze',
    brainstorm: '💡 Brainstorm', classify: '🏷️ Classify',
    extract: '✂️ Extract',    convert: '🔄 Convert',
    table: '📊 Table',        json: '{ } JSON',
    explain: '📖 Explain',    write: '✍️ Write',
    question: '❓ Question',  fix: '🔧 Fix',
    other: '',
  };

  // ─── Ghost text autocomplete ─────────────────────────────────────────────────
  let ghostEl = null;
  let pendingGhost = null;
  let ghostTimer = null;

  function ensureGhost() {
    if (ghostEl) return ghostEl;
    ghostEl = document.createElement('div');
    ghostEl.id = 'pl-ghost';
    Object.assign(ghostEl.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
      color: 'rgba(148,163,184,0.6)', fontStyle: 'italic',
      whiteSpace: 'pre', display: 'none',
    });
    document.body.appendChild(ghostEl);
    return ghostEl;
  }

  function getCursorRect(el) {
    if (el.tagName === 'TEXTAREA') {
      const r = el.getBoundingClientRect();
      return { top: r.top + 8, right: r.right - 8 };
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const rng = sel.getRangeAt(0).cloneRange();
    rng.collapse(false);
    const rects = rng.getClientRects();
    const r = rects[0];
    return r ? { top: r.top, right: r.right + 4 } : null;
  }

  function getTextAndCursor(el) {
    if (el.tagName === 'TEXTAREA') return { text: el.value, cursor: el.selectionStart ?? el.value.length };
    const text = platform ? platform.getText(el) : (el.textContent ?? '');
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { text, cursor: text.length };
    const rng = document.createRange();
    rng.selectNodeContents(el);
    rng.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return { text, cursor: rng.toString().length };
  }

  function showGhost(text, rect) {
    const el = ensureGhost();
    el.textContent = text;
    el.style.left = rect.right + 'px';
    el.style.top  = rect.top + 'px';
    el.style.display = 'block';
  }

  function hideGhost() {
    if (ghostEl) ghostEl.style.display = 'none';
    pendingGhost = null;
  }

  function applyGhost(el) {
    if (!pendingGhost) return;
    const { text } = getTextAndCursor(el);
    const { text: newText, cursorPos } = applyTabCompletion(text, pendingGhost);
    if (el.tagName === 'TEXTAREA') {
      el.value = newText;
      el.selectionStart = el.selectionEnd = cursorPos;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, newText);
    }
    hideGhost();
  }

  function scheduleGhost(el) {
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => {
      const { text, cursor } = getTextAndCursor(el);
      const suggestion = getTabCompletion(text, cursor);
      if (!suggestion) { hideGhost(); return; }
      const rect = getCursorRect(el);
      if (!rect) { hideGhost(); return; }
      pendingGhost = suggestion;
      showGhost(suggestion.ghostText, rect);
    }, 180);
  }

  // ─── Click-on-suggestion autocorrect ────────────────────────────────────────
  // When the user clicks a suggestion pill inside the panel, replace the
  // misspelled word in the active input automatically.
  let activeInput = null;


  // ─── Scaffold text insertion ─────────────────────────────────────────────
  // The composer is a <textarea> on some platforms and a contenteditable on
  // others; both need a synthetic input event or the host app never notices
  // the change. Kept separate from applySpellFix, which replaces a span at a
  // known offset — here we are rewriting the whole field.
  function getInputText(el) {
    if (!el) return '';
    return el.tagName === 'TEXTAREA' ? el.value : (el.textContent ?? '');
  }

  function setInputText(el, text) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA') {
      el.value = text;
      el.selectionStart = el.selectionEnd = text.length;
    } else {
      el.textContent = text;
      try {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      } catch { /* selection is best-effort */ }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  }

  function applySpellFix(el, original, corrected, offset) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA') {
      const val = el.value;
      // BUG FIX (found via user testing): the old code always searched
      // BACKWARDS from the current cursor position ("lastIndexOf ... at
      // selectionStart") to find the misspelled word. If the cursor wasn't
      // near the flagged word — extremely common, since opening the panel
      // and clicking a suggestion doesn't require the cursor to be there —
      // the search silently failed and clicking the pill did nothing at
      // all, with no visible error. Now we use the observation's own
      // precise offset (computed once, at analysis time, so it's exact)
      // when available, and only fall back to the cursor-relative guess if
      // for some reason no offset was passed.
      let idx;
      if (offset !== null && offset !== undefined && val.slice(offset, offset + original.length).toLowerCase() === original.toLowerCase()) {
        idx = offset;
      } else {
        idx = val.toLowerCase().lastIndexOf(original.toLowerCase(), el.selectionStart ?? val.length);
        if (idx === -1) idx = val.toLowerCase().indexOf(original.toLowerCase()); // last resort: first occurrence anywhere
      }
      if (idx === -1 || idx === undefined) return;
      el.value = val.slice(0, idx) + corrected + val.slice(idx + original.length);
      el.selectionStart = el.selectionEnd = idx + corrected.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const text = el.textContent ?? '';
      const lower = text.toLowerCase();
      let idx = (offset !== null && offset !== undefined && text.slice(offset, offset + original.length).toLowerCase() === original.toLowerCase())
        ? offset
        : lower.lastIndexOf(original.toLowerCase());
      if (idx === -1) return;
      const newText = text.slice(0, idx) + corrected + text.slice(idx + original.length);
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, newText);
    }
    // Re-run analysis after fix
    setTimeout(() => runAnalysis(platform ? platform.getText(el) : (el.textContent ?? '')), 50);
  }

  // ─── Toolbar ─────────────────────────────────────────────────────────────────
  function buildToolbar() {
    const el = document.createElement('div');
    el.id = 'pl-toolbar';
    el.className = 'pl-hidden';
    el.innerHTML = `
      <span class="pl-logo">⚡</span>
      <span class="pl-score-badge" id="pl-score-badge">—</span>
      <span class="pl-sep"></span>
      <span class="pl-tokens" id="pl-tokens">0 tok</span>
      <span class="pl-intent" id="pl-intent" style="display:none"></span>
      <span class="pl-issues" id="pl-issues">✓</span>
      <span class="pl-sep"></span>
      <button class="pl-btn" id="pl-open-panel">Details ▸</button>
      <button class="pl-btn pl-x-btn" id="pl-toggle" title="Hide">×</button>
    `;
    document.body.appendChild(el);
    return el;
  }

  // ─── Panel ───────────────────────────────────────────────────────────────────
  function buildPanel() {
    const el = document.createElement('div');
    el.id = 'pl-panel';
    el.innerHTML = `
      <div class="pl-panel-header">
        <span class="pl-logo">⚡</span>
        <span class="pl-panel-title">PromptLint</span>
        <span class="pl-panel-version">v${(chrome.runtime?.getManifest?.().version) ?? ''}</span>
        <button class="pl-x-btn" id="pl-close-panel">×</button>
      </div>
      <div class="pl-panel-body" id="pl-panel-body">
        <div class="pl-empty">
          <div class="pl-empty-icon">💡</div>
          <div class="pl-empty-title">Start typing a prompt</div>
          <div class="pl-empty-sub">Real-time analysis. No AI, no network.</div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    return el;
  }

  // ─── Structure checklist ─────────────────────────────────────────────────────
  function renderStructure(structure) {
    const items = [
      ['task',        '⚡ Task',        'Clear action verb'],
      ['role',        '🎭 Role',        'Model persona defined'],
      ['format',      '📋 Format',      'Output format specified'],
      ['length',      '📏 Length',      'Length constraint given'],
      ['examples',    '📌 Examples',    'Few-shot example provided'],
      ['constraints', '🔒 Constraints', 'Constraints or tone set'],
      ['context',     '🌍 Context',     'Purpose or audience stated'],
    ];
    const isSB = structure.selfBounding;
    return `<div class="pl-structure">${items.map(([key, label, hint]) => {
      const val = structure[key];
      const na  = isSB && (key === 'format' || key === 'length');
      const cls = na ? 'na' : val ? 'ok' : 'miss';
      const icon = na ? '—' : val ? '✔' : '⚠';
      return `<div class="pl-struct-row ${cls}">
        <span class="pl-struct-icon">${icon}</span>
        <span class="pl-struct-label">${label}</span>
        ${!val && !na ? `<span class="pl-struct-hint">${hint}</span>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  // ─── Panel rendering ──────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function scoreColor(label) {
    // 3-color scheme (green/yellow/red): showing 4 finely-graded colors
    // (excellent=green, good=blue, fair=yellow, poor=red) implied a
    // precision the tool can't really justify to a user — "why is 82
    // excellent-blue and 78 good-blue a different shade" isn't a question
    // worth answering. Collapsed excellent+good into green.
    return { excellent:'#4ade80', good:'#4ade80', fair:'#fbbf24', poor:'#f87171' }[label] ?? '#8892a4';
  }

  // Debug mode: OFF by default (the public-release state). When off, only a
  // colored dot + qualitative label is shown for the overall score — no
  // numeric total. The exact number is still computed internally (nothing
  // about the engine changes) and is available to anyone who explicitly
  // opts into debug mode from the popup. Loaded once at init, kept live via
  // storage.onChanged so toggling in the popup updates any open tab
  // immediately without a page reload.
  let debugMode = false;
  chrome.storage.sync.get(['debugMode']).then(r => { debugMode = r.debugMode === true; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.debugMode) {
      debugMode = changes.debugMode.newValue === true;
      if (lastResult) { renderPanel(lastResult); updateToolbar(lastResult); }
    }
  });

  // Token-cost ($ estimate) display disabled per product decision — token
  // COUNT is still shown, just not a currency estimate. Kept here, commented,
  // for easy re-enabling later instead of deleting the logic outright.
  /*
  function getCostForPlatform(costs) {
    if (!costs || costs.length === 0) return null;
    const modelId = platform?.costModelId;
    if (modelId) {
      const match = costs.find(c => c.model.id === modelId);
      if (match) return match;
    }
    // fallback: most expensive (= most likely the one the user is actually on)
    return costs[costs.length - 1];
  }
  */

  function renderPanel(result) {
    const body = document.getElementById('pl-panel-body');
    if (!body) return;
    if (!result || !result.text.trim()) {
      body.innerHTML = `<div class="pl-empty">
        <div class="pl-empty-icon">💡</div>
        <div class="pl-empty-title">Start typing a prompt</div>
        <div class="pl-empty-sub">Real-time analysis. No AI, no network.</div>
      </div>`;
      return;
    }
    const { score, tokens, observations, costs, potentialSavings, intent, conversational, scaffold } = result;
    const col = scoreColor(score.label);
    const intentLabel = INTENT_LABELS[intent] || '';
    // const platformCost = getCostForPlatform(costs); // token-cost display disabled per product decision (see stats row below)

    let html = '';
    if (conversational) {
      html += `<div class="pl-conv-badge">💬 Conversational reply — structure checks relaxed</div>`;
    }
    html += `<div class="pl-score-section">
      <div class="pl-score-row">
        ${debugMode
          ? `<div class="pl-score-big" style="color:${col}">${score.total}</div>`
          : `<div class="pl-score-dot-big" style="background:${col}"></div>`
        }
        <div class="pl-score-meta">
          <div class="pl-score-label" style="color:${col}">${score.label.toUpperCase()}</div>
          ${debugMode ? `<div class="pl-score-bar-track"><div class="pl-score-bar-fill" style="width:${score.total}%;background:${col}"></div></div>` : ''}
          <div class="pl-score-summary">${esc(score.summary)}</div>
        </div>
      </div>`;

    for (const dim of Object.values(score.dimensions)) {
      const c = scoreColor(dim.label);
      html += `<div class="pl-dim-row">
        <span class="pl-dim-name">${dim.name}</span>
        <div class="pl-dim-track"><div class="pl-dim-fill" style="width:${dim.score}%;background:${c}"></div></div>
        ${debugMode ? `<span class="pl-dim-val" style="color:${c}">${dim.score}</span>` : `<span class="pl-dim-dot" style="background:${c}"></span>`}
      </div>`;
    }
    html += '</div>';

    // Token COST display (dollar estimate) — commented out per product
    // decision: showing a $ estimate implied a precision/relevance that
    // wasn't earning its place in the UI. Token COUNT itself is kept (it's
    // not "cost", just a size indicator). To re-enable, uncomment the
    // platformCost line in the stat row below.
    html += `<div class="pl-stats-row">
      <div class="pl-stat">${tokens.tokenCount} <span>tokens</span></div>
      <div class="pl-stat">${tokens.wordCount} <span>words</span></div>
      ${/* platformCost ? `<div class=\"pl-stat\">${platformCost.formattedTotal} <span>${platformCost.model.name}</span></div>` : '' */ ''}
      ${potentialSavings > 0 ? `<div class="pl-stat pl-savings">-${potentialSavings} <span>tokens saved</span></div>` : ''}
      ${intentLabel ? `<div class="pl-stat pl-intent-stat">${intentLabel}</div>` : ''}
    </div>`;

    if (observations.length === 0) {
      // The clean line is a claim, and it must agree with the dot above it.
      // It used to print on any empty observation list, so a prompt the engine
      // itself scored 32 was shown as red and clean at the same time. The
      // engine's coverage work reduced the red case to 2 prompts in 1863, but
      // the middle band still hits this branch 154 times, where "no issues
      // found" is not true either — the score is low because something is
      // missing, and the panel simply has no name for it.
      html += score.label === 'good' || score.label === 'excellent'
        ? `<div class="pl-clean">✅ No issues found</div>`
        : `<div class="pl-unnamed">Nothing specific to flag — the prompt is just thin. Add the object to work on and one bound (a length, a format, or who it is for).</div>`;
    } else {
      html += `<div class="pl-section-title">Observations (${observations.length})</div><div class="pl-obs-list">`;
      for (const obs of observations) {
        const isSpell = obs.code === 'SPELL_001';
        const match = obs.matchText.startsWith('(') ? '' : `<span class="pl-obs-match">${esc(obs.matchText.slice(0,30))}</span>`;

        // Spell observations: show clickable suggestion pills
        let spellPills = '';
        // The message is localised ("Forse intendevi…" / "Did you mean…"), so
        // matching only the English form meant no pill ever rendered for an
        // Italian UI — the suggestions were computed and then thrown away.
        if (isSpell && obs.suggestion && /^(did you mean|forse intendevi)/i.test(obs.suggestion)) {
          const raw = obs.suggestion.replace(/Did you mean:?\s*/i,'').replace(/Forse intendevi:?\s*/i,'').replace(/\?$/,'');
          const words = raw.split(/,\s*/);
          spellPills = `<div class="pl-spell-pills">${words.map(w =>
            `<button class="pl-spell-pill" data-original="${esc(obs.matchText)}" data-corrected="${esc(w.trim())}" data-offset="${obs.offset}">${esc(w.trim())}</button>`
          ).join('')}</div>`;
        }

        const example = obs.example && !obs.example.after.startsWith('(')
          ? `<div class="pl-obs-example"><span class="before">✗ ${esc(obs.example.before)}</span><span class="after">✓ ${esc(obs.example.after)}</span></div>` : '';
        const impact = obs.impact.tokensSaved > 0
          ? `<div class="pl-obs-impact">-${obs.impact.tokensSaved} tok · ${obs.impact.impact}</div>` : '';

        html += `<div class="pl-obs-card">
          <div class="pl-obs-header" data-obs>
            <span class="pl-obs-dot ${obs.level}"></span>
            <span class="pl-obs-label">${esc(obs.label)}</span>
            ${match}
            <span class="pl-obs-code">${obs.code}</span>
          </div>
          <div class="pl-obs-body" style="display:none">
            <div class="pl-obs-why">${esc(obs.why)}</div>
            <div class="pl-obs-fix">${esc(obs.suggestion)}</div>
            ${spellPills}${example}${impact}
          </div>
        </div>`;
      }
      html += '</div>';
    }


    // ── Completa il prompt — HIDDEN IN v1.0.0 ─────────────────────────────
    //
    // The scaffold turns "what is missing" into a line you can edit, and it is
    // the feature most likely to bring people back. It is switched off for the
    // first release anyway.
    //
    // The reason is that its slot vocabularies — which questions to ask per
    // intent, and which values to offer — were chosen by hand and never
    // measured against anything. Everything else in this build has a number
    // behind it; this does not. Under real use it produced templates that
    // echoed the prompt back, asked code prompts for a length and an audience,
    // and offered values that did not fit. Some of that is fixed; the fact
    // that it needed fixing at all is the argument for holding it.
    //
    // The engine still computes it and `result.scaffold` is still populated,
    // so turning this back on is one flag. Ship it when the slot tables have
    // been validated the way the detectors were: against prompts, with a
    // measured precision, not against intuition.
    const SHOW_SCAFFOLD = false;
    if (SHOW_SCAFFOLD && scaffold && (scaffold.template || scaffold.slots.some(s => !s.filled))) {
      const missing = scaffold.slots.filter(s => !s.filled);
      const it = getUILocale() === 'it';
      html += `<div class="pl-section-title">${it ? 'Completa il prompt' : 'Complete the prompt'}
        <span class="pl-scaffold-count">${scaffold.filledCount}/${scaffold.totalCount}</span></div>`;
      if (scaffold.template) {
        html += `<div class="pl-scaffold-template">
          <code>${esc(scaffold.template)}</code>
          <button class="pl-scaffold-copy" data-template="${esc(scaffold.template)}">${it ? 'Copia' : 'Copy'}</button>
        </div>`;
      }
      html += '<div class="pl-scaffold-slots">';
      for (const sl of missing.slice(0, 4)) {
        html += `<div class="pl-scaffold-slot">
          <div class="pl-scaffold-slot-head">
            <span class="pl-scaffold-label">${esc(sl.label)}</span>
            <span class="pl-scaffold-why">${esc(sl.why)}</span>
          </div>
          <div class="pl-scaffold-opts">${sl.options.slice(0,4).map(o =>
            `<button class="pl-scaffold-opt" data-slot="${esc(sl.label)}" data-insert="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        </div>`;
      }
      html += '</div>';
    }

    html += `<div class="pl-section-title">Structure</div>${renderStructure(score.structure)}`;

    body.innerHTML = html;

    // Expand/collapse
    body.querySelectorAll('[data-obs]').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const b = hdr.nextElementSibling;
        if (b) b.style.display = b.style.display === 'none' ? 'block' : 'none';
      });
    });

    // Spell fix pills — click to apply
    body.querySelectorAll('.pl-spell-pill').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const original  = btn.dataset.original;
        const corrected = btn.dataset.corrected;
        const offset    = btn.dataset.offset !== undefined ? Number(btn.dataset.offset) : null;
        if (original && corrected && activeInput) applySpellFix(activeInput, original, corrected, offset);
      });
    });

    // Scaffold: copy the whole template into the composer. The blanks are left
    // as [label] on purpose — the user fills them, which is the point. Nothing
    // is auto-selected, so nobody accepts a requirement they did not choose.
    body.querySelectorAll('.pl-scaffold-copy').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const tpl = btn.dataset.template;
        if (tpl && activeInput) {
          setInputText(activeInput, tpl);
          btn.textContent = getUILocale() === 'it' ? 'Inserito' : 'Inserted';
          setTimeout(() => { btn.textContent = getUILocale() === 'it' ? 'Copia' : 'Copy'; }, 1400);
        }
      });
    });

    // Scaffold: a value fills the blank it belongs to. Appending it instead
    // produced "scrvi un prompt, un articolo, principianti, un CEO di
    // [lunghezza] per [per chi]." — four values glued on while the blanks they
    // were meant for sat there untouched, and the result still read as "good".
    body.querySelectorAll('.pl-scaffold-opt').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const v = btn.dataset.insert;
        const slot = btn.dataset.slot;
        if (!v || !activeInput) return;
        const cur = getInputText(activeInput);
        const blank = slot ? new RegExp('\\[\\s*' + slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\]') : null;

        if (blank && blank.test(cur)) {
          setInputText(activeInput, cur.replace(blank, v));
          return;
        }
        // No blank to fill — the user is typing freely, so offer the value at
        // the end rather than silently doing nothing.
        const trimmed = cur.replace(/\s+$/, '');
        const sep = !trimmed ? '' : /[.!?,;:]$/.test(trimmed) ? ' ' : ', ';
        setInputText(activeInput, trimmed + sep + v);
      });
    });
  }

  // ─── Toolbar update ───────────────────────────────────────────────────────────
  function updateToolbar(result) {
    const bar = document.getElementById('pl-toolbar');
    if (!bar) return;
    if (!result || !result.text.trim()) { bar.classList.add('pl-hidden'); return; }
    bar.classList.remove('pl-hidden');

    const badge = document.getElementById('pl-score-badge');
    if (badge) {
      badge.className = 'pl-score-badge ' + result.score.label + (debugMode ? '' : ' pl-dot-mode');
      badge.textContent = debugMode ? String(result.score.total) : '';
    }

    const tok = document.getElementById('pl-tokens');
    if (tok) tok.textContent = result.tokens.tokenCount + ' tok';

    const intentEl = document.getElementById('pl-intent');
    if (intentEl) {
      const lbl = INTENT_LABELS[result.intent] || '';
      intentEl.textContent = lbl;
      intentEl.style.display = lbl ? '' : 'none';
    }

    const issues = document.getElementById('pl-issues');
    if (issues) {
      const errs  = result.observations.filter(o => o.level === 'contradiction').length;
      const warns = result.observations.filter(o => o.level === 'unnecessary').length;
      const tips  = result.observations.filter(o => o.level === 'improvable').length;
      if (errs)       { issues.className='pl-issues err';  issues.textContent=`🔴 ${errs}`; }
      else if (warns) { issues.className='pl-issues warn'; issues.textContent=`🟠 ${warns+tips}`; }
      else if (tips)  { issues.className='pl-issues tip';  issues.textContent=`🟡 ${tips}`; }
      else            { issues.className='pl-issues clean'; issues.textContent='✓'; }
    }

    chrome.runtime.sendMessage({ type: 'ANALYSIS_RESULT', score: result.score.total, label: result.score.label }).catch(()=>{});
  }

  // ─── Analysis ─────────────────────────────────────────────────────────────────
  function runAnalysis(text) {
    if (!enabled || !text.trim()) {
      lastResult = null; updateToolbar(null);
      if (panelOpen) renderPanel(null);
      return;
    }
    // Pass Chrome language as forced language hint if auto-detect is uncertain
    const forcedLang = getDefaultLang();
    const conversationTurn = getConversationTurn();
    lastResult = analyze(text, {
      language: forcedLang === 'it' ? 'it' : undefined,
      conversationTurn,
      uiLocale: getUILocale(),
    });
    updateToolbar(lastResult);
    if (panelOpen) renderPanel(lastResult);
  }

  function scheduleAnalysis(text) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runAnalysis(text), 400);
  }

  // ─── Input wiring ──────────────────────────────────────────────────────────────
  const wired = new WeakSet();

  function wireInput(el) {
    if (wired.has(el)) return;
    wired.add(el);
    activeInput = el;

    const onInput = () => {
      const text = platform ? platform.getText(el) : (el.textContent ?? '');
      scheduleAnalysis(text);
      scheduleGhost(el);
    };

    el.addEventListener('input', onInput);
    el.addEventListener('keyup', onInput);
    if (el.tagName !== 'TEXTAREA') {
      new MutationObserver(() => {
        const text = platform ? platform.getText(el) : (el.textContent ?? '');
        scheduleAnalysis(text);
      }).observe(el, { childList: true, subtree: true, characterData: true });
    }

    el.addEventListener('keydown', e => {
      if (pendingGhost) {
        if (e.key === 'Tab')    { e.preventDefault(); e.stopPropagation(); applyGhost(el); return; }
        if (e.key === 'Escape') { hideGhost(); return; }
        if (!['Shift','Control','Alt','Meta'].includes(e.key)) hideGhost();
      }
    }, true);

    el.addEventListener('blur', hideGhost);
    el.addEventListener('click', () => scheduleGhost(el));
    el.addEventListener('focus', () => { activeInput = el; });

    const initial = platform ? platform.getText(el) : (el.textContent ?? '');
    if (initial.trim()) runAnalysis(initial);
  }

  // ─── Main ──────────────────────────────────────────────────────────────────────
  async function main() {
    const stored = await chrome.storage.sync.get(['enabled']);
    enabled = stored.enabled !== false;

    platform = detectPlatform();
    const inputEl = await waitForElement(platform.inputSelector, 15000);
    if (!inputEl) {
      console.warn(`[PromptLint] Nessuna casella di testo trovata su ${location.hostname} (piattaforma rilevata: ${platform.name}). Se questo sito dovrebbe essere supportato, segnala questo messaggio.`);
      return;
    }

    const toolbar = buildToolbar();
    const panel   = buildPanel();

    // Details button: toggle panel open/close
    document.getElementById('pl-open-panel')?.addEventListener('click', () => {
      panelOpen = !panelOpen;
      if (panelOpen) {
        panel.classList.add('pl-open');
        renderPanel(lastResult);
      } else {
        panel.classList.remove('pl-open');
      }
    });

    // Close button inside panel
    document.getElementById('pl-close-panel')?.addEventListener('click', () => {
      panelOpen = false;
      panel.classList.remove('pl-open');
    });

    // Hide toolbar button
    document.getElementById('pl-toggle')?.addEventListener('click', () => {
      enabled = false;
      chrome.storage.sync.set({ enabled: false });
      toolbar.classList.add('pl-hidden');
      panel.classList.remove('pl-open');
      panelOpen = false;
    });

    wireInput(inputEl);

    new MutationObserver(() => {
      const newEl = findBestInput(platform.inputSelector);
      if (newEl && !wired.has(newEl)) wireInput(newEl);
    }).observe(document.body, { childList: true, subtree: true });

    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.type === 'GET_RESULT') {
        reply(lastResult ? {
          score: lastResult.score.total,
          label: lastResult.score.label,
          tokens: lastResult.tokens.tokenCount,
          intent: lastResult.intent,
        } : null);
        return true;
      }
      if (msg.type === 'TOGGLE') {
        enabled = msg.enabled;
        if (!enabled) { toolbar.classList.add('pl-hidden'); panel.classList.remove('pl-open'); panelOpen = false; }
      }
    });
  }

  main().catch(console.error);
