'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readConfig, applyToManifest, applyToIndex } = require('../scripts/sync-config.js');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('manifest.json and index.html carry the app name from config.js (run npm run sync:config)', () => {
  const names = readConfig();
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.name, names.name);
  assert.equal(manifest.short_name, names.shortName);
  assert.equal(applyToIndex(read('index.html'), names), read('index.html'));
});

test('sync: replaces only the name fields and escapes HTML', () => {
  const names = { name: 'A & B <Wedding>', shortName: 'A&B' };
  const src = '{\n  "name": "x",\n  "short_name": "y",\n  "theme_color": "#000"\n}\n';
  const manifest = JSON.parse(applyToManifest(src, names));
  assert.deepEqual(manifest, { name: names.name, short_name: 'A&B', theme_color: '#000' });
  assert.throws(() => applyToManifest('{"theme_color":"#000"}', names), /could not find "name"/);

  const html = '<title>x</title>\n<meta name="apple-mobile-web-app-title" content="y" />\n<h1><span id="app-title-text" class="t">z</span></h1>';
  const out = applyToIndex(html, names);
  assert.match(out, /<title>A &amp; B &lt;Wedding&gt;<\/title>/);
  assert.match(out, /content="A&amp;B" \/>/);
  assert.match(out, /class="t">A &amp; B &lt;Wedding&gt;<\/span>/);
  assert.throws(() => applyToIndex('<p>no title</p>', names), /could not find/);
});
