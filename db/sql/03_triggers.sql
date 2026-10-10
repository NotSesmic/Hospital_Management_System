-- =====================================================================
-- 03_triggers.sql
--
-- Custom SQLSTATEs used across the database (mapped to HTTP codes by
-- server.js):  HM400 bad input · HM401 auth · HM404 not found ·
--              HM409 state conflict (no beds, wrong status, ...)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Patient name normalisation
--    Replaces toUpperName()/getInitials() that were duplicated across
--    register, demo import and live inflow in App.js. Doing it here means
--    every insert path (and any manual SQL) stores names the same way.
-- ---------------------------------------------------------------------
CREATE FUNCTION hms.trg_patient_normalize() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_parts text[];
BEGIN
    NEW.full_name := upper(regexp_replace(btrim(NEW.full_name), '\s+', ' ', 'g'));
    IF NEW.full_name = '' THEN
        RAISE EXCEPTION 'Name cannot be empty!' USING ERRCODE = 'HM400';
    END IF;
    v_parts := string_to_array(NEW.full_name, ' ');
    NEW.initials := left(v_parts[1], 1)
                 || CASE WHEN cardinality(v_parts) > 1 THEN left(v_parts[cardinality(v_parts)], 1) ELSE '' END;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_patient_normalize
    BEFORE INSERT OR UPDATE OF full_name ON hms.patient
    FOR EACH ROW EXECUTE FUNCTION hms.trg_patient_normalize();

-- ---------------------------------------------------------------------
-- 2. Admission lifecycle guard
--    A CHECK constraint can't see the OLD row, so transition rules need a
--    trigger:  WAITING -> ADMITTED -> DISCHARGED, never backwards; intake
--    details are frozen once recorded; discharged rows are read-only;
--    admissions are never deleted (except by the owner-only reset, which
--    sets the transaction-local flag hms.maintenance; the app role has no
--    DELETE privilege at all, so it cannot use that path).
--    Historical rows may be inserted directly as DISCHARGED only by the
--    demo back-fill (source = 'DEMO').
-- ---------------------------------------------------------------------
CREATE FUNCTION hms.trg_admission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('hms.maintenance', true) = 'on' THEN   -- pkg_simulation.reset_all only
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'Admissions are never deleted (admission %)', OLD.admission_id USING ERRCODE = 'HM409';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'WAITING' AND NEW.source <> 'DEMO' THEN
            RAISE EXCEPTION 'New admissions must start in WAITING (got %)', NEW.status USING ERRCODE = 'HM409';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE
    IF OLD.status = 'DISCHARGED' THEN
        RAISE EXCEPTION 'Admission % is discharged and read-only', OLD.admission_id USING ERRCODE = 'HM409';
    END IF;

    IF NEW.status <> OLD.status
       AND NOT ((OLD.status = 'WAITING'  AND NEW.status = 'ADMITTED')
             OR (OLD.status = 'ADMITTED' AND NEW.status = 'DISCHARGED')) THEN
        RAISE EXCEPTION 'Invalid status change % -> % for admission %', OLD.status, NEW.status, OLD.admission_id
            USING ERRCODE = 'HM409';
    END IF;

    IF (NEW.patient_id, NEW.disease, NEW.preferred_room, NEW.emergency_level, NEW.specialty, NEW.source, NEW.arrival_time)
       IS DISTINCT FROM
       (OLD.patient_id, OLD.disease, OLD.preferred_room, OLD.emergency_level, OLD.specialty, OLD.source, OLD.arrival_time) THEN
        RAISE EXCEPTION 'Intake details of admission % cannot be changed', OLD.admission_id USING ERRCODE = 'HM409';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admission_guard
    BEFORE INSERT OR UPDATE OR DELETE ON hms.admission
    FOR EACH ROW EXECUTE FUNCTION hms.trg_admission_guard();

