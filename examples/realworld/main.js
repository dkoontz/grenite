"use strict";

// This file is the Node entry point. It owns everything Gren cannot do:
// - the connection to Supabase Postgres (running via Docker Compose),
// - password hashing and JWT signing with node:crypto,
// - one async task-port handler per port declared in src/Ports.gren.
//
// The Gren app is compiled separately (npm run build) into build/main.js.
// That file exports Gren.Main.init. Calling init starts the HTTP server.
//
// Every handler resolves with a value that matches the port's success type.
// A handler rejects with { code, message } to make the Task fail on the Gren
// side. Shared.dbError maps the code onto the matching HTTP error.

const { createHmac, randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const postgres = require("postgres");

const { Gren } = require("./build/main.js");

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://supabase_admin:postgres@127.0.0.1:54322/postgres";
const JWT_SECRET =
  process.env.JWT_SECRET || "grenite-realworld-dev-secret-change-me";
const TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60; // 60 days

const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});
const scryptAsync = promisify(scrypt);

// -- Coded rejections ---------------------------------------------------------

const articleNotFound = () => ({
  code: "article-not-found",
  message: "article not found",
});
const commentNotFound = () => ({
  code: "comment-not-found",
  message: "comment not found",
});
const profileNotFound = () => ({
  code: "profile-not-found",
  message: "profile not found",
});
const articleForbidden = () => ({
  code: "article-forbidden",
  message: "only the author may modify this article",
});
const commentForbidden = () => ({
  code: "comment-forbidden",
  message: "only the author may delete this comment",
});
const emailTaken = () => ({
  code: "email-taken",
  message: "email has already been taken",
});
const usernameTaken = () => ({
  code: "username-taken",
  message: "username has already been taken",
});

// -- Startup ------------------------------------------------------------------

async function start() {
  await connectWithRetry();
  await applySchema();
  registerPorts();
  console.log(`RealWorld API ready. Database: ${DATABASE_URL}`);
}

async function connectWithRetry() {
  const attempts = 15;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      if (attempt === attempts) {
        console.error(
          `Cannot reach Postgres at ${DATABASE_URL}: ${err.message}`,
        );
        console.error('Did you run "npm run db:up"?');
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function applySchema() {
  const schemaPath = path.join(__dirname, "db", "schema.sql");
  await sql.unsafe(readFileSync(schemaPath, "utf8"));
}

// -- Crypto: scrypt password hashing ------------------------------------------

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword({ password, hash }) {
  const [scheme, saltHex, expectedHex] = String(hash).split("$");
  if (scheme !== "scrypt" || !saltHex || !expectedHex) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await scryptAsync(
    password,
    Buffer.from(saltHex, "hex"),
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// -- Crypto: HS256 JWT ---------------------------------------------------------

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function createToken({ userId, email, username }) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      sub: String(userId),
      email,
      username,
      iat: issuedAt,
      exp: issuedAt + TOKEN_TTL_SECONDS,
    }),
  );
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function verifyToken(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const userId = Number(claims.sub);
  if (!Number.isInteger(userId) || typeof claims.exp !== "number") {
    return null;
  }
  if (Date.now() / 1000 >= claims.exp) {
    return null;
  }
  return { userId };
}

// -- Users ---------------------------------------------------------------------

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    bio: row.bio,
    image: row.image,
  };
}

async function findUserById(id) {
  const rows = await sql`SELECT id, email, username, bio, image FROM users WHERE id = ${id}`;
  return rows.length === 0 ? null : rowToUser(rows[0]);
}

async function findUserByEmail(email) {
  const rows = await sql`
    SELECT id, email, username, bio, image, password_hash
    FROM users WHERE email = ${email}
  `;
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  return { ...rowToUser(row), passwordHash: row.password_hash };
}

async function insertUser({ username, email, passwordHash }) {
  try {
    const rows = await sql`
      INSERT INTO users (username, email, password_hash)
      VALUES (${username}, ${email}, ${passwordHash})
      RETURNING id
    `;
    return findUserById(rows[0].id);
  } catch (err) {
    if (/users_email_key/.test(String(err.message))) {
      throw emailTaken();
    }
    if (/users_username_key/.test(String(err.message))) {
      throw usernameTaken();
    }
    throw err;
  }
}

