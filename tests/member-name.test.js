const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('./gas-harness');

const ADMIN = 'admin@example.com';
const GUEST = 'guest@example.com';
const backend = () => createBackend({ members: [[ADMIN, 'Admin', 'seed', ''], [GUEST, 'Atithi', ADMIN, '']] });
const session = (b, email, name) => b.post({ action: 'session', idToken: b.tokenFor(email, { name }), userEmail: email, timestamp: new Date().toISOString() });
const nameCell = (b, email) => {
  const d = b.sheets.Members.data;
  const col = d[0].indexOf('Name');
  return col < 0 ? undefined : d.find((r) => r[0] === email)[col];
};

test('the first sign-in saves the verified Google name and adds the Name column', () => {
  const b = backend();
  assert.equal(b.sheets.Members.data[0].includes('Name'), false);
  assert.equal(session(b, GUEST, 'Asha Rao').ok, true);
  assert.equal(nameCell(b, GUEST), 'Asha Rao');
  assert.equal(b.audit().length, 0, 'a self-service profile fill is not an admin action');
});

test('an existing name is never overwritten, even when Google reports a different one', () => {
  const b = backend();
  session(b, GUEST, 'Asha Rao');
  session(b, GUEST, 'Asha R. Sharma');
  assert.equal(nameCell(b, GUEST), 'Asha Rao');
});

test('a hand-edited name in the sheet is respected', () => {
  const b = backend();
  session(b, GUEST, 'Asha Rao');
  const d = b.sheets.Members.data;
  d.find((r) => r[0] === GUEST)[d[0].indexOf('Name')] = 'Mrs. Rao';
  session(b, GUEST, 'Asha Rao');
  assert.equal(nameCell(b, GUEST), 'Mrs. Rao');
});

test('names are sanitised and formula-like values are neutralised', () => {
  const b = backend();
  session(b, GUEST, '=HYPERLINK("x")\n  Evil\t');
  const saved = nameCell(b, GUEST);
  assert.ok(saved.startsWith("'="), 'safeCell_ prefixes formula-looking text');
  assert.equal(/[\n\t]/.test(saved), false);

  const long = backend();
  session(long, GUEST, 'A'.repeat(180));
  assert.equal(nameCell(long, GUEST).length, 100);
});

test('a token without a name writes nothing and still signs in', () => {
  const b = backend();
  const out = session(b, GUEST, '   ');
  assert.equal(out.ok, true);
  assert.equal(nameCell(b, GUEST), undefined);
});

test('a busy lock never blocks sign-in; the name is saved on the next sign-in', () => {
  const b = backend();
  const realLock = b.sandbox.LockService;
  b.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) };
  assert.equal(session(b, GUEST, 'Asha Rao').ok, true);
  assert.notEqual(nameCell(b, GUEST), 'Asha Rao');
  b.sandbox.LockService = realLock;
  session(b, GUEST, 'Asha Rao');
  assert.equal(nameCell(b, GUEST), 'Asha Rao');
});

test('admins see member names; other members never get the member list', () => {
  const b = backend();
  session(b, GUEST, 'Asha Rao');
  const admin = session(b, ADMIN, 'Host Admin').data;
  assert.equal(admin.members.find((m) => m.email === GUEST).name, 'Asha Rao');
  assert.equal(admin.members.find((m) => m.email === ADMIN).name, 'Host Admin');
  assert.equal(session(b, GUEST, 'Asha Rao').data.members, undefined);
});

test('removing and re-adding a member lets their name be captured again; existing columns stay untouched', () => {
  const b = backend();
  session(b, GUEST, 'Asha Rao');
  const headerBefore = b.sheets.Members.data[0].slice();
  assert.equal(b.call(ADMIN, 'removeMember', { email: GUEST }).ok, true);
  b.call(ADMIN, 'addMember', { email: GUEST, role: 'Atithi' });
  assert.equal(nameCell(b, GUEST), '');
  session(b, GUEST, 'Asha Rao');
  assert.equal(nameCell(b, GUEST), 'Asha Rao');
  assert.deepEqual(b.sheets.Members.data[0].slice(0, headerBefore.length), headerBefore);
});