-- ---------------------------------------------------------------------
-- 3. Bed occupancy sync
--    Keeps hms.bed.current_admission_id in step with admissions. Because
--    the allocator locks the bed row (FOR UPDATE SKIP LOCKED) and this
--    trigger writes that same row, two concurrent allocations can never
--    receive the same bed. If somehow they try, the "IS NULL" guard fails.
-- ---------------------------------------------------------------------
CREATE FUNCTION hms.trg_admission_bed_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- release the old bed when leaving ADMITTED (discharge) or moving beds
    IF TG_OP = 'UPDATE' AND OLD.status = 'ADMITTED'
       AND (NEW.status <> 'ADMITTED' OR NEW.bed_no IS DISTINCT FROM OLD.bed_no) THEN
        UPDATE hms.bed SET current_admission_id = NULL
         WHERE bed_no = OLD.bed_no AND current_admission_id = OLD.admission_id;
    END IF;

    -- occupy the new bed when entering ADMITTED (or moving beds)
    IF NEW.status = 'ADMITTED'
       AND (TG_OP = 'INSERT' OR OLD.status <> 'ADMITTED' OR NEW.bed_no IS DISTINCT FROM OLD.bed_no) THEN
        UPDATE hms.bed SET current_admission_id = NEW.admission_id
         WHERE bed_no = NEW.bed_no AND current_admission_id IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Bed % is already occupied', NEW.bed_no USING ERRCODE = 'HM409';
        END IF;
    END IF;
    RETURN NULL;   -- AFTER trigger
END;
$$;

CREATE TRIGGER trg_admission_bed_sync
    AFTER INSERT OR UPDATE OF status, bed_no ON hms.admission
    FOR EACH ROW EXECUTE FUNCTION hms.trg_admission_bed_sync();

-- ---------------------------------------------------------------------
-- 4. Doctor load counter
--    The old app kept doctorLoads in memory and it drifted (the demo
--    bootstrap discharged patients without releasing their doctor, and the
--    poll loop overwrote counts from stale snapshots). Now the counter only
--    moves when an admission enters/leaves ADMITTED, and doctor_capacity_ck
--    rejects any assignment beyond max_patients.
-- ---------------------------------------------------------------------
CREATE FUNCTION hms.trg_admission_doctor_load() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_old_counts boolean := TG_OP = 'UPDATE' AND OLD.status = 'ADMITTED' AND OLD.doctor_id IS NOT NULL;
    v_new_counts boolean := NEW.status = 'ADMITTED' AND NEW.doctor_id IS NOT NULL;
BEGIN
    IF v_old_counts AND v_new_counts AND OLD.doctor_id = NEW.doctor_id THEN
        RETURN NULL;                     -- still with the same doctor
    END IF;
    IF v_old_counts THEN
        UPDATE hms.doctor SET current_load = current_load - 1 WHERE doctor_id = OLD.doctor_id;
    END IF;
    IF v_new_counts THEN
        UPDATE hms.doctor SET current_load = current_load + 1 WHERE doctor_id = NEW.doctor_id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_admission_doctor_load
    AFTER INSERT OR UPDATE OF status, doctor_id ON hms.admission
    FOR EACH ROW EXECUTE FUNCTION hms.trg_admission_doctor_load();

-- ---------------------------------------------------------------------
-- 5. Issued bills are final
--    A generated invoice must not be silently edited or removed; any
--    correction would be a new credit note, not an UPDATE.
-- ---------------------------------------------------------------------
CREATE FUNCTION hms.trg_bill_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('hms.maintenance', true) = 'on' THEN   -- reset_all only
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Bill for admission % is final and cannot be %d', OLD.admission_id, lower(TG_OP)
        USING ERRCODE = 'HM409';
END;
$$;

CREATE TRIGGER trg_bill_immutable
    BEFORE UPDATE OR DELETE ON hms.bill
    FOR EACH ROW EXECUTE FUNCTION hms.trg_bill_immutable();
