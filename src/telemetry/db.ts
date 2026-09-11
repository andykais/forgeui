import { Database } from "@db/sqlite";
import { applyPragmas, DATABASE_OPTIONS, type Migration } from "../db/db.ts";
import schemaSql from "./schema.sql" with { type: "text" };

/**
 * `telemetry.db` (§7.1): its own file, its own `user_version` chain, opened
 * through the same options as `app.db` because the driver truncates integers
 * above 2³¹ without `int64` — which is every `at` in here.
 */
export const TELEMETRY_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "telemetry schema", sql: schemaSql },
];

export const TELEMETRY_SCHEMA_VERSION: number =
  TELEMETRY_MIGRATIONS[TELEMETRY_MIGRATIONS.length - 1]?.version ?? 0;

/** Run every telemetry migration newer than the file's `user_version`. */
export function migrateTelemetry(db: Database): number {
  const row = db.prepare("PRAGMA user_version").value<[number]>();
  let version = row?.[0] ?? 0;
  for (const migration of TELEMETRY_MIGRATIONS) {
    if (migration.version <= version) continue;
    db.exec("BEGIN");
    try {
      // The same two shapes `app.db` migrations take: statements, or a step
      // SQL cannot express idempotently.
      if (migration.sql) db.exec(migration.sql);
      migration.apply?.(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `telemetry migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : error
        }`,
        { cause: error },
      );
    }
    version = migration.version;
  }
  return version;
}

export function openTelemetryDatabase(path: string): Database {
  const db = new Database(path, DATABASE_OPTIONS);
  try {
    applyPragmas(db);
    migrateTelemetry(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
