#!/usr/bin/env node
/**
 * Copies the app name from config.js into the files a phone reads *before* any JavaScript runs:
 * manifest.json (Android/desktop install name) and index.html (<title>, iOS home-screen title,
 * header fallback). Run `npm run sync:config` after editing EVENT_NAME / APP_SHORT_NAME.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** Evaluates our own config.js in a sandbox (it only assigns window.APP_CONFIG). */
function readConfig(file = path.join(ROOT, 'config.js')) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const cfg = sandbox.window.APP_CONFIG || {};
  const name = String(cfg.EVENT_NAME || '').trim();
  if (!name) throw new Error('config.js: EVENT_NAME is empty');
  return { name, shortName: String(cfg.APP_SHORT_NAME || '').trim() || name };
}

const escapeHtml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Rewrites only the top-level "name"/"short_name" values so the file's hand formatting is kept. */
function applyToManifest(json, { name, shortName }) {
  const set = (src, key, value) => {
    const re = new RegExp(String.raw`^(\s*"${key}"\s*:\s*)"(?:[^"\\]|\\.)*"`, 'm');
    if (!re.test(src)) throw new Error(`manifest.json: could not find "${key}"`);
    return src.replace(re, (_m, prefix) => `${prefix}${JSON.stringify(value)}`);
  };
  const out = set(set(json, 'name', name), 'short_name', shortName);
  JSON.parse(out); // fail loudly rather than ship a broken manifest
  return out;
}

function applyToIndex(html, { name, shortName }) {
  const replace = (src, re, value, what) => {
    if (!re.test(src)) throw new Error(`index.html: could not find ${what}`);
    return src.replace(re, (_m, open, close) => `${open}${value}${close}`);
  };
  let out = html;
  out = replace(out, /(<title>)[^<]*(<\/title>)/, escapeHtml(name), '<title>');
  out = replace(out, /(<meta name="apple-mobile-web-app-title" content=")[^"]*(" \/>)/, escapeHtml(shortName), 'apple-mobile-web-app-title');
  out = replace(out, /(<span id="app-title-text"[^>]*>)[^<]*(<\/span>)/, escapeHtml(name), '#app-title-text');
  return out;
}

function main() {
  const names = readConfig();
  const manifestPath = path.join(ROOT, 'manifest.json');
  const indexPath = path.join(ROOT, 'index.html');
  fs.writeFileSync(manifestPath, applyToManifest(fs.readFileSync(manifestPath, 'utf8'), names));
  fs.writeFileSync(indexPath, applyToIndex(fs.readFileSync(indexPath, 'utf8'), names));
  console.log(`App name → "${names.name}" (home screen: "${names.shortName}"). Bump CACHE_VERSION in service-worker.js before deploying.`);
}

if (require.main === module) main();

module.exports = { readConfig, applyToManifest, applyToIndex };
