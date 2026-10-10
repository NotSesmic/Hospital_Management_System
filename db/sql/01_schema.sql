-- =====================================================================
-- 01_schema.sql  —  core tables, constraints and indexes
-- Runs as role hms_owner (see db/setup.js). Extensions pgcrypto and
-- btree_gist are created by the superuser step before this file.
-- =====================================================================

CREATE SCHEMA hms;          -- base tables (never touched directly by the app)
CREATE SCHEMA api;          -- read-only views exposed to the app role

-- ---------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------

-- Room categories. Bed capacity is NOT stored here: it is the number of
-- rows in hms.bed for that type, so it can never disagree with reality.
CREATE TABLE hms.room_type (
    code           varchar(10)   PRIMARY KEY,
    display_order  smallint      NOT NULL UNIQUE,      -- fallback order when the preferred type is full
    hourly_rate    numeric(10,2) NOT NULL CHECK (hourly_rate > 0),
    stay_factor    numeric(4,2)  NOT NULL CHECK (stay_factor > 0)   -- multiplier used by the stay estimate
);

CREATE TABLE hms.emergency_level (
    level              smallint     PRIMARY KEY CHECK (level BETWEEN 1 AND 7),
    label              varchar(20)  NOT NULL,
    protocol_note      varchar(80)  NOT NULL,
    base_wait_seconds  integer      NOT NULL CHECK (base_wait_seconds > 0)  -- used only to synthesise demo history
);

-- match_order: specialties are tried in this order and the first one with a
-- matching keyword wins (same semantics as SPECIALTY_KEYWORDS.find()).
-- NULL = specialty exists (doctors can hold it) but is never inferred.
CREATE TABLE hms.specialty (
    name         varchar(40) PRIMARY KEY,
    match_order  smallint    UNIQUE
);

CREATE TABLE hms.specialty_keyword (
    specialty  varchar(40) NOT NULL REFERENCES hms.specialty(name),
    keyword    varchar(40) NOT NULL CHECK (keyword = lower(keyword)),
    PRIMARY KEY (specialty, keyword)
);

CREATE TABLE hms.disease_profile (
    profile_id        smallint      PRIMARY KEY,
    label             varchar(40)   NOT NULL,
    match_order       smallint      UNIQUE,           -- NULL only for the default profile
    is_default        boolean       NOT NULL DEFAULT false,
    min_stay_hours    integer       NOT NULL CHECK (min_stay_hours > 0),
    max_stay_hours    integer       NOT NULL,
    treatment_cost    numeric(10,2) NOT NULL CHECK (treatment_cost >= 0),
    diagnostics_cost  numeric(10,2) NOT NULL CHECK (diagnostics_cost >= 0),
    procedure_cost    numeric(10,2) NOT NULL CHECK (procedure_cost >= 0),
    CHECK (max_stay_hours >= min_stay_hours),
    CHECK (is_default = (match_order IS NULL))
);
-- exactly one default profile
CREATE UNIQUE INDEX disease_profile_one_default ON hms.disease_profile (is_default) WHERE is_default;

CREATE TABLE hms.disease_profile_keyword (
    profile_id  smallint    NOT NULL REFERENCES hms.disease_profile,
    keyword     varchar(40) NOT NULL CHECK (keyword = lower(keyword)),
    PRIMARY KEY (profile_id, keyword)
);

CREATE TABLE hms.doctor (
    doctor_id     smallint     PRIMARY KEY,
    full_name     varchar(60)  NOT NULL,
    specialty     varchar(40)  NOT NULL REFERENCES hms.specialty(name),
    max_patients  integer      NOT NULL CHECK (max_patients > 0),
    -- maintained by trigger trg_admission_doctor_load; the CHECK below is what
    -- actually stops a doctor being assigned beyond capacity, even under
    -- concurrent allocations.
    current_load  integer      NOT NULL DEFAULT 0,
    CONSTRAINT doctor_capacity_ck CHECK (current_load BETWEEN 0 AND max_patients)
);
CREATE INDEX doctor_specialty_idx ON hms.doctor (specialty, current_load, doctor_id);

CREATE TABLE hms.bed (
    bed_no                integer     PRIMARY KEY CHECK (bed_no > 0),
    room_type             varchar(10) NOT NULL REFERENCES hms.room_type(code),
    -- maintained by trigger trg_admission_bed_sync; UNIQUE => one bed per admission
    current_admission_id  integer     UNIQUE
);
-- "lowest free bed of a given type" is an index range scan on this
CREATE INDEX bed_free_idx ON hms.bed (room_type, bed_no) WHERE current_admission_id IS NULL;

