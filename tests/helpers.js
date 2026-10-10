// Shared test plumbing. Every test file rebuilds a separate database
// (hospital_test) so the real "hospital" database is never touched.
process.env.DB_NAME = process.env.TEST_DB_NAME || 'hospital_test';
process.env.HMS_SETUP_QUIET = '1';

const { Client, types } = require('pg');
const { config, adminConnection, appConnection } = require('../db/config');
const { fullSetup } = require('../db/setup');

types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

async function freshDatabase({ demo = false } = {}) {
  await fullSetup({ demo });
}

// hms_app — exactly what server.js connects as
async function appClient() {
  const c = new Client(appConnection());
  await c.connect();
  return c;
}

// superuser acting as the schema owner, for arranging test situations
async function ownerClient() {
  const c = new Client(adminConnection(config.database));
  await c.connect();
  await c.query(`SET ROLE ${config.ownerRole}`);
  return c;
}

// run a query that is expected to fail; returns the pg error
async function expectError(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the query to fail, but it succeeded');
}

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const all = async (client, sql, params) => (await client.query(sql, params)).rows;

module.exports = { freshDatabase, appClient, ownerClient, expectError, one, all, config };
