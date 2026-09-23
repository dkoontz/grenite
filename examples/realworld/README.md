# RealWorld example

A Grenite server that implements the RealWorld backend API
(<https://docs.realworld.show/specifications/backend/introduction/>) and stores
its data in Supabase Postgres running via Docker. The official Hurl contract
suite passes in full: 13 files, 154 requests.

## How the pieces connect

1. `docker-compose.yml` runs Supabase's Postgres image (`supabase/postgres`).
   The app connects as `supabase_admin` on `127.0.0.1:54322`. A Docker volume
   keeps the data between runs.
2. `src/Ports.gren` declares 23 task ports with `port module`. Four cover
   crypto (scrypt hashing, HS256 tokens). The rest cover one database
   operation each. The types that cross the boundary, such as `Article` and
   `Profile`, live in the same module.
3. `npm run build` compiles the Gren app to `build/main.js`. That file exports
   `Gren.Main.init`. It does not start the server by itself.
4. `main.js` applies `db/schema.sql`, then calls `Gren.Main.init` and
   registers one async handler per port. Each handler rejects with
   `{ code, message }` on failure. `Shared.dbError` maps the code onto the
   matching HTTP response, such as 409 for a duplicate email.
5. The route modules in `src/` map each endpoint onto one or more ports.
   `Shared.gren` holds the shared error type, token parsing, query-parameter
   parsing, validation helpers, and the CORS headers.

The app owns authentication. Passwords are hashed with scrypt from
`node:crypto`, and the JWT is signed with HS256. Set `JWT_SECRET` before you
run this outside a local machine.

Gren decodes an absent JSON field and an explicit `null` differently, with
`Maybe (Maybe a)`. That distinction drives the RealWorld update rules: a null
bio becomes null, but a null username is rejected. A port argument cannot
carry that distinction, because both encode to JSON `null`. The `*Patch`
types solve this: an entry in `patches` means "change this field", and its
null `value` means "change it to null".

## Run it

Requirements: Docker, Gren 0.6.5, Node.js, and hurl for the tests.

```bash
npm install
npm run db:up     # start Supabase Postgres
npm run build     # compile the Gren app to build/main.js
npm start         # apply the schema, then listen on 0.0.0.0:3000
```

`npm run db:down` stops the container but keeps the data. `npm run db:clean`
also deletes the volume.

## Test it

```bash
brew install hurl   # once
npm test
```

`npm test` runs the files in `hurl/`. They come from the RealWorld repo
(<https://github.com/realworld-apps/realworld/tree/main/specs/api/hurl>) and
define the API contract. The default host is `http://localhost:3000`. Override
it with `HOST=http://localhost:8000 npm test`.

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
- The dev JWT secret ships in `main.js`. Set `JWT_SECRET` for any shared use.
- Unique slug generation checks the database one candidate at a time. A burst
  of identical titles could race it.
