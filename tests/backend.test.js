const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend, makeToken } = require('./gas-harness');

const ADMIN = 'admin@example.com';
const VIEWER = 'viewer@example.com';
const withViewer = () => createBackend({ members: [[ADMIN, 'Admin', 'seed', ''], [VIEWER, 'Viewer', ADMIN, '']] });

test('doGet is a health check and leaks no data', () => {
  const b = createBackend();
  const out = JSON.parse(b.sandbox.doGet().text);
  assert.equal(out.ok, true);
  assert.equal(out.data.itinerary, undefined);
});

test('requests without a token are rejected', () => {
  const out = createBackend().post({ action: 'session' });
  assert.equal(out.code, 'AUTH_REQUIRED');
});

test('malformed, foreign-audience and expired tokens fail locally without tokeninfo calls', () => {
  const b = createBackend();
  assert.equal(b.post({ action: 'session', idToken: 'not-a-jwt' }).code, 'AUTH_INVALID');
  assert.equal(b.post({ action: 'session', idToken: makeToken(ADMIN, { aud: 'evil' }).token }).code, 'AUTH_INVALID');
  assert.equal(b.post({ action: 'session', idToken: makeToken(ADMIN, { expIn: -60 }).token }).code, 'AUTH_EXPIRED');
  assert.equal(b.post({ action: 'session', idToken: 'a'.repeat(5000) }).code, 'AUTH_INVALID');
  assert.equal(b.fetches.length, 0);
});

test('a well-formed token Google rejects is refused', () => {
  const b = createBackend();
  assert.equal(b.post({ action: 'session', idToken: makeToken(ADMIN).token }).code, 'AUTH_EXPIRED');
});

test('oversized and malformed bodies are rejected', () => {
  const b = createBackend();
  assert.equal(b.post('x'.repeat(20000)).code, 'BAD_REQUEST');
  assert.equal(b.post('[1,2]').code, 'BAD_REQUEST');
  assert.equal(b.post({ action: 'drop table' }).code, 'BAD_REQUEST');
  assert.equal(b.post({ action: 'session', payload: [] }).code, 'BAD_REQUEST');
});

test('non-members are denied without echoing their email', () => {
  const out = createBackend().call('stranger@example.com', 'session');
  assert.equal(out.code, 'NOT_MEMBER');
  assert.ok(!out.error.includes('stranger'));
});

test('client-claimed email must match the verified token', () => {
  const b = createBackend();
  const out = b.post({ action: 'session', idToken: b.tokenFor(VIEWER), userEmail: ADMIN });
  assert.equal(out.code, 'FORBIDDEN');
});

test('viewer session contains the schedule only', () => {
  const out = withViewer().call(VIEWER, 'session');
  assert.equal(out.ok, true);
  assert.equal(out.data.role, 'Viewer');
  assert.equal(out.data.isAdmin, false);
  assert.equal(out.data.itinerary.length, 2);
  assert.equal(out.data.logistics, undefined);
  assert.equal(out.data.members, undefined);
});

test('admin session includes logistics and members', () => {
  const out = createBackend().call(ADMIN, 'session');
  assert.equal(out.data.isAdmin, true);
  assert.equal(out.data.logistics[0].name, 'John Doe');
  assert.equal(out.data.members[0].email, ADMIN);
});

test('viewers cannot run admin actions and the attempt is audited', () => {
  const b = withViewer();
  for (const action of ['updateEvent', 'updatePickup', 'addMember', 'updateMemberRole', 'removeMember', 'addAdmin']) {
    assert.equal(b.call(VIEWER, action, { eventId: '1', status: 'Live', email: 'x@example.com' }).code, 'FORBIDDEN');
  }
  assert.ok(b.audit().every((r) => r[2] === 'Security' && r[1] === VIEWER));
  assert.equal(b.sheets.Itinerary.data[1][5], 'Upcoming');
});

test('prototype-chain action names are not dispatchable', () => {
  const b = createBackend();
  for (const action of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(b.call(ADMIN, action).code, 'BAD_REQUEST');
  }
});

