// Shared database settings for setup.js, server.js and the tests.
// Everything can be overridden with environment variables (or a .env file).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const env = process.env;

const config = {
  host: env.PGHOST || 'localhost',
  port: Number(env.PGPORT || 5432),
  database: env.DB_NAME || 'hospital',

  // superuser used only by db/setup.js (creates roles, database, extensions)
  adminUser: env.PG_ADMIN_USER || 'postgres',
  adminPassword: env.PG_ADMIN_PASSWORD || 'postgres',
  adminDatabase: env.PG_ADMIN_DATABASE || 'postgres',

  // owner of every schema object (NOLOGIN; setup uses SET ROLE)
  ownerRole: 'hms_owner',

  // the only role the API server connects as
  appUser: 'hms_app',                 // fixed: db/sql/11_grants.sql grants to this role
  appPassword: env.APP_DB_PASSWORD || 'hms_app_password',
};

const adminConnection = (database = config.adminDatabase) => ({
  host: config.host,
  port: config.port,
  user: config.adminUser,
  password: config.adminPassword,
  database,
});

const appConnection = () => ({
  host: config.host,
  port: config.port,
  user: config.appUser,
  password: config.appPassword,
  database: config.database,
});

module.exports = { config, adminConnection, appConnection };
