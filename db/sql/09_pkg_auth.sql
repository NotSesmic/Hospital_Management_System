-- =====================================================================
-- 09_pkg_auth.sql  —  PACKAGE pkg_auth
-- Staff sign-up / sign-in. Replaces the users array the old app kept in
-- localStorage with plaintext passwords.
--   * passwords: bcrypt (pgcrypto crypt + gen_salt('bf'))
--   * sessions:  random 256-bit token returned once; only its SHA-256 is stored
--
-- Package spec (granted to app): sign_up, sign_in, sign_out, validate_session
-- =====================================================================
CREATE SCHEMA pkg_auth;

CREATE FUNCTION pkg_auth.sign_up(p_name text, p_email text, p_password text)
RETURNS TABLE (user_id integer, full_name varchar, email varchar)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_email text := lower(btrim(COALESCE(p_email, '')));
BEGIN
    IF v_email = '' OR COALESCE(btrim(p_password), '') = '' THEN
        RAISE EXCEPTION 'Email and password are required.' USING ERRCODE = 'HM400';
    END IF;
    IF COALESCE(btrim(p_name), '') = '' THEN
        RAISE EXCEPTION 'Please enter your full name.' USING ERRCODE = 'HM400';
    END IF;
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = 'HM400';
    END IF;
    IF length(p_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters.' USING ERRCODE = 'HM400';
    END IF;

    BEGIN
        RETURN QUERY
        INSERT INTO hms.app_user (full_name, email, password_hash)
        VALUES (btrim(p_name), v_email, public.crypt(p_password, public.gen_salt('bf', 10)))
        RETURNING app_user.user_id, app_user.full_name, app_user.email;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'User already exists. Please sign in.' USING ERRCODE = 'HM409';
    END;
END;
$$;

CREATE FUNCTION pkg_auth.sign_in(p_email text, p_password text)
RETURNS TABLE (token text, user_id integer, full_name varchar, email varchar, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    u        hms.app_user;
    v_token  text;
    v_ttl    integer;
BEGIN
    IF COALESCE(btrim(p_email), '') = '' OR COALESCE(btrim(p_password), '') = '' THEN
        RAISE EXCEPTION 'Email and password are required.' USING ERRCODE = 'HM400';
    END IF;

    SELECT * INTO u FROM hms.app_user WHERE app_user.email = lower(btrim(p_email));
    -- compare against a dummy hash when the user doesn't exist, so response
    -- time doesn't reveal which emails are registered
    IF u.user_id IS NULL
       OR public.crypt(p_password, COALESCE(u.password_hash, public.gen_salt('bf', 10))) <> u.password_hash THEN
        RAISE EXCEPTION 'Sign in failed: invalid credentials.' USING ERRCODE = 'HM401';
    END IF;

    DELETE FROM hms.user_session WHERE user_session.expires_at <= now();   -- housekeeping

    SELECT value::integer INTO v_ttl FROM hms.app_setting WHERE key = 'session_ttl_hours';
    v_token := encode(public.gen_random_bytes(32), 'hex');
    INSERT INTO hms.user_session (token_hash, user_id, expires_at)
    VALUES (public.digest(v_token, 'sha256'), u.user_id, now() + make_interval(hours => COALESCE(v_ttl, 12)));

    RETURN QUERY SELECT v_token, u.user_id, u.full_name, u.email, now() + make_interval(hours => COALESCE(v_ttl, 12));
END;
$$;

CREATE FUNCTION pkg_auth.sign_out(p_token text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    DELETE FROM hms.user_session WHERE token_hash = public.digest(COALESCE(p_token, ''), 'sha256');
    RETURN FOUND;
END;
$$;

-- Returns the signed-in user for a token, or no row if invalid/expired.
CREATE FUNCTION pkg_auth.validate_session(p_token text)
RETURNS TABLE (user_id integer, full_name varchar, email varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
    SELECT u.user_id, u.full_name, u.email
      FROM hms.user_session s
      JOIN hms.app_user u ON u.user_id = s.user_id
     WHERE s.token_hash = public.digest(COALESCE(p_token, ''), 'sha256')
       AND s.expires_at > now();
$$;