test('updateEvent to Live writes the sheet, pushes and audits', () => {
  const b = createBackend();
  const out = b.call(ADMIN, 'updateEvent', { eventId: '2', status: 'Live', notify: true });
  assert.equal(out.ok, true);
  assert.equal(b.sheets.Itinerary.data[2][5], 'Live');
  assert.equal(out.data.push.ok, true);
  const push = b.fetches.find((f) => f.url.includes('onesignal'));
  assert.equal(push.opts.headers.Authorization, 'Key os-key');
  const [row] = b.audit();
  assert.equal(row[1], ADMIN);
  assert.equal(row[2], 'Event');
  assert.match(row[3], /Changed Event 2 .* to Live — push sent/);
});

test('invalid status values are rejected', () => {
  const b = createBackend();
  assert.equal(b.call(ADMIN, 'updateEvent', { eventId: '1', status: 'Hacked' }).code, 'BAD_REQUEST');
  assert.equal(b.call(ADMIN, 'updateEvent', { eventId: { $ne: 1 }, status: 'Live' }).code, 'BAD_REQUEST');
});

test('updatePickup writes and audits', () => {
  const b = createBackend();
  const out = b.call(ADMIN, 'updatePickup', { id: 'G1', status: 'Picked Up' });
  assert.equal(out.data.logistics[0].pickupStatus, 'Picked Up');
  assert.equal(b.audit()[0][3], 'Marked John Doe (ID G1) as Picked Up');
});

test('member lifecycle: add, change role, remove — each audited', () => {
  const b = createBackend();
  assert.equal(b.call(ADMIN, 'addMember', { email: 'New@Example.com', role: 'Viewer' }).ok, true);
  assert.equal(b.call(ADMIN, 'addMember', { email: 'new@example.com' }).code, 'CONFLICT');
  assert.equal(b.call('new@example.com', 'session').data.role, 'Viewer');
  assert.equal(b.call(ADMIN, 'updateMemberRole', { email: 'new@example.com', role: 'Admin' }).ok, true);
  assert.equal(b.call('new@example.com', 'session').data.isAdmin, true);
  assert.equal(b.call(ADMIN, 'removeMember', { email: 'new@example.com' }).ok, true);
  assert.equal(b.call('new@example.com', 'session').code, 'NOT_MEMBER');
  const details = b.audit().map((r) => r[3]);
  assert.deepEqual(details, [
    'Added new@example.com to Members as Viewer',
    'Changed role of new@example.com from Viewer to Admin',
    'Removed new@example.com (Admin) from Members',
  ]);
});

test('admins cannot remove or demote themselves, and the last admin is protected', () => {
  const b = withViewer();
  assert.equal(b.call(ADMIN, 'removeMember', { email: ADMIN }).code, 'FORBIDDEN');
  assert.equal(b.call(ADMIN, 'updateMemberRole', { email: ADMIN, role: 'Viewer' }).code, 'FORBIDDEN');
  b.call(ADMIN, 'updateMemberRole', { email: VIEWER, role: 'Admin' });
  // Two admins: VIEWER (now admin) can demote ADMIN, but then cannot be demoted by anyone.
  assert.equal(b.call(VIEWER, 'updateMemberRole', { email: ADMIN, role: 'Viewer' }).ok, true);
  assert.equal(b.call(VIEWER, 'removeMember', { email: VIEWER }).code, 'FORBIDDEN');
});

test('an admin removed while their request waits on the lock cannot act', () => {
  const b = withViewer();
  b.call(ADMIN, 'updateMemberRole', { email: VIEWER, role: 'Admin' });
  // Simulate another admin removing VIEWER while VIEWER's request is queued on the lock.
  b.sandbox.LockService.getScriptLock = () => ({
    tryLock: () => {
      const rows = b.sheets.Members.data;
      const i = rows.findIndex((r) => r[0] === VIEWER);
      if (i > 0) rows.splice(i, 1);
      return true;
    },
    releaseLock: () => {},
  });
  const out = b.call(VIEWER, 'addMember', { email: 'sock@example.com', role: 'Admin' });
  assert.equal(out.code, 'NOT_MEMBER');
  assert.ok(!b.sheets.Members.data.some((r) => r[0] === 'sock@example.com'));
  assert.ok(b.audit().some((r) => r[2] === 'Security' && /queued action/.test(r[3])));
});

