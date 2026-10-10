// Registration, priority queue, bed + doctor allocation, discharge,
// triggers and concurrency — exercised through the app role exactly as
// server.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDatabase, appClient, ownerClient, expectError, one, all } = require('./helpers');

let app;
let owner;

const register = (name, disease, room, level) =>
  one(app, 'SELECT * FROM pkg_admission.register_patient($1, $2, $3, $4)', [name, disease, room, level]);
const allocateNext = () => one(app, 'SELECT * FROM pkg_admission.allocate_next()');
const discharge = (id) => one(app, 'SELECT * FROM pkg_admission.discharge_patient($1)', [id]);
const integrity = () => all(app, 'SELECT * FROM api.v_integrity_issues');
const reset = () => owner.query('SELECT pkg_simulation.reset_all()');

test.before(async () => {
  await freshDatabase({ demo: false });
  app = await appClient();
  owner = await ownerClient();
});
test.after(async () => {
  await app.end();
  await owner.end();
});

test('register normalises names, infers specialty and starts WAITING', async () => {
  const p = await register('  ravi   kumar  ', 'Severe Chest Pain', 'ICU', 6);
  assert.equal(p.name, 'RAVI KUMAR');
  assert.equal(p.initials, 'RK');
  assert.equal(p.specialty, 'Cardiology');
  assert.equal(p.status, 'WAITING');
  assert.equal(p.doctor_name, 'Pending Allocation');
  assert.equal(p.emergency_msg, 'Priority trauma/critical response required.');
  assert.equal((await register('madonna', 'migraine', 'General', 1)).initials, 'M');
});

test('register rejects bad input with HM400', async () => {
  for (const args of [['', 'fever', 'General', 3], ['   ', 'fever', 'General', 3], ['A', '  ', 'General', 3],
    ['A', 'fever', 'Suite', 3], ['A', 'fever', 'General', 0], ['A', 'fever', 'General', 8]]) {
    const err = await expectError(register(...args));
    assert.equal(err.code, 'HM400', JSON.stringify(args));
  }
});

test('allocation follows priority: emergency level DESC, then arrival time', async () => {
  await reset();
  const order = [];
  for (const [name, level] of [['p two', 2], ['p five a', 5], ['p five b', 5], ['p one', 1], ['p seven', 7]]) {
    order.push({ name: name.toUpperCase(), level, id: (await register(name, 'fever', 'General', level)).id });
  }
  const queue = await all(app, 'SELECT name, queue_position FROM api.v_waiting_queue ORDER BY queue_position');
  assert.deepEqual(queue.map((q) => q.name), ['P SEVEN', 'P FIVE A', 'P FIVE B', 'P TWO', 'P ONE']);

  const served = [];
  for (let i = 0; i < 5; i++) served.push((await allocateNext()).name);
  assert.deepEqual(served, ['P SEVEN', 'P FIVE A', 'P FIVE B', 'P TWO', 'P ONE']);
  const err = await expectError(allocateNext());
  assert.equal(err.code, 'HM409');
  assert.match(err.message, /No patients in waiting queue/);
});

test('beds: lowest free bed of the preferred type, then fallback in room order', async () => {
  await reset();
  await register('icu one', 'chest pain', 'ICU', 5);
  const first = await allocateNext();
  assert.equal(first.bed_no, 271);
  assert.equal(first.room_type, 'ICU');

  // fill the remaining 29 ICU beds
  for (let i = 0; i < 29; i++) await register(`icu ${i}`, 'chest pain', 'ICU', 5);
  assert.equal(await one(app, 'SELECT pkg_admission.allocate_bulk(29) AS n').then((r) => r.n), 29);
  assert.equal((await one(app, "SELECT free_beds FROM api.v_room_type WHERE code = 'ICU'")).free_beds, 0);

  await register('overflow', 'chest pain', 'ICU', 7);
  const overflow = await allocateNext();
  assert.equal(overflow.room_type, 'General', 'ICU full -> first type in display order');
  assert.equal(overflow.bed_no, 1);
  // stay estimate is recomputed for the room actually given
  assert.notEqual(overflow.estimated_stay_hours, undefined);
  assert.deepEqual(await integrity(), []);
});

