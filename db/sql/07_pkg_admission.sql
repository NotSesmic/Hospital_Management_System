-- =====================================================================
-- 07_pkg_admission.sql  —  PACKAGE pkg_admission
-- Registration, bed/doctor allocation and discharge.
--
-- Package spec (granted to app):
--     register_patient(name, disease, preferred_room, emergency_level)
--     allocate_next()
--     allocate_bulk(count)
--     discharge_patient(admission_id)
-- Private body (no EXECUTE for the app):
--     _register, _pick_bed, _pick_doctor, _allocate, _discharge,
--     _lock_allocation
--
-- Concurrency model
--   * Every allocating call first takes a transaction-scoped advisory lock
--     (_lock_allocation). Allocation is therefore serialised — the DB
--     equivalent of popping one heap at a time — which also guarantees a
--     fixed lock order on doctor rows, so two allocators can't deadlock.
--   * Queue rows and bed rows are still taken with FOR UPDATE SKIP LOCKED,
--     and the bed-sync trigger + exclusion constraint make a double-booked
--     bed impossible even if someone bypasses the lock.
-- =====================================================================
CREATE SCHEMA pkg_admission;

CREATE FUNCTION pkg_admission._lock_allocation()
RETURNS void
LANGUAGE sql
AS $$
    SELECT pg_advisory_xact_lock(hashtext('hms.allocation'));
$$;

-- Creates patient + WAITING admission. Returns the admission id.
CREATE FUNCTION pkg_admission._register(
    p_name             text,
    p_disease          text,
    p_preferred_room   text,
    p_emergency_level  integer,
    p_source           text,
    p_arrival          timestamptz)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_patient_id    integer;
    v_admission_id  integer;
    v_disease       text := btrim(p_disease);
BEGIN
    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'Name cannot be empty!' USING ERRCODE = 'HM400';
    END IF;
    IF v_disease IS NULL OR v_disease = '' THEN
        RAISE EXCEPTION 'Please enter disease/suffering.' USING ERRCODE = 'HM400';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hms.room_type WHERE code = p_preferred_room) THEN
        RAISE EXCEPTION 'Unknown room type "%".', p_preferred_room USING ERRCODE = 'HM400';
    END IF;
    IF p_emergency_level IS NULL OR p_emergency_level NOT BETWEEN 1 AND 7 THEN
        RAISE EXCEPTION 'Emergency level must be between 1 and 7.' USING ERRCODE = 'HM400';
    END IF;

    INSERT INTO hms.patient (full_name, initials)
    VALUES (p_name, '')                       -- initials filled in by trg_patient_normalize
    RETURNING patient_id INTO v_patient_id;

    -- the stay estimate is seeded by the admission id, so take it first
    v_admission_id := nextval(pg_get_serial_sequence('hms.admission', 'admission_id'));

    INSERT INTO hms.admission (admission_id, patient_id, disease, preferred_room, emergency_level,
                               specialty, source, arrival_time, estimated_stay_hours)
    OVERRIDING SYSTEM VALUE
    VALUES (v_admission_id, v_patient_id, v_disease, p_preferred_room, p_emergency_level,
            pkg_rules.infer_specialty(v_disease), p_source, p_arrival,
            -- provisional (preferred room); recomputed for the real room on allocation
            pkg_rules.estimate_stay_hours(v_admission_id, v_disease, p_emergency_level, p_preferred_room));

    RETURN v_admission_id;
END;
$$;