test('an admin demoted while their request waits on the lock gets FORBIDDEN', () => {
  const b = withViewer();
  b.call(ADMIN, 'updateMemberRole', { email: VIEWER, role: 'Admin' });
  b.sandbox.LockService.getScriptLock = () => ({
    tryLock: () => { b.sheets.Members.data.find((r) => r[0] === VIEWER)[1] = 'Viewer'; return true; },
    releaseLock: () => {},
  });
  assert.equal(b.call(VIEWER, 'addMember', { email: 'sock@example.com' }).code, 'FORBIDDEN');
});

test('invalid emails are rejected when adding', () => {
  const b = createBackend();
  for (const email of ['nope', 'a@b', '=HYPERLINK("x")@evil.com', 'x'.repeat(300) + '@example.com', 42]) {
    assert.equal(b.call(ADMIN, 'addMember', { email }).code, 'BAD_REQUEST', String(email));
  }
});

test('formula injection is neutralised in sheet writes', () => {
  const b = createBackend();
  b.sheets.Itinerary.data[1][3] = '=IMPORTXML("http://evil")';
  b.call(ADMIN, 'updateEvent', { eventId: '1', status: 'Completed' });
  const details = b.audit()[0][3];
  assert.ok(!/^[=+\-@]/.test(details));
  assert.equal(b.sandbox.safeCell_('=1+1'), "'=1+1");
  assert.equal(b.sandbox.safeCell_('@cmd'), "'@cmd");
  assert.equal(b.sandbox.safeCell_('hello'), 'hello');
});

test('per-user rate limiting kicks in', () => {
  const b = createBackend();
  const token = b.tokenFor(ADMIN);
  let last;
  for (let i = 0; i < 61; i++) last = b.post({ action: 'session', idToken: token });
  assert.equal(last.code, 'RATE_LIMITED');
});

test('verified tokens are cached so tokeninfo is called once', () => {
  const b = createBackend();
  const token = b.tokenFor(ADMIN);
  b.post({ action: 'session', idToken: token });
  b.post({ action: 'session', idToken: token });
  assert.equal(b.fetches.filter((f) => f.url.includes('tokeninfo')).length, 1);
});

test('unexpected errors do not leak internals', () => {
  const b = createBackend();
  delete b.sheets.Members;
  const out = b.call(ADMIN, 'session');
  assert.equal(out.ok, false);
  assert.ok(!/stack|at /.test(out.error));
});

/* ---------------------------------------------------------------- Welcome tour */

test('tour: works on a legacy Members sheet with no tour columns and only touches the caller row', () => {
  const b = createBackend({ members: [['admin@example.com', 'Admin', 'seed', ''], [VIEWER, 'Viewer', 'admin@example.com', '']] });
  assert.equal(b.call(VIEWER, 'session').data.tourStatus, 'Pending');
  const out = b.call(VIEWER, 'completeTour', { status: 'Skipped' });
  assert.equal(out.ok, true);
  assert.equal(out.data.tourStatus, 'Skipped');
  const [header, adminRow, viewerRow] = b.sheets.Members.data;
  assert.deepEqual(header, ['Email', 'Role', 'AddedBy', 'AddedDate', 'TourStatus', 'TourCompletedAt']);
  assert.equal(viewerRow[4], 'Skipped');
  assert.equal(Object.prototype.toString.call(viewerRow[5]), '[object Date]');
  assert.ok(adminRow[4] === undefined || adminRow[4] === '', 'other members untouched');
  assert.equal(b.call(VIEWER, 'session').data.tourStatus, 'Skipped');
  assert.match(b.audit().at(-1)[3], /tour skipped/);
});

test('tour: is recorded once — a second call does not overwrite the first outcome', () => {
  const b = createBackend({ members: [['admin@example.com', 'Admin', 'seed', ''], [VIEWER, 'Viewer', 'x', '']] });
  b.call(VIEWER, 'completeTour', { status: 'Completed' });
  const auditCount = b.audit().length;
  assert.equal(b.call(VIEWER, 'completeTour', { status: 'Skipped' }).data.tourStatus, 'Completed');
  assert.equal(b.audit().length, auditCount);
});

