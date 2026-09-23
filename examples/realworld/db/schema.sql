-- RealWorld schema. main.js applies this file at startup. Every statement is
-- idempotent, so restarting the app never destroys data.

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL CONSTRAINT users_username_key UNIQUE,
    email         TEXT NOT NULL CONSTRAINT users_email_key UNIQUE,
    password_hash TEXT NOT NULL,
    bio           TEXT,
    image         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS follows (
    follower_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    followee_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS articles (
    id          SERIAL PRIMARY KEY,
    slug        TEXT NOT NULL CONSTRAINT articles_slug_key UNIQUE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    body        TEXT NOT NULL,
    author_id   INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS articles_created_at_idx ON articles (created_at DESC);
CREATE INDEX IF NOT EXISTS articles_author_idx ON articles (author_id);

CREATE TABLE IF NOT EXISTS article_tags (
    article_id INT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    position   INT NOT NULL,
    PRIMARY KEY (article_id, tag)
);

CREATE INDEX IF NOT EXISTS article_tags_tag_idx ON article_tags (tag);

CREATE TABLE IF NOT EXISTS favorites (
    user_id    INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    article_id INT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, article_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id         SERIAL PRIMARY KEY,
    article_id INT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    author_id  INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comments_article_idx ON comments (article_id, created_at);
