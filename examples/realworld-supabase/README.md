# RealWorld example

A Grenite server that implements the RealWorld backend API
(<https://docs.realworld.show/specifications/backend/introduction/>) and stores
its data in Supabase. The app talks to the Supabase HTTP API (PostgREST), so
it needs no task ports and no database driver. The official Hurl contract
suite passes in full: 13 files, 154 requests.

## How the pieces connect

1. `docker-compose.yml` runs two services:
   - `db`: Supabase's Postgres image (`supabase/postgres`).
   - `rest`: PostgREST (`postgrest/postgrest`). This is the component that
     serves `/rest/v1` on a hosted Supabase project.
2. `db/schema.sql` creates the tables, the PostgREST roles, and the SQL
   functions. `npm run db:prepare` applies the file with psql. Every
   statement is idempotent, so restarting never destroys data.
3. `npm run build` compiles the Gren app to `build/main.js`.
4. `npm start` runs `main.js`. That file holds one line of JavaScript: a
   compiled Gren node program exports `Gren.Main.init`, and one call starts
   the server. All logic lives in Gren.
5. `src/Supabase.gren` replaces the task ports of the older design. Each
   function builds one or more PostgREST requests:
   - Reads use table routes with `select` embeddings. The viewer decides the
     `following` and `favorited` flags: the request embeds the `follows` and
     `favorites` rows filtered to that viewer.
   - The `tag`, `author`, and `favorited` filters add `!inner` embeds, so
     they narrow the articles. The feed uses the `author_followers` computed
     relationship in the schema, because no foreign key joins articles to
     follows directly.
   - The `articlesCount` total comes from the `count_articles` function.
   - Writes that need logic run in SQL functions under `/rpc`: registration
     and login (bcrypt hashing with pgcrypto), tokens (HS256 signing and
     verification), user and article updates (patches, ownership checks,
     unique slugs), and following.
   - Simple writes post straight to table routes. A comment insert uses
     `Prefer: return=representation` with an embedded author, so one request
     returns the full response row.
6. The route modules in `src/` map each endpoint onto those functions.
   `Shared.gren` holds the error type, the token handling, query-parameter
   parsing, validation helpers, and the CORS headers. `Shared.supabaseError`
   maps a failed request onto the RealWorld HTTP response, such as 409 for a
   duplicate email.
7. To reach PostgREST, the handlers need an HTTP client permission. Grenite
   resolves this at startup: `Application.init` now receives an
   `InitContext` record with the Node environment, an
   `HttpClient.Permission`, and the process environment variables.

The app owns authentication. Passwords are hashed with bcrypt inside the
database (`crypt` and `gen_salt` from pgcrypto), and the JWT is signed with
HS256 inside the database. The signing key lives in `private.app_config`,
one table outside the schema PostgREST exposes. The `grenite_app` role that
PostgREST uses can read five user columns, never `password_hash`.

## Run it

Requirements: Docker, Gren 0.6.5, Node.js, and hurl for the tests.

```bash
npm install        # create package-lock.json (no runtime dependencies)
npm run db:up      # start Postgres and PostgREST
npm run db:prepare # apply db/schema.sql, then reload the PostgREST schema
npm run build      # compile the Gren app to build/main.js
npm start          # listen on 0.0.0.0:3000
```

`npm run db:down` stops the containers but keeps the data. `npm run
db:clean` also deletes the volume. Run `db:clean` once when you come from
the older ports-based version of this example: the password hashes changed
from scrypt to bcrypt.

Environment variables, all optional:

| Variable                 | Purpose                              | Default                  |
| ------------------------ | ------------------------------------ | ------------------------ |
| `SUPABASE_URL`           | PostgREST base URL                   | `http://127.0.0.1:3100` |
| `SUPABASE_API_KEY`       | `apikey` header value                | `local-dev-key`          |
| `SUPABASE_SERVICE_TOKEN` | `Authorization: Bearer` value        | not sent                 |

For a hosted Supabase project, set `SUPABASE_URL` to
`https://<ref>.supabase.co/rest/v1`, and pass the service role key as both
the API key and the service token. Apply `db/schema.sql` in the SQL editor
first. The local PostgREST sends no `Authorization` header, and a hosted
project requires one, so the token is optional only in Docker.

## Test it

```bash
brew install hurl   # once
npm test
```

`npm test` runs the files in `hurl/`. They come from the RealWorld repo
(<https://github.com/realworld-apps/realworld/tree/main/specs/api/hurl>) and
define the API contract. The default host is `http://localhost:3000`.
Override it with `HOST=http://localhost:8000 npm test`.

## Endpoints

| Method | Path                                 | Result                                        |
| ------ | ------------------------------------ | --------------------------------------------- |
| POST   | `/api/users`                         | 201 with the registered user and token        |
| POST   | `/api/users/login`                   | 200 with the user and token                   |
| GET    | `/api/user`                          | 200 with the current user                     |
| PUT    | `/api/user`                          | 200 with the updated user                     |
| GET    | `/api/profiles/:username`            | 200 with the profile                          |
| POST   | `/api/profiles/:username/follow`     | 200 with the profile, following true          |
| DELETE | `/api/profiles/:username/follow`     | 200 with the profile, following false         |
| GET    | `/api/articles`                      | 200 with articles, filtered and paginated     |
| GET    | `/api/articles/feed`                 | 200 with articles from followed authors       |
| GET    | `/api/articles/:slug`                | 200 with one article, or 404                  |
| POST   | `/api/articles`                      | 201 with the created article                  |
| PUT    | `/api/articles/:slug`                | 200 with the updated article                  |
| DELETE | `/api/articles/:slug`                | 204 after a delete by the author              |
| POST   | `/api/articles/:slug/comments`       | 201 with the created comment                  |
| GET    | `/api/articles/:slug/comments`       | 200 with the comments                         |
| DELETE | `/api/articles/:slug/comments/:id`   | 204 after a delete by the comment author      |
| POST   | `/api/articles/:slug/favorite`       | 200 with the article, favorited               |
| DELETE | `/api/articles/:slug/favorite`       | 200 with the article, unfavorited             |
| GET    | `/api/tags`                          | 200 with all tags in use                      |

List endpoints accept `tag`, `author`, `favorited`, `limit`, and `offset`.
They omit the article body. Each endpoint also answers an `OPTIONS` request
with CORS headers, so a browser frontend on another port works.

Try it:

```bash
curl -s -X POST http://localhost:3000/api/users \
  -H 'Content-Type: application/json' \
  -d '{"user":{"username":"jake","email":"jake@jake.jake","password":"jakejake"}}'
```

## Status codes

| Code | When                                                    |
| ---- | ------------------------------------------------------- |
| 401  | No token where one is required, or invalid credentials  |
| 403  | A user modifies an article or comment they do not own   |
| 404  | An unknown article, profile, comment, or route          |
| 409  | A username or email that already exists                 |
| 422  | A field that is blank, null, or too short               |

Errors use the RealWorld format, such as
`{"errors":{"username":["can't be blank"]}}`.

## Known gaps

- The framework answers malformed JSON bodies with its own 400 response, not
  the RealWorld error format.
- The token signature check inside `verify_token` compares strings, so it
  does not run in constant time.
- Reads that span two requests, such as favorite-then-read, are not atomic.
  A concurrent writer can change the article between the two calls.
- PostgREST runs without JWT authentication in Docker. Anything that can
  reach port 3100 can read and write the tables as `grenite_app`. Bind the
  port to localhost, as the compose file does.