test('tour: rejects bad status and non-members', () => {
  const b = createBackend({ members: [['admin@example.com', 'Admin', 'seed', ''], [VIEWER, 'Viewer', 'x', '']] });
  assert.equal(b.call(VIEWER, 'completeTour', { status: 'Pending' }).code, 'BAD_REQUEST');
  assert.equal(b.call('nobody@example.com', 'completeTour', { status: 'Completed' }).code, 'NOT_MEMBER');
});

/* -------------------------------------------------------- Non-destructive setup() */

test('setup: creates missing tabs and headers on an empty workbook', () => {
  const b = createBackend({ members: [], overrides: { Itinerary: null, Logistics: null, Members: null, AuditLog: null } });
  b.sandbox.setup();
  assert.deepEqual(b.sheets.Itinerary.data[0], ['EventID', 'Day', 'Time', 'Title', 'Location', 'Status']);
  assert.deepEqual(b.sheets.Members.data[0], ['Email', 'Role', 'AddedBy', 'AddedDate', 'TourStatus', 'TourCompletedAt']);
  assert.equal(b.sheets.Members.data[1][0], 'owner@example.com');
  assert.equal(b.sheets.Members.data[1][1], 'Admin');
});

test('setup: existing data is preserved; missing columns appended; only blank cells backfilled', () => {
  const b = createBackend({
    members: [['admin@example.com', 'Admin', 'seed', ''], ['old@example.com', '', 'seed', '']],
    overrides: {
      // Custom column order, odd header casing, an extra user column and a blank status.
      Itinerary: [
        ['title', 'EventID', 'Day', 'Time', 'Location', ' status ', 'Notes'],
        ['Mehndi', '1', 'Day 1', '4 PM', 'Lawn', '', 'bring henna'],
        ['Sangeet', '2', 'Day 1', '8 PM', 'Hall', 'Live', ''],
        ['', '', '', '', '', '', 'free-text row without an id'],
      ],
    },
  });
  const before = JSON.stringify(b.sheets.Itinerary.data);
  const summary = b.sandbox.setup();

  const it = b.sheets.Itinerary.data;
  assert.deepEqual(it[0], ['title', 'EventID', 'Day', 'Time', 'Location', ' status ', 'Notes'], 'headers not renamed/reordered');
  assert.equal(it[1][5], 'Upcoming', 'blank status backfilled');
  assert.equal(it[2][5], 'Live', 'filled status untouched');
  assert.equal(it[1][6], 'bring henna', 'extra column preserved');
  assert.equal(it[3][5], '', 'row without key not backfilled');
  assert.notEqual(JSON.stringify(it), before);

  const m = b.sheets.Members.data;
  assert.deepEqual(m[0].slice(4), ['TourStatus', 'TourCompletedAt'], 'new columns appended to the right');
  assert.equal(m[2][1], 'Viewer', 'blank role defaulted');
  assert.equal(m[1][4], 'Pending');
  assert.equal(m.length, 3, 'owner not re-seeded when Members already has people');
  assert.match(summary, /added columns TourStatus, TourCompletedAt/);
  assert.equal(b.audit().at(-1)[2], 'Schema');
});

test('setup: is idempotent — a second run changes nothing', () => {
  const b = createBackend();
  b.sandbox.setup();
  const snapshot = JSON.stringify(Object.fromEntries(Object.entries(b.sheets).map(([k, v]) => [k, v.data])));
  const audits = b.audit().length;
  assert.match(b.sandbox.setup(), /no changes needed/);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(b.sheets).map(([k, v]) => [k, v.data]))), snapshot);
  assert.equal(b.audit().length, audits);
});

test('setup: legacy Admins tab migrates into an empty Members tab', () => {
  const b = createBackend({ members: [], overrides: { Admins: [['Email', 'AddedBy', 'AddedDate'], ['Boss@Example.com', 'me', '']] } });
  b.sandbox.setup();
  const emails = b.sheets.Members.data.slice(1).map((r) => [r[0], r[1]]);
  assert.deepEqual(emails[0], ['boss@example.com', 'Admin']);
  assert.ok(b.sheets.Admins.data.length === 2, 'legacy tab left intact');
});
