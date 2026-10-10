// E2E smoke test with mocked Google Identity, OneSignal and Apps Script backend.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const PORT = 8765;
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (email, name) => `h.${b64({ email, name, aud: 'x.apps.googleusercontent.com', email_verified: true, picture: '', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;

const GSI_STUB = `window.google = { accounts: { id: {
  initialize(o) { window.__gsiCb = o.callback; },
  renderButton(el) { el.innerHTML = '<button id="fake-gsi">Sign in with Google</button>';
    el.querySelector('button').onclick = () => window.__gsiCb({ credential: window.__nextToken }); },
  prompt() {}, disableAutoSelect() {} } } };`;

const CONFIG = `window.APP_CONFIG = Object.freeze({ EVENT_NAME: 'Test Fest', EVENT_TAGLINE: 'tag',
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/TEST/exec', GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
  ONESIGNAL_APP_ID: 'REPLACE_WITH_ONESIGNAL_APP_ID', REFRESH_INTERVAL_MS: 600000, REQUEST_TIMEOUT_MS: 5000 });`;

function makeBackend() {
  const members = [
    { email: 'admin@gmail.com', role: 'Admin', addedBy: 'setup()', addedDate: '', tourStatus: 'Completed' },
    { email: 'viewer@gmail.com', role: 'Viewer', addedBy: 'admin@gmail.com', addedDate: '', tourStatus: 'Pending' },
  ];
  const itinerary = [{ id: '1', day: 'Fri', time: '10:00', title: 'Welcome', location: 'Hall', status: 'Upcoming' }];
  const audit = [];
  const email = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email;
  return {
    audit, members, calls: 0, tourCalls: [],
    handle(body) {
      this.calls += 1;
      const me = email(body.idToken);
      const m = members.find((x) => x.email === me);
      if (!m) return { ok: false, code: 'NOT_MEMBER', error: 'This Google account is not on the guest list.' };
      const isAdmin = m.role === 'Admin';
      if (body.action === 'session') {
        return { ok: true, data: { email: me, name: me, role: m.role, isAdmin, tourStatus: m.tourStatus, itinerary, ...(isAdmin ? { logistics: [], members } : {}) } };
      }
      if (body.action === 'completeTour') { // any member may record their own tour outcome
        this.tourCalls.push(`${me}|${body.payload.status}`);
        if (m.tourStatus === 'Pending') m.tourStatus = body.payload.status;
        return { ok: true, data: { tourStatus: m.tourStatus } };
      }
      if (!isAdmin) return { ok: false, code: 'FORBIDDEN', error: 'You are not authorized to perform admin actions.' };
      const p = body.payload;
      audit.push(`${me}|${body.action}|${JSON.stringify(p)}|${body.timestamp}`);
      if (body.action === 'addMember') members.push({ email: p.email, role: p.role, addedBy: me, addedDate: '', tourStatus: 'Pending' });
      if (body.action === 'updateMemberRole') members.find((x) => x.email === p.email).role = p.role;
      if (body.action === 'removeMember') members.splice(members.findIndex((x) => x.email === p.email), 1);
      return { ok: true, data: { members } };
    },
  };
}

const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`  ✓ ${msg}`); };

async function newPage(browser, backend) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route('**/config.js', (r) => r.fulfill({ body: CONFIG, contentType: 'text/javascript' }));
  await page.route('https://accounts.google.com/**', (r) => r.fulfill({ body: GSI_STUB, contentType: 'text/javascript' }));
  await page.route('https://cdn.onesignal.com/**', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.route('https://script.google.com/**', async (r) => {
    const body = JSON.parse(r.request().postData());
    if (backend.delayMs) await new Promise((res) => setTimeout(res, backend.delayMs));
    r.fulfill({ body: JSON.stringify(backend.handle(body)), contentType: 'application/json' });
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  return page;
}

async function signIn(page, email, token = jwt(email, email)) {
  await page.evaluate((t) => { window.__nextToken = t; }, token);
  await page.click('#fake-gsi');
}

/** Dismiss the Ganesh Vandana welcome splash (shown once per browser session). */
async function enter(page) {
  await page.waitForSelector('#welcome-splash [data-welcome="enter"]');
  await page.click('[data-welcome="enter"]');
  await page.waitForSelector('#welcome-splash', { state: 'detached' });
}

const visible = (page, sel) => page.$eval(sel, (el) => !el.classList.contains('hidden'));

(async () => {
  const browser = await chromium.launch();
  try {
    const backend = makeBackend();

    console.log('Gate (signed out)');
    let page = await newPage(browser, backend);
    await page.waitForSelector('#fake-gsi');
    assert(await page.isVisible('text=private to invited guests'), 'login gate shown');
    assert(!(await visible(page, '#bottom-nav')), 'nav hidden while signed out');
    assert(!(await visible(page, '#account-btn')), 'account button hidden while signed out');
    assert(await page.$('meta[http-equiv="Content-Security-Policy"]') !== null, 'CSP meta present');

    console.log('Token issued for another client is rejected client-side');
    const before = backend.calls;
    const foreign = `h.${b64({ email: 'admin@gmail.com', aud: 'evil.apps.googleusercontent.com', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
    await signIn(page, 'admin@gmail.com', foreign);
    await page.waitForSelector('text=Sign-in failed');
    assert(backend.calls === before, 'foreign-audience token never sent to backend');

    console.log('Non-member is denied');
    await signIn(page, 'stranger@gmail.com');
    await page.waitForSelector('text=Access not granted');
    assert(await page.isVisible('text=stranger@gmail.com'), 'denied screen names the email');
    assert(await page.$('#fake-gsi') !== null, 'can try another account');
    assert(await page.evaluate(() => !localStorage.getItem('evt.credential')), 'credential cleared on deny');

    console.log('Viewer');
    await signIn(page, 'viewer@gmail.com');
    await page.waitForSelector('#welcome-splash');
    assert(await page.isVisible('text=श्री गणेशाय नमः'), 'welcome splash opens with Ganesh Vandana');
    assert(await page.isVisible('#welcome-title'), 'splash greets the guest by name');
    await enter(page);
    await page.waitForSelector('text=Namaste');

    console.log('One-time guided tour');
    await page.waitForSelector('#tour-root [data-tour="card"]');
    assert(await page.isVisible('text=Step 1 of'), 'tour starts for a Pending guest');
    await page.click('[data-tour="next"]');
    assert(await page.isVisible('text=Step 2 of'), 'tour advances');
    await page.click('[data-tour="skip"]');
    await page.waitForSelector('#tour-root', { state: 'detached' });
    await page.waitForTimeout(200);
    assert(backend.tourCalls.join() === 'viewer@gmail.com|Skipped', 'skip recorded once via completeTour');
    assert(backend.members.find((m) => m.email === 'viewer@gmail.com').tourStatus === 'Skipped', 'tour status saved for the guest');
    await page.click('#refresh-btn');
    await page.waitForTimeout(300);
    assert(!(await page.$('#tour-root')), 'tour does not replay after a sync');

    assert(!(await visible(page, '#bottom-nav')), 'viewer has no admin nav');
    assert((await page.textContent('#account-label')) === 'Viewer', 'role label = Viewer');
    assert(await page.evaluate(() => !localStorage.getItem('evt.credential') && !!sessionStorage.getItem('evt.credential')),
      'ID token kept in sessionStorage only');
    assert(await page.evaluate(() => !/eyJ|idToken/.test(JSON.stringify(localStorage))), 'no token material in localStorage');
    assert(await page.evaluate(() => Object.keys(window.EventApp).sort().join() === 'WhatsApp,decodeJwt,escapeHtml,safePicture'),
      'no app state exposed on window');
    assert((await page.evaluate(() => window.__cspViolations)).length === 0, 'no CSP violations');

    console.log('Admin + Members tab');
    await page.close();
    page = await newPage(browser, backend);
    await page.waitForSelector('#fake-gsi');
    await signIn(page, 'admin@gmail.com');
    await enter(page);
    assert(!(await page.$('#tour-root')), 'no tour for a member who already completed it');
    await page.waitForSelector('[data-tab="members"]:not(.hidden)');
    await page.click('[data-tab="members"]');
    await page.waitForSelector('text=Members & access');
    assert(await page.isVisible('text=tour skipped'), 'admins can see who skipped the tour');
    assert(await page.$eval('select[data-email="admin@gmail.com"]', (e) => e.disabled), 'own role select disabled');
    assert(await page.$eval('button[data-email="admin@gmail.com"]', (e) => e.disabled), 'own remove disabled');

    await page.fill('#new-member-email', 'New.Guest@Gmail.com');
    await page.selectOption('form[data-action="add-member"] select[name="role"]', 'Viewer');
    await page.click('form[data-action="add-member"] button[type="submit"]');
    await page.waitForSelector('text=new.guest@gmail.com');
    assert(backend.members.some((m) => m.email === 'new.guest@gmail.com' && m.role === 'Viewer'), 'member added (lower-cased) as Viewer');

    await page.selectOption('select[data-email="new.guest@gmail.com"]', 'Admin');
    await page.waitForFunction(() => document.querySelector('select[data-email="new.guest@gmail.com"]')?.value === 'Admin');
    assert(backend.members.find((m) => m.email === 'new.guest@gmail.com').role === 'Admin', 'role changed to Admin');

    await page.click('button[data-email="viewer@gmail.com"]');
    await page.waitForFunction(() => !document.querySelector('button[data-email="viewer@gmail.com"]'));
    assert(!backend.members.some((m) => m.email === 'viewer@gmail.com'), 'member removed');

    assert(backend.audit.length === 3 && backend.audit.every((a) => a.startsWith('admin@gmail.com|') && /\|\d{4}-\d\d-\d\dT/.test(a)),
      'every admin call carried userEmail + timestamp');

    console.log('Sign-out during an in-flight sync stays signed out (race regression)');
    backend.delayMs = 800;
    await page.click('#refresh-btn');
    await page.click('#account-btn');
    await page.click('[data-modal="signout"]');
    await page.waitForTimeout(1300);
    backend.delayMs = 0;
    assert(await page.isVisible('#fake-gsi'), 'gate still shown after stale response lands');
    assert(!(await visible(page, '#bottom-nav')), 'admin nav not restored');
    assert(await page.evaluate(() => !localStorage.getItem('evt.data') && !localStorage.getItem('evt.credential')), 'cache not re-written');

    console.log('Removed viewer is locked out on next visit');
    await page.close();
    page = await newPage(browser, backend);
    await page.waitForSelector('#fake-gsi');
    await signIn(page, 'viewer@gmail.com');
    await page.waitForSelector('text=Access not granted');
    assert(true, 'removed member denied');

    console.log('Clickjacking: app refuses to render inside a cross-origin frame');
    await page.close();
    page = await newPage(browser, backend);
    await page.goto(`http://127.0.0.1:${PORT}/attacker.html`); // different origin; 404 body is fine
    await page.setContent(`<iframe src="http://localhost:${PORT}/index.html?framed=1" width="400" height="400"></iframe>`);
    await page.waitForTimeout(1500);
    const framed = page.frames().find((f) => f !== page.mainFrame() && f.url().includes('framed=1'));
    const bustedOut = page.url().includes('framed=1');
    const rendered = framed ? await framed.evaluate(() => !!document.querySelector('#view')) : false;
    assert(bustedOut || (framed && !rendered), 'framed copy is blanked or busted out');

    console.log('\nALL PASSED');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
