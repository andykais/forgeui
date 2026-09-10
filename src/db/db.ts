import { Database } from "@db/sqlite";
import schemaSql from "./schema.sql" with { type: "text" };

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only list, keyed by `PRAGMA user_version`. Version 1 is
 * `schema.sql`; later versions add their own statements.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial schema", sql: schemaSql },
  {
    version: 2,
    name: "model_probes",
    // Also in schema.sql, so a fresh database gets it from version 1 and
    // this is a no-op there; an existing one gets it here.
    sql: `
      CREATE TABLE IF NOT EXISTS model_probes (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL, mtime INTEGER NOT NULL,
        arch TEXT,
        probed_at INTEGER NOT NULL
      );
    `,
  },
];

export const SCHEMA_VERSION: number =
  MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Every database this app opens must be opened with these options. `int64` is
 * load-bearing rather than an optimisation: without it the driver binds
 * integers through a 32-bit path and silently truncates anything larger, which
 * is every `created_at` in §7 (epoch milliseconds passed 2³¹ in 1971). Values
 * still come back as plain numbers while they fit in a double.
 */
export const DATABASE_OPTIONS = { int64: true } as const;

/** Production pragmas; tests open databases through the same function. */
export function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
}

export function schemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").value<[number]>();
  return row?.[0] ?? 0;
}

/** Run every migration newer than the file's `user_version`. */
export function migrate(db: Database): number {
  let version = schemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : error
        }`,
        { cause: error },
      );
    }
    version = migration.version;
  }
  return version;
}

/** Open `app.db` in WAL mode and bring it up to `SCHEMA_VERSION`. */
export function openDatabase(path: string): Database {
  const db = new Database(path, DATABASE_OPTIONS);
  try {
    applyPragmas(db);
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