async function updateUser({ userId, patches }) {
  const allowed = new Set(["username", "email", "password_hash", "bio", "image"]);
  const assignments = [];
  for (const patch of patches) {
    const field = patch.field === "passwordHash" ? "password_hash" : patch.field;
    if (allowed.has(field)) {
      assignments.push([field, patch.value === null ? null : patch.value]);
    }
  }
  if (assignments.length > 0) {
    const setClause = assignments
      .map(([column, value]) => sql`${sql(column)} = ${value}`)
      .reduce((left, right) => sql`${left}, ${right}`);
    try {
      await sql`UPDATE users SET ${setClause} WHERE id = ${userId}`;
    } catch (err) {
      if (/users_email_key/.test(String(err.message))) {
        throw emailTaken();
      }
      if (/users_username_key/.test(String(err.message))) {
        throw usernameTaken();
      }
      throw err;
    }
  }
  return findUserById(userId);
}

// -- Profiles -------------------------------------------------------------------

async function getProfile({ username, viewerId }) {
  const viewer = viewerId === null || viewerId === undefined ? null : viewerId;
  const rows = await sql`
    SELECT u.username, u.bio, u.image,
      EXISTS(
        SELECT 1 FROM follows f
        WHERE f.follower_id = ${viewer} AND f.followee_id = u.id
      ) AS following
    FROM users u
    WHERE u.username = ${username}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  return {
    username: row.username,
    bio: row.bio,
    image: row.image,
    following: row.following,
  };
}

async function followUser({ username, viewerId }) {
  const rows = await sql`SELECT id FROM users WHERE username = ${username}`;
  if (rows.length === 0) {
    throw profileNotFound();
  }
  await sql`
    INSERT INTO follows (follower_id, followee_id)
    VALUES (${viewerId}, ${rows[0].id})
    ON CONFLICT DO NOTHING
  `;
  return getProfile({ username, viewerId });
}

async function unfollowUser({ username, viewerId }) {
  const rows = await sql`SELECT id FROM users WHERE username = ${username}`;
  if (rows.length === 0) {
    throw profileNotFound();
  }
  await sql`
    DELETE FROM follows WHERE follower_id = ${viewerId} AND followee_id = ${rows[0].id}
  `;
  return getProfile({ username, viewerId });
}

// -- Articles ---------------------------------------------------------------------

function toIso(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function slugify(title) {
  const base = String(title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "article";
}

// Find a slug not used by any other article. Duplicate titles get -2, -3, ...
// `excludeId` lets an article keep its own slug when the title did not change.
async function uniqueSlug(db, title, excludeId) {
  const base = slugify(title);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const rows = await db`
      SELECT 1 FROM articles WHERE slug = ${candidate} AND id <> ${excludeId}
    `;
    if (rows.length === 0) {
      return candidate;
    }
  }
}

// The SELECT part shared by every article query. The viewer decides the
// favorited and author-following flags; a null viewer makes both false.
function articleSelect(viewer) {
  return sql`
    SELECT a.id, a.slug, a.title, a.description, a.body, a.created_at, a.updated_at,
      au.username AS author_username, au.bio AS author_bio, au.image AS author_image,
      EXISTS(
        SELECT 1 FROM follows f
        WHERE f.follower_id = ${viewer} AND f.followee_id = au.id
      ) AS author_following,
      (SELECT COUNT(*)::int FROM favorites fv WHERE fv.article_id = a.id) AS favorites_count,
      EXISTS(
        SELECT 1 FROM favorites fv2
        WHERE fv2.article_id = a.id AND fv2.user_id = ${viewer}
      ) AS favorited
    FROM articles a
    JOIN users au ON au.id = a.author_id
  `;
}

function rowToProfile(row) {
  return {
    username: row.author_username,
    bio: row.author_bio,
    image: row.author_image,
    following: row.author_following,
  };
}

async function tagsFor(db, articleId) {
  const rows = await db`
    SELECT tag FROM article_tags WHERE article_id = ${articleId} ORDER BY position
  `;
  return rows.map((row) => row.tag);
}

async function withTags(db, row, { includeBody }) {
  const article = {
    slug: row.slug,
    title: row.title,
    description: row.description,
    tagList: await tagsFor(db, row.id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    favorited: row.favorited,
    favoritesCount: row.favorites_count,
    author: rowToProfile(row),
  };
  if (includeBody) {
    return { ...article, body: row.body };
  }
  return article;
}

async function getArticle({ slug, viewerId }) {
  const viewer = viewerId === null || viewerId === undefined ? null : viewerId;
  const rows = await sql`${articleSelect(viewer)} WHERE a.slug = ${slug} LIMIT 1`;
  if (rows.length === 0) {
    return null;
  }
  return withTags(sql, rows[0], { includeBody: true });
}

// Insert tags in order, dropping duplicates so the primary key holds.
async function insertTags(db, articleId, tagList) {
  const seen = new Set();
  let position = 0;
  for (const tag of tagList) {
    if (seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    await db`
      INSERT INTO article_tags (article_id, tag, position)
      VALUES (${articleId}, ${tag}, ${position})
    `;
    position += 1;
  }
}

async function insertArticle({ authorId, title, description, body, tagList }) {
  const slug = await uniqueSlug(sql, title, 0);
  const rows = await sql`
    INSERT INTO articles (slug, title, description, body, author_id)
    VALUES (${slug}, ${title}, ${description}, ${body}, ${authorId})
    RETURNING id
  `;
  await insertTags(sql, rows[0].id, tagList);
  return getArticle({ slug, viewerId: authorId });
}

async function listArticles(query) {
  const viewer = query.viewerId === null || query.viewerId === undefined ? null : query.viewerId;
  const conditions = [];
  if (query.tag) {
    conditions.push(sql`
      EXISTS(
        SELECT 1 FROM article_tags t
        WHERE t.article_id = a.id AND t.tag = ${query.tag}
      )
    `);
  }
  if (query.author) {
    conditions.push(sql`au.username = ${query.author}`);
  }
  if (query.favorited) {
    conditions.push(sql`
      EXISTS(
        SELECT 1 FROM favorites fv
        JOIN users fu ON fu.id = fv.user_id
        WHERE fv.article_id = a.id AND fu.username = ${query.favorited}
      )
    `);
  }
  // The filter fragment includes the WHERE keyword once any filter exists.
  const filterClause =
    conditions.length === 0
      ? sql``
      : sql` WHERE ${conditions.reduce((left, right) => sql`${left} AND ${right}`)}`;

  return runArticlePage(filterClause, viewer, query.limit, query.offset);
}

async function listFeed({ viewerId, limit, offset }) {
  const filterClause = sql`
    WHERE EXISTS(
      SELECT 1 FROM follows f
      WHERE f.follower_id = ${viewerId} AND f.followee_id = a.author_id
    )
  `;
  return runArticlePage(filterClause, viewerId, limit, offset);
}

async function runArticlePage(filterClause, viewer, limit, offset) {
  const rows = await sql`
    ${articleSelect(viewer)}
    ${filterClause}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const countRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM articles a
    JOIN users au ON au.id = a.author_id
    ${filterClause}
  `;
  const articles = [];
  for (const row of rows) {
    articles.push(await withTags(sql, row, { includeBody: false }));
  }
  return { articles, count: countRows[0].count };
}

async function updateArticle(update) {
  const { slug, requesterId, patches, tagList } = update;
  const newSlug = await sql.begin(async (tx) => {
    const existing = await tx`
      SELECT id, author_id, slug, title FROM articles WHERE slug = ${slug} FOR UPDATE
    `;
    if (existing.length === 0) {
      throw articleNotFound();
    }
    const article = existing[0];
    if (article.author_id !== requesterId) {
      throw articleForbidden();
    }

    const sets = {};
    for (const patch of patches) {
      if (["title", "description", "body"].includes(patch.field)) {
        sets[patch.field] = patch.value;
      }
    }
    if (sets.title !== undefined) {
      // The slug follows the title. Keeping the same title keeps the slug.
      sets.slug = await uniqueSlug(tx, sets.title, article.id);
    }
    sets.updated_at = sql`now()`;

    const setClause = Object.entries(sets)
      .map(([column, value]) => sql`${sql(column)} = ${value}`)
      .reduce((left, right) => sql`${left}, ${right}`);
    await tx`UPDATE articles SET ${setClause} WHERE id = ${article.id}`;

    if (tagList !== null && tagList !== undefined) {
      await tx`DELETE FROM article_tags WHERE article_id = ${article.id}`;
      await insertTags(tx, article.id, tagList);
    }
    return sets.slug !== undefined ? sets.slug : article.slug;
  });
  return getArticle({ slug: newSlug, viewerId: requesterId });
}

async function deleteArticle({ slug, requesterId }) {
  const rows = await sql`SELECT id, author_id FROM articles WHERE slug = ${slug}`;
  if (rows.length === 0) {
    throw articleNotFound();
  }
  if (rows[0].author_id !== requesterId) {
    throw articleForbidden();
  }
  await sql`DELETE FROM articles WHERE id = ${rows[0].id}`;
  return {};
}

async function favoriteArticle({ slug, viewerId }) {
  const rows = await sql`SELECT id FROM articles WHERE slug = ${slug}`;
  if (rows.length === 0) {
    throw articleNotFound();
  }
  await sql`
    INSERT INTO favorites (user_id, article_id)
    VALUES (${viewerId}, ${rows[0].id})
    ON CONFLICT DO NOTHING
  `;
  return getArticle({ slug, viewerId });
}

async function unfavoriteArticle({ slug, viewerId }) {
  const rows = await sql`SELECT id FROM articles WHERE slug = ${slug}`;
  if (rows.length === 0) {
    throw articleNotFound();
  }
  await sql`
    DELETE FROM favorites WHERE user_id = ${viewerId} AND article_id = ${rows[0].id}
  `;
  return getArticle({ slug, viewerId });
}

// -- Comments ------------------------------------------------------------------

function rowToComment(row) {
  return {
    id: row.id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    body: row.body,
    author: {
      username: row.author_username,
      bio: row.author_bio,
      image: row.author_image,
      following: row.author_following,
    },
  };
}

function commentSelect(viewer) {
  return sql`
    SELECT c.id, c.body, c.created_at, c.updated_at,
      u.username AS author_username, u.bio AS author_bio, u.image AS author_image,
      EXISTS(
        SELECT 1 FROM follows f
        WHERE f.follower_id = ${viewer} AND f.followee_id = u.id
      ) AS author_following
    FROM comments c
    JOIN users u ON u.id = c.author_id
  `;
}

async function insertComment({ slug, authorId, body }) {
  const articles = await sql`SELECT id FROM articles WHERE slug = ${slug}`;
  if (articles.length === 0) {
    throw articleNotFound();
  }
  const rows = await sql`
    INSERT INTO comments (article_id, author_id, body)
    VALUES (${articles[0].id}, ${authorId}, ${body})
    RETURNING id
  `;
  const comments = await sql`${commentSelect(authorId)} WHERE c.id = ${rows[0].id}`;
  return rowToComment(comments[0]);
}

async function listComments({ slug, viewerId }) {
  const viewer = viewerId === null || viewerId === undefined ? null : viewerId;
  const articles = await sql`SELECT id FROM articles WHERE slug = ${slug}`;
  if (articles.length === 0) {
    return null;
  }
  const rows = await sql`
    ${commentSelect(viewer)}
    WHERE c.article_id = ${articles[0].id}
    ORDER BY c.created_at ASC, c.id ASC
  `;
  return rows.map(rowToComment);
}

async function deleteComment({ slug, commentId, requesterId }) {
  const articles = await sql`SELECT id FROM articles WHERE slug = ${slug}`;
  if (articles.length === 0) {
    throw articleNotFound();
  }
  const rows = await sql`
    SELECT id, author_id FROM comments
    WHERE id = ${commentId} AND article_id = ${articles[0].id}
  `;
  if (rows.length === 0) {
    throw commentNotFound();
  }
  if (rows[0].author_id !== requesterId) {
    throw commentForbidden();
  }
  await sql`DELETE FROM comments WHERE id = ${commentId}`;
  return {};
}

// -- Tags ------------------------------------------------------------------------

async function listTags() {
  const rows = await sql`SELECT DISTINCT tag FROM article_tags ORDER BY tag`;
  return rows.map((row) => row.tag);
}

// -- Port registration ------------------------------------------------------------

function registerPorts() {
  Gren.Main.init({
    taskPorts: {
      hashPassword: async (password) => hashPassword(password),
      verifyPassword: async (credentials) => verifyPassword(credentials),
      createToken: async (claims) => createToken(claims),
      verifyToken: async (token) => verifyToken(token),

      insertUser: async (newUser) => insertUser(newUser),
      findUserByEmail: async (email) => findUserByEmail(email),
      findUserById: async (id) => findUserById(id),
      updateUser: async (update) => updateUser(update),

      getProfile: async (query) => getProfile(query),
      followUser: async (query) => followUser(query),
      unfollowUser: async (query) => unfollowUser(query),

      insertArticle: async (newArticle) => insertArticle(newArticle),
      getArticle: async (query) => getArticle(query),
      listArticles: async (query) => listArticles(query),
      listFeed: async (query) => listFeed(query),
      updateArticle: async (update) => updateArticle(update),
      deleteArticle: async (query) => deleteArticle(query),
      favoriteArticle: async (query) => favoriteArticle(query),
      unfavoriteArticle: async (query) => unfavoriteArticle(query),

      insertComment: async (newComment) => insertComment(newComment),
      listComments: async (query) => listComments(query),
      deleteComment: async (query) => deleteComment(query),

      listTags: async () => listTags(),
    },
  });
}

process.on("SIGINT", () => {
  sql.end({ timeout: 5 }).finally(() => process.exit(0));
});

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
