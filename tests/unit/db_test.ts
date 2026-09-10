import { Database } from "@db/sqlite";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  applyPragmas,
  DATABASE_OPTIONS,
  migrate,
  MIGRATIONS,
  openDatabase,
  SCHEMA_VERSION,
  schemaVersion,
} from "../../src/db/db.ts";

async function withDbDir(body: (path: string) => void | Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "forgeui-db-" });
  try {
    await body(join(dir, "app.db"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function names(db: Database, type: "table" | "index"): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .values<[string]>(type)
    .map(([name]) => name);
}

Deno.test("open creates the §7 schema in WAL mode", async () => {
  await withDbDir((path) => {
    const db = openDatabase(path);
    try {
      assertEquals(schemaVersion(db), SCHEMA_VERSION);
      assertEquals(db.prepare("PRAGMA journal_mode").value<[string]>(), [
        "wal",
      ]);
      assertEquals(
        names(db, "table").filter((n) => !n.startsWith("outputs_fts_")),
        [
          "inputs",
          "jobs",
          "model_probes",
          "models",
          "node_timings",
          "output_inputs",
          "output_models",
          "outputs",
          "outputs_fts",
          "samples",
        ],
      );
      assertEquals(names(db, "index"), [
        "output_models_model",
        "outputs_created",
        "outputs_workflow",
        "samples_model",
      ]);
    } finally {
      db.close();
    }
  });
});

Deno.test("migrations are idempotent across reopens", async () => {
  await withDbDir((path) => {
    const first = openDatabase(path);
    first.exec(
      `INSERT INTO jobs (id, status, params_json, api_graph_json, created_at)
       VALUES ('01J', 'queued', '{}', '{}', 1)`,
    );
    first.close();

    const second = openDatabase(path);
    try {
      assertEquals(migrate(second), SCHEMA_VERSION);
      assertEquals(
        second.prepare("SELECT count(*) FROM jobs").value<[number]>(),
        [1],
      );
    } finally {
      second.close();
    }
  });
});

Deno.test("a database from before the probes table gains it, keeping its rows", async () => {
  await withDbDir((path) => {
    // A version-1 database: the schema as it shipped, with no model_probes.
    const old = new Database(path, DATABASE_OPTIONS);
    old.exec(MIGRATIONS[0]!.sql);
    old.exec("DROP TABLE model_probes");
    old.exec("PRAGMA user_version = 1");
    old.exec(
      `INSERT INTO models (hash, path, kind, size, mtime, last_seen_at)
       VALUES ('abc', '/models/a.safetensors', 'checkpoints', 1, 1, 1)`,
    );
    old.close();

    const migrated = openDatabase(path);
    try {
      assertEquals(schemaVersion(migrated), SCHEMA_VERSION);
      assert(names(migrated, "table").includes("model_probes"));
      // The upgrade adds a table; it does not rebuild the library.
      assertEquals(
        migrated.prepare("SELECT count(*) FROM models").value<[number]>(),
        [1],
      );
      migrated.exec(
        `INSERT INTO model_probes (path, size, mtime, arch, probed_at)
         VALUES ('/models/a.safetensors', 1, 1, 'flux', 2)`,
      );
      assertEquals(
        migrated.prepare("SELECT arch FROM model_probes").value<[string]>(),
        ["flux"],
      );
    } finally {
      migrated.close();
    }
  });
});

Deno.test("full-text search over prompts works", async () => {
  await withDbDir((path) => {
    const db = openDatabase(path);
    try {
      db.exec(
        `INSERT INTO outputs (id, path, sidecar_path, kind, prompt, params_json, created_at)
         VALUES ('01J-0', 'outputs/2026/09/03/01J-0.png', 'outputs/2026/09/03/01J.json',
                 'image', 'a granite bowl of figs', '{}', 1)`,
      );
      db.exec(
        `INSERT INTO outputs_fts (rowid, prompt)
         SELECT rowid, prompt FROM outputs WHERE id = '01J-0'`,
      );
      const hits = db
        .prepare(
          `SELECT outputs.id FROM outputs_fts
           JOIN outputs ON outputs.rowid = outputs_fts.rowid
           WHERE outputs_fts MATCH ?`,
        )
        .values<[string]>("granite");
      assertEquals(hits, [["01J-0"]]);
    } finally {
      db.close();
    }
  });
});

Deno.test("a fresh in-memory database gets the same pragmas and schema", () => {
  const db = new Database(":memory:", DATABASE_OPTIONS);
  try {
    applyPragmas(db);
    migrate(db);
    assertEquals(schemaVersion(db), SCHEMA_VERSION);
    assert(names(db, "table").includes("node_timings"));
  } finally {
    db.close();
  }
});

Deno.test("millisecond timestamps survive a round-trip", async () => {
  await withDbDir((path) => {
    const db = openDatabase(path);
    try {
      // The driver has a 32-bit bind path that silently truncates; every
      // created_at in §7 is well past 2³¹, so this is worth pinning down.
      const now = Date.now();
      db.prepare(
        `INSERT INTO jobs (id, status, params_json, api_graph_json, created_at,
                           started_at, finished_at)
         VALUES ('01JTIME', 'done', '{}', '{}', ?, ?, ?)`,
      ).run(now, now + 1, now + 2);
      assertEquals(
        db.prepare(
          `SELECT created_at, started_at, finished_at FROM jobs WHERE id = '01JTIME'`,
        ).value<[number, number, number]>(),
        [now, now + 1, now + 2],
      );
      assertEquals(
        typeof db.prepare(`SELECT created_at FROM jobs`).value<[number]>()?.[0],
        "number",
      );
    } finally {
      db.close();
    }
  });
});

Deno.test("outputs survive a deleted workflow: no foreign keys point at one", async () => {
  await withDbDir((path) => {
    const db = openDatabase(path);
    try {
      const foreignKeys = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES%'`,
        )
        .values<[string]>();
      assertEquals(foreignKeys, []);
    } finally {
      db.close();
    }
  });
});
