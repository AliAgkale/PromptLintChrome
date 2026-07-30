#!/usr/bin/env node
/**
 * Ricostruisce content.js.
 *
 * content.js NON si modifica a mano. È un artefatto, e si compone di due parti
 * con due sorgenti diversi:
 *
 *   1. il motore   → compilato da ../../core/promptlint-core-v3/src/index.chrome.ts
 *   2. il pannello → src-ui/panel.js, in questa cartella
 *
 * Le due parti finiscono dentro una IIFE unica, così il pannello vede le
 * funzioni del motore senza passare da import. È il motivo per cui non basta
 * lanciare tsup e copiare l'output: farlo cancellerebbe il pannello.
 *
 *   node build.mjs                 usa il core accanto a questa cartella
 *   node build.mjs /percorso/core  usa un core altrove
 *
 * Verifica: lo script rifiuta di scrivere se l'output non contiene il fetch di
 * dictionary.it.big.txt o se il pannello si è perso per strada. Un bundle
 * scritto male non dà errori a runtime: smette semplicemente di funzionare
 * sulla pagina, che è il modo peggiore per accorgersene.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = resolve(process.argv[2] ?? join(here, '..', '..', 'core', 'promptlint-core-v3'));

if (!existsSync(join(core, 'src', 'index.chrome.ts'))) {
  console.error(`Core non trovato in ${core}`);
  console.error('Passa il percorso: node build.mjs /percorso/a/promptlint-core-v3');
  process.exit(1);
}

console.log(`core:   ${core}`);
console.log('compilo il motore…');
// Si usa tsup.config.ts del core, NON argomenti da riga di comando.
// Il config contiene `noExternal: [/.*/]` per questa entry, che è ciò che
// inlina nspell dentro il bundle. Invocando tsup con --format/--out-dir quel
// campo può non venire applicato: il risultato compila, passa `node --check`,
// ed è 33 KB più piccolo perché contiene ancora `import nspell from "nspell"`.
// Un import nudo dentro un content script non si risolve, quindi l'estensione
// non parte del tutto — e nulla lo segnala. È successo davvero.
execSync('npx tsup', { cwd: core, stdio: 'inherit' });
const built = join(core, 'dist', 'index.chrome.js');
if (!existsSync(built)) {
  console.error(`Build non trovata in ${built}`);
  process.exit(1);
}

// tsup emette un modulo ESM; dentro la IIFE gli export non servono e sarebbero
// un errore di sintassi.
const engine = readFileSync(built, 'utf8').replace(/\nexport \{[\s\S]*$/, '');
const panel = readFileSync(join(here, 'src-ui', 'panel.js'), 'utf8');

const bundle = `(function () {\n  'use strict';\n${engine}\n${panel}\n})();\n`;

// ── controlli prima di scrivere ────────────────────────────────────────────
const checks = [
  ['il motore è presente', () => bundle.includes('function analyze')],
  ['il pannello è presente', () => bundle.includes('pl-panel') && bundle.length - engine.length > 20000],
  ['il dizionario grande resta esterno', () => bundle.includes('dictionary.it.big.txt')],
  ['la IIFE è chiusa', () => bundle.trimEnd().endsWith('})();')],
  // Il controllo che sarebbe servito la prima volta. Un import rimasto nudo
  // non è un errore di sintassi e non si vede finché non si carica
  // l'estensione e non succede niente.
  ['nessuna dipendenza esterna rimasta',
    () => !/^\s*import\s+[^(]/m.test(bundle) && !/\brequire\(['"][^.]/.test(bundle)],
  ['nspell è inlinato', () => bundle.includes('EN_AFF') && bundle.includes('EN_DIC')],
];
let ok = true;
for (const [name, fn] of checks) {
  const pass = fn();
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  if (!pass) ok = false;
}
if (!ok) {
  console.error('\nControlli falliti: content.js NON è stato scritto.');
  process.exit(1);
}

writeFileSync(join(here, 'content.js'), bundle);
console.log(`\ncontent.js scritto — ${(bundle.length / 1048576).toFixed(2)} MB`);
console.log('Verifica la sintassi con:  node --check content.js');
