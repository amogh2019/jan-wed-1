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
  ONESIGNAL_APP_ID: 'test-onesignal-app', REFRESH_INTERVAL_MS: 600000, REQUEST_TIMEOUT_MS: 5000 });`;

const ONESIGNAL_STUB = `window.__oneSignalLog = [];
window.__pushSubscribedStub = new URLSearchParams(location.search).has('pushOn');
window.OneSignalDeferred = { push(callback) {
  const initialize = () => callback({
    init: async () => {},
    login: async (id) => window.__oneSignalLog.push('login:' + id),
    logout: async () => window.__oneSignalLog.push('logout'),
    Notifications: { permission: window.__pushSubscribedStub, addEventListener() {}, requestPermission: async () => { window.__oneSignalPermissionRequests += 1; } },
    User: { PushSubscription: { id: window.__pushSubscribedStub ? 'registered' : null, optedIn: window.__pushSubscribedStub, addEventListener() {}, optIn: async () => {} } },
  });
  if (new URLSearchParams(location.search).has('delayPush')) window.__releasePushInit = () => { void initialize(); };
  else void initialize();
} };`;

function makeBackend() {
  const members = [
    { email: 'admin@gmail.com', role: 'Admin', addedBy: 'setup()', addedDate: '', tourStatus: 'Completed', groups: [] },
    { email: 'viewer@gmail.com', role: 'Viewer', addedBy: 'admin@gmail.com', addedDate: '', tourStatus: 'Completed', groups: [] },
  ];
  const itinerary = [{ id: '1', day: 'Fri', time: '10:00', title: 'Welcome', location: 'Hall', status: 'Upcoming', groups: [] }];
  const groupCatalog = [];
  const logistics = [{ id: 'G1', name: 'Verma family', members: '3', contact: '+91 98765 43210', email: 'viewer@gmail.com',
    arrival: '2027-01-22T14:30:00+05:30', departure: '', mode: 'Train', pickupStatus: 'Pending', dropStatus: 'Pending' }];
  const familyContact = { name: 'Kaus', phone: '+91 90000 00000' };
  const audit = [];
  const notifications = [{ id: 'n1', at: new Date(Date.now() - 1000).toISOString(), title: 'Live now: Welcome', message: 'Welcome is live', eventId: '1', groups: [], sentBy: 'admin@gmail.com', pushStatus: 'Sent' }];
  const clearedNotifications = new Map();
  const email = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email;
  return {
    audit, members, itinerary, logistics, notifications, groupCatalog, calls: 0, tourCalls: [], broadcastRequests: [],
    expireNext: false, failNextAction: null, failBroadcastPush: false, failEventPush: false,
    ignoreAudienceFilters: false,
    exposeNoticeMetadataToGuests: false,
    handle(body) {
      this.calls += 1;
      const me = email(body.idToken);
      if (body.action === 'session' && this.expireNext) {
        this.expireNext = false;
        return { ok: false, code: 'AUTH_EXPIRED', error: 'Your session expired.' };
      }
      const m = members.find((x) => x.email === me);
      if (!m) return { ok: false, code: 'NOT_MEMBER', error: 'This Google account is not on the guest list.' };
      const isAdmin = m.role === 'Admin';
      if (body.action === 'session') {
        const myTravel = logistics.filter((g) => g.email === me);
        const myGroups = m.groups || [];
        const matching = (groups) => !groups?.length || groups.some((g) => myGroups.some((mine) => mine.toLowerCase() === g.toLowerCase()));
        const cutoff = clearedNotifications.get(me) || 0;
        const visibleNotifications = notifications.filter((n) =>
          (isAdmin || this.ignoreAudienceFilters || matching(n.groups)) && Date.parse(n.at) > cutoff);
        return { ok: true, data: { email: me, name: me, role: m.role, isAdmin, tourStatus: m.tourStatus,
          groups: myGroups, knownGroups: [...new Set(members.flatMap((x) => x.groups || []).concat(itinerary.flatMap((x) => x.groups || [])))],
          groupCatalog: isAdmin ? groupCatalog : undefined,
          itinerary: isAdmin || this.ignoreAudienceFilters ? itinerary : itinerary.filter((e) => matching(e.groups)),
          notifications: isAdmin || this.exposeNoticeMetadataToGuests
            ? visibleNotifications
            : visibleNotifications.map(({ sentBy, pushStatus, ...n }) => n),
          pushId: `m_${(me === 'viewer@gmail.com' ? 'a' : 'b').repeat(40)}`,
          myTravel, familyContact, ...(isAdmin ? { logistics, members } : {}) } };
      }
      if (body.action === 'completeTour') { // any member may record their own tour outcome
        this.tourCalls.push(`${me}|${body.payload.status}`);
        if (this.failNextAction === body.action) {
          this.failNextAction = null;
          return { ok: false, code: 'TEST_FAILURE', error: 'Simulated request failure.' };
        }
        if (m.tourStatus === 'Pending') m.tourStatus = body.payload.status;
        return { ok: true, data: { tourStatus: m.tourStatus } };
      }
      if (body.action === 'clearNotifications') {
        clearedNotifications.set(me, Date.now());
        return { ok: true, data: { notifications: [] } };
      }
      if (!isAdmin) return { ok: false, code: 'FORBIDDEN', error: 'You are not authorized to perform admin actions.' };
      const p = body.payload;
      if (this.failNextAction === body.action) {
        this.failNextAction = null;
        return { ok: false, code: 'TEST_FAILURE', error: 'Simulated request failure.' };
      }
      audit.push(`${me}|${body.action}|${JSON.stringify(p)}|${body.timestamp}`);
      const parseGroups = (value) => Array.isArray(value) ? value : (value ? value.split(',').map((x) => x.trim()).filter(Boolean) : []);
      if (body.action === 'addGroup') {
        if (groupCatalog.some((g) => g.label.toLowerCase() === p.label.toLowerCase())) return { ok: false, code: 'CONFLICT', error: 'Group already exists.' };
        groupCatalog.push({ label: p.label, status: 'Active' });
        return { ok: true, data: { groupCatalog } };
      }
      if (body.action === 'archiveGroup') {
        const group = groupCatalog.find((g) => g.label.toLowerCase() === p.label.toLowerCase());
        if (!group) return { ok: false, code: 'NOT_FOUND', error: 'Group not found.' };
        group.status = 'Archived';
        return { ok: true, data: { groupCatalog } };
      }
      if (body.action === 'addMember') members.push({ email: p.email, role: p.role, addedBy: me, addedDate: '', tourStatus: 'Pending', groups: parseGroups(p.groups) });
      if (body.action === 'updateMemberRole') members.find((x) => x.email === p.email).role = p.role;
      if (body.action === 'removeMember') members.splice(members.findIndex((x) => x.email === p.email), 1);
      if (body.action === 'updateMemberGroups') {
        const member = members.find((x) => x.email === p.email);
        member.groups = parseGroups(p.groups);
        return { ok: true, data: { members } };
      }
      if (body.action === 'updateEventGroup') {
        const event = itinerary.find((x) => x.id === p.eventId);
        event.groups = parseGroups(p.groups);
        return { ok: true, data: { itinerary } };
      }
      if (body.action === 'addEvent') {
        itinerary.push({ id: String(itinerary.length + 1), day: p.day, time: p.time, title: p.title, location: p.location, mapLink: p.mapLink, groups: parseGroups(p.groups), status: 'Upcoming' });
        return { ok: true, data: { itinerary } };
      }
      if (body.action === 'updateEvent') {
        const event = itinerary.find((x) => x.id === p.eventId);
        event.status = p.status;
        const attempted = p.status === 'Live' && p.notify !== false;
        const pushOk = !attempted || !this.failEventPush;
        if (p.status === 'Live' && p.notify !== false) notifications.unshift({
          id: `n${notifications.length + 1}`, at: new Date().toISOString(), title: `Live now: ${event.title}`,
          message: `${event.title} is live`, eventId: event.id, groups: event.groups || [], sentBy: me,
          pushStatus: pushOk ? 'Sent' : 'Failed: Simulated OneSignal failure.',
        });
        return { ok: true, data: { event, push: { attempted, ok: pushOk, error: pushOk ? undefined : 'Simulated OneSignal failure.' }, itinerary } };
      }
      if (body.action === 'broadcastNotification') {
        this.broadcastRequests.push({ email: me, timestamp: body.timestamp, ...p });
        const push = { attempted: true, ok: !this.failBroadcastPush, error: this.failBroadcastPush ? 'Simulated OneSignal failure.' : undefined };
        notifications.unshift({
          id: `n${notifications.length + 1}`, at: new Date().toISOString(), title: p.title, message: p.body,
          eventId: '', groups: parseGroups(p.groups), sentBy: me, pushStatus: push.ok ? 'Sent' : `Failed: ${push.error}`,
        });
        return { ok: true, data: { push, notifications: [...notifications] } };
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

async function newPage(browser, backend, query = '', eventName = 'Test Fest') {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.stack || e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => {
    window.__cspViolations = [];
    window.__oneSignalPermissionRequests = 0;
    if (new URLSearchParams(location.search).has('pushOn') && 'Notification' in window) {
      Object.defineProperty(Notification, 'permission', { configurable: true, value: 'granted' });
    }
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const pageConfig = CONFIG.replace("EVENT_NAME: 'Test Fest'", `EVENT_NAME: ${JSON.stringify(eventName)}`);
  await page.route('**/config.js', (r) => r.fulfill({ body: pageConfig, contentType: 'text/javascript' }));
  await page.route('https://accounts.google.com/**', (r) => r.fulfill({ body: GSI_STUB, contentType: 'text/javascript' }));
  await page.route('https://cdn.onesignal.com/**', (r) => r.fulfill({ body: ONESIGNAL_STUB, contentType: 'text/javascript' }));
  await page.route('https://script.google.com/**', async (r) => {
    const body = JSON.parse(r.request().postData());
    if (backend.delayMs) await new Promise((res) => setTimeout(res, backend.delayMs));
    await r.fulfill({ body: JSON.stringify(backend.handle(body)), contentType: 'application/json' });
  });
  await page.goto(`http://localhost:${PORT}/index.html${query}`);
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
async function assertTourStep(page, id, tab, target = null) {
  const root = page.locator('#tour-root');
  assert((await root.getAttribute('data-step-id')) === id, `tour step is ${id}`);
  assert((await page.locator('#bottom-nav [aria-current="page"]').getAttribute('data-tab')) === tab, `${id} selects ${tab}`);
  const targetSelector = target || await root.getAttribute('data-step-target');
  if (targetSelector) assert(await page.locator(targetSelector).isVisible(), `${id} target is visible`);
}

