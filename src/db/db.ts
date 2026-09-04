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
];

export const SCHEMA_VERSION: number =
  MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

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
  const db = new Database(path);
  try {
    applyPragmas(db);
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
