import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildOutputsWhere,
  ftsMatchQuery,
  listOutputs,
} from "../../src/db/queries.ts";
import {
  CursorError,
  decodeCursor,
  encodeCursor,
} from "../../src/outputs/cursor.ts";
import { mediaUrl } from "../../src/outputs/store.ts";
import { MediaPathError, resolveMediaPath } from "../../src/http/media.ts";
import { dataPaths } from "../../src/config/paths.ts";
import { Database } from "@db/sqlite";
import { applyPragmas, DATABASE_OPTIONS, migrate } from "../../src/db/db.ts";

Deno.test("cursors round-trip and reject anything else", () => {
  const cursor = { created_at: 1788577384416, id: "01JZM4T-0" };
  const encoded = encodeCursor(cursor);
  assertEquals(decodeCursor(encoded), cursor);
  // Opaque to the client: no separators to fiddle with.
  assertEquals(/^[A-Za-z0-9_-]+$/.test(encoded), true);

  for (const bad of ["", "!!!", encodeCursor({ created_at: 1, id: "" })]) {
    assertThrows(() => decodeCursor(bad), CursorError);
  }
  assertThrows(
    () => decodeCursor(btoa("notanumber:01J").replaceAll("=", "")),
    CursorError,
  );
});

Deno.test("search text becomes a safe FTS5 prefix query", () => {
  assertEquals(ftsMatchQuery("granite bowl"), '"granite"* "bowl"*');
  // Punctuation a user types must not be read as FTS operator syntax.
  assertEquals(
    ftsMatchQuery('figs OR "north light"'),
    '"figs"* "OR"* "north"* "light"*',
  );
  assertEquals(ftsMatchQuery("  "), null);
  assertEquals(ftsMatchQuery(""), null);
});

Deno.test("filters build the SQL the gallery needs", () => {
  assertEquals(buildOutputsWhere(), {
    sql: "outputs.deleted_at IS NULL",
    params: [],
  });

  const all = buildOutputsWhere({
    workflow: "krea2",
    kind: "image",
    models: ["sha256:aaa", "sha256:bbb"],
    q: "figs",
  });
  assertStringIncludes(all.sql, "outputs.workflow_id = ?");
  assertStringIncludes(all.sql, "outputs.kind = ?");
  assertStringIncludes(all.sql, "outputs_fts MATCH ?");
  // One EXISTS per model: selections are ANDed (§11.2).
  assertEquals(all.sql.match(/EXISTS/g)?.length, 2);
  assertEquals(all.params, [
    "krea2",
    "image",
    "sha256:aaa",
    "sha256:bbb",
    '"figs"*',
  ]);

  // Soft-deleted rows are only visible when asked for.
  assertEquals(
    buildOutputsWhere({ includeDeleted: true }).sql,
    "1",
  );
});

Deno.test("the keyset query is ordered and bounded", () => {
  const db = new Database(":memory:", DATABASE_OPTIONS);
  applyPragmas(db);
  migrate(db);
  try {
    const insert = db.prepare(
      `INSERT INTO outputs (id, path, sidecar_path, kind, params_json, created_at)
       VALUES (?, ?, ?, 'image', '{}', ?)`,
    );
    // Two rows share a timestamp, which is what the id half of the key is for.
    const rows: [string, number][] = [
      ["01A-0", 1000],
      ["01B-0", 2000],
      ["01C-0", 2000],
      ["01D-0", 3000],
    ];
    for (const [id, createdAt] of rows) {
      insert.run(id, `outputs/${id}.png`, "outputs/s.json", createdAt);
    }

    const newest = listOutputs(db, { limit: 2 });
    assertEquals(newest.map((row) => row.id), ["01D-0", "01C-0"]);
    const next = listOutputs(db, {
      limit: 2,
      cursor: { created_at: 2000, id: "01C-0" },
    });
    assertEquals(next.map((row) => row.id), ["01B-0", "01A-0"]);

    const oldest = listOutputs(db, { sort: "oldest", limit: 3 });
    assertEquals(oldest.map((row) => row.id), ["01A-0", "01B-0", "01C-0"]);
    assertEquals(
      listOutputs(db, {
        sort: "oldest",
        cursor: { created_at: 2000, id: "01B-0" },
      }).map((row) => row.id),
      ["01C-0", "01D-0"],
    );
  } finally {
    db.close();
  }
});

Deno.test("media paths stay inside the data dir", () => {
  const paths = dataPaths("/home/nt/.forgeui");
  assertEquals(
    resolveMediaPath(paths, "outputs/2026/09/05/01J-0.png"),
    "/home/nt/.forgeui/outputs/2026/09/05/01J-0.png",
  );
  assertEquals(
    resolveMediaPath(paths, "inputs/ab/abc.png"),
    "/home/nt/.forgeui/inputs/ab/abc.png",
  );

  for (
    const bad of [
      "../config.yaml",
      "outputs/../../etc/passwd",
      "app.db",
      "workflows/user/krea2/manifest.json",
      "/etc/passwd",
      "outputs/../inputs/../../secret",
    ]
  ) {
    assertThrows(
      () => resolveMediaPath(paths, bad),
      MediaPathError,
      undefined,
      bad,
    );
  }
});

Deno.test("media urls are built from the stored path", () => {
  assertEquals(
    mediaUrl("outputs/2026/09/05/01J-0.png"),
    "/api/media/outputs/2026/09/05/01J-0.png",
  );
});
