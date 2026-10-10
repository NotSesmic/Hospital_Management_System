#!/usr/bin/env node
/*
 * Builds (or resets) the hospital database.
 *
 *   node db/setup.js            drop + recreate the database, load demo data
 *   node db/setup.js --no-demo  same, but leave the hospital empty
 *   node db/setup.js --reset    keep schema and staff accounts, wipe patients,
 *                               re-import the demo data (add --no-demo to skip)
 *
 * Connection settings come from db/config.js (.env / environment variables).
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { config, adminConnection } = require('./config');

const SQL_DIR = path.join(__dirname, 'sql');
const SEED_FILE = path.join(__dirname, '..', 'src', 'data', 'patients-500.json');

const args = new Set(process.argv.slice(2));
const withDemo = !args.has('--no-demo');
const resetOnly = args.has('--reset');
const quiet = args.has('--quiet') || process.env.HMS_SETUP_QUIET === '1';
const log = (...m) => { if (!quiet) console.log(...m); };

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (text) => `'${String(text).replace(/'/g, "''")}'`;

async function withClient(connection, fn) {
  const client = new Client(connection);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureRoles(admin) {
  const { rows } = await admin.query(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [[config.ownerRole, config.appUser]]
  );
  const existing = new Set(rows.map((r) => r.rolname));
  if (!existing.has(config.ownerRole)) {
    await admin.query(`CREATE ROLE ${ident(config.ownerRole)} NOLOGIN`);
  }
  if (!existing.has(config.appUser)) {
    await admin.query(`CREATE ROLE ${ident(config.appUser)} LOGIN PASSWORD ${literal(config.appPassword)}`);
  } else {
    await admin.query(`ALTER ROLE ${ident(config.appUser)} LOGIN PASSWORD ${literal(config.appPassword)}`);
  }
}

// Node/ICU and PostgreSQL don't always agree on zone names (Windows reports
// the legacy "Asia/Calcutta", which some PostgreSQL builds don't ship).
const TZ_ALIASES = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh' };

async function pickTimeZone(admin) {
  const wanted = process.env.DB_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  for (const candidate of [wanted, TZ_ALIASES[wanted]].filter(Boolean)) {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [candidate]);
    if (rowCount) return candidate;
  }
  console.warn(`Time zone "${wanted}" is unknown to PostgreSQL; using UTC (set DB_TIMEZONE to override).`);
  return 'UTC';
}

async function recreateDatabase(admin) {
  const db = ident(config.database);
  const timeZone = await pickTimeZone(admin);
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${ident(config.ownerRole)}`);
  // "today" for the demo history is computed in this zone
  await admin.query(`ALTER DATABASE ${db} SET timezone TO ${literal(timeZone)}`);
  await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${ident(config.appUser)}`);
  return timeZone;
}

async function loadSeed(client) {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  await client.query(
    `INSERT INTO hms.demo_patient_seed (seed_id, full_name, disease, preferred_room, emergency_level)
     SELECT id, name, disease, "preferredRoom", "emergencyLevel"
       FROM jsonb_to_recordset($1::jsonb)
            AS s(id integer, name text, disease text, "preferredRoom" text, "emergencyLevel" smallint)`,
    [JSON.stringify(seed)]
  );
  return seed.length;
}

async function importDemo(client) {
  const { rows } = await client.query('SELECT * FROM pkg_simulation.import_demo(true)');
  return rows[0];
}

async function fullSetup({ demo = withDemo } = {}) {
  const timeZone = await withClient(adminConnection(), async (admin) => {
    await ensureRoles(admin);
    return recreateDatabase(admin);
  });
  log(`Created database "${config.database}" (time zone ${timeZone})`);

  await withClient(adminConnection(config.database), async (client) => {
    // extensions need the superuser; everything else is created as hms_owner
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public');
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${ident(config.ownerRole)}`);
      const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        await client.query(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
        log(`  applied ${file}`);
      }
      const n = await loadSeed(client);
      log(`  loaded ${n} demo seed patients`);
      if (demo) {
        const r = await importDemo(client);
        log(`  demo data: ${r.waiting} waiting, ${r.admitted} admitted, ${r.discharged} discharged`);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function resetData({ demo = withDemo } = {}) {
  await withClient(adminConnection(config.database), async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${ident(config.ownerRole)}`);
      await client.query('SELECT pkg_simulation.reset_all()');
      log('Wiped all patients, admissions, bills and feedback');
      if (demo) {
        const r = await importDemo(client);
        log(`  demo data: ${r.waiting} waiting, ${r.admitted} admitted, ${r.discharged} discharged`);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

if (require.main === module) {
  (resetOnly ? resetData() : fullSetup())
    .then(() => log('Done.'))
    .catch((err) => {
      console.error(`\nDatabase setup failed: ${err.message}`);
      if (err.where) console.error(err.where);
      if (err.code === 'ECONNREFUSED') {
        console.error(`Is PostgreSQL running on ${config.host}:${config.port}? See README "Database".`);
      }
      process.exit(1);
    });
}

module.exports = { fullSetup, resetData };
