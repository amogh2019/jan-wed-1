const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createBackend } = require('./gas-harness');

const ADMIN = 'admin@example.com';
const ATITHI = 'guest@example.com';
const HEADERS = [
  'Timestamp', 'Email address', 'Name of the Family / Person', 'Number of Members', 'Contact Number',
  'Date Time of Arrival', 'Date Time of Departure', 'Mode of Transport', 'Family Member\u2019s Email Addresses',
];
const row = (over = {}) => {
  const v = {
    ts: '01/01/2027 10:00:00', email: 'new@example.com', name: 'The Rao Family', members: 3, contact: '+91 98765 43210',
    arrival: '20/01/2027 09:00', departure: '23/01/2027 18:30', mode: 'Flight', family: 'a@example.com, b@example.com', ...over,
  };
  return [v.ts, v.email, v.name, v.members, v.contact, v.arrival, v.departure, v.mode, v.family];
};
const lastLogistics = (b) => {
  const d = b.sheets.Logistics.data;
  const at = (name) => d[d.length - 1][d[0].indexOf(name)];
  return { arrival: at('ArrivalDateTime'), departure: at('DepartureDateTime'), members: at('Members'), contact: at('Contact'), name: at('Name') };
};
const backend = (rows, extra = {}) => createBackend({
  members: [[ADMIN, 'Admin', 'seed', ''], [ATITHI, 'Atithi', ADMIN, '']],
  overrides: { 'Form Responses 1': [HEADERS, ...rows] },
  ...extra,
});

test('list parses entries newest first and hides fully onboarded ones', () => {
  const b = backend([row({ email: 'old@example.com', family: '' }), row({ email: ATITHI, family: '' }), row({ email: 'bad', family: '' }), row()]);
  const { formResponses: f } = b.call(ADMIN, 'listFormResponses').data;
  assert.equal(f.configured, true);
  assert.deepEqual(f.hidden, { onboarded: 1, noEmail: 1 });
  assert.deepEqual(f.items.map((i) => i.email), ['new@example.com', 'old@example.com']);
  const item = f.items[0];
  assert.equal(item.row, 5);
  assert.equal(item.newCount, 3);
  assert.equal(item.members, '3');
  assert.deepEqual(item.familyEmails.map((e) => e.email), ['a@example.com', 'b@example.com']);
});

test('list reports when the responses tab is missing', () => {
  const out = createBackend().call(ADMIN, 'listFormResponses');
  assert.equal(out.data.formResponses.configured, false);
});

test('tab name can be overridden with a script property', () => {
  const b = createBackend({ props: { FORM_RESPONSES_SHEET: 'RSVP' }, overrides: { RSVP: [HEADERS, row()] } });
  assert.equal(b.call(ADMIN, 'listFormResponses').data.formResponses.items.length, 1);
});

test('family emails are split, deduplicated and validated', () => {
  const b = backend([row({ family: 'a@example.com;A@example.com\nnew@example.com, nope, <b@example.com>' })]);
  const [item] = b.call(ADMIN, 'listFormResponses').data.formResponses.items;
  assert.deepEqual(item.familyEmails.map((e) => e.email), ['a@example.com', 'b@example.com']);
  assert.ok(item.warnings.some((w) => w.includes('nope')));
});

test('onboarding adds members and a travel plan, and audits each write', () => {
  const b = backend([row()]);
  const out = b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.data.result.added, ['new@example.com', 'a@example.com', 'b@example.com']);
  const emails = out.data.members.map((m) => m.email);
  assert.ok(['new@example.com', 'a@example.com', 'b@example.com'].every((e) => emails.includes(e)));
  assert.ok(out.data.members.filter((m) => m.email !== ADMIN).every((m) => m.role === 'Atithi'));
  const g = out.data.logistics.find((l) => l.email === 'new@example.com');
  assert.equal(g.name, 'The Rao Family');
  assert.equal(g.members, '3');
  assert.equal(g.mode, 'Flight');
  assert.equal(g.pickupStatus, 'Pending');
  assert.equal(out.data.formResponses.items.length, 0);
  assert.equal(b.audit().length, 4);
});

test('onboarding the same response twice is idempotent', () => {
  const b = backend([row()]);
  b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  const before = b.sheets.Members.data.length;
  const again = b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  assert.equal(again.ok, true);
  assert.deepEqual(again.data.result.added, []);
  assert.equal(b.sheets.Members.data.length, before);
  assert.equal(b.call(ADMIN, 'session').data.logistics.filter((l) => l.email === 'new@example.com').length, 1);
});

test('existing primary member: only new family is added, travel created once', () => {
  const b = backend([row({ email: ATITHI })]);
  const out = b.call(ADMIN, 'onboardFormResponse', { row: 2, email: ATITHI });
  assert.deepEqual(out.data.result.added, ['a@example.com', 'b@example.com']);
  assert.ok(out.data.result.travelId);
  assert.equal(out.data.logistics.filter((l) => l.email === ATITHI).length, 1);
});

test('a moved or mismatching row is a conflict and changes nothing', () => {
  const b = backend([row()]);
  assert.equal(b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'other@example.com' }).code, 'CONFLICT');
  assert.equal(b.call(ADMIN, 'onboardFormResponse', { row: 9, email: 'new@example.com' }).code, 'CONFLICT');
  assert.equal(b.call(ADMIN, 'onboardFormResponse', { row: 'x', email: 'new@example.com' }).code, 'BAD_REQUEST');
  assert.equal(b.sheets.Members.data.length, 3);
});