-- ---------------------------------------------------------------------
-- Patients and admissions
-- ---------------------------------------------------------------------

-- The person. Name formatting (upper case + initials) is enforced by
-- trigger trg_patient_normalize so every insert path behaves the same.
CREATE TABLE hms.patient (
    patient_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name   varchar(100) NOT NULL CHECK (btrim(full_name) <> ''),
    initials    varchar(3)   NOT NULL,
    created_at  timestamptz  NOT NULL DEFAULT now()
);
-- prefix search (replaces the in-browser Trie)
CREATE INDEX patient_name_prefix_idx ON hms.patient (full_name text_pattern_ops);

-- One hospital episode: WAITING -> ADMITTED -> DISCHARGED.
-- The admission_id is the "ID" shown everywhere in the UI.
CREATE TABLE hms.admission (
    admission_id          integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id            integer      NOT NULL REFERENCES hms.patient,
    disease               varchar(120) NOT NULL CHECK (btrim(disease) <> ''),
    preferred_room        varchar(10)  NOT NULL REFERENCES hms.room_type(code),
    emergency_level       smallint     NOT NULL REFERENCES hms.emergency_level(level),
    specialty             varchar(40)  NOT NULL REFERENCES hms.specialty(name),
    source                varchar(10)  NOT NULL DEFAULT 'MANUAL'
                                       CHECK (source IN ('MANUAL', 'LIVE', 'DEMO')),
    status                varchar(10)  NOT NULL DEFAULT 'WAITING'
                                       CHECK (status IN ('WAITING', 'ADMITTED', 'DISCHARGED')),
    arrival_time          timestamptz  NOT NULL DEFAULT now(),
    allocated_at          timestamptz,
    bed_no                integer      REFERENCES hms.bed,
    doctor_id             smallint     REFERENCES hms.doctor,   -- NULL = every doctor was at capacity
    estimated_stay_hours  integer      NOT NULL CHECK (estimated_stay_hours >= 2),
    discharged_at         timestamptz,
    -- the period the bed was occupied; open-ended while admitted
    stay_period           tstzrange    GENERATED ALWAYS AS
                          (tstzrange(allocated_at, COALESCE(discharged_at, 'infinity'::timestamptz))) STORED,

    -- columns that must / must not be filled for each status
    CONSTRAINT admission_status_shape_ck CHECK (
           (status = 'WAITING'    AND allocated_at IS NULL     AND bed_no IS NULL     AND doctor_id IS NULL AND discharged_at IS NULL)
        OR (status = 'ADMITTED'   AND allocated_at IS NOT NULL AND bed_no IS NOT NULL AND discharged_at IS NULL)
        OR (status = 'DISCHARGED' AND allocated_at IS NOT NULL AND bed_no IS NOT NULL AND discharged_at IS NOT NULL)
    ),
    CONSTRAINT admission_time_order_ck CHECK (
        (allocated_at IS NULL OR allocated_at >= arrival_time) AND
        (discharged_at IS NULL OR discharged_at >= allocated_at)
    ),
    -- the same bed can never be occupied by two admissions at overlapping times,
    -- including historical ones (needs btree_gist for the "bed_no WITH =" part)
    CONSTRAINT admission_bed_no_double_booking
        EXCLUDE USING gist (bed_no WITH =, stay_period WITH &&) WHERE (bed_no IS NOT NULL)
);

ALTER TABLE hms.bed
    ADD CONSTRAINT bed_current_admission_fk
    FOREIGN KEY (current_admission_id) REFERENCES hms.admission (admission_id);

-- the waiting queue: emergency level DESC, then arrival (replaces the binary heap)
CREATE INDEX admission_queue_idx ON hms.admission (emergency_level DESC, arrival_time, admission_id)
    WHERE status = 'WAITING';
-- currently admitted (due-discharge scan, admitted panel)
CREATE INDEX admission_admitted_idx ON hms.admission (allocated_at) WHERE status = 'ADMITTED';
-- discharge history by day
CREATE INDEX admission_discharged_idx ON hms.admission (discharged_at DESC) WHERE status = 'DISCHARGED';
CREATE INDEX admission_patient_idx ON hms.admission (patient_id);
CREATE INDEX admission_doctor_idx ON hms.admission (doctor_id) WHERE status = 'ADMITTED';

