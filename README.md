# PromptLint — estensione Chrome

Analizza il prompt mentre lo scrivi, dentro la pagina di ChatGPT, Claude, Gemini e altri.
Offline, senza rete, senza modelli: solo regole deterministiche. Mostra un indicatore accanto al
campo di input e, aprendo il pannello, cosa non funziona e come sistemarlo.

Motore: `promptlint-core` 3.0.0. Estensione: 1.0.0.

---

## `content.js` è un artefatto: non si modifica a mano

Si ricostruisce con `node build.mjs`. Il motivo non è di stile — il file contiene due cose con
due sorgenti diversi:

| parte | dimensione | sorgente |
|---|---|---|
| motore di analisi | ~1,14 MB | `promptlint-core-v3/src/index.chrome.ts` |
| pannello (interfaccia) | ~40 KB | **`src-ui/panel.js`, in questa cartella** |

Le due parti vivono dentro una IIFE unica, così il pannello vede le funzioni del motore senza
passare da `import`.

Per un periodo il pannello è esistito **soltanto** dentro il bundle compilato, senza sorgente in
nessun archivio: ricostruire `content.js` dal core con un normale `tsup` avrebbe cancellato
novecento righe di interfaccia in modo non recuperabile. Ora sono in `src-ui/panel.js` e
`build.mjs` le rimette al loro posto. Se qualcuno ti dice di "ricompilare il core e copiare il
`dist`", quella è la procedura che distrugge il pannello.

## Build

```bash
node build.mjs                 # core accanto a questa cartella
node build.mjs /percorso/core  # core altrove
node --check content.js        # sintassi
```

Lo script non scrive il file se un controllo fallisce. Vale la pena sapere perché ciascuno
esiste:

- **il motore è presente**, **il pannello è presente** — un errore di splice perde una metà in
  silenzio
- **il dizionario grande resta esterno** — `dictionary.it.big.txt` (3,7 MB) è caricato a
  richiesta via `web_accessible_resources`, non inlinato
- **la IIFE è chiusa**
- **nessuna dipendenza esterna rimasta**, **nspell è inlinato** — questi due nascono da un
  errore reale. Invocando `tsup` con argomenti da riga di comando invece del `tsup.config.ts`
  del core, il campo `noExternal: [/.*/]` non viene applicato: il bundle compila, passa
  `node --check`, è 33 KB più piccolo, e contiene ancora `import nspell from "nspell"`. Un
  import nudo dentro un content script non si risolve, quindi **l'estensione non parte affatto**
  e nulla lo segnala. Per questo `build.mjs` invoca `npx tsup` senza argomenti.

**Riproducibilità.** A parità di `node_modules` il motore compilato è byte per byte identico fra
build successive. Il core ha un `package-lock.json`: usa `npm ci`. Con `npm install` la
risoluzione delle dipendenze può cambiare, e con essa il bundle.

---

## Installazione in sviluppo

1. `chrome://extensions`
2. attiva **Modalità sviluppatore**
3. **Carica estensione non pacchettizzata**, scegli questa cartella
4. apri una pagina supportata e comincia a scrivere

Siti in `manifest.json`: ChatGPT, chat.openai.com, Claude, Gemini, AI Studio, Copilot, Bing,
Poe, Perplexity, M365. Permessi: `storage`, `activeTab`. Nessuna richiesta di rete, in nessun
momento.

`homepage_url` nel manifest è ancora il segnaposto `github.com/your-username/promptlint`.

---

## File

| file | cosa è |
|---|---|
| `manifest.json` | manifest v3 |
| `content.js` | **artefatto** — motore + pannello, prodotto da `build.mjs` |
| `src-ui/panel.js` | sorgente del pannello: DOM, stato, aggancio all'input |
| `content.css` | stili del pannello e dell'indicatore |
| `popup.html`, `popup.js` | popup della barra: interruttore on/off e interruttore debug |
| `background.js` | service worker: imposta `enabled` all'installazione e aggiorna il badge |
| `dictionary.it.big.txt` | dizionario italiano, 3,7 MB, caricato a richiesta |
| `build.mjs` | ricostruisce `content.js` |

---

## Come funziona

Un `MutationObserver` aggancia il campo di input della pagina. A ogni battitura il testo passa
ad `analyze()`, che gira interamente in locale e restituisce un punteggio 0-100, una banda e una
lista di osservazioni. Lo stato on/off e il debug stanno in `chrome.storage.sync`.

### Dove il numero si vede e dove no

Questo punto è importante e attualmente **incoerente**.

| superficie | mostra il numero? | soglie |
|---|---|---|
| pannello e indicatore, `debugMode` off (default) | no: pallino colorato + etichetta | 66 / 45 |
| pannello, `debugMode` on (interruttore nel popup) | sì: numero, barra, valori per dimensione | 66 / 45 |
| **badge sull'icona dell'estensione** | **sì, sempre** | **80 / 60 / 40** |

Il pannello nasconde il numero per scelta: con la precisione attuale della banda buona (73% sul
gold set) due cifre comunicherebbero una precisione che il motore non ha, mentre tre bande sono
oneste. Ma `background.js` scrive il punteggio grezzo sul badge senza guardare `debugMode`, e con
soglie sue: un prompt da 62 ha il **badge arancione e il pallino verde**.

Va deciso, non lasciato così. Le opzioni:

```js
// background.js — allineare il badge al pannello (una riga)
chrome.action.setBadgeText({ tabId, text: '' });   // il badge tace
// oppure rispettare debugMode, oppure usare 66/45 al posto di 80/60/40
```

Non l'ho cambiato perché è una decisione di prodotto, non un bug di implementazione.

### Lo scaffold è spento

`SHOW_SCAFFOLD = false` in `src-ui/panel.js`. Il motore lo calcola e `result.scaffold` è
popolato, ma non viene disegnato: i vocabolari degli slot non sono stati validati. Riaccenderlo
richiede il lavoro descritto come Priorità 4 nel core.

---

## Stato noto

- **La versione non è stata aggiornata** nonostante il lavoro sul motore. Quando rilasciare non
  è una decisione dello sviluppo.
- **`conversationTurn`.** Il motore valuta un follow-up in modo molto diverso da una prima
  battuta — fino a 65 punti sullo stesso testo. Verificare che il pannello passi sempre
  `conversationTurn: 'followup'` quando la conversazione ha già dei messaggi è la cosa a più alto
  rendimento e più basso costo che resti da fare, e finché non è verificata tutte le metriche del
  core sono ottimistiche.
- **Volume dei suggerimenti.** Su un prompt valutato buono possono comparire cinque osservazioni.
  Il pannello le mostra tutte; due basterebbero.
- **La riga di riepilogo.** `Buon prompt, migliorabile. Focus: precisione.` compare su quasi
  ogni prompt e non porta informazione.
- **Il badge**, sopra.

Metriche del motore, criterio di valutazione e cronologia: `CHANGELOG.md`, `README.md` e
`gold/CRITERIO.md` nel core.
