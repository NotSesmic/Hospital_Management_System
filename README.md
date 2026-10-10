# 3D Multispecialist Hospital — Management System

A hospital admissions dashboard: patients are registered into an emergency-priority
queue, allocated beds and doctors, discharged with an itemised bill, and tracked
across a 300-bed hospital. A live mode simulates continuous arrivals and discharges.

**Stack:** React (Create React App) · Node/Express API · PostgreSQL 16 with PL/pgSQL.

All hospital state and business rules live in the database. The API is a thin
layer that calls database packages as a restricted role, and the React app only
renders data and sends commands.

```
React (src/App.js) ──fetch /api──▶ server.js (Express, role hms_app)
                                        │  SELECT * FROM pkg_admission.allocate_next() ...
                                        ▼
                     PostgreSQL: schema hms (tables, triggers)
                                 schema api (read-only views)
                                 pkg_* schemas (the "packages")
```

---

## Running it

### 1. PostgreSQL

Any PostgreSQL 13+ works (16 recommended). Either:

- **Native install** (Windows/macOS installer from postgresql.org). Remember the
  password you set for the `postgres` superuser, or
- **Docker:** `docker compose up -d` (superuser `postgres` / password `postgres`).

If your superuser password isn't `postgres`, copy `.env.example` to `.env` and set
`PG_ADMIN_PASSWORD`.

### 2. Install and build the database

```bash
npm install
npm run db:setup        # creates roles, the "hospital" database, schema, packages, demo data
```

| Script | What it does |
|---|---|
| `npm run db:setup` | Drop and rebuild the database, then load the 500 demo patients |
| `npm run db:setup:empty` | Same, but start with an empty hospital |
| `npm run db:reset` | Keep schema and staff accounts, wipe all patients, reload demo data |

### 3. Run

```bash
npm start               # API on :4000 + React dev server on :3000 (proxied)
```

Open http://localhost:3000, create an account, sign in.
For a production-style single server: `npm run serve` (builds React, serves it from :4000).

### 4. Tests

```bash
npm run test:db         # 29 tests: formula parity, triggers, concurrency, privileges, HTTP API
npm test                # React unit test
```

`test:db` builds a separate `hospital_test` database, so your data is untouched.

---

## Database design

### Tables (schema `hms`)

| Table | Purpose | Notable constraints |
|---|---|---|
| `room_type` | General / Normal / Deluxe / ICU: hourly rate, stay factor, fallback order | |
| `bed` | 300 beds; `current_admission_id` = who is in it | partial index on free beds; UNIQUE occupant |
| `emergency_level` | levels 1–7: label, protocol note | `CHECK (level BETWEEN 1 AND 7)` |
| `specialty`, `specialty_keyword` | keyword rules for inferring a specialty from the disease text | |
| `disease_profile`, `disease_profile_keyword` | stay range and cost profile per disease group | exactly one default profile |
| `doctor` | 8 doctors with `max_patients` and a trigger-maintained `current_load` | `CHECK (current_load BETWEEN 0 AND max_patients)` |
| `patient` | the person (name, initials) | prefix index for search |
| `admission` | one episode: `WAITING → ADMITTED → DISCHARGED` | status-shape CHECK, time-order CHECK, **exclusion constraint: no bed double-booked over any overlapping period** |
| `bill` | itemised invoice per discharge | subtotal/total arithmetic CHECKs |
| `feedback` | discharge feedback | rating 1–5 |
| `app_user`, `user_session` | staff accounts (bcrypt) and sessions (only a SHA-256 of the token is stored) | unique lower-case email |
| `app_setting`, `demo_patient_seed`, `sim_name_pool` | configuration and simulation inputs | |

The waiting queue is a partial index on `(emergency_level DESC, arrival_time, admission_id) WHERE status = 'WAITING'`.

### Triggers (`db/sql/03_triggers.sql`)

| Trigger | Why it exists |
|---|---|
| `trg_patient_normalize` | Upper-cases names and computes initials once, for every insert path |
| `trg_admission_guard` | Enforces the lifecycle (no going backwards, intake details frozen, discharged rows read-only, no deletes). A CHECK can't see the old row, so this needs a trigger |
| `trg_admission_bed_sync` | Keeps `bed.current_admission_id` in step with admissions; refuses an occupied bed |
| `trg_admission_doctor_load` | Moves the doctor's load counter only on entering/leaving ADMITTED; the CHECK then blocks over-assignment |
| `trg_bill_immutable` | Issued bills cannot be edited or deleted |