test('doctors: least-loaded in specialty, fallback to least-loaded overall, NULL when all full', async () => {
  await reset();
  // two Cardiology patients -> Dr. House (only cardiologist) gets both
  await register('c1', 'heart attack', 'General', 3);
  await register('c2', 'cardiac arrest', 'General', 3);
  await allocateNext();
  await allocateNext();
  assert.equal((await one(app, 'SELECT current_load FROM api.v_doctor_load WHERE doctor_id = 1')).current_load, 2);

  // Nephrology has no doctor -> least loaded overall (all 0 except Dr. House) -> lowest id among them = 2
  await register('n1', 'kidney stones', 'General', 3);
  assert.equal((await allocateNext()).doctor_id, 2);

  // cap every doctor at their current load: next patient gets no doctor
  await owner.query('UPDATE hms.doctor SET max_patients = greatest(current_load, 1)');
  await register('busy1', 'heart attack', 'General', 3);
  await register('busy2', 'heart attack', 'General', 3);
  await register('busy3', 'heart attack', 'General', 3);
  // doctors 3..8 have max 1 and load 0 -> 6 more slots; use them up first
  for (let i = 0; i < 6; i++) await register(`fill${i}`, 'heart attack', 'General', 3);
  await one(app, 'SELECT pkg_admission.allocate_bulk(50)');
  const unassigned = await all(app, "SELECT * FROM api.v_admitted WHERE doctor_id IS NULL");
  assert.equal(unassigned.length, 3);
  assert.equal(unassigned[0].doctor_name, 'Unassigned (At Capacity)');

  // the capacity CHECK is the last line of defence
  const err = await expectError(owner.query('UPDATE hms.doctor SET current_load = max_patients + 1 WHERE doctor_id = 1'));
  assert.equal(err.code, '23514');
  assert.deepEqual(await integrity(), []);
  await reset();
  await owner.query(`UPDATE hms.doctor d SET max_patients = x.m
                       FROM (VALUES (1,40),(2,48),(3,40),(4,52),(5,60),(6,48),(7,44),(8,36)) x(id, m)
                      WHERE d.doctor_id = x.id`);
});

test('discharge frees the bed and doctor slot and writes bill + feedback', async () => {
  await reset();
  await register('dis charge', 'pneumonia', 'Deluxe', 4);
  const admitted = await allocateNext();
  const loadBefore = (await one(app, 'SELECT current_load FROM api.v_doctor_load WHERE doctor_id = $1', [admitted.doctor_id])).current_load;

  const done = await discharge(admitted.id);
  assert.equal(done.status, 'DISCHARGED');
  assert.ok(done.bill.total > 0);
  assert.ok(done.feedback.rating >= 3 && done.feedback.rating <= 5);
  assert.equal((await one(app, 'SELECT occupied FROM api.v_bed_map WHERE bed_no = $1', [admitted.bed_no])).occupied, false);
  assert.equal((await one(app, 'SELECT current_load FROM api.v_doctor_load WHERE doctor_id = $1', [admitted.doctor_id])).current_load, loadBefore - 1);

  // immediate discharge: billed for the (simulated) time actually spent, not the full estimate
  assert.equal(done.bill.stayHours, 1);
  assert.ok(done.estimated_stay_hours > 1);

  assert.equal((await expectError(discharge(admitted.id))).code, 'HM409');
  assert.equal((await expectError(discharge(999999))).code, 'HM404');
  assert.deepEqual(await integrity(), []);
});

test('allocate_bulk clamps to 1..50 and stops when beds run out', async () => {
  await reset();
  assert.equal((await expectError(one(app, 'SELECT pkg_admission.allocate_bulk(5)'))).code, 'HM409');
  for (let i = 0; i < 60; i++) await register(`bulk ${i}`, 'fever', 'Normal', (i % 7) + 1);
  assert.equal((await one(app, 'SELECT pkg_admission.allocate_bulk(500) AS n')).n, 50);
  assert.equal((await one(app, 'SELECT pkg_admission.allocate_bulk(0) AS n')).n, 1);
  // leave exactly 3 beds free
  for (let i = 0; i < 240; i++) await register(`more ${i}`, 'fever', 'General', 1);
  while ((await one(app, 'SELECT free_beds FROM api.v_dashboard_summary')).free_beds > 3) {
    const free = (await one(app, 'SELECT free_beds FROM api.v_dashboard_summary')).free_beds;
    await one(app, 'SELECT pkg_admission.allocate_bulk($1)', [Math.min(50, free - 3)]);
  }
  await register('one more', 'fever', 'General', 1);
  assert.equal((await one(app, 'SELECT pkg_admission.allocate_bulk(50) AS n')).n, 3);
  const err = await expectError(allocateNext());
  assert.match(err.message, /No free beds available/);
  assert.deepEqual(await integrity(), []);
});

test('lifecycle trigger blocks illegal changes; bills are final', async () => {
  await reset();
  await register('trig ger', 'fever', 'General', 3);
  const a = await allocateNext();
  const cases = [
    ["UPDATE hms.admission SET status = 'WAITING', allocated_at = NULL, bed_no = NULL, doctor_id = NULL WHERE admission_id = $1", 'backwards'],
    ["UPDATE hms.admission SET disease = 'something else' WHERE admission_id = $1", 'intake edit'],
    ["UPDATE hms.admission SET arrival_time = now() - interval '1 day' WHERE admission_id = $1", 'arrival edit'],
    ['DELETE FROM hms.admission WHERE admission_id = $1', 'delete'],
  ];
  for (const [sql, label] of cases) {
    assert.equal((await expectError(owner.query(sql, [a.id]))).code, 'HM409', label);
  }
  const insertErr = await expectError(owner.query(`
      INSERT INTO hms.admission (patient_id, disease, preferred_room, emergency_level, specialty, source, status,
                                 allocated_at, bed_no, estimated_stay_hours, discharged_at)
      VALUES ($1, 'x', 'General', 1, 'General Medicine', 'MANUAL', 'DISCHARGED', now(), 5, 2, now())`, [a.patient_id]));
  assert.equal(insertErr.code, 'HM409');

  await discharge(a.id);
  assert.equal((await expectError(owner.query("UPDATE hms.admission SET discharged_at = now() WHERE admission_id = $1", [a.id]))).code, 'HM409');
  assert.equal((await expectError(owner.query('UPDATE hms.bill SET total = 0 WHERE admission_id = $1', [a.id]))).code, 'HM409');
  assert.equal((await expectError(owner.query('DELETE FROM hms.bill WHERE admission_id = $1', [a.id]))).code, 'HM409');
});

