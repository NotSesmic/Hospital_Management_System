// End-to-end through HTTP: the exact calls the React app makes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDatabase } = require('./helpers');

let server;
let base;
let token;
let appPool;

const call = async (method, path, body, auth = true) => {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, {
    method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json() };
};

test.before(async () => {
  await freshDatabase({ demo: true });
  const { app, pool } = require('../server');
  appPool = pool;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await appPool.end();
});

test('health is public, everything else needs a session', async () => {
  assert.deepEqual((await call('GET', '/health', undefined, false)).body, { ok: true, integrityIssues: 0 });
  for (const [m, p] of [['GET', '/dashboard'], ['GET', '/meta'], ['POST', '/allocations/next'], ['GET', '/auth/me']]) {
    const r = await call(m, p, undefined, false);
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  token = 'f'.repeat(64);
  assert.equal((await call('GET', '/dashboard')).status, 401);
  token = undefined;
});

test('sign up / sign in / me / sign out', async () => {
  let r = await call('POST', '/auth/signup', { name: 'Ward Admin', email: 'Admin@Hospital.test', password: 'pa55word' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.user, { id: 1, name: 'Ward Admin', email: 'admin@hospital.test' });
  assert.equal((await call('POST', '/auth/signup', { name: 'X', email: 'admin@hospital.test', password: 'pa55word' })).status, 409);
  assert.equal((await call('POST', '/auth/signup', { name: 'X', email: 'y@z.test', password: '1' })).status, 400);
  assert.equal((await call('POST', '/auth/signin', { email: 'admin@hospital.test', password: 'nope' })).status, 401);

  r = await call('POST', '/auth/signin', { email: 'admin@hospital.test', password: 'pa55word' });
  assert.equal(r.status, 200);
  token = r.body.token;
  assert.equal((await call('GET', '/auth/me')).body.user.email, 'admin@hospital.test');

  const old = token;
  assert.equal((await call('POST', '/auth/signout')).status, 200);
  assert.equal((await call('GET', '/auth/me')).status, 401);
  token = (await call('POST', '/auth/signin', { email: 'admin@hospital.test', password: 'pa55word' })).body.token;
  assert.notEqual(token, old);
});

test('meta and dashboard shapes', async () => {
  const meta = (await call('GET', '/meta')).body;
  assert.deepEqual(meta.roomTypes.map((r) => [r.code, r.capacity]), [['General', 120], ['Normal', 90], ['Deluxe', 60], ['ICU', 30]]);
  assert.equal(meta.emergencyLevels.length, 7);

  const d = (await call('GET', '/dashboard')).body;
  assert.equal(d.summary.totalBeds, 300);
  assert.equal(d.waiting.length, d.summary.waiting);
  assert.equal(d.admitted.length, d.summary.admitted);
  assert.equal(d.beds.length, 300);
  assert.equal(d.beds.filter((b) => b.occupied).length, d.summary.admitted);
  assert.equal(d.doctors.reduce((s, x) => s + x.currentLoad, 0), d.admitted.filter((p) => p.doctorId).length);
  assert.deepEqual(d.waiting.map((p) => p.queuePosition), d.waiting.map((_, i) => i + 1));
  const p = d.admitted[0];
  for (const key of ['id', 'name', 'initials', 'disease', 'roomType', 'emergencyLevel', 'emergencyMsg', 'specialty',
    'doctorName', 'bedNo', 'arrivalTime', 'bedAllocTime', 'estimatedStayHours']) {
    assert.ok(p[key] !== undefined && p[key] !== null, key);
  }
  assert.equal(typeof p.arrivalTime, 'number');
});

test('register -> allocate -> discharge -> bill shows up in today\'s history', async () => {
  let r = await call('POST', '/patients', { name: 'test patient', disease: 'Road accident trauma', preferredRoom: 'Deluxe', emergencyLevel: 7 });
  assert.equal(r.status, 201);
  const id = r.body.patient.id;
  assert.equal(r.body.patient.name, 'TEST PATIENT');
  assert.equal(r.body.patient.specialty, 'Orthopedics');

  r = await call('POST', '/allocations/next');
  assert.equal(r.status, 200);
  assert.equal(r.body.patient.id, id, 'level 7 jumps the queue');
  assert.equal(r.body.patient.status, 'admitted');
  assert.equal(r.body.patient.roomType, 'Deluxe');

  r = await call('POST', `/admissions/${id}/discharge`);
  assert.equal(r.status, 200);
  const bill = r.body.patient.bill;
  assert.equal(bill.billedHours, 24, 'severe case billed in whole days');
  assert.equal(bill.total, bill.subtotal + bill.gst - bill.insuranceDiscount);

  const start = new Date(); start.setHours(0, 0, 0, 0);
  r = await call('GET', `/discharges?from=${start.getTime()}&to=${start.getTime() + 86400000}`);
  assert.ok(r.body.discharges.some((x) => x.id === id && x.bill && x.feedback));
  assert.ok(r.body.discharges.every((x, i, a) => i === 0 || a[i - 1].dischargeTime >= x.dischargeTime), 'newest first');

  assert.equal((await call('POST', `/admissions/${id}/discharge`)).status, 409);
  assert.equal((await call('POST', '/admissions/99999/discharge')).status, 404);
  assert.equal((await call('POST', '/admissions/abc/discharge')).status, 400);
});

test('bulk allocation, arrivals, tick, demo import', async () => {
  const before = (await call('GET', '/dashboard')).body.summary;
  let r = await call('POST', '/allocations/bulk', { count: 5 });
  assert.equal(r.body.allocated, 5);
  assert.equal((await call('POST', '/allocations/bulk', { count: 51 })).status, 400);

  r = await call('POST', '/simulation/arrivals', { count: 4 });
  assert.equal(r.body.arrived, 4);

  r = await call('POST', '/simulation/tick', { inflow: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['allocated', 'arrived', 'discharged']);

  const after = (await call('GET', '/dashboard')).body.summary;
  assert.equal(after.waiting, before.waiting - 5 + 4 + r.body.arrived - r.body.allocated);

  assert.equal((await call('POST', '/demo/import')).status, 409);
});

test('search endpoints', async () => {
  const name = (await call('GET', '/dashboard')).body.admitted[0].name;
  const prefix = name.slice(0, 3).toLowerCase();
  const s = (await call('GET', `/search/suggest?q=${encodeURIComponent(prefix)}`)).body.suggestions;
  assert.ok(s.length >= 1 && s.length <= 8);
  assert.ok(s.every((n) => n.startsWith(prefix.toUpperCase())));
  const rows = (await call('GET', `/search?q=${encodeURIComponent(name)}`)).body.results;
  assert.ok(rows.some((r) => r.name === name && r.status === 'admitted'));
  assert.deepEqual((await call('GET', '/search?q=')).body.results, []);
});

test('error mapping for bad requests', async () => {
  assert.equal((await call('POST', '/patients', '{not json')).status, 400);
  assert.equal((await call('POST', '/patients', { name: 'a', disease: 'b', preferredRoom: 'ICU', emergencyLevel: 'x' })).status, 400);
  const r = await call('POST', '/patients', { name: ' ', disease: 'b', preferredRoom: 'ICU', emergencyLevel: 3 });
  assert.deepEqual([r.status, r.body.error], [400, 'Name cannot be empty!']);
  assert.equal((await call('GET', '/discharges?from=abc&to=1')).status, 400);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.deepEqual((await call('GET', '/health', undefined, false)).body.integrityIssues, 0);
});
