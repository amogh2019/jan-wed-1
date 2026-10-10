/* Loads backend/Code.gs into a Node vm with in-memory mocks of the Apps Script services. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function makeToken(email, { aud = CLIENT_ID, expIn = 3600, name = 'Test User' } = {}) {
  const claims = { iss: 'https://accounts.google.com', aud, email, email_verified: true, name, exp: Math.floor(Date.now() / 1000) + expIn };
  return { token: `${b64url({ alg: 'RS256' })}.${b64url(claims)}.c2ln`, claims };
}

function makeSheet(name, rows) {
  const data = rows.map((r) => r.slice());
  const width = () => data.reduce((m, r) => Math.max(m, r.length), 0);
  const sheet = {
    name, data, validations: {}, frozen: 0,
    getDataRange: () => ({ getValues: () => data.map((r) => { const o = r.slice(); while (o.length < width()) o.push(''); return o.map((v) => (v === undefined ? '' : v)); }) }),
    getRange: (r, c, nr = 1, nc = 1) => {
      const range = {
        setValue: (v) => { while (data.length < r) data.push([]); data[r - 1][c - 1] = v; return range; },
        setValues: (vals) => { vals.forEach((row, i) => row.forEach((v, j) => { while (data.length < r + i) data.push([]); data[r - 1 + i][c - 1 + j] = v; })); return range; },
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (data[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
        setFontWeight: () => range,
        setDataValidation: (rule) => { sheet.validations[c] = rule; return range; },
      };
      return range;
    },
    appendRow: (vals) => data.push(vals.slice()),
    deleteRow: (r) => data.splice(r - 1, 1),
    getLastRow: () => data.length,
    getLastColumn: () => width(),
    getMaxRows: () => Math.max(1000, data.length),
    setFrozenRows: (n) => { sheet.frozen = n; },
  };
  return sheet;
}

function createBackend({ members = [['admin@example.com', 'Admin', 'seed', '']], props = {}, overrides = {} } = {}) {
  const sheets = {
    Itinerary: makeSheet('Itinerary', [
      ['EventID', 'Day', 'Time', 'Title', 'Location', 'Status'],
      ['1', 'Day 1', '10:00 AM', 'Welcome Brunch', 'Garden', 'Upcoming'],
      ['2', 'Day 1', '7:00 PM', 'Sangeet', 'Ballroom', 'Upcoming'],
    ]),
    Logistics: makeSheet('Logistics', [
      ['ID', 'Name', 'Members', 'Contact', 'ArrivalDateTime', 'DepartureDateTime', 'Mode', 'PickupStatus'],
      ['G1', 'John Doe', 2, '+15550001', '2026-12-01 10:00', '2026-12-04 10:00', 'Flight', 'Pending'],
    ]),
    Members: makeSheet('Members', [['Email', 'Role', 'AddedBy', 'AddedDate'], ...members]),
    AuditLog: makeSheet('AuditLog', [['Timestamp', 'UserEmail', 'ActionCategory', 'Details']]),
  };
  Object.entries(overrides).forEach(([n, rows]) => { if (rows === null) delete sheets[n]; else sheets[n] = makeSheet(n, rows); });
  const cache = new Map();
  const tokens = new Map(); // token -> tokeninfo payload
  const fetches = [];
  const properties = { GOOGLE_CLIENT_ID: CLIENT_ID, ONESIGNAL_APP_ID: 'os-app', ONESIGNAL_REST_API_KEY: 'os-key', ...props };

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => { sheets[n] = makeSheet(n, []); return sheets[n]; },
        getSpreadsheetTimeZone: () => 'UTC',
      }),
      newDataValidation: () => { const rule = {}; const b = { requireValueInList: (v) => { rule.values = v; return b; }, setAllowInvalid: (x) => { rule.allowInvalid = x; return b; }, build: () => rule }; return b; },
      flush: () => {},
    },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => properties[k] || null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => 'UTC', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_alg, text) => Array.from(crypto.createHash('sha256').update(String(text)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64DecodeWebSafe: (s) => Buffer.from(s, 'base64url'),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      formatDate: (d) => new Date(d).toISOString(),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetches.push({ url, opts });
        if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
          const tok = decodeURIComponent(url.split('id_token=')[1]);
          const info = tokens.get(tok);
          return { getResponseCode: () => (info ? 200 : 400), getContentText: () => JSON.stringify(info || { error: 'invalid_token' }) };
        }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ id: 'notif-1' }) };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });

  const tokenFor = (email, opts) => {
    const { token, claims } = makeToken(email, opts);
    tokens.set(token, { ...claims, exp: String(claims.exp), email_verified: 'true' });
    return token;
  };

  const post = (body) => {
    const contents = typeof body === 'string' ? body : JSON.stringify(body);
    return JSON.parse(sandbox.doPost({ postData: { contents } }).text);
  };

  const call = (email, action, payload = {}, extra = {}) => post({ action, payload, idToken: tokenFor(email), userEmail: email, timestamp: new Date().toISOString(), ...extra });

  return { sandbox, sheets, cache, fetches, tokens, tokenFor, post, call, audit: () => sheets.AuditLog.data.slice(1) };
}

module.exports = { createBackend, makeToken, CLIENT_ID };
