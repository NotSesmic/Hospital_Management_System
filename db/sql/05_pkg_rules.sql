-- =====================================================================
-- 05_pkg_rules.sql  —  PACKAGE pkg_rules
-- Clinical/business rules that used to be JS helpers in App.js
-- (inferSpecialty, getDiseaseProfile, estimateStayHours, estimateWaitSeconds).
-- All are read-only lookups over the reference tables, so changing a
-- keyword or a rate is now a data change, not a code change.
--
-- Package spec (granted to app): none — used internally by other packages.
-- =====================================================================
CREATE SCHEMA pkg_rules;

-- First specialty (by match_order) having a keyword contained in the
-- disease text; 'General Medicine' when nothing matches.
CREATE FUNCTION pkg_rules.infer_specialty(p_disease text)
RETURNS varchar
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        (SELECT s.name
           FROM hms.specialty s
           JOIN hms.specialty_keyword k ON k.specialty = s.name
          WHERE s.match_order IS NOT NULL
            AND strpos(lower(p_disease), k.keyword) > 0
          ORDER BY s.match_order
          LIMIT 1),
        'General Medicine');
$$;

-- First matching disease profile (by match_order), else the default one.
CREATE FUNCTION pkg_rules.disease_profile(p_disease text)
RETURNS hms.disease_profile
LANGUAGE sql STABLE
AS $$
    SELECT p.*
      FROM hms.disease_profile p
     WHERE p.is_default
        OR EXISTS (SELECT 1
                     FROM hms.disease_profile_keyword k
                    WHERE k.profile_id = p.profile_id
                      AND strpos(lower(p_disease), k.keyword) > 0)
     ORDER BY p.is_default, p.match_order
     LIMIT 1;
$$;

-- Estimated stay in (simulated) hours. Same formula as the old
-- estimateStayHours(): a deterministic spread inside the profile's range,
-- scaled by room, emergency level and disease severity; minimum 2 hours.
CREATE FUNCTION pkg_rules.estimate_stay_hours(p_seed integer, p_disease text, p_level integer, p_room text)
RETURNS integer
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_profile         hms.disease_profile;
    v_spread          integer;
    v_base            integer;
    v_room_factor     numeric;
    v_emer_factor     numeric;
    v_disease_factor  numeric;
BEGIN
    v_profile := pkg_rules.disease_profile(p_disease);
    v_spread  := greatest(1, v_profile.max_stay_hours - v_profile.min_stay_hours);
    v_base    := v_profile.min_stay_hours + ((p_seed * 11 + p_level * 7) % v_spread);

    SELECT stay_factor INTO v_room_factor FROM hms.room_type WHERE code = p_room;
    v_room_factor := COALESCE(v_room_factor, 1);

    v_emer_factor := 1 + (greatest(1, least(7, p_level)) - 3) * 0.11;
    v_disease_factor := CASE WHEN v_profile.treatment_cost >= 20000 THEN 1.22
                             WHEN v_profile.treatment_cost >= 12000 THEN 1.10
                             ELSE 1 END;

    RETURN greatest(2, round(v_base * v_room_factor * v_emer_factor * v_disease_factor)::integer);
END;
$$;

-- Synthetic queue wait used ONLY to back-fill realistic demo history
-- (the old estimateWaitSeconds). Live allocations record the real wait.
CREATE FUNCTION pkg_rules.estimate_wait_seconds(p_seed integer, p_level integer, p_queue_depth integer)
RETURNS integer
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_total_beds  integer;
    v_base        integer;
    v_load        integer;
    v_variability integer;
BEGIN
    SELECT count(*) INTO v_total_beds FROM hms.bed;
    SELECT base_wait_seconds INTO v_base FROM hms.emergency_level WHERE level = p_level;
    v_load        := floor((p_queue_depth::numeric / greatest(1, v_total_beds)) * 4 * 60);
    v_variability := (p_seed * 41 + p_queue_depth * 17) % (3 * 60);
    RETURN least(14 * 60 + 59, greatest(10, COALESCE(v_base, 300) + v_load + v_variability));
END;
$$;
