-- =====================================================================
-- 06_pkg_billing.sql  —  PACKAGE pkg_billing
-- Bill and discharge-feedback generation (the old buildBill() and
-- createFeedback()). Called by pkg_admission when a patient is discharged.
--
-- Package spec (granted to app): none — only pkg_admission calls it
-- Private body:                  compute_bill, generate_bill, generate_feedback
-- =====================================================================
CREATE SCHEMA pkg_billing;

-- Pure calculation: returns the bill row without storing it.
-- For a still-admitted patient it prices the stay up to now (a preview).
CREATE FUNCTION pkg_billing.compute_bill(p_admission_id integer)
RETURNS hms.bill
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    a          hms.admission;
    v_room     varchar;
    v_rate     numeric;
    v_profile  hms.disease_profile;
    v_accel    numeric;
    v_sim_hrs  integer;
    v_severe   boolean;
    r          hms.bill;
BEGIN
    SELECT * INTO a FROM hms.admission WHERE admission_id = p_admission_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Admission % not found', p_admission_id USING ERRCODE = 'HM404';
    END IF;
    IF a.allocated_at IS NULL THEN
        RAISE EXCEPTION 'Admission % has not been allocated a bed yet', p_admission_id USING ERRCODE = 'HM409';
    END IF;

    SELECT b.room_type, rt.hourly_rate INTO v_room, v_rate
      FROM hms.bed b JOIN hms.room_type rt ON rt.code = b.room_type
     WHERE b.bed_no = a.bed_no;

    v_profile := pkg_rules.disease_profile(a.disease);
    SELECT value::numeric INTO v_accel FROM hms.app_setting WHERE key = 'live_time_acceleration';

    -- Simulated hours actually spent in the bed. The old code always billed the
    -- full estimate, so a patient discharged early paid for days they never
    -- stayed; now the bill uses whichever is smaller.
    v_sim_hrs := ceil(extract(epoch FROM COALESCE(a.discharged_at, now()) - a.allocated_at)
                      * COALESCE(v_accel, 1) / 3600.0);

    r.admission_id       := a.admission_id;
    r.stay_hours         := least(a.estimated_stay_hours, greatest(1, v_sim_hrs));
    v_severe             := a.emergency_level >= 5
                            OR a.disease ~* '(accident|severe|trauma|burn|stroke|failure)';
    -- severe cases are billed in whole days
    r.billed_hours       := CASE WHEN v_severe THEN ceil(r.stay_hours / 24.0)::integer * 24 ELSE r.stay_hours END;
    r.room_type          := v_room;
    r.room_rate          := v_rate;
    r.room_charge        := round(r.billed_hours * v_rate);
    r.emergency_charge   := a.emergency_level * 950;
    r.doctor_fee         := 1400 + a.emergency_level * 700;
    r.nursing_charge     := ceil(r.stay_hours / 24.0) * 950;
    r.pharmacy_charge    := round(v_profile.treatment_cost * 0.35);
    -- (old JS produced NaN -> 0 here for diseases with no profile match,
    --  silently dropping the emergency part of the diagnostics charge)
    r.diagnostics_charge := round(v_profile.diagnostics_cost + a.emergency_level * 350);
    r.procedure_charge   := round(v_profile.procedure_cost);
    r.treatment_charge   := round(v_profile.treatment_cost);
    r.service_charge     := 1400;
    r.subtotal           := r.room_charge + r.emergency_charge + r.doctor_fee + r.nursing_charge
                          + r.pharmacy_charge + r.diagnostics_charge + r.procedure_charge
                          + r.treatment_charge + r.service_charge;
    r.gst                := round(r.subtotal * 0.05);
    -- demo insurance rule kept from the original app: every 4th case is insured (12% off)
    r.insurance_discount := CASE WHEN a.admission_id % 4 = 0 THEN round(r.subtotal * 0.12) ELSE 0 END;
    r.total              := r.subtotal + r.gst - r.insurance_discount;
    r.generated_at       := now();
    RETURN r;
END;
$$;

CREATE FUNCTION pkg_billing.generate_bill(p_admission_id integer)
RETURNS hms.bill
LANGUAGE plpgsql
AS $$
DECLARE
    r hms.bill;
BEGIN
    r := pkg_billing.compute_bill(p_admission_id);
    INSERT INTO hms.bill VALUES (r.*);
    RETURN r;
END;
$$;

-- Deterministic discharge feedback (same selection rules as createFeedback()).
CREATE FUNCTION pkg_billing.generate_feedback(p_admission_id integer)
RETURNS hms.feedback
LANGUAGE plpgsql
AS $$
DECLARE
    c_types CONSTANT text[] := ARRAY[
        'Cleanliness', 'Waiting Time', 'Staff Responsiveness', 'Billing Desk', 'Food Quality', 'No Major Complaint'];
    c_bodies CONSTANT text[] := ARRAY[
        'Admission process was smooth but initial room transfer took longer than expected.',
        'Nursing team was attentive; however, medicine delivery missed one scheduled window.',
        'Housekeeping standards were good, though washroom sanitization can be more frequent.',
        'Doctor communication was clear, but attendants wanted more frequent status updates.',
        'Discharge billing queue was busy during peak hours and felt slightly delayed.',
        'Overall experience remained stable with no significant concerns.'];
    c_suggestions CONSTANT text[] := ARRAY[
        'Add one more billing counter during evening discharge rush.',
        'Introduce digital nursing call tracking for quicker non-emergency responses.',
        'Increase attendant communication rounds to every 4 hours.',
        'Expand housekeeping checks for shared facilities at fixed intervals.',
        'Provide bedside discharge summary preview before final bill generation.',
        'Maintain current quality standards and continue periodic audits.'];
    v_level  integer;
    v_idx    integer;
    r        hms.feedback;
BEGIN
    SELECT emergency_level INTO v_level FROM hms.admission WHERE admission_id = p_admission_id;
    v_idx := (p_admission_id + v_level) % 6;                         -- 0-based like the JS version
    r.admission_id   := p_admission_id;
    r.rating         := 3 + (p_admission_id % 3);
    r.complaint_type := c_types[v_idx + 1];                          -- PL/pgSQL arrays are 1-based
    r.complaint_text := c_bodies[((v_idx + p_admission_id) % 6) + 1];
    r.suggestion     := c_suggestions[((v_idx + v_level) % 6) + 1];
    r.submitted_at   := now();
    INSERT INTO hms.feedback VALUES (r.*);
    RETURN r;
END;
$$;