### Packages

PostgreSQL has no `CREATE PACKAGE`, so each package is a schema. The **package
spec** is the set of functions granted to the app role; the **private body**
(functions prefixed `_`, plus whole internal packages) has `EXECUTE` revoked.

| Package | Public API (granted to `hms_app`) | Private |
|---|---|---|
| `pkg_rules` | — | `infer_specialty`, `disease_profile`, `estimate_stay_hours`, `estimate_wait_seconds` |
| `pkg_billing` | — | `compute_bill`, `generate_bill`, `generate_feedback` |
| `pkg_admission` | `register_patient`, `allocate_next`, `allocate_bulk`, `discharge_patient` | `_register`, `_pick_bed`, `_pick_doctor`, `_allocate`, `_discharge`, `_lock_allocation` |
| `pkg_simulation` | `enqueue_arrivals`, `tick`, `import_demo` | `_enqueue`, `_discharge_due`, `_backfill_history`, `reset_all` |
| `pkg_auth` | `sign_up`, `sign_in`, `sign_out`, `validate_session` | — |
| `pkg_report` | `search_suggestions`, `search_admissions`, `discharge_history` | `_like_escape` |

### Cursors

Used where rows must be processed one at a time with a per-row decision:

- `pkg_admission.allocate_bulk` walks the queue with a parameterised `FOR UPDATE SKIP LOCKED` cursor and stops early when beds run out.
- `pkg_simulation._discharge_due` locks each admitted patient whose stay has elapsed and runs the full discharge (bill, feedback, bed and doctor release) for it.
- `pkg_simulation.import_demo` makes one pass over a ranked cursor of the 500 seed patients, deciding for each whether it becomes history, a current admission, or stays in the queue.

### Views (schema `api`, read-only for the app)

`v_admission`, `v_waiting_queue`, `v_admitted`, `v_doctor_load`, `v_bed_map`,
`v_room_type`, `v_emergency_level`, `v_dashboard_summary` (median wait via
`percentile_cont`), `v_integrity_issues` (should always be empty; exposed at `GET /api/health`).

### Security model

- `hms_owner` (NOLOGIN) owns every object.
- `hms_app` (the API's login) has **no privileges on schema `hms`**: it can only
  SELECT the `api` views and EXECUTE the public package functions, which are
  `SECURITY DEFINER` with a locked `search_path`.
- Every allocating call takes a transaction-scoped advisory lock first, so
  allocation is serialised (like popping a single heap) and doctor-row locks are
  always taken in a consistent order. Concurrent requests can't deadlock or
  double-book a bed.

### Custom error codes

Packages raise `HM400` (bad input), `HM401` (auth), `HM404` (not found) and
`HM409` (state conflict); `server.js` maps them to the same HTTP status codes.

---

## API

All routes are under `/api`; everything except `health`, `auth/signup` and
`auth/signin` needs `Authorization: Bearer <token>`.

| Method | Route | Calls |
|---|---|---|
| GET | `/health` | `api.v_integrity_issues` |
| POST | `/auth/signup` · `/auth/signin` · `/auth/signout` · GET `/auth/me` | `pkg_auth.*` |
| GET | `/meta` | room types, emergency levels |
| GET | `/dashboard` | summary, queue, admitted, doctors, beds (one consistent snapshot) |
| GET | `/discharges?from=&to=` | `pkg_report.discharge_history` |
| GET | `/search/suggest?q=` · `/search?q=` | `pkg_report.search_*` |
| POST | `/patients` | `pkg_admission.register_patient` |
| POST | `/allocations/next` · `/allocations/bulk` | `pkg_admission.allocate_*` |
| POST | `/admissions/:id/discharge` | `pkg_admission.discharge_patient` |
| POST | `/simulation/arrivals` · `/simulation/tick` | `pkg_simulation.*` |
| POST | `/demo/import` | `pkg_simulation.import_demo` |

---

## Project layout

```
db/
  config.js            connection settings (.env)
  setup.js             builds / resets the database
  sql/01_schema.sql … 11_grants.sql
server.js              Express API
src/App.js             React UI (talks to the API via src/api.js)
src/data/              demo seed patients (loaded into hms.demo_patient_seed)
tests/                 node:test suites + verbatim copy of the original formulas
```
