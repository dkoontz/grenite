# SQLite example

A Grenite server that stores users in SQLite. The Gren side talks to the
database with task ports. No npm packages are needed. The example uses the
built-in `node:sqlite` module of Node.js 22.5 or newer.

## How the pieces connect

1. `src/Ports.gren` declares the four task ports with `port module`. Each port
   is a function that returns a `Task`. The types that cross the boundary,
   `User` and `NewUser`, live in the same module.
2. `npm run build` compiles the Gren app to `build/main.js`. That file exports
   `Gren.Main.init`. It does not start the server by itself.
3. `main.js` opens the database in `data/app.db`, creates the schema, and
   seeds two rows when the table is empty. It then calls
   `Gren.Main.init({ taskPorts: ... })` and registers one async handler per
   port. The handler name must match the port name.
4. The route handlers in `src/UserApi.gren` call the port functions from
   `src/Ports.gren` directly. When a handler resolves, the Task on the Gren
   side succeeds with the resolved value. When the handler rejects, the Task
   fails with the error as a `Json.Decode.Value`. The `fromDbError` function
   reads the `message` field from that value.

## Run it

```bash
npm run build
npm start
```

The server listens on `0.0.0.0:3000`. The file `data/app.db` keeps its data
between runs. Run `npm run clean` to delete the build output and the database.

## Endpoints

| Method | Path         | Result                                             |
| ------ | ------------ | -------------------------------------------------- |
| GET    | `/users`     | 200 with all users as a JSON array                 |
| GET    | `/user/:id`  | 200 with one user, or 404 when the id is unknown   |
| POST   | `/user`      | 201 with the created user                          |
| POST   | `/user`      | 422 when a field is empty                          |
| POST   | `/user`      | 500 when the email breaks the UNIQUE constraint    |
| DELETE | `/user/:id`  | 204 after a delete, or 404 when the id is unknown  |

Try it:

```bash
curl http://localhost:3000/users
curl http://localhost:3000/user/1
curl -X POST http://localhost:3000/user \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com"}'
curl -X DELETE http://localhost:3000/user/1
```