test('onboarding without a responses tab is NOT_FOUND', () => {
  assert.equal(createBackend().call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' }).code, 'NOT_FOUND');
});

test('unusable travel values are blanked with warnings but members are still added', () => {
  const b = backend([row({ members: 9999, contact: 'call me', arrival: 'soon', departure: '31/02/2027', mode: '' })]);
  const out = b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  assert.equal(out.ok, true);
  assert.equal(out.data.result.warnings.length, 4);
  const g = out.data.logistics.find((l) => l.email === 'new@example.com');
  assert.deepEqual([g.members, g.contact, g.arrival, g.departure], ['', '', '', '']);
  assert.deepEqual(Object.values(lastLogistics(b)).slice(0, 4), ['', '', '', '']);
});

test('departure before arrival is dropped; Date cells and date-only strings work', () => {
  const b = backend([row({ departure: '19/01/2027' })]);
  b.sheets['Form Responses 1'].data[1][5] = vm.runInContext('new Date(Date.UTC(2027, 0, 20, 9, 0))', b.sandbox);
  assert.equal(b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' }).ok, true);
  let l = lastLogistics(b);
  assert.equal(l.arrival.getTime(), Date.UTC(2027, 0, 20, 9, 0));
  assert.equal(l.departure, '');

  const b2 = backend([row({ arrival: '20/01/2027', departure: '' })]);
  b2.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  l = lastLogistics(b2);
  assert.equal(l.arrival.getTime(), Date.UTC(2027, 0, 20, 0, 0));
});

test('string dates are stored as real dates in dd/MM/yyyy HH:mm', () => {
  const b = backend([row()]);
  b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  const l = lastLogistics(b);
  assert.equal(l.arrival.getTime(), Date.UTC(2027, 0, 20, 9, 0));
  assert.equal(l.departure.getTime(), Date.UTC(2027, 0, 23, 18, 30));
});

test('formula-like names are neutralised in the sheet', () => {
  const b = backend([row({ name: '=HYPERLINK("http://evil")' })]);
  b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  const logistics = b.sheets.Logistics.data;
  const nameCol = logistics[0].indexOf('Name');
  assert.equal(logistics[logistics.length - 1][nameCol][0], "'");
});

test('newly onboarded members get every active group; existing members and archived groups are untouched', () => {
  const b = backend([row()], {
    overrides: {
      'Form Responses 1': [HEADERS, row({ email: ATITHI, family: 'a@example.com' })],
      Groups: [['Label', 'Status'], ['Bride Side', 'Active'], ['Groom Side', 'Active'], ['Old Crew', 'Archived']],
    },
  });
  const out = b.call(ADMIN, 'onboardFormResponse', { row: 2, email: ATITHI });
  assert.equal(out.ok, true);
  assert.deepEqual(out.data.result.added, ['a@example.com']);
  const byEmail = Object.fromEntries(out.data.members.map((m) => [m.email, m.groups]));
  assert.deepEqual(byEmail['a@example.com'], ['Bride Side', 'Groom Side']);
  assert.deepEqual(byEmail[ATITHI], []);
  assert.ok(b.audit().some((l) => l[3].includes('a@example.com') && l[3].includes('Bride Side, Groom Side')));
});

test('onboarding with no groups defined adds members with no groups', () => {
  const out = backend([row()]).call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  assert.ok(out.data.members.filter((m) => m.email !== ADMIN).every((m) => m.groups.length === 0));
});

test('more than 10 active groups: only the first 10 are assigned, with a warning', () => {
  const groups = Array.from({ length: 12 }, (_, i) => [`Group ${String.fromCharCode(65 + i)}`, 'Active']);
  const b = backend([row({ family: '' })], { overrides: { 'Form Responses 1': [HEADERS, row({ family: '' })], Groups: [['Label', 'Status'], ...groups] } });
  const out = b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com' });
  assert.equal(out.ok, true);
  assert.equal(out.data.members.find((m) => m.email === 'new@example.com').groups.length, 10);
  assert.ok(out.data.result.warnings.some((w) => w.includes('first 10 of 12')));
});

test('admin-chosen groups override the default; empty means no groups; unknown or archived groups are rejected', () => {
  const groups = { Groups: [['Label', 'Status'], ['Bride Side', 'Active'], ['Groom Side', 'Active'], ['Old Crew', 'Archived']] };
  const run = (sel) => {
    const b = backend([row({ family: 'a@example.com' })], { overrides: { 'Form Responses 1': [HEADERS, row({ family: 'a@example.com' })], ...groups } });
    return b.call(ADMIN, 'onboardFormResponse', { row: 2, email: 'new@example.com', groups: sel });
  };
  const picked = run(['Groom Side']);
  assert.ok(picked.data.members.filter((m) => picked.data.result.added.includes(m.email)).every((m) => m.groups.join() === 'Groom Side'));
  assert.ok((() => { const r = run([]); return r.data.members.filter((m) => r.data.result.added.includes(m.email)).every((m) => m.groups.length === 0); })());
  assert.equal(run(['Nope']).code, 'BAD_REQUEST');
  assert.equal(run(['Old Crew']).code, 'BAD_REQUEST');
});
