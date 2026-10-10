-- =====================================================================
-- 11_grants.sql  —  what the application role (hms_app) may do.
--
-- This is how "package spec vs package body" is enforced in PostgreSQL:
-- only the public API functions get EXECUTE; private helpers (prefixed
-- with "_") and the internal packages stay owner-only. The app has no
-- privileges on schema hms at all, so it cannot INSERT/UPDATE/DELETE a
-- table directly — every change goes through the business rules.
-- =====================================================================

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default; undo that.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hms, pkg_rules, pkg_billing, pkg_admission,
                                          pkg_simulation, pkg_auth, pkg_report FROM PUBLIC;

GRANT USAGE ON SCHEMA api, pkg_admission, pkg_simulation, pkg_auth, pkg_report TO hms_app;

GRANT SELECT ON ALL TABLES IN SCHEMA api TO hms_app;     -- views only

GRANT EXECUTE ON FUNCTION
    pkg_admission.register_patient(text, text, text, integer),
    pkg_admission.allocate_next(),
    pkg_admission.allocate_bulk(integer),
    pkg_admission.discharge_patient(integer),
    pkg_simulation.enqueue_arrivals(integer),
    pkg_simulation.tick(integer),
    pkg_simulation.import_demo(boolean),
    pkg_auth.sign_up(text, text, text),
    pkg_auth.sign_in(text, text),
    pkg_auth.sign_out(text),
    pkg_auth.validate_session(text),
    pkg_report.search_suggestions(text, integer),
    pkg_report.search_admissions(text, integer),
    pkg_report.discharge_history(timestamptz, timestamptz)
TO hms_app;
