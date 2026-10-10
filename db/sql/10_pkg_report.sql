-- =====================================================================
-- 10_pkg_report.sql  —  PACKAGE pkg_report
-- Parameterised read queries (the static ones are plain views in api.*).
--
-- Package spec (granted to app): search_suggestions, search_admissions,
--                                discharge_history
-- Private body:                  _like_escape
-- =====================================================================
CREATE SCHEMA pkg_report;

-- Escape LIKE wildcards in user input so "%" or "_" are matched literally.
CREATE FUNCTION pkg_report._like_escape(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT replace(replace(replace(COALESCE(p_text, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$;

-- Distinct patient names starting with a prefix (replaces the Trie).
-- Names are stored upper-case, so this is an index range scan on
-- patient_name_prefix_idx (text_pattern_ops).
CREATE FUNCTION pkg_report.search_suggestions(p_prefix text, p_limit integer DEFAULT 8)
RETURNS TABLE (name varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
    SELECT DISTINCT p.full_name
      FROM hms.patient p
     WHERE btrim(COALESCE(p_prefix, '')) <> ''
       AND p.full_name LIKE pkg_report._like_escape(upper(btrim(p_prefix))) || '%'
     ORDER BY p.full_name
     LIMIT greatest(1, least(50, p_limit));
$$;

-- Every admission whose patient name contains the term, grouped like the
-- old search table: waiting (queue order), then admitted, then discharged.
CREATE FUNCTION pkg_report.search_admissions(p_term text, p_limit integer DEFAULT 200)
RETURNS SETOF api.v_admission
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
    SELECT v.*
      FROM api.v_admission v
     WHERE btrim(COALESCE(p_term, '')) <> ''
       AND v.name LIKE '%' || pkg_report._like_escape(upper(btrim(p_term))) || '%'
     ORDER BY CASE v.status WHEN 'WAITING' THEN 1 WHEN 'ADMITTED' THEN 2 ELSE 3 END,
              CASE WHEN v.status = 'WAITING' THEN -v.emergency_level END,
              CASE WHEN v.status = 'WAITING' THEN v.arrival_time END,
              v.discharged_at DESC NULLS FIRST,
              v.allocated_at,
              v.id
     LIMIT greatest(1, least(1000, p_limit));
$$;

-- Discharges in [p_from, p_to), newest first. The client passes its own
-- local-day boundaries so "Today"/"Yesterday" match the user's time zone.
CREATE FUNCTION pkg_report.discharge_history(p_from timestamptz, p_to timestamptz)
RETURNS SETOF api.v_admission
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
    SELECT v.*
      FROM api.v_admission v
     WHERE v.status = 'DISCHARGED'
       AND v.discharged_at >= p_from
       AND v.discharged_at <  p_to
     ORDER BY v.discharged_at DESC, v.id DESC;
$$;
