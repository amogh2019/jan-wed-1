const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('./gas-harness');

const ADMIN = 'admin@example.com';
const ATITHI = 'guest@example.com';
const backend = (extra = {}) => createBackend({ members: [[ADMIN, 'Admin', 'seed', ''], [ATITHI, 'Atithi', ADMIN, '']], ...extra });
const memberCell = (b, email, column) => {
  const d = b.sheets.Members.data;
  const row = d.find((r) => r[0] === email);
  return row[d[0].indexOf(column)];
};

test('addStay creates the Stays tab on first use, rejects duplicates and is audited', () => {
  const b = backend();
  assert.equal(b.sheets.Stays, undefined);
  const out = b.call(ADMIN, 'addStay', { label: '  Hotel   Leela ' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.data.stayCatalog, [{ label: 'Hotel Leela', status: 'Active' }]);
  assert.deepEqual(b.sheets.Stays.data[0], ['Label', 'Status']);
  assert.equal(b.call(ADMIN, 'addStay', { label: 'hotel leela' }).code, 'CONFLICT');
  assert.equal(b.call(ADMIN, 'addStay', { label: 'A, B' }).code, 'BAD_REQUEST');
  assert.ok(b.audit().some((r) => r[2] === 'Rooms' && r[3] === 'Added place of stay "Hotel Leela"'));
});

test('stay and room actions are admin-only', () => {
  const b = backend();
  assert.equal(b.call(ATITHI, 'addStay', { label: 'Home' }).code, 'FORBIDDEN');
  assert.equal(b.call(ATITHI, 'assignRoom', { email: ATITHI, stay: 'Home', room: '1' }).code, 'FORBIDDEN');
  assert.equal(b.call(ATITHI, 'clearRoom', { email: ATITHI }).code, 'FORBIDDEN');
});

test('assignRoom writes Stay/Room, shows in sessions and audits moves', () => {
  const b = backend();
  b.call(ADMIN, 'addStay', { label: 'Hotel Leela' });
  b.call(ADMIN, 'addStay', { label: 'Farm House' });
  const out = b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'hotel leela', room: ' 204 ' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.data.members.find((m) => m.email === ATITHI), { ...out.data.members.find((m) => m.email === ATITHI), stay: 'Hotel Leela', room: '204' });
  assert.equal(memberCell(b, ATITHI, 'Stay'), 'Hotel Leela');

  const guest = b.call(ATITHI, 'session').data;
  assert.deepEqual(guest.myRoom, { stay: 'Hotel Leela', room: '204' });
  assert.equal(guest.stayCatalog, undefined, 'guests do not get the stay catalog');
  assert.equal(b.call(ADMIN, 'session').data.myRoom, null);
  assert.equal(b.call(ADMIN, 'session').data.stayCatalog.length, 2);

  b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Farm House', room: 'Cottage 2' });
  assert.ok(b.audit().some((r) => r[3] === 'Assigned guest@example.com to Farm House · Room Cottage 2 (was Hotel Leela · Room 204)'));
  const before = b.audit().length;
  b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Farm House', room: 'Cottage 2' });
  assert.equal(b.audit().length, before, 'unchanged assignment is not re-audited');
});

test('assignRoom validates the member, room and place of stay', () => {
  const b = backend();
  assert.equal(b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Nowhere', room: '1' }).code, 'BAD_REQUEST');
  b.call(ADMIN, 'addStay', { label: 'Home' });
  assert.equal(b.call(ADMIN, 'assignRoom', { email: 'stranger@example.com', stay: 'Home', room: '1' }).code, 'NOT_FOUND');
  assert.equal(b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Home', room: '' }).code, 'BAD_REQUEST');
  assert.equal(b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Home', room: 'x'.repeat(21) }).code, 'BAD_REQUEST');
  assert.equal(b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Home', room: '<b>' }).code, 'BAD_REQUEST');
  assert.equal(b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Home', room: 'x'.repeat(20) }).ok, true);
});

test('archived stays keep existing assignments but take no new ones', () => {
  const b = backend();
  b.call(ADMIN, 'addStay', { label: 'Home' });
  b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Home', room: '1' });
  assert.deepEqual(b.call(ADMIN, 'archiveStay', { label: 'home' }).data.stayCatalog, [{ label: 'Home', status: 'Archived' }]);
  assert.equal(b.call(ATITHI, 'session').data.myRoom.room, '1');
  assert.equal(b.call(ADMIN, 'assignRoom', { email: ADMIN, stay: 'Home', room: '2' }).code, 'BAD_REQUEST');
  assert.equal(b.call(ADMIN, 'archiveStay', { label: 'Nope' }).code, 'NOT_FOUND');
});

test('clearRoom removes the assignment and is audited once', () => {
  const b = backend();
  b.call(ADMIN, 'addStay', { label: 'Home' });
  b.call(ADMIN, 'assignRoom', { email: ATITHI, stay: 'Home', room: '1' });
  const out = b.call(ADMIN, 'clearRoom', { email: ATITHI });
  assert.equal(out.data.members.find((m) => m.email === ATITHI).room, '');
  assert.equal(b.call(ATITHI, 'session').data.myRoom, null);
  const before = b.audit().length;
  b.call(ADMIN, 'clearRoom', { email: ATITHI });
  assert.equal(b.audit().length, before);
  assert.ok(b.audit().some((r) => r[3] === 'Removed room assignment of guest@example.com (was Home · Room 1)'));
});

test('assignRoom can place several members in one room atomically', () => {
  const b = backend();
  b.call(ADMIN, 'addStay', { label: 'Home' });
  const out = b.call(ADMIN, 'assignRoom', { emails: [ADMIN, ATITHI, ATITHI.toUpperCase()], stay: 'Home', room: '3' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.data.members.map((m) => m.room), ['3', '3']);
  assert.equal(b.audit().filter((r) => r[3].startsWith('Assigned ')).length, 2);
  const before = b.audit().length;
  assert.equal(b.call(ADMIN, 'assignRoom', { emails: [ATITHI, 'stranger@example.com'], stay: 'Home', room: '4' }).code, 'NOT_FOUND');
  assert.equal(memberCell(b, ATITHI, 'Room'), '3', 'nothing is written when any member is invalid');
  assert.equal(b.audit().length, before);
  assert.equal(b.call(ADMIN, 'assignRoom', { emails: [], stay: 'Home', room: '4' }).code, 'BAD_REQUEST');
});
