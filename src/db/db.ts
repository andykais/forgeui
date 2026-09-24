import { Database } from "./sqlite.ts";
import schemaSql from "./schema.sql" with { type: "text" };

export interface Migration {
  version: number;
  name: string;
  sql?: string;
  /**
   * For a step SQL cannot express idempotently. `ADD COLUMN` has no
   * `IF NOT EXISTS`, and every migration also has to be a no-op on a fresh
   * database, which gets the whole of `schema.sql` as version 1.
   */
  apply?: (db: Database) => void;
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
  {
    version: 3,
    name: "per-model strength range",
    // Also in schema.sql, so a fresh database already has these and this does
    // nothing; an existing one gets them here. NULL means the default range,
    // so nothing has to be backfilled.
    apply: (db) => {
      const present = new Set(
        db.prepare("PRAGMA table_info(models)")
          .values<[number, string]>()
          .map(([, name]) => name),
      );
      for (const column of ["strength_min", "strength_max"]) {
        if (present.has(column)) continue;
        db.exec(`ALTER TABLE models ADD COLUMN ${column} REAL`);
      }
    },
  },
  {
    version: 4,
    name: "probe detector version",
    // Existing rows get 0, older than every real detector version, so the
    // next scan re-reads them — which is the point: a family added after a
    // file was probed never reached that file otherwise (§6).
    apply: (db) => {
      const present = new Set(
        db.prepare("PRAGMA table_info(model_probes)")
          .values<[number, string]>()
          .map(([, name]) => name),
      );
      if (!present.has("detector")) {
        db.exec(
          "ALTER TABLE model_probes ADD COLUMN detector INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    version: 5,
    name: "per-file hashes and hidden models",
    // Both are in schema.sql, so a fresh database has them from version 1 and
    // this does nothing there. `model_files` is backfilled from `models`, so
    // an existing library is not re-hashed wholesale — only the paths that
    // never won their hash, which are the ones that were looping.
    apply: (db) => {
      const columns = new Set(
        db.prepare("PRAGMA table_info(models)")
          .values<[number, string]>()
          .map(([, name]) => name),
      );
      if (!columns.has("hidden")) {
        db.exec(
          "ALTER TABLE models ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
        );
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_files (
          path TEXT PRIMARY KEY,
          size INTEGER NOT NULL, mtime INTEGER NOT NULL,
          hash TEXT NOT NULL,
          hashed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS model_files_hash ON model_files(hash);
        INSERT OR IGNORE INTO model_files (path, size, mtime, hash, hashed_at)
          SELECT path, size, mtime, hash, last_seen_at FROM models;
      `);
    },
  },
  {
    version: 6,
    name: "input duration",
    // Audio inputs have a length and no dimensions (DESIGN-AUDIO §5). Also
    // in schema.sql, so a fresh database gets it at version 1 and this does
    // nothing there; NULL means "not measured", which every existing row is.
    apply: (db) => {
      const present = new Set(
        db.prepare("PRAGMA table_info(inputs)")
          .values<[number, string]>()
          .map(([, name]) => name),
      );
      if (!present.has("duration_ms")) {
        db.exec("ALTER TABLE inputs ADD COLUMN duration_ms INTEGER");
      }
    },
  },
  {
    version: 7,
    name: "output tone",
    // What a take was asked to sound like, which colours its waveform and
    // captions its tile (DESIGN-AUDIO §11.5). Also in schema.sql, so a fresh
    // database gets it at version 1 and this does nothing there. NULL is
    // "no tone", which every existing row is and every image always will be
    // — `deno task reindex` fills it in for the takes whose workflow says
    // where it lives.
    apply: (db) => {
      const present = new Set(
        db.prepare("PRAGMA table_info(outputs)")
          .values<[number, string]>()
          .map(([, name]) => name),
      );
      if (!present.has("tone")) {
        db.exec("ALTER TABLE outputs ADD COLUMN tone TEXT");
      }
    },
  },
  {
    version: 8,
    name: "job and output origin",
    // Who asked for a run and why (§6.2): `ui` for the app itself, or
    // `llm:<model>` from the MCP bridge. Also in schema.sql, so a fresh
    // database gets these at version 1 and this does nothing there. NULL is
    // "unknown", which every existing row is and stays — an output made
    // before the block existed was not made by anything we can now name, and
    // backfilling it as `ui` would be inventing a fact. `reindex` fills in
    // what the sidecars of newer runs record.
    apply: (db) => {
      const columnsOf = (table: string) =>
        new Set(
          db.prepare(`PRAGMA table_info(${table})`)
            .values<[number, string]>()
            .map(([, name]) => name),
        );
      for (const table of ["jobs", "outputs"]) {
        const present = columnsOf(table);
        for (
          const column of ["origin_source", "origin_project", "origin_note"]
        ) {
          if (present.has(column)) continue;
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        }
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS outputs_project
           ON outputs(origin_project, created_at DESC)`,
      );
    },
  },
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
      if (migration.sql) db.exec(migration.sql);
      migration.apply?.(db);
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
