// Demo import, live-mode ticks, authentication and the app role's privileges.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDatabase, appClient, ownerClient, expectError, one, all } = require('./helpers');

let app;
let owner;

test.before(async () => {
  await freshDatabase({ demo: false });
  app = await appClient();
  owner = await ownerClient();
});
test.after(async () => {
  await app.end();
  await owner.end();
});

test('import_demo bootstraps 180 history / 240 admitted / 80 waiting, consistently', async () => {
  const r = await one(app, 'SELECT * FROM pkg_simulation.import_demo(true)');
  assert.deepEqual(r, { imported: 500, waiting: 80, admitted: 240, discharged: 180 });

  const s = await one(app, 'SELECT * FROM api.v_dashboard_summary');
  assert.equal(s.waiting, 80);
  assert.equal(s.admitted, 240);
  assert.equal(s.discharged, 180);
  assert.equal(s.free_beds, 60);
  assert.equal(s.demo_imported, true);
  assert.equal(s.patients_served, 420);

  // timeline sanity: arrival <= allocation <= discharge <= now
  const bad = await one(owner, `
      SELECT count(*)::int AS n FROM hms.admission
       WHERE arrival_time > now() OR allocated_at > now() OR discharged_at > now()
          OR allocated_at < arrival_time OR discharged_at < allocated_at`);
  assert.equal(bad.n, 0);

  // history covers today and the previous 6 local days (what the UI filters on)
  const days = await all(owner, `
      SELECT (current_date - discharged_at::date) AS days_ago, count(*)::int AS n
        FROM hms.admission WHERE status = 'DISCHARGED' GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(days.map((d) => d.days_ago), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(days.every((d) => d.n >= 25));

  // the 80 left waiting are the lowest priority
  const minAdmittedLevel = (await one(app, 'SELECT min(emergency_level) AS l FROM api.v_admission WHERE status <> $1', ['WAITING'])).l;
  const maxWaitingLevel = (await one(app, 'SELECT max(emergency_level) AS l FROM api.v_waiting_queue')).l;
  assert.ok(maxWaitingLevel <= minAdmittedLevel);

  assert.deepEqual(await all(app, 'SELECT * FROM api.v_integrity_issues'), []);
  assert.equal((await expectError(app.query('SELECT * FROM pkg_simulation.import_demo(true)'))).code, 'HM409');
});

test('tick: arrivals, due discharges (cursor) and allocations in one transaction', async () => {
  const before = await one(app, 'SELECT * FROM api.v_dashboard_summary');
  const t = await one(app, 'SELECT * FROM pkg_simulation.tick(4)');
  assert.ok(t.arrived === 4 || t.arrived === 5, `arrived ${t.arrived}`);
  const after = await one(app, 'SELECT * FROM api.v_dashboard_summary');
  assert.equal(after.discharged, before.discharged + t.discharged);
  assert.equal(after.waiting, before.waiting + t.arrived - t.allocated);
  assert.ok(t.allocated <= 3);

  // make every stay "elapsed": the next tick discharges all admitted patients
  await owner.query("UPDATE hms.app_setting SET value = '1000000000' WHERE key = 'live_time_acceleration'");
  const admittedNow = (await one(app, 'SELECT admitted FROM api.v_dashboard_summary')).admitted;
  const t2 = await one(app, 'SELECT * FROM pkg_simulation.tick(1)');
  assert.equal(t2.discharged, admittedNow);
  await owner.query("UPDATE hms.app_setting SET value = '1200' WHERE key = 'live_time_acceleration'");

  // queue cap: no arrivals once the queue is at the cap
  await owner.query("UPDATE hms.app_setting SET value = '10' WHERE key = 'live_queue_cap'");
  assert.equal((await one(app, 'SELECT * FROM pkg_simulation.tick(5)')).arrived, 0);
  await owner.query("UPDATE hms.app_setting SET value = '300' WHERE key = 'live_queue_cap'");

  // live arrivals get random names from the pools and are flagged LIVE
  const live = await all(app, "SELECT name, source FROM api.v_admission WHERE source = 'LIVE'");
  assert.ok(live.length >= 4);
  assert.ok(live.every((p) => /^[A-Z]+ [A-Z]+$/.test(p.name)));
  assert.deepEqual(await all(app, 'SELECT * FROM api.v_integrity_issues'), []);
});

test('enqueue_arrivals clamps its count', async () => {
  assert.equal((await one(app, 'SELECT pkg_simulation.enqueue_arrivals(0) AS n')).n, 1);
  assert.equal((await one(app, 'SELECT pkg_simulation.enqueue_arrivals(999) AS n')).n, 50);
});

test('search: prefix suggestions and substring matches, wildcards escaped', async () => {
  await one(app, "SELECT * FROM pkg_admission.register_patient('Zara 100%_Khan', 'fever', 'General', 2)");
  const sug = await all(app, "SELECT name FROM pkg_report.search_suggestions('zara', 8)");
  assert.deepEqual(sug.map((r) => r.name), ['ZARA 100%_KHAN']);
  assert.equal((await all(app, "SELECT name FROM pkg_report.search_suggestions('%', 8)")).length, 0, '% is literal');
  assert.equal((await all(app, "SELECT * FROM pkg_report.search_admissions('0%_k', 50)")).length, 1);
  assert.equal((await all(app, "SELECT * FROM pkg_report.search_admissions('', 50)")).length, 0);
  const rows = await all(app, "SELECT status FROM pkg_report.search_admissions('a', 1000)");
  const rank = { WAITING: 1, ADMITTED: 2, DISCHARGED: 3 };
  assert.ok(rows.every((r, i) => i === 0 || rank[rows[i - 1].status] <= rank[r.status]), 'grouped by status');
});

test('auth: sign up, sign in, sessions, sign out', async () => {
  const u = await one(app, "SELECT * FROM pkg_auth.sign_up('Buri', 'Buri@Example.COM', 'secret1')");
  assert.equal(u.email, 'buri@example.com');

  const hash = (await one(owner, 'SELECT password_hash FROM hms.app_user WHERE user_id = $1', [u.user_id])).password_hash;
  assert.match(hash, /^\$2[abxy]\$10\$/, 'bcrypt, cost 10');
  assert.ok(!hash.includes('secret1'));

  for (const [args, code] of [
    [['Buri', 'buri@example.com', 'secret1'], 'HM409'],      // duplicate (case-insensitive)
    [['', 'x@y.zz', 'secret1'], 'HM400'],
    [['X', 'not-an-email', 'secret1'], 'HM400'],
    [['X', 'x@y.zz', '123'], 'HM400'],
    [['X', '', ''], 'HM400'],
  ]) {
    assert.equal((await expectError(app.query('SELECT * FROM pkg_auth.sign_up($1, $2, $3)', args))).code, code, JSON.stringify(args));
  }

  assert.equal((await expectError(app.query("SELECT * FROM pkg_auth.sign_in('buri@example.com', 'wrong')"))).code, 'HM401');
  assert.equal((await expectError(app.query("SELECT * FROM pkg_auth.sign_in('nobody@example.com', 'secret1')"))).code, 'HM401');

  const s = await one(app, "SELECT * FROM pkg_auth.sign_in('  BURI@example.com ', 'secret1')");
  assert.match(s.token, /^[0-9a-f]{64}$/);
  const stored = await one(owner, 'SELECT count(*)::int AS n FROM hms.user_session WHERE token_hash = digest($1, $2)', [s.token, 'sha256']);
  assert.equal(stored.n, 1, 'only the hash is stored');
  assert.equal((await all(owner, "SELECT 1 FROM hms.user_session WHERE encode(token_hash, 'hex') = $1", [s.token])).length, 0);

  assert.equal((await one(app, 'SELECT * FROM pkg_auth.validate_session($1)', [s.token])).full_name, 'Buri');
  assert.equal((await all(app, 'SELECT * FROM pkg_auth.validate_session($1)', ['f'.repeat(64)])).length, 0);

  // expiry
  await owner.query("UPDATE hms.user_session SET created_at = now() - interval '2 day', expires_at = now() - interval '1 second'");
  assert.equal((await all(app, 'SELECT * FROM pkg_auth.validate_session($1)', [s.token])).length, 0);

  const s2 = await one(app, "SELECT * FROM pkg_auth.sign_in('buri@example.com', 'secret1')");
  assert.equal((await one(owner, 'SELECT count(*)::int AS n FROM hms.user_session')).n, 1, 'expired sessions cleaned up');
  assert.equal((await one(app, 'SELECT pkg_auth.sign_out($1) AS ok', [s2.token])).ok, true);
  assert.equal((await all(app, 'SELECT * FROM pkg_auth.validate_session($1)', [s2.token])).length, 0);
});

test('the app role can only read api views and call the public package API', async () => {
  const denied = [
    'SELECT * FROM hms.admission',
    "INSERT INTO hms.app_setting VALUES ('x', 'y')",
    "UPDATE hms.bill SET total = 0",
    'SELECT pkg_admission._pick_bed($$ICU$$)',
    'SELECT pkg_admission._allocate(1, now())',
    'SELECT pkg_billing.generate_bill(1)',
    'SELECT pkg_rules.infer_specialty($$x$$)',
    'SELECT pkg_simulation.reset_all()',
    'SELECT pkg_simulation._discharge_due()',
  ];
  for (const sql of denied) {
    const err = await expectError(app.query(sql));
    assert.equal(err.code, '42501', `${sql} -> ${err.message}`);   // insufficient_privilege
  }
  // and what it should be able to do
  for (const view of ['v_admission', 'v_waiting_queue', 'v_admitted', 'v_doctor_load', 'v_bed_map',
    'v_room_type', 'v_emergency_level', 'v_dashboard_summary', 'v_integrity_issues']) {
    await app.query(`SELECT * FROM api.${view} LIMIT 1`);
  }
});
