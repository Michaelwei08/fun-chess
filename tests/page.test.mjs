// page.test.mjs -- the page is checked as text, with no browser and no DOM
// library. It guards the two things that break silently: the wiring between
// index.html and app.js, and the constraints the site imposes on any route it
// is willing to run a script on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const html = read('web/index.html');

// Every id app.js and panel.js look up by name, so a rename breaks the build
// here rather than in front of a visitor.
const REQUIRED_IDS = [
  'board', 'status-text', 'status-dot', 'eval-bar', 'eval-fill', 'eval-score',
  'move-list', 'move-count', 'level', 'new-game', 'undo', 'redo', 'flip', 'hint',
  'analysis-headline', 'analysis-lines', 'analysis-why', 'analysis-depth',
  'review-label', 'review-detail', 'fen-input', 'fen-load', 'fen-copy',
  'san-input', 'san-submit', 'promotion-dialog', 'captured-white', 'captured-black',
  'thinking', 'main-content',
];

test('every required id exists exactly once', () => {
  for (const id of REQUIRED_IDS) {
    const hits = html.match(new RegExp('id="' + id + '"', 'g')) || [];
    assert.equal(hits.length, 1, '#' + id + ' appears ' + hits.length + ' times');
  }
});

test('the ids app.js asks for are the ids the page defines', () => {
  const source = read('web/lib/app.js') + read('web/lib/panel.js');
  const asked = new Set();
  for (const match of source.matchAll(/(?:el|getElementById)\(\s*'([a-z-]+)'\s*\)/g)) asked.add(match[1]);
  for (const id of asked) {
    assert.ok(html.includes('id="' + id + '"'), 'app.js reads #' + id + ' but index.html has no such element');
  }
  assert.ok(asked.size >= 20, 'expected the controller to bind the whole panel, found ' + asked.size);
});

test('the controls carry the attributes the controller binds to', () => {
  for (const value of ['play', 'record']) {
    assert.ok(html.includes('data-mode="' + value + '"'), 'missing data-mode=' + value);
  }
  for (const value of ['white', 'black']) {
    assert.ok(html.includes('data-side="' + value + '"'), 'missing data-side=' + value);
  }
  for (const value of ['q', 'r', 'b', 'n']) {
    assert.ok(html.includes('data-promo="' + value + '"'), 'missing data-promo=' + value);
  }
  for (const level of ['casual', 'club', 'focused', 'deep']) {
    assert.ok(html.includes('value="' + level + '"'), 'the level select is missing ' + level);
  }
});

test('the module script is the only script and it comes last', () => {
  const scripts = html.match(/<script[^>]*>/g) || [];
  assert.equal(scripts.length, 1, 'exactly one script tag');
  assert.match(scripts[0], /type="module"/);
  assert.match(scripts[0], /src="\.\/lib\/app\.js"/);
  const tail = html.slice(html.indexOf(scripts[0]));
  assert.ok(!/<(div|section|main|aside)\b/.test(tail), 'the script must be the last element in the body');
});

test('nothing on the page violates the site content security policy', () => {
  assert.ok(!/\son[a-z]+\s*=/.test(html), 'inline event handlers are blocked by script-src');
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    assert.equal(match[1].trim(), '', 'inline script bodies are blocked by script-src');
  }
  assert.ok(!/javascript:/i.test(html), 'javascript: urls are blocked');
  // Remote FETCHES would need img-src / font-src / connect-src, all 'none'.
  // Absolute URLs in canonical and Open Graph metadata are fine: nothing loads
  // them, and the site needs them to point at the production route.
  const remote = [
    ...html.matchAll(/<(?:script|img|iframe|source|audio|video)[^>]*\ssrc="[^"]*\/\/[^"]*"/g),
    ...html.matchAll(/<link[^>]*rel="(?:stylesheet|preload|icon|apple-touch-icon)"[^>]*href="[^"]*\/\/[^"]*"/g),
  ].map((match) => match[0]);
  assert.deepEqual(remote, [], 'remote resources: ' + remote.join(', '));
  for (const file of ['web/chess.css', 'web/chess-board.css']) {
    const css = read(file);
    assert.ok(!/url\(\s*['"]?https?:/.test(css), file + ' loads a remote url');
    assert.ok(!/@import/.test(css), file + ' uses @import');
  }
});

test('no source file exceeds the 300-line site cap', () => {
  const files = [
    ...readdirSync(join(ROOT, 'web/lib')).map((name) => 'web/lib/' + name),
    'web/index.html', 'web/chess.css', 'web/chess-stage.css',
    'web/chess-panel.css', 'web/chess-board.css',
  ];
  const over = files
    .map((file) => [file, read(file).split('\n').length])
    .filter(([, lines]) => lines > 300);
  assert.deepEqual(over, [], 'over the cap: ' + JSON.stringify(over));
});

test('the engine modules are free of browser globals, and the UI of node ones', () => {
  // Comments are stripped first: prose about "a full window." is not a global.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const engineFiles = ['rules.js', 'fen.js', 'tables.js', 'notation.js', 'eval.js',
    'engine.js', 'search.js', 'explain.js', 'order.js'];
  for (const file of engineFiles) {
    // engine.js reads document.hidden to decide whether yielding is worth it.
    // That is a scheduling hint behind a feature test, not DOM access, and it
    // is the one exception; everything else here has to run headless.
    const source = stripComments(read('web/lib/' + file)).replace(/document\.hidden/g, '');
    assert.ok(!/\b(document|window|localStorage|navigator)\s*\./.test(source),
      file + ' touches the DOM; it must run under node too');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|new Worker/.test(source), file + ' tries to leave the page');
  }
  for (const file of ['app.js', 'panel.js', 'board-view.js']) {
    assert.ok(!/require\(|process\./.test(read('web/lib/' + file)), file + ' assumes node');
  }
});

test('every source file is plain ASCII with no byte order mark', () => {
  // PowerShell's Set-Content -Encoding utf8 writes a BOM, and the workspace keeps
  // source ASCII for exactly that reason. Piece glyphs are built from char codes
  // in notation.js rather than pasted in.
  const files = [
    ...readdirSync(join(ROOT, 'web/lib')).map((name) => 'web/lib/' + name),
    ...readdirSync(join(ROOT, 'tests')).map((name) => 'tests/' + name),
    'web/index.html', 'web/chess.css', 'web/chess-stage.css',
    'web/chess-panel.css', 'web/chess-board.css', 'scripts/bench.mjs', 'scripts/sync_site.py',
  ];
  for (const file of files) {
    const bytes = readFileSync(join(ROOT, file));
    const offender = bytes.findIndex((byte) => byte > 127);
    assert.equal(offender, -1,
      file + ' has a non-ASCII byte at offset ' + offender +
      (offender === 0 ? ' (byte order mark)' : ''));
  }
});

test('the vendored base.css still matches the site copy', () => {
  // Not a hard failure if the site is not checked out next to this project.
  let site;
  try {
    site = readFileSync(
      new URL('../../../personal_website/base.css', import.meta.url), 'utf8');
  } catch { return; }
  assert.equal(read('web/base.css'), site,
    'web/base.css has drifted from personal_website/base.css; re-copy it rather than editing here');
});
