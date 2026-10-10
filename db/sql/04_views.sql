-- =====================================================================
-- 04_views.sql  —  read model for the app (schema "api").
-- The app role can SELECT these views but has no access to schema hms,
-- so every write must go through a package function.
-- Column names are chosen so server.js can map them 1:1 to the field
-- names the React UI already used (id, name, bedNo, doctorName, ...).
-- =====================================================================

-- One row per admission with everything the UI shows about a patient.
CREATE VIEW api.v_admission AS
SELECT a.admission_id                       AS id,
       p.patient_id,
       p.full_name                          AS name,
       p.initials,
       a.disease,
       a.preferred_room,
       b.room_type,                                       -- NULL while waiting
       a.emergency_level,
       el.label                             AS emergency_label,
       el.protocol_note                     AS emergency_msg,
       a.specialty,
       a.doctor_id,
       COALESCE(d.full_name,
                CASE WHEN a.status = 'WAITING' THEN 'Pending Allocation'
                     ELSE 'Unassigned (At Capacity)' END) AS doctor_name,
       a.status,
       a.source,
       a.arrival_time,
       a.allocated_at,
       a.discharged_at,
       a.bed_no,
       a.estimated_stay_hours,
       floor(extract(epoch FROM a.allocated_at - a.arrival_time))::integer AS wait_seconds,
       CASE WHEN bl.admission_id IS NOT NULL THEN jsonb_build_object(
            'stayHours',         bl.stay_hours,
            'billedHours',       bl.billed_hours,
            'roomType',          bl.room_type,
            'roomRate',          bl.room_rate,
            'roomCharge',        bl.room_charge,
            'emergencyCharge',   bl.emergency_charge,
            'doctorFee',         bl.doctor_fee,
            'nursingCharge',     bl.nursing_charge,
            'pharmacyCharge',    bl.pharmacy_charge,
            'diagnosticsCharge', bl.diagnostics_charge,
            'procedureCharge',   bl.procedure_charge,
            'treatmentCharge',   bl.treatment_charge,
            'serviceCharge',     bl.service_charge,
            'subtotal',          bl.subtotal,
            'gst',               bl.gst,
            'insuranceDiscount', bl.insurance_discount,
            'total',             bl.total) END AS bill,
       CASE WHEN f.admission_id IS NOT NULL THEN jsonb_build_object(
            'rating',        f.rating,
            'complaintType', f.complaint_type,
            'complaintText', f.complaint_text,
            'suggestion',    f.suggestion) END AS feedback
FROM hms.admission a
JOIN hms.patient         p  ON p.patient_id = a.patient_id
JOIN hms.emergency_level el ON el.level = a.emergency_level
LEFT JOIN hms.bed        b  ON b.bed_no = a.bed_no
LEFT JOIN hms.doctor     d  ON d.doctor_id = a.doctor_id
LEFT JOIN hms.bill       bl ON bl.admission_id = a.admission_id
LEFT JOIN hms.feedback   f  ON f.admission_id = a.admission_id;

-- The priority queue, in the exact order allocation will take patients.
CREATE VIEW api.v_waiting_queue AS
SELECT row_number() OVER (ORDER BY v.emergency_level DESC, v.arrival_time, v.id)::integer AS queue_position,
       v.*
FROM api.v_admission v
WHERE v.status = 'WAITING';

CREATE VIEW api.v_admitted AS
SELECT v.* FROM api.v_admission v WHERE v.status = 'ADMITTED';

CREATE VIEW api.v_doctor_load AS
SELECT d.doctor_id,
       d.full_name,
       d.specialty,
       d.current_load,
       d.max_patients,
       d.max_patients - d.current_load AS available_slots
FROM hms.doctor d;

CREATE VIEW api.v_bed_map AS
SELECT b.bed_no, b.room_type, (b.current_admission_id IS NOT NULL) AS occupied, b.current_admission_id
FROM hms.bed b;

