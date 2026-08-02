# PromptLint — Chrome Extension

PromptLint analyses your prompt as you type, directly inside ChatGPT, Claude, Gemini and other supported AI platforms.

It runs entirely offline using deterministic rules—no network requests, no AI models, no cloud services.

A small indicator appears next to the input box, and opening the panel explains what is wrong with the prompt, why it matters, and how to improve it.

---

# `content.js` is a generated artifact

`content.js` should **never** be edited manually.

Always rebuild it with:

```bash
node build.mjs
```

This is not simply a style preference.

The bundle combines two independent codebases:

| Component | Source |
|-----------|--------|
| Analysis engine | `promptlint-core/src/index.chrome.ts` |
| User interface | `src-ui/panel.js` |

Both are merged into a single IIFE so the UI can directly access the analysis engine without imports.

Originally the panel only existed inside the compiled bundle. Rebuilding `content.js` directly from the core would permanently overwrite hundreds of lines of UI code. The panel source now lives in `src-ui/panel.js`, and `build.mjs` merges everything correctly.

If someone suggests "just rebuild the core and copy the generated bundle", **do not do it**—that procedure removes the entire UI.

---

# Building

```bash
node build.mjs                 # core located next to this repository
node build.mjs /path/to/core   # core located elsewhere

node --check content.js        # syntax validation
```

The build script refuses to overwrite `content.js` if any validation fails.

Each validation exists because it previously prevented a real production issue:

- both the analysis engine and UI are present
- the large Italian dictionary remains external (`dictionary.it.big.txt`) and is loaded on demand through `web_accessible_resources`
- the generated IIFE is properly closed
- no external dependencies remain inside the bundle

The last check is particularly important.

If `tsup` is executed from the command line instead of using the core's `tsup.config.ts`, the `noExternal: [/.*/]` configuration is ignored.

The bundle still compiles successfully and passes `node --check`, but it silently contains:

```javascript
import nspell from "nspell";
```

Content scripts cannot resolve bare imports, so the extension simply fails to start without any obvious error.

For this reason `build.mjs` always invokes `npx tsup` without command-line overrides.

---

## Reproducible builds

Given identical `node_modules`, the generated analysis engine is byte-for-byte reproducible.

The core repository includes a `package-lock.json`.

Use:

```bash
npm ci
```

instead of:

```bash
npm install
```

to ensure dependency resolution—and therefore the generated bundle—remains identical.

---

# Development installation

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder
5. Open any supported website and start typing

Supported websites include:

- ChatGPT
- Claude
- Gemini
- Google AI Studio
- Microsoft Copilot
- Bing
- Poe
- Perplexity
- Microsoft 365

Permissions:

- `storage`
- `activeTab`

The extension never performs network requests.

> **Note:** `homepage_url` in `manifest.json` is still a placeholder.

---

# Project structure

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3 configuration |
| `content.js` | Generated artifact combining engine and UI |
| `src-ui/panel.js` | Panel source code, DOM integration and state management |
| `content.css` | Panel and indicator styles |
| `popup.html`, `popup.js` | Extension popup (enable/disable, debug mode) |
| `background.js` | Service worker, default settings and badge updates |
| `dictionary.it.big.txt` | Large Italian dictionary loaded on demand |
| `build.mjs` | Rebuilds `content.js` |

---

# How it works

A `MutationObserver` attaches to the page's input field.

On every keystroke, the prompt is analysed locally by `analyze()`.

The engine returns:

- a score (0–100)
- a quality band
- a list of observations explaining detected issues

Extension settings such as enabled/disabled state and debug mode are stored in `chrome.storage.sync`.

---

# Where the score is shown

The current behaviour is intentionally inconsistent and represents an open product decision.

| Surface | Numeric score | Thresholds |
|----------|---------------|------------|
| Panel and indicator (default) | No | 66 / 45 |
| Panel (Debug Mode enabled) | Yes | 66 / 45 |
| Extension badge | Always | 80 / 60 / 40 |

The panel intentionally hides the numeric score.

With the current accuracy, the quality band communicates confidence more honestly than an exact number.

However, `background.js` always displays the raw score in the toolbar badge using different thresholds.

This can produce inconsistent feedback—for example, a prompt may appear **green** inside the panel while the extension badge remains **orange**.

Possible solutions include:

```javascript
chrome.action.setBadgeText({ tabId, text: '' });
```

or making the badge follow Debug Mode, or simply using the same thresholds as the panel.

This has intentionally been left as a product decision rather than an implementation bug.

---

# Scaffold UI

The scaffold interface is currently disabled.

```javascript
SHOW_SCAFFOLD = false
```

The analysis engine still computes `result.scaffold`, but the UI does not display it because the slot vocabularies have not yet been fully validated.

---

# Known issues

### Conversation context

The analysis engine evaluates follow-up prompts very differently from opening prompts.

Ensuring the extension correctly passes:

```javascript
conversationTurn: "followup"
```

whenever a conversation already exists is likely the highest-impact improvement still remaining.

Until this is fully verified, engine benchmark metrics should be considered slightly optimistic.

### Too many observations

Good prompts may still produce five or more suggestions.

Showing only the most relevant two would improve readability.

### Summary line

The message:

> Good prompt, but could be improved. Focus: precision.

appears for most prompts while adding little useful information.

### Extension badge

The badge behaviour described above still needs a final product decision.

---

# Additional documentation

Further information about the analysis engine, benchmarking methodology and evaluation criteria can be found in the core repository:

- `README.md`
- `CHANGELOG.md`
- `gold/CRITERIO.md`