test('a bed can never be double-booked (sync trigger + exclusion constraint)', async () => {
  await reset();
  await register('bed one', 'fever', 'General', 3);
  await register('bed two', 'fever', 'General', 3);
  const a = await allocateNext();
  const waiting = await one(app, 'SELECT id FROM api.v_waiting_queue');

  // force the waiting patient into the occupied bed
  const err = await expectError(owner.query(
    "UPDATE hms.admission SET status = 'ADMITTED', allocated_at = now(), bed_no = $1 WHERE admission_id = $2", [a.bed_no, waiting.id]));
  assert.ok(['HM409', '23P01'].includes(err.code), err.code);

  // historical overlap on the same bed is rejected by the exclusion constraint
  await discharge(a.id);
  const pid = (await one(owner, "INSERT INTO hms.patient (full_name, initials) VALUES ('ghost', '') RETURNING patient_id")).patient_id;
  const overlap = await expectError(owner.query(`
      INSERT INTO hms.admission (patient_id, disease, preferred_room, emergency_level, specialty, source, status,
                                 arrival_time, allocated_at, bed_no, estimated_stay_hours, discharged_at)
      SELECT $1, 'x', 'General', 1, 'General Medicine', 'DEMO', 'DISCHARGED',
             allocated_at - interval '1 hour', allocated_at - interval '1 minute', bed_no, 2, discharged_at
        FROM hms.admission WHERE admission_id = $2`, [pid, a.id]));
  assert.equal(overlap.code, '23P01');
});

test('concurrency: 25 parallel allocations for 20 free beds', async () => {
  await reset();
  // fill all 300 beds (30 left waiting), then discharge 20 so exactly 20 are free
  for (let i = 0; i < 330; i++) await register(`cc ${i}`, 'fever', 'General', (i % 7) + 1);
  for (let i = 0; i < 6; i++) await one(app, 'SELECT pkg_admission.allocate_bulk(50)');
  assert.equal((await one(app, 'SELECT free_beds FROM api.v_dashboard_summary')).free_beds, 0);
  for (const { id } of await all(app, 'SELECT id FROM api.v_admitted ORDER BY id LIMIT 20')) await discharge(id);
  assert.equal((await one(app, 'SELECT free_beds FROM api.v_dashboard_summary')).free_beds, 20);
  const waitingBefore = (await one(app, 'SELECT waiting FROM api.v_dashboard_summary')).waiting;

  const clients = await Promise.all(Array.from({ length: 25 }, () => appClient()));
  const results = await Promise.allSettled(clients.map((c) => c.query('SELECT * FROM pkg_admission.allocate_next()')));
  await Promise.all(clients.map((c) => c.end()));

  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.rows[0]);
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 20);
  assert.equal(failed.length, 5);
  for (const f of failed) assert.match(f.reason.message, /No free beds available/);
  assert.equal(new Set(ok.map((r) => r.bed_no)).size, 20, 'no bed handed out twice');
  assert.equal(new Set(ok.map((r) => r.id)).size, 20, 'no patient admitted twice');
  assert.equal((await one(app, 'SELECT waiting FROM api.v_dashboard_summary')).waiting, waitingBefore - 20);
  assert.deepEqual(await integrity(), []);
});

test('concurrency: parallel discharges + live ticks do not deadlock', async () => {
  const admittedIds = (await all(app, 'SELECT id FROM api.v_admitted ORDER BY id LIMIT 40')).map((r) => r.id);
  const clients = await Promise.all(Array.from({ length: 12 }, () => appClient()));
  const jobs = [];
  admittedIds.forEach((id, i) => jobs.push(clients[i % 6].query('SELECT * FROM pkg_admission.discharge_patient($1)', [id])));
  for (let i = 6; i < 12; i++) {
    jobs.push(clients[i].query('SELECT * FROM pkg_simulation.tick(5)'));
    jobs.push(clients[i].query('SELECT * FROM pkg_admission.allocate_bulk(10)').catch((e) => e));
  }
  const results = await Promise.allSettled(jobs);
  await Promise.all(clients.map((c) => c.end()));
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  assert.deepEqual(errors.map((e) => e.code), [], errors.map((e) => e.message).join('\n'));
  assert.deepEqual(await integrity(), []);
});
