-- RealWorld schema for the PostgREST HTTP API.
--
-- `npm run db:prepare` applies this file with psql after `npm run db:up`.
-- Every statement is idempotent, so re-running it never destroys data.
--
-- Layout:
--   * Tables live in `public` and PostgREST exposes them over HTTP.
--   * `grenite_app` is the role PostgREST uses for every request. It gets
--     SELECT on the public user columns, but never on `password_hash`.
--   * Writes that need logic (unique slugs, ownership checks, password
--     hashing) run inside the `public.*` functions below. The crypto ones
--     are SECURITY DEFINER and read their secret from `private.app_config`,
--     which has no HTTP endpoint.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The private schema holds what the HTTP API must not expose: the JWT
-- secret and helper functions. Created first, because the grants below
-- refer to it.

CREATE SCHEMA IF NOT EXISTS private;

-- Tables -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL CONSTRAINT users_username_key UNIQUE,
    email         TEXT NOT NULL CONSTRAINT users_email_key UNIQUE,
    password_hash TEXT NOT NULL,
    bio           TEXT,
    image         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Both foreign keys are named: embedding `follows` through a user is
-- ambiguous (follower or followee?), so PostgREST queries name the
-- constraint they mean, as in `follows!follows_followee_fk(...)`.
CREATE TABLE IF NOT EXISTS follows (
    follower_id INT NOT NULL CONSTRAINT follows_follower_fk REFERENCES users (id) ON DELETE CASCADE,
    followee_id INT NOT NULL CONSTRAINT follows_followee_fk REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS articles (
    id          SERIAL PRIMARY KEY,
    slug        TEXT NOT NULL CONSTRAINT articles_slug_key UNIQUE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    body        TEXT NOT NULL,
    author_id   INT NOT NULL CONSTRAINT articles_author_fk REFERENCES users (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS articles_created_at_idx ON articles (created_at DESC);
CREATE INDEX IF NOT EXISTS articles_author_idx ON articles (author_id);

CREATE TABLE IF NOT EXISTS article_tags (
    article_id INT NOT NULL CONSTRAINT article_tags_article_fk REFERENCES articles (id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    position   INT NOT NULL,
    PRIMARY KEY (article_id, tag)
);

CREATE INDEX IF NOT EXISTS article_tags_tag_idx ON article_tags (tag);

CREATE TABLE IF NOT EXISTS favorites (
    user_id    INT NOT NULL CONSTRAINT favorites_user_fk REFERENCES users (id) ON DELETE CASCADE,
    article_id INT NOT NULL CONSTRAINT favorites_article_fk REFERENCES articles (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, article_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id         SERIAL PRIMARY KEY,
    article_id INT NOT NULL CONSTRAINT comments_article_fk REFERENCES articles (id) ON DELETE CASCADE,
    author_id  INT NOT NULL CONSTRAINT comments_author_fk REFERENCES users (id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comments_article_idx ON comments (article_id, created_at);

-- Shared row type: every user-shaped return value, without the password hash.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_user') THEN
        CREATE TYPE public.app_user AS (id int, email text, username text, bio text, image text);
    END IF;
END
$$;

-- PostgREST roles ------------------------------------------------------------
--
-- PostgREST connects as `grenite_authenticator` and switches to
-- `grenite_app` for every request without an Authorization header.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grenite_app') THEN
        CREATE ROLE grenite_app NOINHERIT NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grenite_authenticator') THEN
        CREATE ROLE grenite_authenticator NOINHERIT LOGIN PASSWORD 'grenite_local_only';
    ELSE
        ALTER ROLE grenite_authenticator NOINHERIT LOGIN PASSWORD 'grenite_local_only';
    END IF;
END
$$;

GRANT grenite_app TO grenite_authenticator;

GRANT USAGE ON SCHEMA public TO grenite_app;

-- The article functions call private helpers as grenite_app, so the schema
-- itself must be usable. The secrets stay locked: only jwt_secret() is
-- revoked from PUBLIC, and private tables carry no grants at all.
GRANT USAGE ON SCHEMA private TO grenite_app;

-- Password hashes stay out of the HTTP API: only five user columns are
-- readable, and user writes go through the update_user function.
GRANT SELECT (id, email, username, bio, image) ON users TO grenite_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON articles TO grenite_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON article_tags TO grenite_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON favorites TO grenite_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON follows TO grenite_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON comments TO grenite_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO grenite_app;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO grenite_app;

-- Secrets --------------------------------------------------------------------
--
-- The JWT signing key lives here, one table outside the exposed schema.
-- Change it before sharing a database: the shipped value is for local use.

CREATE TABLE IF NOT EXISTS private.app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO private.app_config (key, value)
VALUES ('jwt_secret', 'grenite-realworld-dev-secret-change-me')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON private.app_config FROM PUBLIC;

CREATE OR REPLACE FUNCTION private.jwt_secret()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = private
AS $$
    SELECT value FROM app_config WHERE key = 'jwt_secret'
$$;

REVOKE EXECUTE ON FUNCTION private.jwt_secret() FROM PUBLIC;

-- Base64 without padding, with the URL-safe alphabet JWT needs.
-- encode() wraps its output every 76 characters, so the newlines go first.

CREATE OR REPLACE FUNCTION private.b64url(data bytea)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT rtrim(translate(regexp_replace(encode(data, 'base64'), '\s', '', 'g'), '+/', '-_'), '=')
$$;

-- Decode the base64url part of a JWT back into JSON.

CREATE OR REPLACE FUNCTION private.b64url_json(data text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT convert_from(
        decode(
            translate(data, '-_', '+/') || repeat('=', (4 - length(data) % 4) % 4),
            'base64'
        ),
        'UTF8'
    )::jsonb
$$;

-- Authentication -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_user(
    p_username text,
    p_email text,
    p_password text
)
RETURNS public.app_user
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    new_id int;
BEGIN
    INSERT INTO users (username, email, password_hash)
    VALUES (p_username, p_email, crypt(p_password, gen_salt('bf', 10)))
    RETURNING id INTO new_id;

    RETURN (SELECT (id, email, username, bio, image)::app_user FROM users WHERE id = new_id);
END
$$;

CREATE OR REPLACE FUNCTION public.authenticate(
    p_email text,
    p_password text
)
RETURNS public.app_user
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
    SELECT (u.id, u.email, u.username, u.bio, u.image)::app_user
    FROM users u
    WHERE u.email = p_email
      AND u.password_hash = crypt(p_password, u.password_hash)
$$;

-- Tokens: HS256 JWTs signed inside the database ------------------------------

CREATE OR REPLACE FUNCTION public.create_token(
    p_user_id int,
    p_email text,
    p_username text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = private, extensions
AS $$
DECLARE
    header text := private.b64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'UTF8'));
    payload text := private.b64url(convert_to(jsonb_build_object(
        'sub', p_user_id::text,
        'email', p_email,
        'username', p_username,
        'iat', extract(epoch from now())::bigint,
        'exp', extract(epoch from now() + interval '60 days')::bigint
    )::text, 'UTF8'));
BEGIN
    RETURN header || '.' || payload || '.' || private.b64url(hmac(
        convert_to(header || '.' || payload, 'UTF8'),
        convert_to(private.jwt_secret(), 'UTF8'),
        'sha256'
    ));
END
$$;

CREATE OR REPLACE FUNCTION public.verify_token(p_token text)
RETURNS public.app_user
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = private, public, extensions
AS $$
DECLARE
    parts text[] := string_to_array(p_token, '.');
    claims jsonb;
    expected text;
    token_user_id int;
BEGIN
    IF array_length(parts, 1) <> 3 THEN
        RETURN NULL;
    END IF;

    expected := private.b64url(hmac(
        convert_to(parts[1] || '.' || parts[2], 'UTF8'),
        convert_to(private.jwt_secret(), 'UTF8'),
        'sha256'
    ));

    IF parts[3] <> expected THEN
        RETURN NULL;
    END IF;

    BEGIN
        claims := private.b64url_json(parts[2]);
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;

    IF claims IS NULL OR NOT (claims ? 'exp') OR NOT (claims ? 'sub') THEN
        RETURN NULL;
    END IF;

    IF (claims->>'exp')::bigint <= extract(epoch from now())::bigint THEN
        RETURN NULL;
    END IF;

    BEGIN
        token_user_id := (claims->>'sub')::int;
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;

    RETURN (SELECT (id, email, username, bio, image)::app_user FROM users WHERE id = token_user_id);
END
$$;

-- User and profile writes ------------------------------------------------------

-- `p_patch` holds one key per field to change; a key set to JSON null means
-- "store null". The `password` key holds the raw password and is hashed here.
CREATE OR REPLACE FUNCTION public.update_user(
    p_user_id int,
    p_patch jsonb
)
RETURNS public.app_user
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    UPDATE users SET
        email = CASE WHEN p_patch ? 'email' THEN p_patch->>'email' ELSE users.email END,
        username = CASE WHEN p_patch ? 'username' THEN p_patch->>'username' ELSE users.username END,
        bio = CASE WHEN p_patch ? 'bio' THEN p_patch->'bio' #>> '{}' ELSE users.bio END,
        image = CASE WHEN p_patch ? 'image' THEN p_patch->'image' #>> '{}' ELSE users.image END,
        password_hash = CASE
            WHEN p_patch ? 'password' THEN crypt(p_patch->>'password', gen_salt('bf', 10))
            ELSE password_hash
        END
    WHERE id = p_user_id;

    RETURN (SELECT (id, email, username, bio, image)::app_user FROM users WHERE id = p_user_id);
END
$$;

CREATE OR REPLACE FUNCTION public.set_following(
    p_username text,
    p_viewer_id int,
    p_follow boolean
)
RETURNS TABLE (username text, bio text, image text, following boolean)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    target_id int;
BEGIN
    SELECT id INTO target_id FROM users WHERE users.username = p_username;

    IF target_id IS NULL THEN
        RAISE EXCEPTION 'profile not found' USING ERRCODE = 'RW404';
    END IF;

    IF p_follow THEN
        INSERT INTO follows (follower_id, followee_id)
        VALUES (p_viewer_id, target_id)
        ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM follows
        WHERE follower_id = p_viewer_id AND followee_id = target_id;
    END IF;

    RETURN QUERY
    SELECT u.username, u.bio, u.image,
           EXISTS (SELECT 1 FROM follows f
                   WHERE f.follower_id = p_viewer_id AND f.followee_id = u.id)
    FROM users u
    WHERE u.id = target_id;
END
$$;

-- Articles -------------------------------------------------------------------

-- Turn a title into the slug base: lowercase, non-alphanumerics collapsed
-- into single dashes, dashes trimmed from both ends.

CREATE OR REPLACE FUNCTION private.slugify(p_title text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(NULLIF(rtrim(ltrim(regexp_replace(lower(p_title), '[^a-z0-9]+', '-', 'g'), '-'), '-'), ''), 'article')
$$;

-- Insert the tags of an article in order, keeping only the first copy of a
-- duplicate so the primary key holds.

CREATE OR REPLACE FUNCTION private.replace_tags(p_article_id int, p_tags text[])
RETURNS void
LANGUAGE sql
VOLATILE
AS $$
    DELETE FROM article_tags WHERE article_id = p_article_id;

    INSERT INTO article_tags (article_id, tag, position)
    SELECT p_article_id, tag, min(idx) - 1
    FROM unnest(p_tags) WITH ORDINALITY AS t(tag, idx)
    GROUP BY tag
    ORDER BY min(idx)
$$;

-- Create an article with a slug nobody else uses. Duplicate titles get
-- -2, -3, ... and a concurrent create retries on the unique violation.

CREATE OR REPLACE FUNCTION public.create_article(
    p_author_id int,
    p_title text,
    p_description text,
    p_body text,
    p_tags text[] DEFAULT '{}'
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    base text := private.slugify(p_title);
    candidate text;
    suffix int := 1;
    new_id int;
BEGIN
    LOOP
        candidate := CASE WHEN suffix = 1 THEN base ELSE base || '-' || suffix END;
        BEGIN
            INSERT INTO articles (slug, title, description, body, author_id)
            VALUES (candidate, p_title, p_description, p_body, p_author_id)
            RETURNING id INTO new_id;
            EXIT;
        EXCEPTION WHEN unique_violation THEN
            suffix := suffix + 1;
            IF suffix > 100 THEN
                RAISE EXCEPTION 'cannot generate a unique slug' USING ERRCODE = 'RW500';
            END IF;
        END;
    END LOOP;

    PERFORM private.replace_tags(new_id, p_tags);

    RETURN candidate;
END
$$;

-- Update an article as its author. `p_patch` follows the update_user rules:
-- present keys change, absent keys stay. A new title regenerates the slug,
-- and `tagList` replaces the tag set. Runs in one transaction.

CREATE OR REPLACE FUNCTION public.update_article(
    p_slug text,
    p_requester_id int,
    p_patch jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    a_id int;
    a_author int;
    a_slug text;
    base text;
    candidate text;
    suffix int := 1;
    new_slug text;
BEGIN
    SELECT id, author_id, slug INTO a_id, a_author, a_slug
    FROM articles WHERE slug = p_slug FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'article not found' USING ERRCODE = 'RW404';
    END IF;
    IF a_author <> p_requester_id THEN
        RAISE EXCEPTION 'only the author may modify this article' USING ERRCODE = 'RW403';
    END IF;

    IF p_patch ? 'title' THEN
        base := private.slugify(p_patch->>'title');
        LOOP
            candidate := CASE WHEN suffix = 1 THEN base ELSE base || '-' || suffix END;
            EXIT WHEN candidate = a_slug
                OR NOT EXISTS (SELECT 1 FROM articles WHERE slug = candidate AND id <> a_id);
            suffix := suffix + 1;
            IF suffix > 100 THEN
                RAISE EXCEPTION 'cannot generate a unique slug' USING ERRCODE = 'RW500';
            END IF;
        END LOOP;
        new_slug := candidate;
    ELSE
        new_slug := a_slug;
    END IF;

    UPDATE articles SET
        title = CASE WHEN p_patch ? 'title' THEN p_patch->>'title' ELSE articles.title END,
        description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE articles.description END,
        body = CASE WHEN p_patch ? 'body' THEN p_patch->>'body' ELSE articles.body END,
        slug = new_slug,
        updated_at = now()
    WHERE id = a_id;

    IF p_patch ? 'tagList' THEN
        PERFORM private.replace_tags(a_id, ARRAY (SELECT jsonb_array_elements_text(p_patch->'tagList')));
    END IF;

    RETURN new_slug;
END
$$;

-- The follows of an article's author, as a computed relationship. PostgREST
-- cannot join articles to follows through the author with a foreign key
-- alone, and a nested `!inner` does not filter the top-level rows. This
-- function gives the feed endpoint a direct, filterable embed.

CREATE OR REPLACE FUNCTION public.author_followers(a articles)
RETURNS SETOF follows
ROWS 1000
LANGUAGE sql
STABLE
AS $$
    SELECT f.* FROM follows f WHERE f.followee_id = a.author_id
$$;

-- Total article count for the list and feed endpoints, with the same
-- filters those endpoints accept. A null argument means "no filter".

CREATE OR REPLACE FUNCTION public.count_articles(
    p_tag text DEFAULT NULL,
    p_author text DEFAULT NULL,
    p_favorited_by text DEFAULT NULL,
    p_followed_by int DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
    SELECT count(*)
    FROM articles a
    JOIN users au ON au.id = a.author_id
    WHERE (p_tag IS NULL OR EXISTS (
               SELECT 1 FROM article_tags t
               WHERE t.article_id = a.id AND t.tag = p_tag))
      AND (p_author IS NULL OR au.username = p_author)
      AND (p_favorited_by IS NULL OR EXISTS (
               SELECT 1 FROM favorites fv
               JOIN users fu ON fu.id = fv.user_id
               WHERE fv.article_id = a.id AND fu.username = p_favorited_by))
      AND (p_followed_by IS NULL OR EXISTS (
               SELECT 1 FROM follows f
               WHERE f.followee_id = a.author_id AND f.follower_id = p_followed_by))
$$;

-- Reload the PostgREST schema cache so new functions show up at once.

NOTIFY pgrst, 'reload schema';