CREATE VIEW api.v_room_type AS
SELECT rt.code,
       rt.display_order,
       rt.hourly_rate,
       count(b.bed_no)::integer                                         AS capacity,
       count(b.bed_no) FILTER (WHERE b.current_admission_id IS NULL)::integer AS free_beds
FROM hms.room_type rt
LEFT JOIN hms.bed b ON b.room_type = rt.code
GROUP BY rt.code, rt.display_order, rt.hourly_rate;

CREATE VIEW api.v_emergency_level AS
SELECT level, label, protocol_note FROM hms.emergency_level;

-- Single-row dashboard / statistics summary.
-- Median uses percentile_cont over every allocation ever made (replaces the
-- in-memory two-heap MedianFinder, which was reset on every page reload).
CREATE VIEW api.v_dashboard_summary AS
WITH counts AS (
    SELECT count(*) FILTER (WHERE status = 'WAITING')::integer    AS waiting,
           count(*) FILTER (WHERE status = 'ADMITTED')::integer   AS admitted,
           count(*) FILTER (WHERE status = 'DISCHARGED')::integer AS discharged,
           max(emergency_level)                                    AS peak_level
    FROM hms.admission
), waits AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM allocated_at - arrival_time)) AS median_wait_seconds,
           avg(extract(epoch FROM allocated_at - arrival_time))                                        AS avg_wait_seconds,
           count(*)::integer                                                                           AS patients_served
    FROM hms.admission
    WHERE allocated_at IS NOT NULL
), dist AS (
    SELECT array_agg(COALESCE(x.n, 0)::integer ORDER BY el.level) AS emergency_distribution
    FROM hms.emergency_level el
    LEFT JOIN (SELECT emergency_level, count(*) AS n FROM hms.admission GROUP BY emergency_level) x
           ON x.emergency_level = el.level
)
SELECT c.waiting, c.admitted, c.discharged, c.peak_level,
       (SELECT count(*)::integer FROM hms.bed)                                     AS total_beds,
       (SELECT count(*)::integer FROM hms.bed WHERE current_admission_id IS NULL)  AS free_beds,
       floor(w.median_wait_seconds)::integer AS median_wait_seconds,
       floor(w.avg_wait_seconds)::integer    AS avg_wait_seconds,
       w.patients_served,
       d.emergency_distribution,
       (SELECT value = 'true' FROM hms.app_setting WHERE key = 'demo_imported') AS demo_imported
FROM counts c, waits w, dist d;

-- Invariants that the triggers are supposed to keep true. Should always be
-- empty; used by the test-suite and GET /api/health.
CREATE VIEW api.v_integrity_issues AS
SELECT 'doctor_load_mismatch' AS issue, d.doctor_id::text AS ref,
       format('stored %s, actual %s', d.current_load, count(a.admission_id)) AS detail
FROM hms.doctor d
LEFT JOIN hms.admission a ON a.doctor_id = d.doctor_id AND a.status = 'ADMITTED'
GROUP BY d.doctor_id, d.current_load
HAVING d.current_load <> count(a.admission_id)
UNION ALL
SELECT 'bed_points_to_non_admitted', b.bed_no::text, format('admission %s', b.current_admission_id)
FROM hms.bed b
JOIN hms.admission a ON a.admission_id = b.current_admission_id
WHERE a.status <> 'ADMITTED' OR a.bed_no <> b.bed_no
UNION ALL
SELECT 'admitted_without_bed_link', a.admission_id::text, format('bed %s', a.bed_no)
FROM hms.admission a
LEFT JOIN hms.bed b ON b.current_admission_id = a.admission_id
WHERE a.status = 'ADMITTED' AND b.bed_no IS NULL
UNION ALL
SELECT 'discharged_without_bill', a.admission_id::text, ''
FROM hms.admission a
LEFT JOIN hms.bill bl ON bl.admission_id = a.admission_id
WHERE a.status = 'DISCHARGED' AND bl.admission_id IS NULL;
