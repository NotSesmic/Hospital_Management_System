-- =====================================================================
-- 08_pkg_simulation.sql  —  PACKAGE pkg_simulation
-- Live-mode traffic and the demo dataset (previously the setInterval loop
-- and importDemoPatients() in App.js).
--
-- Package spec (granted to app):
--     enqueue_arrivals(count)   — "Add Incoming Now"
--     tick(inflow)              — one live-mode cycle
--     import_demo(bootstrap)    — "Import Demo Patients"
-- Private body:
--     _setting, _discharge_due, _backfill_history, reset_all (owner only)
-- =====================================================================
CREATE SCHEMA pkg_simulation;

CREATE FUNCTION pkg_simulation._setting(p_key text)
RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT value FROM hms.app_setting WHERE key = p_key;
$$;

-- Registers p_count synthetic arrivals: diseases/rooms/levels cycle through
-- the demo seed, names are random from the name pools.
CREATE FUNCTION pkg_simulation._enqueue(p_count integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_seed_count integer;
    v_offset     integer;
    v_added      integer := 0;
    s            hms.demo_patient_seed;
    v_first      text;
    v_last       text;
BEGIN
    SELECT count(*) INTO v_seed_count FROM hms.demo_patient_seed;
    IF v_seed_count = 0 THEN
        RETURN 0;
    END IF;
    SELECT COALESCE(max(admission_id), 0) INTO v_offset FROM hms.admission;

    FOR i IN 1 .. greatest(0, p_count) LOOP
        SELECT * INTO s FROM hms.demo_patient_seed WHERE seed_id = 1 + ((v_offset + i) % v_seed_count);
        SELECT name INTO v_first FROM hms.sim_name_pool WHERE kind = 'FIRST' ORDER BY random() LIMIT 1;
        SELECT name INTO v_last  FROM hms.sim_name_pool WHERE kind = 'LAST'  ORDER BY random() LIMIT 1;
        PERFORM pkg_admission._register(v_first || ' ' || v_last, s.disease, s.preferred_room,
                                        s.emergency_level, 'LIVE', now());
        v_added := v_added + 1;
    END LOOP;
    RETURN v_added;
END;
$$;

-- Discharges every admitted patient whose (accelerated) stay has elapsed.
-- Explicit cursor: rows are locked as they are read and each one goes
-- through the full discharge routine (bill + feedback + bed/doctor release).
CREATE FUNCTION pkg_simulation._discharge_due()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_accel numeric := pkg_simulation._setting('live_time_acceleration')::numeric;
    v_count integer := 0;
    r       record;
    cur_due CURSOR FOR
        SELECT admission_id
          FROM hms.admission
         WHERE status = 'ADMITTED'
           AND allocated_at + make_interval(secs => estimated_stay_hours * 3600.0 / v_accel) <= now()
         ORDER BY allocated_at
           FOR UPDATE SKIP LOCKED;
BEGIN
    OPEN cur_due;
    LOOP
        FETCH cur_due INTO r;
        EXIT WHEN NOT FOUND;
        PERFORM pkg_admission._discharge(r.admission_id, clock_timestamp());
        v_count := v_count + 1;
    END LOOP;
    CLOSE cur_due;
    RETURN v_count;
END;
$$;

-- Inserts one historical (already discharged) admission for the demo data,
-- choosing a bed that was genuinely free for that whole period so the
-- double-booking exclusion constraint holds for history as well.
CREATE FUNCTION pkg_simulation._backfill_history(
    s              hms.demo_patient_seed,
    p_discharge_at timestamptz,
    p_queue_depth  integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_id          integer := nextval(pg_get_serial_sequence('hms.admission', 'admission_id'));
    v_patient_id  integer;
    v_specialty   varchar := pkg_rules.infer_specialty(s.disease);
    v_stay        integer;
    v_alloc       timestamptz;
    v_bed         integer;
    v_doctor      smallint;
    v_wait        integer;
    rt            record;
BEGIN
    -- try the preferred room type first, then the others in display order
    FOR rt IN SELECT code FROM hms.room_type
              ORDER BY (code = s.preferred_room) DESC, display_order LOOP
        v_stay  := pkg_rules.estimate_stay_hours(v_id, s.disease, s.emergency_level, rt.code);
        v_alloc := p_discharge_at - make_interval(hours => v_stay);
        SELECT b.bed_no INTO v_bed
          FROM hms.bed b
         WHERE b.room_type = rt.code
           AND NOT EXISTS (SELECT 1 FROM hms.admission x
                            WHERE x.bed_no = b.bed_no
                              AND x.stay_period && tstzrange(v_alloc, p_discharge_at))
         ORDER BY b.bed_no
         LIMIT 1;
        EXIT WHEN v_bed IS NOT NULL;
    END LOOP;
    IF v_bed IS NULL THEN
        RETURN NULL;
    END IF;

    -- spread historical cases across the doctors of the specialty
    SELECT doctor_id INTO v_doctor
      FROM hms.doctor
     WHERE specialty = v_specialty
        OR NOT EXISTS (SELECT 1 FROM hms.doctor WHERE specialty = v_specialty)
     ORDER BY doctor_id
     OFFSET (v_id % greatest(1, (SELECT count(*) FROM hms.doctor WHERE specialty = v_specialty)::integer))
     LIMIT 1;

    v_wait := pkg_rules.estimate_wait_seconds(v_id, s.emergency_level, p_queue_depth);

    INSERT INTO hms.patient (full_name, initials) VALUES (s.full_name, '') RETURNING patient_id INTO v_patient_id;
    INSERT INTO hms.admission (admission_id, patient_id, disease, preferred_room, emergency_level, specialty,
                               source, status, arrival_time, allocated_at, bed_no, doctor_id,
                               estimated_stay_hours, discharged_at)
    OVERRIDING SYSTEM VALUE
    VALUES (v_id, v_patient_id, s.disease, s.preferred_room, s.emergency_level, v_specialty,
            'DEMO', 'DISCHARGED', v_alloc - make_interval(secs => v_wait), v_alloc, v_bed, v_doctor,
            v_stay, p_discharge_at);

    PERFORM pkg_billing.generate_bill(v_id);
    PERFORM pkg_billing.generate_feedback(v_id);
    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------
-- Public API
-- ---------------------------------------------------------------------

CREATE FUNCTION pkg_simulation.enqueue_arrivals(p_count integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RETURN pkg_simulation._enqueue(greatest(1, least(50, COALESCE(p_count, 3))));
END;
$$;

-- One live-mode cycle, atomically: new arrivals (while the queue is below
-- the cap), discharge everyone whose stay has elapsed, then (95% of ticks)
-- admit 2-3 patients. Returns what happened so the UI can react.
CREATE FUNCTION pkg_simulation.tick(p_inflow integer)
RETURNS TABLE (arrived integer, discharged integer, allocated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_inflow  integer := greatest(1, least(20, COALESCE(p_inflow, 6)));
    v_waiting integer;
    v_free    integer;
    v_cycles  integer;
BEGIN
    -- serialise with other allocators BEFORE touching any doctor row
    PERFORM pkg_admission._lock_allocation();
    arrived := 0; discharged := 0; allocated := 0;

    SELECT count(*) INTO v_waiting FROM hms.admission WHERE status = 'WAITING';
    IF v_waiting < pkg_simulation._setting('live_queue_cap')::integer THEN
        arrived := pkg_simulation._enqueue(v_inflow + floor(random() * 2)::integer);
    END IF;

    discharged := pkg_simulation._discharge_due();

    SELECT count(*) INTO v_waiting FROM hms.admission WHERE status = 'WAITING';
    SELECT count(*) INTO v_free FROM hms.bed WHERE current_admission_id IS NULL;
    IF v_waiting > 0 AND v_free > 0 AND random() > 0.05 THEN
        v_cycles := least(2 + floor(random() * 2)::integer, v_free, v_waiting);
        allocated := pkg_admission.allocate_bulk(v_cycles);
    END IF;
    RETURN NEXT;
END;
$$;

-- Loads the 500 demo patients. With p_bootstrap the hospital is put into a
-- realistic running state: the highest-priority 180 become discharge history
-- spread over the last 7 days (with bills), the next 240 are currently
-- admitted part-way through their stay, and the remaining 80 wait in queue.
-- One pass over the seed with an explicit, ranked cursor.
CREATE FUNCTION pkg_simulation.import_demo(p_bootstrap boolean DEFAULT true)
RETURNS TABLE (imported integer, waiting integer, admitted integer, discharged integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    c_history     CONSTANT integer := 180;
    c_waiting     CONSTANT integer := 80;
    v_now         timestamptz := now();
    v_today       timestamptz := date_trunc('day', now());
    v_since_mid   integer     := floor(extract(epoch FROM now() - date_trunc('day', now())));
    v_accel       numeric     := pkg_simulation._setting('live_time_acceleration')::numeric;
    v_total       integer;
    v_admit_goal  integer;
    v_flag        text;
    v_days_ago    integer;
    v_discharge   timestamptz;
    v_alloc       timestamptz;
    v_wait        integer;
    v_stay        integer;
    v_id          integer;
    s             hms.demo_patient_seed;
    r             record;
    cur_seed CURSOR FOR
        SELECT q.*, row_number() OVER (ORDER BY q.emergency_level DESC, q.arrival, q.seed_id)::integer AS rnk
          FROM (SELECT d.*,
                       -- same staggering as before: 6h .. 24h ago
                       v_now - make_interval(mins => 360 + ((d.seed_id - 1) * 34) % 1080) AS arrival
                  FROM hms.demo_patient_seed d) q
         ORDER BY rnk;
BEGIN
    PERFORM pkg_admission._lock_allocation();

    SELECT value INTO v_flag FROM hms.app_setting WHERE key = 'demo_imported' FOR UPDATE;
    IF v_flag = 'true' THEN
        RAISE EXCEPTION 'Demo patients are already imported.' USING ERRCODE = 'HM409';
    END IF;

    SELECT count(*) INTO v_total FROM hms.demo_patient_seed;
    IF v_total = 0 THEN
        RAISE EXCEPTION 'Demo seed table is empty — run db/setup.js.' USING ERRCODE = 'HM409';
    END IF;
    -- never try to admit more than the beds that are free right now
    v_admit_goal := least(greatest(0, v_total - c_history - c_waiting),
                          (SELECT count(*) FROM hms.bed WHERE current_admission_id IS NULL)::integer);

    imported := 0; waiting := 0; admitted := 0; discharged := 0;

    OPEN cur_seed;
    LOOP
        FETCH cur_seed INTO r;
        EXIT WHEN NOT FOUND;
        s := ROW(r.seed_id, r.full_name, r.disease, r.preferred_room, r.emergency_level)::hms.demo_patient_seed;
        imported := imported + 1;

        IF p_bootstrap AND r.rnk <= c_history THEN
            -- history: discharged 0..6 days ago
            v_days_ago := (r.rnk - 1) % 7;
            IF v_days_ago = 0 THEN
                v_discharge := v_now - make_interval(secs => (r.seed_id * 61) % greatest(60, least(10800, v_since_mid)));
            ELSE
                -- between 03:00 and 21:00 on that day
                v_discharge := v_today - make_interval(days => v_days_ago - 1, hours => 3)
                                       - make_interval(secs => (r.seed_id * 61) % 64800);
            END IF;
            IF pkg_simulation._backfill_history(s, v_discharge, v_total - c_waiting - r.rnk + 1) IS NOT NULL THEN
                discharged := discharged + 1;
                CONTINUE;
            END IF;
            -- (no bed free for that period: fall through and keep them waiting)

        ELSIF p_bootstrap AND r.rnk <= c_history + v_admit_goal THEN
            -- currently admitted, somewhere inside their (accelerated) stay
            v_stay  := pkg_rules.estimate_stay_hours(r.seed_id, r.disease, r.emergency_level, r.preferred_room);
            v_alloc := v_now - make_interval(secs => (v_stay * 3600.0 / v_accel) * ((r.seed_id * 37) % 90) / 100.0);
            v_wait  := pkg_rules.estimate_wait_seconds(r.seed_id, r.emergency_level, v_total - c_waiting - r.rnk + 1);
            v_id := pkg_admission._register(r.full_name, r.disease, r.preferred_room, r.emergency_level,
                                             'DEMO', v_alloc - make_interval(secs => v_wait));
            IF pkg_admission._allocate(v_id, v_alloc) IS NOT NULL THEN
                admitted := admitted + 1;
            ELSE
                waiting := waiting + 1;
            END IF;
            CONTINUE;
        END IF;

        PERFORM pkg_admission._register(r.full_name, r.disease, r.preferred_room, r.emergency_level, 'DEMO', r.arrival);
        waiting := waiting + 1;
    END LOOP;
    CLOSE cur_seed;

    UPDATE hms.app_setting SET value = 'true' WHERE key = 'demo_imported';
    RETURN NEXT;
END;
$$;

-- Owner-only: wipe all operational data (used by db/setup.js --reset and tests).
CREATE FUNCTION pkg_simulation.reset_all()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('hms.maintenance', 'on', true);       -- transaction-local
    UPDATE hms.bed SET current_admission_id = NULL WHERE current_admission_id IS NOT NULL;
    DELETE FROM hms.feedback;
    DELETE FROM hms.bill;
    DELETE FROM hms.admission;     -- doctor-load trigger only fires on INSERT/UPDATE
    DELETE FROM hms.patient;
    PERFORM setval(pg_get_serial_sequence('hms.admission', 'admission_id'), 1, false);
    PERFORM setval(pg_get_serial_sequence('hms.patient', 'patient_id'), 1, false);
    UPDATE hms.doctor SET current_load = 0;
    UPDATE hms.app_setting SET value = 'false' WHERE key = 'demo_imported';
END;
$$;