-- Lowest-numbered free bed of the preferred type; if that type is full,
-- the lowest free bed of the first type (by display_order) that has one.
CREATE FUNCTION pkg_admission._pick_bed(p_preferred_room text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_bed integer;
BEGIN
    SELECT b.bed_no INTO v_bed
      FROM hms.bed b
     WHERE b.room_type = p_preferred_room AND b.current_admission_id IS NULL
     ORDER BY b.bed_no
     LIMIT 1
       FOR UPDATE SKIP LOCKED;

    IF v_bed IS NULL THEN
        SELECT b.bed_no INTO v_bed
          FROM hms.bed b
          JOIN hms.room_type rt ON rt.code = b.room_type
         WHERE b.current_admission_id IS NULL
         ORDER BY rt.display_order, b.bed_no
         LIMIT 1
           FOR UPDATE OF b SKIP LOCKED;
    END IF;
    RETURN v_bed;      -- NULL = hospital full
END;
$$;

-- Least-loaded doctor of the specialty with spare capacity, else the
-- least-loaded doctor overall; NULL if every doctor is at capacity.
CREATE FUNCTION pkg_admission._pick_doctor(p_specialty text)
RETURNS smallint
LANGUAGE plpgsql
AS $$
DECLARE
    v_doctor smallint;
BEGIN
    SELECT doctor_id INTO v_doctor
      FROM hms.doctor
     WHERE specialty = p_specialty AND current_load < max_patients
     ORDER BY current_load, doctor_id
     LIMIT 1;

    IF v_doctor IS NULL THEN
        SELECT doctor_id INTO v_doctor
          FROM hms.doctor
         WHERE current_load < max_patients
         ORDER BY current_load, doctor_id
         LIMIT 1;
    END IF;
    RETURN v_doctor;
END;
$$;

-- Moves one WAITING admission into a bed. Returns the bed number, or NULL
-- when no bed is free (the admission is left untouched in that case).
CREATE FUNCTION pkg_admission._allocate(p_admission_id integer, p_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    a        hms.admission;
    v_bed    integer;
    v_room   varchar;
BEGIN
    SELECT * INTO a FROM hms.admission
     WHERE admission_id = p_admission_id AND status = 'WAITING'
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Admission % is not waiting', p_admission_id USING ERRCODE = 'HM409';
    END IF;

    v_bed := pkg_admission._pick_bed(a.preferred_room);
    IF v_bed IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT room_type INTO v_room FROM hms.bed WHERE bed_no = v_bed;

    -- triggers take care of bed occupancy and the doctor's load counter
    UPDATE hms.admission
       SET status               = 'ADMITTED',
           allocated_at         = p_at,
           bed_no               = v_bed,
           doctor_id            = pkg_admission._pick_doctor(a.specialty),
           estimated_stay_hours = pkg_rules.estimate_stay_hours(a.admission_id, a.disease, a.emergency_level, v_room)
     WHERE admission_id = p_admission_id;

    RETURN v_bed;
END;
$$;

CREATE FUNCTION pkg_admission._discharge(p_admission_id integer, p_at timestamptz)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE hms.admission
       SET status = 'DISCHARGED', discharged_at = p_at
     WHERE admission_id = p_admission_id AND status = 'ADMITTED';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Patient % is not currently admitted.', p_admission_id USING ERRCODE = 'HM409';
    END IF;
    PERFORM pkg_billing.generate_bill(p_admission_id);
    PERFORM pkg_billing.generate_feedback(p_admission_id);
END;
$$;

-- ---------------------------------------------------------------------
-- Public API
-- ---------------------------------------------------------------------

CREATE FUNCTION pkg_admission.register_patient(
    p_name            text,
    p_disease         text,
    p_preferred_room  text,
    p_emergency_level integer)
RETURNS SETOF api.v_admission
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_id integer;
BEGIN
    v_id := pkg_admission._register(p_name, p_disease, p_preferred_room, p_emergency_level, 'MANUAL', now());
    RETURN QUERY SELECT * FROM api.v_admission WHERE id = v_id;
END;
$$;

-- Allocates the highest-priority waiting patient (emergency level DESC,
-- then earliest arrival). Returns the admitted row.
CREATE FUNCTION pkg_admission.allocate_next()
RETURNS SETOF api.v_admission
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_id integer;
BEGIN
    PERFORM pkg_admission._lock_allocation();

    SELECT admission_id INTO v_id
      FROM hms.admission
     WHERE status = 'WAITING'
     ORDER BY emergency_level DESC, arrival_time, admission_id
     LIMIT 1
       FOR UPDATE SKIP LOCKED;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'No patients in waiting queue.' USING ERRCODE = 'HM409';
    END IF;

    IF pkg_admission._allocate(v_id, clock_timestamp()) IS NULL THEN
        RAISE EXCEPTION 'No free beds available!' USING ERRCODE = 'HM409';
    END IF;

    RETURN QUERY SELECT * FROM api.v_admission WHERE id = v_id;
END;
$$;

-- Allocates up to p_count (1..50) patients in priority order, stopping when
-- beds run out. Walks the queue with an explicit cursor because each row
-- needs a per-row decision (bed + doctor) and the loop must stop early.
CREATE FUNCTION pkg_admission.allocate_bulk(p_count integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_requested   integer := greatest(1, least(50, COALESCE(p_count, 50)));
    v_allocatable integer;
    v_done        integer := 0;
    v_id          integer;
    cur_queue CURSOR (p_limit integer) FOR
        SELECT admission_id
          FROM hms.admission
         WHERE status = 'WAITING'
         ORDER BY emergency_level DESC, arrival_time, admission_id
         LIMIT p_limit
           FOR UPDATE SKIP LOCKED;
BEGIN
    PERFORM pkg_admission._lock_allocation();

    SELECT least(v_requested,
                 (SELECT count(*) FROM hms.admission WHERE status = 'WAITING'),
                 (SELECT count(*) FROM hms.bed WHERE current_admission_id IS NULL))
      INTO v_allocatable;
    IF v_allocatable <= 0 THEN
        RAISE EXCEPTION 'No eligible patients/beds for bulk allocation.' USING ERRCODE = 'HM409';
    END IF;

    OPEN cur_queue(v_allocatable);
    LOOP
        FETCH cur_queue INTO v_id;
        EXIT WHEN NOT FOUND;
        EXIT WHEN pkg_admission._allocate(v_id, clock_timestamp()) IS NULL;   -- beds ran out
        v_done := v_done + 1;
    END LOOP;
    CLOSE cur_queue;

    RETURN v_done;
END;
$$;

-- Discharges an admitted patient: frees the bed and the doctor slot
-- (triggers), then generates the bill and feedback. Returns the final row.
CREATE FUNCTION pkg_admission.discharge_patient(p_admission_id integer)
RETURNS SETOF api.v_admission
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_status varchar;
BEGIN
    SELECT status INTO v_status FROM hms.admission WHERE admission_id = p_admission_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Patient % not found.', p_admission_id USING ERRCODE = 'HM404';
    END IF;
    IF v_status <> 'ADMITTED' THEN
        RAISE EXCEPTION 'Patient % is not currently admitted (status %).', p_admission_id, v_status
            USING ERRCODE = 'HM409';
    END IF;

    PERFORM pkg_admission._discharge(p_admission_id, clock_timestamp());
    RETURN QUERY SELECT * FROM api.v_admission WHERE id = p_admission_id;
END;
$$;