(async () => {
  const browser = await chromium.launch();
  try {
    const backend = makeBackend();

    console.log('Admin tour visits every host tab without running controls');
    const adminTourBackend = makeBackend();
    adminTourBackend.members.find((m) => m.email === 'admin@gmail.com').tourStatus = 'Pending';
    adminTourBackend.itinerary.splice(0);
    adminTourBackend.logistics.splice(0);
    adminTourBackend.notifications.splice(0);
    const adminTourPage = await newPage(browser, adminTourBackend);
    await adminTourPage.waitForSelector('#fake-gsi');
    await signIn(adminTourPage, 'admin@gmail.com');
    await enter(adminTourPage);
    await adminTourPage.waitForSelector('#tour-root');
    const adminTourSteps = [
      ['welcome', 'schedule'],
      ['schedule', 'schedule', '#view [data-tour="schedule-overview"]'],
      ['schedule-days', 'schedule'],
      ['notifications', 'notifications', '#view [data-tour="notifications-overview"]'],
      ['event-control', 'control', '#view [data-tour="event-control"]'],
      ['broadcast', 'broadcast', '#view [data-tour="broadcast-overview"]'],
      ['pick-drop', 'pickups', '#view [data-tour="pick-drop-overview"]'],
      ['members', 'members', '#view [data-tour="members-overview"]'],
      ['notify', 'schedule'],
      ['profile', 'schedule', '#account-btn'],
      ['summary', 'schedule'],
    ];
    for (const [i, [id, tab, target]] of adminTourSteps.entries()) {
      await assertTourStep(adminTourPage, id, tab, target);
      if (id === 'notifications') assert(await adminTourPage.isVisible('text=No announcements yet'), 'empty notifications screen remains explained');
      if (id === 'event-control') assert(await adminTourPage.isVisible('text=No ceremonies yet'), 'empty Event Control screen remains explained');
      if (id === 'broadcast') assert(await adminTourPage.isVisible('text=No groups selected means everyone'), 'Broadcast tour explains its default audience');
      if (id === 'pick-drop') assert(await adminTourPage.isVisible('text=No travel plans yet'), 'empty Pick & Drop screen remains explained');
      if (id === 'members') assert(await adminTourPage.isVisible('text=No group labels yet'), 'empty group catalog remains explained');
      if (i < adminTourSteps.length - 1) await adminTourPage.click('[data-tour="next"]');
    }
    assert(adminTourBackend.audit.length === 0 && adminTourBackend.itinerary.length === 0 && adminTourBackend.logistics.length === 0,
      'admin tour does not execute highlighted controls');
    assert(await adminTourPage.evaluate(() => window.__oneSignalPermissionRequests) === 0, 'tour never requests notification permission');
    await adminTourPage.click('[data-tour="next"]');
    await adminTourPage.waitForSelector('#tour-root', { state: 'detached' });
    assert(adminTourBackend.tourCalls.join() === 'admin@gmail.com|Completed', 'admin tour completion is recorded');
    await adminTourPage.click('#account-btn');
    await adminTourPage.click('[data-modal="tour"]');
    await adminTourPage.waitForSelector('#tour-root');
    await adminTourPage.click('[data-tour="next"]');
    await adminTourPage.click('[data-tour="next"]');
    await adminTourPage.click('[data-tour="next"]');
    await adminTourPage.click('[data-tour="next"]');
    await assertTourStep(adminTourPage, 'event-control', 'control', '#view [data-tour="event-control"]');
    await adminTourPage.click('[data-tour="skip"]');
    await adminTourPage.waitForSelector('#tour-root', { state: 'detached' });
    assert(adminTourBackend.tourCalls.length === 1, 'replay uses the current Admin path without another completion write');
    await adminTourPage.close();

    console.log('Admin standalone Broadcast targeting and WhatsApp handoff');
    const broadcastBackend = makeBackend();
    broadcastBackend.notifications.splice(0);
    broadcastBackend.groupCatalog.push(
      { label: 'Group A', status: 'Active' },
      { label: 'Group B', status: 'Active' },
      { label: 'Outside', status: 'Active' },
    );
    broadcastBackend.members.find((m) => m.email === 'viewer@gmail.com').groups = ['Group A'];
    broadcastBackend.members.push(
      { email: 'beta@gmail.com', role: 'Atithi', addedBy: 'admin@gmail.com', addedDate: '', tourStatus: 'Completed', groups: ['Group B'] },
      { email: 'outside@gmail.com', role: 'Atithi', addedBy: 'admin@gmail.com', addedDate: '', tourStatus: 'Completed', groups: ['Outside'] },
    );
    const broadcastPage = await newPage(browser, broadcastBackend);
    await broadcastPage.waitForSelector('#fake-gsi');
    await signIn(broadcastPage, 'admin@gmail.com');
    await enter(broadcastPage);
    await broadcastPage.waitForSelector('[data-tab="broadcast"]:not(.hidden)');
    await broadcastPage.click('[data-tab="broadcast"]');
    await broadcastPage.waitForSelector('#broadcast-title');
    assert(await visible(broadcastPage, '[data-tab="broadcast"]'), 'Admin can open the Broadcast tab');
    broadcastBackend.delayMs = 500;
    await broadcastPage.fill('#broadcast-title', 'Audience update');
    await broadcastPage.fill('#broadcast-body', 'Please use the east entrance.');
    await broadcastPage.check('input[data-action="broadcast-groups"][value="Group A"]');
    await broadcastPage.check('input[data-action="broadcast-groups"][value="Group B"]');
    await broadcastPage.click('[data-action="broadcast-send"]');
    await broadcastPage.waitForSelector('[data-action="broadcast-send"] .spinner');
    assert(await broadcastPage.isDisabled('[data-action="broadcast-send"]'), 'Broadcast button disables while the request is pending');
    await broadcastPage.waitForSelector('#toast-root >> text=Broadcast sent');
    broadcastBackend.delayMs = 0;
    assert(broadcastBackend.broadcastRequests[0].email === 'admin@gmail.com' &&
      broadcastBackend.broadcastRequests[0].title === 'Audience update' &&
      broadcastBackend.broadcastRequests[0].body === 'Please use the east entrance.' &&
      broadcastBackend.broadcastRequests[0].groups.join(',') === 'Group A,Group B',
    'broadcast sends the exact composed message and selected groups');

    for (const [email, expected] of [
      ['viewer@gmail.com', true],
      ['beta@gmail.com', true],
      ['outside@gmail.com', false],
    ]) {
      const memberPage = await newPage(browser, broadcastBackend);
      await memberPage.waitForSelector('#fake-gsi');
      await signIn(memberPage, email);
      await enter(memberPage);
      await memberPage.click('[data-tab="notifications"]');
      if (expected) {
        await memberPage.waitForSelector('#view >> text=Audience update');
        assert((await memberPage.textContent('#view')).includes('Please use the east entrance.'),
          `${email} receives the announcement for a matching group`);
      } else {
        await memberPage.waitForSelector('#view >> text=No announcements yet');
        assert(!(await memberPage.textContent('#view')).includes('Audience update'),
          'members outside selected groups do not see the announcement');
      }
      await memberPage.close();
    }

    await broadcastPage.fill('#broadcast-title', 'All-member update');
    await broadcastPage.fill('#broadcast-body', 'Everyone is welcome.');
    broadcastBackend.delayMs = 250;
    await broadcastPage.click('[data-action="broadcast-send"]');
    await broadcastPage.waitForSelector('[data-action="broadcast-send"][disabled]');
    await broadcastPage.waitForSelector('[data-action="broadcast-send"]:not([disabled])');
    await broadcastPage.waitForSelector('#toast-root >> text=Broadcast sent');
    broadcastBackend.delayMs = 0;
    assert(broadcastBackend.broadcastRequests[1].groups.length === 0, 'no group selection sends to everyone');

    broadcastBackend.failBroadcastPush = true;
    await broadcastPage.fill('#broadcast-title', 'Bring umbrellas');
    await broadcastPage.fill('#broadcast-body', 'Meet at the covered entrance.');
    broadcastBackend.delayMs = 500;
    const whatsappPopupPromise = broadcastPage.waitForEvent('popup');
    await broadcastPage.click('[data-action="broadcast-whatsapp"]');
    const whatsappPopup = await whatsappPopupPromise;
    assert(whatsappPopup.url() === 'about:blank',
      'WhatsApp tab opens synchronously before the broadcast request completes');
    await broadcastPage.waitForSelector('#toast-root >> text=push delivery failed');
    const pushFailureToast = await broadcastPage.locator('#toast-root').textContent();
    assert(pushFailureToast.includes('delivery failed') && !pushFailureToast.includes('Simulated OneSignal failure'),
      'push failure toast gives a short status without exposing provider diagnostics');
    await whatsappPopup.waitForURL(/api\.whatsapp\.com\/send/, { waitUntil: 'commit' });
    const whatsappText = new URL(whatsappPopup.url()).searchParams.get('text');
    assert(whatsappText === '*Bring umbrellas*\n\nMeet at the covered entrance.' &&
      !whatsappText.includes('Group A') && !whatsappText.includes('Group B'),
    'WhatsApp receives the composed title and body without audience labels even when push delivery fails');

    const broadcastsBeforeRejectedRequest = broadcastBackend.broadcastRequests.length;
    broadcastBackend.failNextAction = 'broadcastNotification';
    broadcastBackend.delayMs = 250;
    await broadcastPage.fill('#broadcast-title', 'Rejected message');
    await broadcastPage.fill('#broadcast-body', 'This must not be sent.');
    const rejectedPopupPromise = broadcastPage.waitForEvent('popup');
    await broadcastPage.click('[data-action="broadcast-whatsapp"]');
    const rejectedPopup = await rejectedPopupPromise;
    const rejectedClosePromise = rejectedPopup.waitForEvent('close');
    await broadcastPage.waitForSelector('#toast-root >> text=Simulated request failure.');
    await rejectedClosePromise;
    broadcastBackend.delayMs = 0;
    assert(rejectedPopup.isClosed(), 'rejected broadcast closes its temporary WhatsApp tab');
    assert(broadcastBackend.broadcastRequests.length === broadcastsBeforeRejectedRequest,
      'rejected request is not recorded as an accepted broadcast');
    await broadcastPage.close();

    const atithiBroadcastPage = await newPage(browser, broadcastBackend);
    await atithiBroadcastPage.waitForSelector('#fake-gsi');
    await signIn(atithiBroadcastPage, 'viewer@gmail.com');
    await enter(atithiBroadcastPage);
    assert(!(await visible(atithiBroadcastPage, '[data-tab="broadcast"]')), 'Atithi cannot see the Broadcast tab');
    await atithiBroadcastPage.close();

    console.log('Tour uses stable fallbacks when Atithi screens are empty');
    const sparseTourBackend = makeBackend();
    sparseTourBackend.members.find((m) => m.email === 'viewer@gmail.com').tourStatus = 'Pending';
    sparseTourBackend.itinerary.splice(0);
    sparseTourBackend.logistics.splice(0);
    sparseTourBackend.notifications.splice(0);
    const sparseTourPage = await newPage(browser, sparseTourBackend, '?pushOn=1');
    await sparseTourPage.waitForSelector('#fake-gsi');
    await signIn(sparseTourPage, 'viewer@gmail.com');
    await enter(sparseTourPage);
    await sparseTourPage.waitForSelector('#tour-root');
    assert(!(await visible(sparseTourPage, '[data-tab="broadcast"]')), 'Broadcast is not available to Atithis');
    await sparseTourPage.click('[data-tour="next"]');
    await assertTourStep(sparseTourPage, 'schedule', 'schedule', '#view [data-tour="schedule-overview"]');
    await sparseTourPage.click('[data-tour="next"]');
    await assertTourStep(sparseTourPage, 'schedule-days', 'schedule', '#view [data-tour="schedule-overview"]');
    await sparseTourPage.click('[data-tour="next"]');
    await assertTourStep(sparseTourPage, 'notifications', 'notifications', '#view [data-tour="notifications-overview"]');
    await sparseTourPage.click('[data-tour="next"]');
    await assertTourStep(sparseTourPage, 'travel', 'travel', '#view [data-tour="travel-overview"]');
    assert(await sparseTourPage.isVisible('text=No travel plans yet'), 'no-plan travel guidance remains visible');
    assert((await sparseTourPage.textContent('#tour-body')).includes('confirm your RSVP'),
      'no-plan tour copy prompts Atithis to confirm their RSVP with the family');
    await sparseTourPage.click('[data-tour="next"]');
    await assertTourStep(sparseTourPage, 'notify', 'schedule');
    assert(await sparseTourPage.locator('#tour-root').getAttribute('data-step-target') === '',
      'hidden notification banner does not become the spotlight target');
    await sparseTourPage.waitForFunction(() => document.querySelector('#tour-root [data-tour="spot"]')?.classList.contains('hidden'));
    assert(await sparseTourPage.$eval('#tour-root [data-tour="spot"]', (el) => el.classList.contains('hidden')),
      'subscribed users get centered notification guidance without a spotlight');
    assert(await sparseTourPage.evaluate(() => window.__oneSignalPermissionRequests) === 0,
      'notification guidance never requests permission');
    await sparseTourPage.click('[data-tour="skip"]');
    await sparseTourPage.waitForSelector('#tour-root', { state: 'detached' });
    await sparseTourPage.close();

    console.log('Gate (signed out)');
    let page = await newPage(browser, backend);
    await page.waitForSelector('#fake-gsi');
    assert(await page.isVisible('text=private to invited guests'), 'login gate shown');
    assert(!(await visible(page, '#bottom-nav')), 'nav hidden while signed out');
    assert(!(await visible(page, '#account-btn')), 'account button hidden while signed out');
    assert(await page.$('meta[http-equiv="Content-Security-Policy"]') !== null, 'CSP meta present');

    console.log('Install prompt confirms only after the browser reports installation');
    const installPage = await newPage(browser, makeBackend());
    await installPage.waitForSelector('#fake-gsi');
    await installPage.evaluate(() => {
      const prompt = new Event('beforeinstallprompt', { cancelable: true });
      prompt.prompt = () => {};
      Object.defineProperty(prompt, 'userChoice', { value: Promise.resolve({ outcome: 'accepted' }) });
      window.dispatchEvent(prompt);
    });
    await installPage.click('#install-btn');
    await installPage.waitForTimeout(0);
    assert(await visible(installPage, '#banner-install'), 'accepted native prompt keeps install card visible while installation is pending');
    assert((await installPage.textContent('#install-text')).includes('Waiting'),
      'pending install copy does not claim installation succeeded');
    await installPage.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    assert(await visible(installPage, '#banner-install'), 'confirmed install card stays visible until dismissed');
    assert((await installPage.textContent('#install-text')).includes('Test Fest') &&
      (await installPage.textContent('#install-text')).includes('Installed'),
    'confirmed install names the configured app');
    assert(await visible(installPage, '#install-dismiss'), 'user can dismiss the install confirmation');
    await installPage.waitForFunction(() => document.querySelector('#banner-install')?.classList.contains('hidden'));
    assert(!(await visible(installPage, '#banner-install')), 'install confirmation disappears after five seconds');
    await installPage.close();

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
    backend.members.find((m) => m.email === 'viewer@gmail.com').tourStatus = 'Pending';
    await signIn(page, 'viewer@gmail.com');
    await page.waitForSelector('#welcome-splash');
    assert(await page.isVisible('text=श्री गणेशाय नमः'), 'welcome splash opens with Ganesh Vandana');
    assert(await page.isVisible('#welcome-title'), 'splash greets the guest by name');
    await enter(page);
    await page.waitForFunction(() => window.__oneSignalLog.some((x) => x === `login:m_${'a'.repeat(40)}`));
    assert(true, 'signed-in member is associated with their opaque OneSignal group ID');
    await page.waitForSelector('text=Namaste');
    const bar = await page.$eval('[data-progress]', (e) => ({ want: `${e.dataset.progress}%`, got: e.style.width }));
    assert(bar.got === bar.want, 'progress bar width applied without inline style attributes');

    console.log('Marquee recalculates when sign-in controls narrow the header');
    const marqueePage = await newPage(browser, backend, '', 'A Long Celebration Name That Must Fully Scroll Across the Header');
    await marqueePage.setViewportSize({ width: 390, height: 844 });
    await marqueePage.waitForSelector('#fake-gsi');
    await marqueePage.evaluate(() => document.fonts.ready);
    await marqueePage.waitForTimeout(200);
    const initialTitleWidth = await marqueePage.$eval('#app-title', (box) => box.clientWidth);
    await signIn(marqueePage, 'admin@gmail.com');
    await enter(marqueePage);
    await marqueePage.waitForTimeout(200);
    const marqueeMeasurement = await marqueePage.evaluate(() => {
      const box = document.querySelector('#app-title');
      const text = document.querySelector('#app-title-text');
      return {
        boxWidth: box.clientWidth,
        shift: Math.abs(parseFloat(getComputedStyle(text).getPropertyValue('--marquee-shift')) || 0),
        required: Math.ceil(text.scrollWidth - box.clientWidth),
      };
    });
    assert(marqueeMeasurement.boxWidth < initialTitleWidth, 'sign-in controls reduce available title width without a window resize');
    assert(marqueeMeasurement.shift >= marqueeMeasurement.required, 'marquee endpoint covers the complete current text overflow');
    await marqueePage.close();

    console.log('Role-specific Atithi tour');
    await page.waitForSelector('#tour-root [data-tour="card"]');
    await assertTourStep(page, 'welcome', 'schedule');
    await page.click('[data-tour="next"]');
    await assertTourStep(page, 'schedule', 'schedule', '#view [data-tour="schedule-overview"]');
    await page.click('[data-tour="next"]');
    await assertTourStep(page, 'schedule-days', 'schedule');
    await page.click('[data-tour="next"]');
    await assertTourStep(page, 'notifications', 'notifications', '#view [data-tour="notifications-overview"]');
    await page.click('[data-tour="back"]');
    await assertTourStep(page, 'schedule-days', 'schedule');
    await page.click('[data-tour="next"]');
    await assertTourStep(page, 'notifications', 'notifications');
    await page.click('[data-tour="next"]');
    await assertTourStep(page, 'travel', 'travel', '#view [data-tour="travel-overview"]');
    assert((await page.textContent('#tour-body')).includes('latest plan'),
      'travel tour reminds Atithis to correct details that no longer match their plan');
    await page.click('[data-tour="next"]');
    await assertTourStep(page, 'notify', 'schedule');
    await page.click('[data-tour="next"]');
    await assertTourStep(page, 'profile', 'schedule', '#account-btn');
    await page.click('[data-tour="next"]');
    await assertTourStep(page, 'summary', 'schedule');
    await page.click('[data-tour="skip"]');
    await page.waitForSelector('#tour-root', { state: 'detached' });
    await page.waitForTimeout(200);
    assert(backend.tourCalls.join() === 'viewer@gmail.com|Skipped', 'skip recorded once via completeTour');
    assert(backend.members.find((m) => m.email === 'viewer@gmail.com').tourStatus === 'Skipped', 'tour status saved for the guest');
    await page.click('#refresh-btn');
    await page.waitForTimeout(300);
    assert(!(await page.$('#tour-root')), 'tour does not replay after a sync');

    await page.click('[data-tab="notifications"]');
    await page.waitForSelector('#view >> text=Welcome is live');
    backend.delayMs = 700;
    await page.click('[data-action="clear-notifications"]');
    await page.waitForSelector('[data-action="clear-notifications"] .spinner');
    assert(await page.isDisabled('[data-action="clear-notifications"]'), 'notification clear disables while pending');
    await page.waitForSelector('#view >> text=No announcements yet');
    backend.delayMs = 0;
    assert(backend.notifications.length === 1, 'clear hides announcements for this member without deleting history');

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

    console.log('Admin manages group labels');
    await page.click('[data-tab="members"]');
    backend.failNextAction = 'addGroup';
    await page.fill('form[data-action="add-group"] input[name="label"]', 'Retry label');
    await page.click('form[data-action="add-group"] button[type="submit"]');
    await page.waitForSelector('#toast-root >> text=Simulated request failure.');
    assert(await page.inputValue('form[data-action="add-group"] input[name="label"]') === 'Retry label',
      'failed label submission preserves its draft');
    assert(!(await page.isDisabled('form[data-action="add-group"] button[type="submit"]')),
      'failed label submission restores the button');
    backend.delayMs = 700;
    await page.click('form[data-action="add-group"] button[type="submit"]');
    await page.waitForSelector('form[data-action="add-group"] button[type="submit"] .spinner');
    assert(await page.isDisabled('form[data-action="add-group"] button[type="submit"]'), 'label submit disables while pending');
    assert(await page.getAttribute('form[data-action="add-group"] button[type="submit"]', 'aria-busy') === 'true' &&
      (await page.textContent('form[data-action="add-group"] button[type="submit"] .sr-only')).includes('Working: Add'),
    'pending label button remains named and announces its busy state');
    assert(await page.inputValue('form[data-action="add-group"] input[name="label"]') === 'Retry label',
      'pending label submission preserves its draft');
    await page.waitForSelector('#view >> text=Retry label');
    assert(await page.inputValue('form[data-action="add-group"] input[name="label"]') === '',
      'successful label submission clears its draft');
    backend.delayMs = 0;
    await page.fill('form[data-action="add-group"] input[name="label"]', 'Submitted label');
    backend.delayMs = 700;
    await page.click('form[data-action="add-group"] button[type="submit"]');
    await page.waitForSelector('form[data-action="add-group"] button[type="submit"] .spinner');
    await page.fill('form[data-action="add-group"] input[name="label"]', 'Newer label draft');
    await page.waitForSelector('#view >> text=Submitted label');
    assert(await page.inputValue('form[data-action="add-group"] input[name="label"]') === 'Newer label draft',
      'successful label submission preserves a newer draft entered while pending');
    backend.delayMs = 0;
    await page.fill('form[data-action="add-group"] input[name="label"]', 'Family');
    await page.click('form[data-action="add-group"] button[type="submit"]');
    await page.waitForSelector('#view >> text=Family');
    await page.fill('form[data-action="add-group"] input[name="label"]', 'Hosts');
    await page.click('form[data-action="add-group"] button[type="submit"]');
    await page.waitForSelector('#view >> text=Hosts');
    await page.fill('form[data-action="add-group"] input[name="label"]', 'Friends');
    await page.click('form[data-action="add-group"] button[type="submit"]');
    await page.waitForSelector('#view >> text=Friends');
    await page.fill('form[data-action="add-group"] input[name="label"]', 'Cousins');
    await page.click('form[data-action="add-group"] button[type="submit"]');
    await page.waitForSelector('#view >> text=Cousins');
    backend.delayMs = 700;
    await page.click('[data-action="archive-group"][data-label="Cousins"]');
    await page.waitForSelector('[data-action="archive-group"][data-label="Cousins"] .spinner');
    assert(await page.isDisabled('[data-action="archive-group"][data-label="Cousins"]'), 'archive button disables while pending');
    await page.waitForSelector('#view >> text=(archived)');
    backend.delayMs = 0;
    assert(backend.groupCatalog.some((g) => g.label === 'Cousins' && g.status === 'Archived'), 'group label can be archived from Members & access');

    console.log('Admin creates a ceremony and an arrival from the app');
    await page.click('[data-tab="control"]');
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
    await page.check('#modal-root input[name="groups"][value="Family"]');
    await page.check('#modal-root input[name="groups"][value="Hosts"]');
    backend.failNextAction = 'addEvent';
    await page.click('#modal-root [data-modal="confirm"]');
    await page.waitForSelector('#toast-root >> text=Simulated request failure.');
    assert(await page.isVisible('#modal-root [role="dialog"]') &&
      await page.inputValue('#modal-root input[name="title"]') === 'Haldi' &&
      await page.isChecked('#modal-root input[name="groups"][value="Hosts"]'),
    'failed modal submission preserves its form draft');
    backend.delayMs = 700;
    await page.click('#modal-root [data-modal="confirm"]');
    await page.waitForSelector('#modal-root [data-modal="confirm"] .spinner');
    assert(await page.isDisabled('#modal-root [data-modal="confirm"]'), 'modal submit disables while pending');
    assert(await page.inputValue('#modal-root input[name="title"]') === 'Haldi', 'pending modal submit preserves form values');
    await page.waitForSelector('#view >> text=Haldi');
    backend.delayMs = 0;
    assert(backend.itinerary.some((e) => e.title === 'Haldi' && e.day === 'Sat, Jan 23' && e.time === '7:05 PM' && e.mapLink === 'https://maps.app.goo.gl/abc123' && e.groups.join() === 'Family,Hosts'), 'event created with date, map link and multiple audience groups');
    assert(!(await page.$('#modal-root [role="dialog"]')), 'create modal closed');

    await page.uncheck('[data-action="event-groups"][data-id="2"][value="Hosts"]');
    backend.delayMs = 700;
    await page.click('[data-action="save-event-groups"][data-id="2"]');
    await page.waitForSelector('[data-action="save-event-groups"][data-id="2"] .spinner');
    assert(await page.isDisabled('[data-action="save-event-groups"][data-id="2"]'), 'event audience save disables while pending');
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-action="save-event-groups"][data-id="2"]');
      return button && !button.disabled;
    });
    backend.delayMs = 0;
    assert(backend.itinerary.find((e) => e.id === '2').groups.join() === 'Family', 'event audience update saves selected groups');

    backend.delayMs = 700;
    await page.click('[data-action="delete-event"][data-id="1"]');
    await page.waitForSelector('[data-action="delete-event"][data-id="1"] .spinner');
    assert(await page.isDisabled('[data-action="delete-event"][data-id="1"]'), 'delete button disables while pending');
    await page.waitForSelector('#view >> text=Welcome', { state: 'detached' });
    backend.delayMs = 0;
    assert(!backend.itinerary.some((e) => e.title === 'Welcome') && backend.itinerary.find((e) => e.title === 'Haldi').id === '1', 'event deleted and later IDs shifted');

    await page.click('[data-action="add-event"]');
    await page.fill('#modal-root input[name="title"]', 'Hosts only');
    await page.fill('#modal-root input[name="day"]', '2027-01-24');
    await page.check('#modal-root input[name="groups"][value="Hosts"]');
    await page.click('#modal-root [data-modal="confirm"]');
    await page.waitForSelector('#view >> text=Hosts only');
    backend.delayMs = 700;
    backend.failEventPush = true;
    await page.selectOption('select[data-action="set-status"][data-id="1"]', 'Live');
    const eventWhatsAppPopupPromise = page.waitForEvent('popup');
    await page.click('#modal-root [data-modal="confirm"]');
    const eventWhatsAppPopup = await eventWhatsAppPopupPromise;
    await page.waitForSelector('#toast-root >> text=push delivery failed');
    const eventPushFailureToast = await page.locator('#toast-root').textContent();
    assert(!eventPushFailureToast.includes('Simulated OneSignal failure.'),
      'event push failure toast does not expose provider diagnostics');
    await eventWhatsAppPopup.close();
    await page.selectOption('select[data-action="set-status"][data-id="1"]', 'Completed');
    await page.waitForSelector('[role="status"][aria-label="Updating event status"] .spinner');
    assert(await page.isDisabled('select[data-action="set-status"][data-id="1"]'), 'event status select disables while pending');
    await page.waitForFunction(() => document.querySelector('select[data-action="set-status"][data-id="1"]')?.value === 'Completed');
    backend.delayMs = 0;
    await page.click('#refresh-btn');
    await page.waitForFunction(() => document.querySelector('#refresh-btn')?.getAttribute('aria-busy') === 'false');
    assert(await page.evaluate(() => {
      const cache = JSON.parse(localStorage.getItem('evt.data'));
      return cache.groupSafe === true && cache.itinerary.every((event) => !event.groups?.length);
    }), 'offline schedule cache excludes every group-restricted ceremony');
    await page.evaluate(() => {
      const cache = JSON.parse(localStorage.getItem('evt.data'));
      cache.savedAt = new Date(Date.now() - (15 * 60 * 1000 - 500)).toISOString();
      localStorage.setItem('evt.data', JSON.stringify(cache));
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      window.dispatchEvent(new Event('offline'));
    });
    await page.waitForSelector('#view >> text=Hosts only', { state: 'detached' });
    const membersTab = await page.$('[data-tab="members"]');
    assert(!membersTab || !(await membersTab.isVisible()), 'going offline immediately hides restricted events and admin controls');
    await page.waitForFunction(() => !localStorage.getItem('evt.data'), null, { timeout: 3000 });
    await page.waitForSelector('#view >> text=Haldi', { state: 'detached' });
    assert(true, 'offline cached schedule is removed when its 15-minute privacy window expires');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      window.dispatchEvent(new Event('online'));
    });
    await page.waitForSelector('#view >> text=Hosts only');

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
    backend.delayMs = 700;
    await page.click('[data-action="toggle-dropoff"][data-id="G2"]');
    await page.waitForSelector('[data-action="toggle-dropoff"][data-id="G2"] .spinner');
    assert(await page.isDisabled('[data-action="toggle-dropoff"][data-id="G2"]'), 'drop status button disables while pending');
    await page.waitForSelector('[data-action="toggle-dropoff"][data-id="G2"][data-next="Pending"]');
    backend.delayMs = 0;
    assert(backend.logistics.find((g) => g.id === 'G2').dropStatus === 'Dropped Off', 'drop marked done');

    await page.click('[data-tab="members"]');
    await page.waitForSelector('text=Members & access');
    assert(await page.isVisible('text=tour skipped'), 'admins can see who skipped the tour');
    assert(await page.isDisabled('select[data-email="admin@gmail.com"]'), 'own role select disabled');
    assert(await page.isDisabled('[data-action="remove-member"][data-email="admin@gmail.com"]'), 'own remove disabled');
    await page.check('input[data-action="member-groups"][data-email="viewer@gmail.com"][value="Family"]');
    await page.check('input[data-action="member-groups"][data-email="viewer@gmail.com"][value="Friends"]');
    backend.delayMs = 700;
    await page.click('button[data-action="save-member-groups"][data-email="viewer@gmail.com"]');
    await page.waitForSelector('button[data-action="save-member-groups"][data-email="viewer@gmail.com"] .spinner');
    assert(await page.isDisabled('button[data-action="save-member-groups"][data-email="viewer@gmail.com"]'),
      'member group save disables while pending');
    await page.waitForFunction(() => document.querySelector('input[data-action="member-groups"][data-email="viewer@gmail.com"][value="Friends"]')?.checked);
    await page.waitForFunction(() => !document.querySelector('button[data-action="save-member-groups"][data-email="viewer@gmail.com"]')?.disabled);
    backend.delayMs = 0;
    assert(backend.members.find((m) => m.email === 'viewer@gmail.com').groups.join() === 'Family,Friends', 'multiple member groups saved');
    const groupPage = await newPage(browser, backend);
    await groupPage.waitForSelector('#fake-gsi');
    await signIn(groupPage, 'viewer@gmail.com');
    await enter(groupPage);
    await groupPage.waitForSelector('#view >> text=Haldi');
    assert(!(await groupPage.isVisible('#view >> text=Hosts only')), 'guest only sees ceremonies for their group and everyone');
    await groupPage.close();

    console.log('Guests see only their audience plus everyone');
    const audienceBackend = makeBackend();
    audienceBackend.members.find((m) => m.email === 'viewer@gmail.com').tourStatus = 'Pending';
    audienceBackend.members[1].groups = ['Group A'];
    audienceBackend.itinerary.push(
      { id: '2', day: 'Fri', time: '11:00', title: 'Group A event', location: 'Hall A', status: 'Upcoming', groups: ['Group A'] },
      { id: '3', day: 'Fri', time: '12:00', title: 'Group B event', location: 'Hall B', status: 'Upcoming', groups: ['Group B'] },
    );
    audienceBackend.notifications.push(
      { id: 'n2', at: new Date().toISOString(), title: 'Group A notice', message: 'For A', eventId: '2', groups: ['Group A'] },
      { id: 'n3', at: new Date().toISOString(), title: 'Group B notice', message: 'For B', eventId: '3', groups: ['Group B'] },
    );
    audienceBackend.ignoreAudienceFilters = true;
    const audiencePage = await newPage(browser, audienceBackend);
    await audiencePage.waitForSelector('#fake-gsi');
    await signIn(audiencePage, 'viewer@gmail.com');
    await enter(audiencePage);
    await audiencePage.waitForSelector('#view >> text=Group A event');
    let audienceText = await audiencePage.textContent('#view');
    assert(audienceText.includes('Group A event') && audienceText.includes('Welcome') &&
      !audienceText.includes('Group B event'),
    'schedule shows matching-group and everyone events, but hides other-group events');
    await audiencePage.click('[data-tour="skip"]');
    await audiencePage.waitForSelector('#tour-root', { state: 'detached' });
    await audiencePage.click('[data-tab="notifications"]');
    await audiencePage.waitForSelector('#view >> text=Group A notice');
    audienceText = await audiencePage.textContent('#view');
    assert(audienceText.includes('Group A notice') && audienceText.includes('Live now: Welcome') &&
      !audienceText.includes('Group B notice'),
    'notifications show matching-group and everyone notices, but hide other-group notices');
    await audiencePage.close();

    console.log('Notification click opens Notices without onboarding overlays');
    const notificationClickBackend = makeBackend();
    notificationClickBackend.exposeNoticeMetadataToGuests = true;
    notificationClickBackend.notifications[0].pushStatus = 'Failed: OneSignal REST error details';
    const notificationClickPage = await newPage(browser, notificationClickBackend, '?open=notifications');
    await notificationClickPage.waitForSelector('#fake-gsi');
    await signIn(notificationClickPage, 'viewer@gmail.com');
    await notificationClickPage.waitForFunction(() => !document.querySelector('#account-btn')?.classList.contains('hidden'));
    assert(!(await notificationClickPage.$('#welcome-splash')), 'notification click skips the welcome animation');
    assert(await notificationClickPage.$eval('#bottom-nav [aria-current="page"]', (button) => button.dataset.tab === 'notifications'),
      'notification click opens the Notices tab');
    assert(!(await notificationClickPage.$('#tour-root')), 'notification click does not cover notices with the first-use tour');
    assert(!(await notificationClickPage.locator('#view').innerText()).includes('OneSignal REST error details'),
      'guest never sees internal OneSignal push errors');
    await notificationClickPage.close();

    console.log('Tour completion stays busy and can recover from an error');
    const tourRetryBackend = makeBackend();
    tourRetryBackend.members.find((m) => m.email === 'viewer@gmail.com').tourStatus = 'Pending';
    const tourRetryPage = await newPage(browser, tourRetryBackend);
    await tourRetryPage.waitForSelector('#fake-gsi');
    await signIn(tourRetryPage, 'viewer@gmail.com');
    await enter(tourRetryPage);
    await tourRetryPage.waitForSelector('#tour-root');
    tourRetryBackend.failNextAction = 'completeTour';
    tourRetryBackend.delayMs = 700;
    await tourRetryPage.click('[data-tour="skip"]');
    await tourRetryPage.waitForSelector('[data-tour="skip"] .spinner');
    assert(await tourRetryPage.isDisabled('[data-tour="skip"]'), 'skip control disables while completion is pending');
    await tourRetryPage.waitForSelector('#toast-root >> text=Simulated request failure.');
    assert(await tourRetryPage.isVisible('#tour-root') &&
      !(await tourRetryPage.isDisabled('[data-tour="skip"]')) &&
      !(await tourRetryPage.evaluate(() => sessionStorage.getItem('evt.tour.viewer@gmail.com'))),
    'failed completion keeps tour open and allows retry without a local completion marker');
    tourRetryBackend.delayMs = 0;
    await tourRetryPage.click('[data-tour="skip"]');
    await tourRetryPage.waitForSelector('#tour-root', { state: 'detached' });
    assert(tourRetryBackend.tourCalls.length === 2 && tourRetryBackend.members.find((m) => m.email === 'viewer@gmail.com').tourStatus === 'Skipped',
      'completion retry records the first successful skip');
    await tourRetryPage.close();

    await page.fill('#new-member-email', 'New.Guest@Gmail.com');
    await page.selectOption('form[data-action="add-member"] select[name="role"]', 'Atithi');
    await page.check('form[data-action="add-member"] input[name="groups"][value="Family"]');
    backend.delayMs = 700;
    await page.click('form[data-action="add-member"] button[type="submit"]');
    await page.waitForSelector('form[data-action="add-member"] button[type="submit"] .spinner');
    assert(await page.isDisabled('form[data-action="add-member"] button[type="submit"]'), 'member invite disables while pending');
    assert(await page.inputValue('#new-member-email') === 'New.Guest@Gmail.com' &&
      await page.isChecked('form[data-action="add-member"] input[name="groups"][value="Family"]'),
    'pending member invite preserves email and group draft');
    await page.fill('#new-member-email', 'Another.Guest@Gmail.com');
    await page.uncheck('form[data-action="add-member"] input[name="groups"][value="Family"]');
    await page.check('form[data-action="add-member"] input[name="groups"][value="Friends"]');
    await page.waitForSelector('text=new.guest@gmail.com');
    backend.delayMs = 0;
    assert(backend.members.some((m) => m.email === 'new.guest@gmail.com' && m.role === 'Atithi'), 'member added (lower-cased) as Atithi');
    assert(await page.inputValue('#new-member-email') === 'Another.Guest@Gmail.com' &&
      await page.isChecked('form[data-action="add-member"] input[name="groups"][value="Friends"]'),
    'successful member invite preserves a newer draft entered while pending');

    backend.delayMs = 700;
    await page.selectOption('select[data-email="new.guest@gmail.com"]', 'Admin');
    await page.waitForSelector('select[data-email="new.guest@gmail.com"] + [role="status"] .spinner');
    assert(await page.isDisabled('select[data-email="new.guest@gmail.com"]'), 'role select disables while pending');
    await page.waitForFunction(() => document.querySelector('select[data-email="new.guest@gmail.com"]')?.value === 'Admin');
    backend.delayMs = 0;
    assert(backend.members.find((m) => m.email === 'new.guest@gmail.com').role === 'Admin', 'role changed to Admin');

    backend.delayMs = 700;
    await page.click('[data-action="remove-member"][data-email="viewer@gmail.com"]');
    await page.waitForSelector('[data-action="remove-member"][data-email="viewer@gmail.com"] .spinner');
    assert(await page.isDisabled('[data-action="remove-member"][data-email="viewer@gmail.com"]'), 'remove button disables while pending');
    await page.waitForFunction(() => !document.querySelector('[data-action="remove-member"][data-email="viewer@gmail.com"]'));
    backend.delayMs = 0;
    assert(!backend.members.some((m) => m.email === 'viewer@gmail.com'), 'member removed');

    assert(backend.audit.length >= 10 && backend.audit.every((a) => a.startsWith('admin@gmail.com|') && /\|\d{4}-\d\d-\d\dT/.test(a)),
      'every admin call carried userEmail + timestamp');

    console.log('Background refresh stays quiet while explicit refresh remains visible');
    backend.delayMs = 700;
    const backgroundResponse = page.waitForResponse((response) => response.url().includes('script.google.com') &&
      response.request().postData()?.includes('"action":"session"'));
    const backgroundRequest = page.waitForRequest((request) => request.url().includes('script.google.com') &&
      request.postData()?.includes('"action":"session"'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await backgroundRequest;
    assert(await page.getAttribute('#refresh-btn', 'aria-busy') === 'false' &&
      await page.textContent('#sync-indicator') !== 'Syncing…',
    'visibility refresh does not show the global loading indicator');
    assert(!(await page.$('form[data-action="add-group"] button .spinner')) &&
      !(await page.$('[data-action="delete-event"] .spinner')),
    'background refresh does not show mutation spinners');
    await backgroundResponse;

    await page.click('#refresh-btn');
    await page.waitForFunction(() => document.querySelector('#refresh-btn')?.getAttribute('aria-busy') === 'true');
    assert(await page.textContent('#sync-indicator') === 'Syncing…', 'explicit refresh keeps its existing loading indicator');
    assert(!(await page.$('form[data-action="add-group"] button .spinner')) &&
      !(await page.$('[data-action="delete-event"] .spinner')) &&
    !(await page.$('[role="status"][aria-label="Updating event status"] .spinner')) &&
    !(await page.$('[role="status"][aria-label="Updating member"] .spinner')),
    'background refresh does not show mutation spinners');
    await page.waitForFunction(() => document.querySelector('#refresh-btn')?.getAttribute('aria-busy') === 'false');
    backend.delayMs = 0;

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
    assert(await page.evaluate(() => window.__oneSignalLog.at(-1) === 'logout'), 'sign-out clears the OneSignal member identity');
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

    console.log('Sign-out before OneSignal initializes clears the pending identity');
    const delayedPushPage = await newPage(browser, backend, '?delayPush=1');
    await delayedPushPage.waitForSelector('#fake-gsi');
    await signIn(delayedPushPage, 'admin@gmail.com');
    await enter(delayedPushPage);
    await delayedPushPage.click('#account-btn');
    await delayedPushPage.click('[data-modal="signout"]');
    await delayedPushPage.waitForSelector('#fake-gsi');
    await delayedPushPage.evaluate(() => window.__releasePushInit());
    await delayedPushPage.waitForFunction(() => window.__oneSignalLog.at(-1) === 'logout');
    assert(await delayedPushPage.evaluate(() => !window.__oneSignalLog.some((x) => x.startsWith('login:'))), 'initialization after sign-out never logs the prior member in');
    await delayedPushPage.close();

    console.log('Expired sessions clear the OneSignal identity');
    const expiredPage = await newPage(browser, backend);
    await expiredPage.waitForSelector('#fake-gsi');
    await signIn(expiredPage, 'admin@gmail.com');
    await enter(expiredPage);
    await expiredPage.waitForFunction(() => window.__oneSignalLog.some((x) => x.startsWith('login:')));
    backend.expireNext = true;
    await expiredPage.click('#refresh-btn');
    await expiredPage.waitForSelector('#fake-gsi');
    assert(await expiredPage.evaluate(() => window.__oneSignalLog.at(-1) === 'logout'), 'expired authentication drops the prior OneSignal identity');
    await expiredPage.close();

    console.log('Offline schedule cache expires to limit stale audience data');
    const offlineCachePage = await newPage(browser, backend);
    await offlineCachePage.waitForSelector('#fake-gsi');
    await signIn(offlineCachePage, 'admin@gmail.com');
    await enter(offlineCachePage);
    await offlineCachePage.evaluate(() => {
      const cache = JSON.parse(localStorage.getItem('evt.data'));
      cache.savedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      localStorage.setItem('evt.data', JSON.stringify(cache));
      sessionStorage.removeItem('evt.credential');
    });
    await offlineCachePage.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
    await offlineCachePage.reload();
    await offlineCachePage.waitForSelector('#fake-gsi');
    assert(await offlineCachePage.evaluate(() => !localStorage.getItem('evt.data')), 'expired offline cache is discarded instead of restoring stale events');
    await offlineCachePage.close();

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
