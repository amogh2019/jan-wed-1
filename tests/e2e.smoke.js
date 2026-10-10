// E2E smoke test with mocked Google Identity, OneSignal and Apps Script backend.
const { chromium } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const PORT = 8765;
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
/**
 * Static file server for the app under test.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function serveStatic(req, res) {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
}
const server = http.createServer(serveStatic).listen(PORT);

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
  const logistics = [{ id: 'G1', name: 'Verma family', members: '3', contact: '+91 98765 43210', email: 'viewer@gmail.com',
    arrival: '2027-01-22T14:30:00+05:30', departure: '', mode: 'Train', pickupStatus: 'Pending', dropStatus: 'Pending' }];
  const familyContact = { name: 'Kaus', phone: '+91 90000 00000' };
  const audit = [];
  const email = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email;
  return {
    audit, members, itinerary, logistics, calls: 0, tourCalls: [],
    handle(body) {
      this.calls += 1;
      const me = email(body.idToken);
      const m = members.find((x) => x.email === me);
      if (!m) return { ok: false, code: 'NOT_MEMBER', error: 'This Google account is not on the guest list.' };
      const isAdmin = m.role === 'Admin';
      if (body.action === 'session') {
        const myTravel = logistics.filter((g) => g.email === me);
        return { ok: true, data: { email: me, name: me, role: m.role, isAdmin, tourStatus: m.tourStatus, itinerary, myTravel, familyContact, ...(isAdmin ? { logistics, members } : {}) } };
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
      if (body.action === 'addEvent') {
        itinerary.push({ id: String(itinerary.length + 1), day: p.day, time: p.time, title: p.title, location: p.location, mapLink: p.mapLink, status: 'Upcoming' });
        return { ok: true, data: { itinerary } };
      }
      if (body.action === 'deleteEvent') {
        const i = itinerary.findIndex((e) => e.id === p.eventId && e.title === p.title);
        if (i < 0) return { ok: false, code: 'CONFLICT', error: 'The schedule changed.' };
        itinerary.splice(i, 1);
        itinerary.forEach((e, n) => { e.id = String(n + 1); });
        return { ok: true, data: { itinerary } };
      }
      if (body.action === 'addPickup') {
        logistics.push({ id: `G${logistics.length + 1}`, name: p.name, members: p.members, contact: p.contact, email: p.email, arrival: '', departure: '', mode: p.mode, pickupStatus: p.pickupStatus, dropStatus: 'Pending' });
        return { ok: true, data: { logistics } };
      }
      if (body.action === 'updateDropoff') {
        logistics.find((g) => g.id === p.id).dropStatus = p.status;
        return { ok: true, data: { logistics } };
      }
      if (body.action === 'updateLogistics') { // partial update: only keys the client sent
        const row = logistics.find((g) => g.id === p.id);
        const changed = Object.keys(p).filter((k) => k !== 'id' && row[k] !== p[k]);
        changed.forEach((k) => { row[k] = p[k]; });
        return { ok: true, data: { id: p.id, changed, logistics } };
      }
      return { ok: true, data: { members } };
    },
  };
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

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
    await r.fulfill({ body: JSON.stringify(backend.handle(body)), contentType: 'application/json' });
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  return page;
}

async function signIn(page, email, token = jwt(email, email)) {
  await page.evaluate((t) => { window.__nextToken = t; }, token);
  await page.click('#fake-gsi');
}

/** Dismiss the Ganesh Vandana welcome splash (shown on every sign-in and app open). */
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
    const bar = await page.$eval('[data-progress]', (e) => ({ want: `${e.dataset.progress}%`, got: e.style.width }));
    assert(bar.got === bar.want, 'progress bar width applied without inline style attributes');

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

    console.log('Guest sees their own pick-up & drop');
    assert(await visible(page, '#bottom-nav'), 'guests get a Schedule + My travel nav');
    assert(!(await visible(page, '[data-tab="pickups"]')) && !(await visible(page, '[data-tab="members"]')), 'no admin tabs for guests');
    await page.click('[data-tab="travel"]');
    await page.waitForSelector('#view >> text=Verma family');
    assert(await page.isVisible('text=Pick-up on arrival') && await page.isVisible('text=Drop on departure'), 'own pick-up and drop shown');
    assert(await page.isVisible('#view a[href="tel:+919000000000"]'), 'family contact is one tap to call');
    assert((await page.textContent('#account-label')) === 'Atithi', 'legacy Viewer role shown as Atithi');
    assert(await page.evaluate(() => !localStorage.getItem('evt.credential') && !!sessionStorage.getItem('evt.credential')),
      'ID token kept in sessionStorage only');
    assert(await page.evaluate(() => !/eyJ|idToken/.test(JSON.stringify(localStorage))), 'no token material in localStorage');
    assert(await page.evaluate(() => Object.keys(window.EventApp).sort((a, b) => a.localeCompare(b)).join() === 'decodeJwt,escapeHtml,safePicture,WhatsApp'),
      'no app state exposed on window');
    assert((await page.evaluate(() => window.__cspViolations)).length === 0, 'no CSP violations');

    console.log('Admin + Members tab');
    await page.close();
    page = await newPage(browser, backend);
    await page.waitForSelector('#fake-gsi');
    await signIn(page, 'admin@gmail.com');
    await enter(page);
    assert(!(await page.$('#tour-root')), 'no tour for a member who already completed it');
    assert((await page.textContent('#app-title-text')) === 'Test Fest', 'full event name in the header');
    assert(!(await visible(page, '[data-tab="travel"]')), 'admins use Pick & Drop instead of My travel');
    await page.waitForSelector('[data-tab="members"]:not(.hidden)');

    console.log('Admin creates a ceremony and an arrival from the app');
    assert((await page.textContent('[data-tab="control"]')).trim() === 'Event Control', 'tab renamed to Event Control');
    await page.click('[data-tab="control"]');
    await page.click('[data-action="add-event"]');
    await page.fill('#modal-root input[name="title"]', 'Haldi');
    assert((await page.getAttribute('#modal-root input[name="day"]', 'type')) === 'date', 'day is a date picker');
    await page.fill('#modal-root input[name="day"]', '2027-01-23');
    await page.fill('#modal-root input[name="time"]', '19:05');
    await page.fill('#modal-root input[name="location"]', 'Lawn');
    await page.fill('#modal-root input[name="mapLink"]', 'javascript:alert(1)');
    await page.click('#modal-root [data-modal="confirm"]');
    assert(await page.isVisible('#modal-root [role="dialog"]'), 'non-Maps link rejected');
    await page.fill('#modal-root input[name="mapLink"]', 'https://maps.app.goo.gl/abc123');
    await page.click('#modal-root [data-modal="confirm"]');
    await page.waitForSelector('#view >> text=Haldi');
    assert(backend.itinerary.some((e) => e.title === 'Haldi' && e.day === 'Sat, Jan 23' && e.time === '7:05 PM' && e.mapLink === 'https://maps.app.goo.gl/abc123'), 'event created with day label, 12h time and map link');
    assert(!(await page.$('#modal-root [role="dialog"]')), 'create modal closed');

    await page.click('[data-action="delete-event"][data-id="1"]');
    await page.waitForSelector('#view >> text=Welcome', { state: 'detached' });
    assert(!backend.itinerary.some((e) => e.title === 'Welcome') && backend.itinerary.find((e) => e.title === 'Haldi').id === '1', 'event deleted and later IDs shifted');

    await page.click('[data-tab="pickups"]');
    await page.click('[data-action="add-pickup"]');
    await page.click('#modal-root [data-modal="confirm"]');
    assert(await page.isVisible('#modal-root [role="dialog"]'), 'modal stays open when the name is missing');
    await page.fill('#modal-root input[name="name"]', 'Sharma family');
    await page.fill('#modal-root input[name="members"]', '4');
    await page.click('#modal-root [data-modal="confirm"]');
    await page.waitForSelector('#view >> text=Sharma family');
    assert(backend.logistics.some((g) => g.name === 'Sharma family' && g.members === '4' && g.pickupStatus === 'Pending'), 'arrival created');

    console.log('Admin edits travel and tracks drops');
    await page.click('[data-action="edit-pickup"][data-id="G1"]');
    assert((await page.inputValue('#modal-root input[name="arrival"]')) === '2027-01-22T14:30', 'edit form prefilled with the arrival');
    assert((await page.inputValue('#modal-root select[name="mode"]')) === 'Train', 'mode prefilled');
    await page.selectOption('#modal-root select[name="mode"]', 'Plane');
    await page.click('#modal-root [data-modal="confirm"]');
    await page.waitForSelector('#modal-root [role="dialog"]', { state: 'detached' });
    const verma = backend.logistics.find((g) => g.id === 'G1');
    assert(verma.mode === 'Plane' && verma.arrival === '2027-01-22T14:30' && verma.email === 'viewer@gmail.com', 'travel edited, other fields kept');
    await page.click('[data-action="logistics-mode"][data-value="drop"]');
    await page.waitForSelector('[data-action="toggle-dropoff"][data-id="G2"]');
    await page.click('[data-action="toggle-dropoff"][data-id="G2"]');
    await page.waitForSelector('[data-action="toggle-dropoff"][data-id="G2"][data-next="Pending"]');
    assert(backend.logistics.find((g) => g.id === 'G2').dropStatus === 'Dropped Off', 'drop marked done');

    await page.click('[data-tab="members"]');
    await page.waitForSelector('text=Members & access');
    assert(await page.isVisible('text=tour skipped'), 'admins can see who skipped the tour');
    assert(await page.isDisabled('select[data-email="admin@gmail.com"]'), 'own role select disabled');
    assert(await page.isDisabled('button[data-email="admin@gmail.com"]'), 'own remove disabled');

    await page.fill('#new-member-email', 'New.Guest@Gmail.com');
    await page.selectOption('form[data-action="add-member"] select[name="role"]', 'Atithi');
    await page.click('form[data-action="add-member"] button[type="submit"]');
    await page.waitForSelector('text=new.guest@gmail.com');
    assert(backend.members.some((m) => m.email === 'new.guest@gmail.com' && m.role === 'Atithi'), 'member added (lower-cased) as Atithi');

    await page.selectOption('select[data-email="new.guest@gmail.com"]', 'Admin');
    await page.waitForFunction(() => document.querySelector('select[data-email="new.guest@gmail.com"]')?.value === 'Admin');
    assert(backend.members.find((m) => m.email === 'new.guest@gmail.com').role === 'Admin', 'role changed to Admin');

    await page.click('button[data-email="viewer@gmail.com"]');
    await page.waitForFunction(() => !document.querySelector('button[data-email="viewer@gmail.com"]'));
    assert(!backend.members.some((m) => m.email === 'viewer@gmail.com'), 'member removed');

    assert(backend.audit.length === 8 && backend.audit.every((a) => a.startsWith('admin@gmail.com|') && /\|\d{4}-\d\d-\d\dT/.test(a)),
      'every admin call carried userEmail + timestamp');

    console.log('Welcome plays again every time the app is opened');
    await page.reload();
    await page.waitForSelector('#welcome-splash');
    assert(true, 'welcome splash on reopen');
    await enter(page);

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