-- ---------------------------------------------------------------------
-- Billing and feedback (one each per discharged admission)
-- ---------------------------------------------------------------------
CREATE TABLE hms.bill (
    admission_id        integer       PRIMARY KEY REFERENCES hms.admission,
    stay_hours          integer       NOT NULL CHECK (stay_hours >= 1),
    billed_hours        integer       NOT NULL CHECK (billed_hours >= stay_hours),
    room_type           varchar(10)   NOT NULL REFERENCES hms.room_type(code),
    room_rate           numeric(10,2) NOT NULL,
    room_charge         numeric(12,2) NOT NULL CHECK (room_charge >= 0),
    emergency_charge    numeric(12,2) NOT NULL CHECK (emergency_charge >= 0),
    doctor_fee          numeric(12,2) NOT NULL CHECK (doctor_fee >= 0),
    nursing_charge      numeric(12,2) NOT NULL CHECK (nursing_charge >= 0),
    pharmacy_charge     numeric(12,2) NOT NULL CHECK (pharmacy_charge >= 0),
    diagnostics_charge  numeric(12,2) NOT NULL CHECK (diagnostics_charge >= 0),
    procedure_charge    numeric(12,2) NOT NULL CHECK (procedure_charge >= 0),
    treatment_charge    numeric(12,2) NOT NULL CHECK (treatment_charge >= 0),
    service_charge      numeric(12,2) NOT NULL CHECK (service_charge >= 0),
    subtotal            numeric(12,2) NOT NULL,
    gst                 numeric(12,2) NOT NULL CHECK (gst >= 0),
    insurance_discount  numeric(12,2) NOT NULL CHECK (insurance_discount >= 0),
    total               numeric(12,2) NOT NULL CHECK (total >= 0),
    generated_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT bill_subtotal_ck CHECK (subtotal = room_charge + emergency_charge + doctor_fee + nursing_charge
                                              + pharmacy_charge + diagnostics_charge + procedure_charge
                                              + treatment_charge + service_charge),
    CONSTRAINT bill_total_ck CHECK (total = subtotal + gst - insurance_discount)
);

CREATE TABLE hms.feedback (
    admission_id    integer      PRIMARY KEY REFERENCES hms.admission,
    rating          smallint     NOT NULL CHECK (rating BETWEEN 1 AND 5),
    complaint_type  varchar(40)  NOT NULL,
    complaint_text  varchar(300) NOT NULL,
    suggestion      varchar(300) NOT NULL,
    submitted_at    timestamptz  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Staff accounts (replaces plaintext users in localStorage)
-- ---------------------------------------------------------------------
CREATE TABLE hms.app_user (
    user_id        integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name      varchar(80)  NOT NULL CHECK (btrim(full_name) <> ''),
    email          varchar(120) NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND email = lower(email)),
    password_hash  text         NOT NULL,          -- bcrypt via pgcrypto crypt()
    created_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_uq ON hms.app_user (email);

-- Only a SHA-256 of the session token is stored, so a DB leak can't be replayed.
CREATE TABLE hms.user_session (
    token_hash  bytea        PRIMARY KEY,
    user_id     integer      NOT NULL REFERENCES hms.app_user ON DELETE CASCADE,
    created_at  timestamptz  NOT NULL DEFAULT now(),
    expires_at  timestamptz  NOT NULL,
    CHECK (expires_at > created_at)
);
CREATE INDEX user_session_expiry_idx ON hms.user_session (expires_at);

-- ---------------------------------------------------------------------
-- Configuration and simulation inputs
-- ---------------------------------------------------------------------
CREATE TABLE hms.app_setting (
    key    varchar(40) PRIMARY KEY,
    value  text        NOT NULL
);

-- the 500 demo patients from src/data/patients-500.json (loaded by db/setup.js)
CREATE TABLE hms.demo_patient_seed (
    seed_id          integer      PRIMARY KEY,
    full_name        varchar(100) NOT NULL,
    disease          varchar(120) NOT NULL,
    preferred_room   varchar(10)  NOT NULL REFERENCES hms.room_type(code),
    emergency_level  smallint     NOT NULL REFERENCES hms.emergency_level(level)
);

-- name pools used for live-mode synthetic arrivals (FIRST_NAMES / LAST_NAMES in old App.js)
CREATE TABLE hms.sim_name_pool (
    kind  varchar(5)  NOT NULL CHECK (kind IN ('FIRST', 'LAST')),
    name  varchar(40) NOT NULL,
    PRIMARY KEY (kind, name)
);
