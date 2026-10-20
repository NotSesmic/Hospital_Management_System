CREATE PROCEDURE pkg_admission.sp_allocate_next(
    INOUT p_admission_id integer DEFAULT NULL,
    INOUT p_bed_no       integer DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    SELECT a.id, a.bed_no INTO p_admission_id, p_bed_no
      FROM pkg_admission.allocate_next() a;
END;
$$;

CREATE PROCEDURE pkg_admission.sp_discharge(
    IN    p_admission_id integer,
    INOUT p_bill_total   numeric DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    PERFORM pkg_admission.discharge_patient(p_admission_id);
    SELECT b.total INTO p_bill_total FROM hms.bill b WHERE b.admission_id = p_admission_id;
END;
$$;

REVOKE EXECUTE ON ALL PROCEDURES IN SCHEMA pkg_admission FROM PUBLIC;
GRANT EXECUTE ON PROCEDURE
    pkg_admission.sp_allocate_next(integer, integer),
    pkg_admission.sp_discharge(integer, numeric)
TO hms_app;
