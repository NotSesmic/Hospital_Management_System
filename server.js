/*
 * Hospital API — thin HTTP layer over the PostgreSQL packages.
 *
 * All business rules (queue priority, bed/doctor allocation, billing,
 * discharge, simulation, authentication) live in the database; this file
 * only validates the HTTP shape, calls the package functions as the
 * restricted role hms_app, and maps rows to the JSON the React UI uses.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool, types } = require('pg');
const { appConnection } = require('./db/config');

// numeric -> JS number (money columns are whole rupees; well within 2^53)
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

const pool = new Pool({ ...appConnection(), max: 10 });

// ---------------------------------------------------------------------
// Row mapping: DB columns -> the field names App.js has always used
// ---------------------------------------------------------------------
const ms = (ts) => (ts ? new Date(ts).getTime() : null);

const toPatient = (r) => ({
  id: r.id,
  patientId: r.patient_id,
  name: r.name,
  initials: r.initials,
  disease: r.disease,
  preferredRoom: r.preferred_room,
  roomType: r.room_type || '',
  emergencyLevel: r.emergency_level,
  emergencyLabel: r.emergency_label,
  emergencyMsg: r.emergency_msg,
  specialty: r.specialty,
  doctorId: r.doctor_id,
  doctorName: r.doctor_name,
  status: String(r.status).toLowerCase(),
  source: r.source,
  arrivalTime: ms(r.arrival_time),
  bedAllocTime: ms(r.allocated_at) || 0,
  dischargeTime: ms(r.discharged_at),
  bedNo: r.bed_no ?? -1,
  estimatedStayHours: r.estimated_stay_hours,
  waitSeconds: r.wait_seconds,
  queuePosition: r.queue_position,
  bill: r.bill || null,
  feedback: r.feedback || null,
});

const toUser = (r) => ({ id: r.user_id, name: r.full_name, email: r.email });

// ---------------------------------------------------------------------
// Errors: the packages raise custom SQLSTATEs (see db/sql/03_triggers.sql)
// ---------------------------------------------------------------------
const PG_STATUS = {
  HM400: 400, HM401: 401, HM404: 404, HM409: 409,
  '22P02': 400, // invalid text representation
  '22003': 400, // numeric out of range
  '22007': 400, // invalid datetime
  '23514': 409, // check constraint (e.g. doctor capacity)
  '23505': 409, // unique violation
  '23P01': 409, // exclusion constraint (bed double booking)
  '40P01': 503, // deadlock — should not happen, see pkg_admission
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const intParam = (value, name, { min = -Infinity, max = Infinity, fallback } = {}) => {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be an integer${Number.isFinite(min) ? ` between ${min} and ${max}` : ''}.`);
  }
  return n;
};

const dateParam = (value, name) => {
  const d = /^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(String(value));
  if (value === undefined || Number.isNaN(d.getTime())) throw new HttpError(400, `${name} must be a date or epoch milliseconds.`);
  return d;
};

const textParam = (value, maxLength = 200) => (typeof value === 'string' ? value.slice(0, maxLength) : '');

// ---------------------------------------------------------------------
// App
// ---------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const api = express.Router();

api.get('/health', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT count(*)::int AS issues FROM api.v_integrity_issues');
  res.json({ ok: true, integrityIssues: rows[0].issues });
}));

// ----- authentication (no session required) --------------------------
api.post('/auth/signup', wrap(async (req, res) => {
  const { name, email, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM pkg_auth.sign_up($1, $2, $3)',
    [textParam(name, 80), textParam(email, 120), textParam(password, 200)]);
  res.status(201).json({ user: toUser(rows[0]) });
}));

api.post('/auth/signin', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM pkg_auth.sign_in($1, $2)',
    [textParam(email, 120), textParam(password, 200)]);
  res.json({ token: rows[0].token, expiresAt: ms(rows[0].expires_at), user: toUser(rows[0]) });
}));

// ----- everything below needs a valid session ------------------------
const bearer = (req) => {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

api.use(wrap(async (req, res, next) => {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Please sign in.');
  const { rows } = await pool.query('SELECT * FROM pkg_auth.validate_session($1)', [token]);
  if (!rows.length) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  req.user = toUser(rows[0]);
  req.token = token;
  next();
}));

api.get('/auth/me', (req, res) => res.json({ user: req.user }));

api.post('/auth/signout', wrap(async (req, res) => {
  await pool.query('SELECT pkg_auth.sign_out($1)', [req.token]);
  res.json({ ok: true });
}));

// Reference data the UI needs to render forms, badges and the bed map.
api.get('/meta', wrap(async (req, res) => {
  const [rooms, levels] = await Promise.all([
    pool.query('SELECT code, hourly_rate, capacity FROM api.v_room_type ORDER BY display_order'),
    pool.query('SELECT level, label, protocol_note FROM api.v_emergency_level ORDER BY level'),
  ]);
  res.json({
    roomTypes: rooms.rows.map((r) => ({ code: r.code, hourlyRate: r.hourly_rate, capacity: r.capacity })),
    emergencyLevels: levels.rows.map((r) => ({ level: r.level, label: r.label, note: r.protocol_note })),
  });
}));

// Everything the live dashboard shows, read from one consistent snapshot.
api.get('/dashboard', wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const summary = (await client.query('SELECT * FROM api.v_dashboard_summary')).rows[0];
    const waiting = (await client.query('SELECT * FROM api.v_waiting_queue ORDER BY queue_position')).rows;
    const admitted = (await client.query('SELECT * FROM api.v_admitted ORDER BY allocated_at, id')).rows;
    const doctors = (await client.query('SELECT * FROM api.v_doctor_load ORDER BY doctor_id')).rows;
    const beds = (await client.query('SELECT bed_no, room_type, occupied FROM api.v_bed_map ORDER BY bed_no')).rows;
    const rooms = (await client.query('SELECT code, capacity, free_beds FROM api.v_room_type ORDER BY display_order')).rows;
    await client.query('COMMIT');

    res.json({
      summary: {
        waiting: summary.waiting,
        admitted: summary.admitted,
        discharged: summary.discharged,
        totalBeds: summary.total_beds,
        freeBeds: summary.free_beds,
        freeByType: Object.fromEntries(rooms.map((r) => [r.code, r.free_beds])),
        medianWaitSeconds: summary.median_wait_seconds,
        avgWaitSeconds: summary.avg_wait_seconds,
        patientsServed: summary.patients_served,
        peakLevel: summary.peak_level,
        emergencyDistribution: summary.emergency_distribution,
        demoImported: summary.demo_imported,
      },
      waiting: waiting.map(toPatient),
      admitted: admitted.map(toPatient),
      doctors: doctors.map((d) => ({
        id: d.doctor_id,
        name: d.full_name,
        specialty: d.specialty,
        currentLoad: d.current_load,
        maxPatients: d.max_patients,
        availableSlots: d.available_slots,
      })),
      beds: beds.map((b) => ({ bedNo: b.bed_no, roomType: b.room_type, occupied: b.occupied })),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

api.get('/discharges', wrap(async (req, res) => {
  const from = dateParam(req.query.from, 'from');
  const to = dateParam(req.query.to, 'to');
  if (to <= from) throw new HttpError(400, '"to" must be after "from".');
  const { rows } = await pool.query('SELECT * FROM pkg_report.discharge_history($1, $2)', [from, to]);
  res.json({ discharges: rows.map(toPatient) });
}));

api.get('/search/suggest', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM pkg_report.search_suggestions($1, 8)', [textParam(req.query.q, 100)]);
  res.json({ suggestions: rows.map((r) => r.name) });
}));

api.get('/search', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pkg_report.search_admissions($1, 200)', [textParam(req.query.q, 100)]);
  res.json({ results: rows.map(toPatient) });
}));

// ----- commands ------------------------------------------------------
api.post('/patients', wrap(async (req, res) => {
  const { name, disease, preferredRoom, emergencyLevel } = req.body || {};
  const level = intParam(emergencyLevel, 'emergencyLevel', { min: 1, max: 7 });
  const { rows } = await pool.query('SELECT * FROM pkg_admission.register_patient($1, $2, $3, $4)',
    [textParam(name, 100), textParam(disease, 120), textParam(preferredRoom, 10), level]);
  res.status(201).json({ patient: toPatient(rows[0]) });
}));

api.post('/allocations/next', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pkg_admission.allocate_next()');
  res.json({ patient: toPatient(rows[0]) });
}));

api.post('/allocations/bulk', wrap(async (req, res) => {
  const count = intParam(req.body?.count, 'count', { min: 1, max: 50, fallback: 50 });
  const { rows } = await pool.query('SELECT pkg_admission.allocate_bulk($1) AS allocated', [count]);
  res.json({ allocated: rows[0].allocated });
}));

api.post('/admissions/:id/discharge', wrap(async (req, res) => {
  const id = intParam(req.params.id, 'id', { min: 1, max: 2147483647 });
  const { rows } = await pool.query('SELECT * FROM pkg_admission.discharge_patient($1)', [id]);
  res.json({ patient: toPatient(rows[0]) });
}));

api.post('/simulation/arrivals', wrap(async (req, res) => {
  const count = intParam(req.body?.count, 'count', { min: 1, max: 50, fallback: 3 });
  const { rows } = await pool.query('SELECT pkg_simulation.enqueue_arrivals($1) AS arrived', [count]);
  res.json({ arrived: rows[0].arrived });
}));

api.post('/simulation/tick', wrap(async (req, res) => {
  const inflow = intParam(req.body?.inflow, 'inflow', { min: 1, max: 20, fallback: 2 });
  const { rows } = await pool.query('SELECT * FROM pkg_simulation.tick($1)', [inflow]);
  res.json(rows[0]);
}));

api.post('/demo/import', wrap(async (req, res) => {
  const bootstrap = req.body?.bootstrap !== false;
  const { rows } = await pool.query('SELECT * FROM pkg_simulation.import_demo($1)', [bootstrap]);
  res.json(rows[0]);
}));

api.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use('/api', api);

// Production: serve the React build from the same origin.
const BUILD_DIR = path.join(__dirname, 'build');
if (fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
  app.use(express.static(BUILD_DIR));
  app.get('*', (req, res) => res.sendFile(path.join(BUILD_DIR, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON payload' });
  const status = err.status || PG_STATUS[err.code] || 500;
  const known = err instanceof HttpError || String(err.code || '').startsWith('HM');
  if (status >= 500 && !known) console.error(err);
  let message = known ? err.message : 'Request could not be completed.';
  if (err.code === '23514' && err.constraint === 'doctor_capacity_ck') message = 'Doctor is at full capacity.';
  if (err.code === '23P01') message = 'That bed is already booked for this period.';
  if (err.code === 'ECONNREFUSED') message = 'Database is not reachable.';
  res.status(err.code === 'ECONNREFUSED' ? 503 : status).json({ error: message, code: err.code });
});

if (require.main === module) {
  const PORT = Number(process.env.API_PORT || 4000);
  const server = app.listen(PORT, () => {
    console.log(`Hospital API running on http://localhost:${PORT}`);
  });
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app, pool };
