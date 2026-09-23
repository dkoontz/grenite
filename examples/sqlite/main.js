"use strict";

// This file is the Node entry point. It owns everything Gren cannot do:
// open the SQLite database, and register the task port handlers.
//
// The Gren app is compiled separately (npm run build) into build/main.js.
// That file exports Gren.Main.init. Calling init starts the HTTP server.
//
// The taskPorts object maps each port declared in src/Ports.gren to an async
// function. Each function must return a Promise:
//   - Resolve with a value that matches the port's success type.
//   - Reject to make the Task fail on the Gren side. The rejection reason
//     arrives in Gren as a Json.Decode.Value.

const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { Gren } = require("./build/main.js");

// -- Database setup -----------------------------------------------------------

const dataDir = path.join(__dirname, "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "app.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    firstName TEXT NOT NULL,
    lastName  TEXT NOT NULL,
    email     TEXT NOT NULL UNIQUE
  )
`);

// Seed the table on first run.
const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get();
if (n === 0) {
  const seed = db.prepare(
    "INSERT INTO users (firstName, lastName, email) VALUES (?, ?, ?)",
  );
  seed.run("John", "Doe", "john.doe@example.com");
  seed.run("Jane", "Smith", "jane.smith@example.com");
}

// -- Task port handlers -------------------------------------------------------

const selectUser = db.prepare(
  "SELECT id, firstName, lastName, email FROM users WHERE id = ?",
);

function rowToUser(row) {
  return {
    id: Number(row.id),
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
  };
}

Gren.Main.init({
  taskPorts: {
    // listUsers : {} -> Task Value (Array User)
    listUsers: async () =>
      db
        .prepare(
          "SELECT id, firstName, lastName, email FROM users ORDER BY id",
        )
        .all()
        .map(rowToUser),

    // findUser : Int -> Task Value (Maybe User)
    // Resolve with null to produce Nothing on the Gren side.
    findUser: async (id) => {
      const row = selectUser.get(id);
      return row ? rowToUser(row) : null;
    },

    // insertUser : NewUser -> Task Value User
    // The record arrives as a plain object: { firstName, lastName, email }.
    // A UNIQUE constraint violation throws, which rejects the promise,
    // which fails the Task with the error message in Gren.
    insertUser: async (newUser) => {
      const result = db
        .prepare(
          "INSERT INTO users (firstName, lastName, email) VALUES (?, ?, ?)",
        )
        .run(newUser.firstName, newUser.lastName, newUser.email);

      const row = selectUser.get(result.lastInsertRowid);
      return rowToUser(row);
    },

    // deleteUser : Int -> Task Value Int
    // Resolve with the number of deleted rows.
    deleteUser: async (id) => {
      const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
      return Number(result.changes);
    },
  },
});
