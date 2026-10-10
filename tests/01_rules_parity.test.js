// pkg_rules / pkg_billing must reproduce the formulas of the original
// App.js (tests/original-logic.js), except for the one deliberate fix
// documented in pkg_billing.compute_bill (diagnostics NaN -> 0 bug).
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDatabase, ownerClient, all, one } = require('./helpers');
const orig = require('./original-logic');
const seed = require('../src/data/patients-500.json');

const ROOMS = ['General', 'Normal', 'Deluxe', 'ICU'];
const EXTRA_DISEASES = ['Heart failure', 'Road Accident', 'skin rash', 'urinary tract issue', 'liver cirrhosis',
  'Septic shock', 'unknown thing', 'HEAD INJURY', 'chikungunya', 'Chest Congestion', 'thyroid storm', 'sinus', 'flu'];
const DISEASES = [...new Set(seed.map((p) => p.disease))].concat(EXTRA_DISEASES);

let owner;
test.before(async () => {
  await freshDatabase({ demo: true });
  owner = await ownerClient();
});
test.after(() => owner.end());

test('infer_specialty matches the original keyword rules for every disease', async () => {
  const rows = await all(owner, 'SELECT d, pkg_rules.infer_specialty(d) AS s FROM unnest($1::text[]) d', [DISEASES]);
  for (const { d, s } of rows) assert.equal(s, orig.inferSpecialty(d), d);
});

test('disease_profile matches the original profile table', async () => {
  const rows = await all(owner, `SELECT d, (p).min_stay_hours AS lo, (p).max_stay_hours AS hi, (p).treatment_cost AS cost
                                   FROM (SELECT d, pkg_rules.disease_profile(d) p FROM unnest($1::text[]) d) x`, [DISEASES]);
  for (const r of rows) {
    const p = orig.getDiseaseProfile(r.d);
    assert.deepEqual([r.lo, r.hi, r.cost], [p.stayHours[0], p.stayHours[1], p.treatmentCost], r.d);
  }
});

test('estimate_stay_hours matches the original for every disease x level x room x 60 ids', async () => {
  const rows = await all(owner, `
      SELECT d, l, r, i, pkg_rules.estimate_stay_hours(i, d, l, r) AS h
        FROM unnest($1::text[]) d, generate_series(1, 7) l, unnest($2::text[]) r, generate_series(1, 60) i`,
  [DISEASES, ROOMS]);
  assert.equal(rows.length, DISEASES.length * 7 * 4 * 60);
  const mismatches = rows.filter((x) => x.h !== orig.estimateStayHours({ id: x.i, disease: x.d, emergencyLevel: x.l }, x.r));
  // JS multiplies binary floats, SQL multiplies exact decimals; allow
  // differences only where the exact product sits on a .5 boundary
  for (const m of mismatches) {
    const exact = await one(owner, `SELECT (p.min_stay_hours + (($1 * 11 + $2 * 7) % greatest(1, p.max_stay_hours - p.min_stay_hours)))
                                           * rt.stay_factor * (1 + ($2 - 3) * 0.11)
                                           * CASE WHEN p.treatment_cost >= 20000 THEN 1.22 WHEN p.treatment_cost >= 12000 THEN 1.10 ELSE 1 END AS v
                                      FROM pkg_rules.disease_profile($3) p, hms.room_type rt WHERE rt.code = $4`, [m.i, m.l, m.d, m.r]);
    assert.equal(Number(exact.v) % 1, 0.5, `unexpected mismatch for ${JSON.stringify(m)}`);
  }
  console.log(`  stay estimates: ${rows.length} compared, ${mismatches.length} differ only by float rounding at .5`);
});

test('every generated bill matches the original buildBill (with the diagnostics fix)', async () => {
  // discharge everyone currently admitted, with stays fully elapsed
  await owner.query("UPDATE hms.app_setting SET value = '1000000000' WHERE key = 'live_time_acceleration'");
  await owner.query('SELECT pkg_simulation._discharge_due()');

  const rows = await all(owner, `
      SELECT a.admission_id AS id, a.disease, a.emergency_level, a.estimated_stay_hours, b.room_type, to_jsonb(b) AS bill
        FROM hms.admission a JOIN hms.bill b USING (admission_id)`);
  assert.equal(rows.length, 420, '180 demo history + 240 discharged now');

  let defaultProfileCases = 0;
  for (const r of rows) {
    const patient = { id: r.id, disease: r.disease, emergencyLevel: r.emergency_level, roomType: r.room_type, estimatedStayHours: r.estimated_stay_hours };
    const expected = { ...orig.buildBill(patient, Date.now()) };
    if (!orig.getDiseaseProfile(r.disease).diagnostics) {
      // original: safeMoney(undefined + level*350) === 0  (bug); DB charges level*350
      defaultProfileCases += 1;
      expected.diagnosticsCharge = r.emergency_level * 350;
      expected.subtotal += expected.diagnosticsCharge;
      expected.gst = Math.round(expected.subtotal * 0.05);
      expected.insuranceDiscount = r.id % 4 === 0 ? Math.round(expected.subtotal * 0.12) : 0;
      expected.total = expected.subtotal + expected.gst - expected.insuranceDiscount;
    }
    const b = r.bill;
    const actual = {
      stayHours: b.stay_hours, roomRate: Number(b.room_rate), roomCharge: Number(b.room_charge),
      emergencyCharge: Number(b.emergency_charge), doctorFee: Number(b.doctor_fee), nursingCharge: Number(b.nursing_charge),
      pharmacyCharge: Number(b.pharmacy_charge), diagnosticsCharge: Number(b.diagnostics_charge),
      procedureCharge: Number(b.procedure_charge), treatmentCharge: Number(b.treatment_charge),
      serviceCharge: Number(b.service_charge), subtotal: Number(b.subtotal), gst: Number(b.gst),
      insuranceDiscount: Number(b.insurance_discount), total: Number(b.total),
    };
    assert.deepEqual(actual, expected, `bill for admission ${r.id} (${r.disease})`);
  }
  assert.ok(defaultProfileCases > 0, 'dataset should include diseases with no profile match');
  console.log(`  bills: 420 compared, ${defaultProfileCases} use the corrected diagnostics charge`);
});

test('feedback matches the original createFeedback for every discharge', async () => {
  const rows = await all(owner, `SELECT f.*, a.emergency_level FROM hms.feedback f JOIN hms.admission a USING (admission_id)`);
  assert.equal(rows.length, 420);
  for (const r of rows) {
    assert.deepEqual(
      { rating: r.rating, complaintType: r.complaint_type, complaintText: r.complaint_text, suggestion: r.suggestion },
      orig.createFeedback({ id: r.admission_id, emergencyLevel: r.emergency_level }),
    );
  }
});
