import type { DayRange, OutputFilters, OutputSort } from "../../db/queries.ts";
import { OUTPUTS_MAX_LIMIT } from "../../db/queries.ts";
import { CursorError, decodeCursor } from "../../outputs/cursor.ts";
import { serveMedia } from "../media.ts";
import { BodyError, json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";
import { WORKFLOW_KINDS } from "../../workflows/types.ts";

/**
 * A note is a sentence or two about a picture, not a document: long enough
 * for what went wrong and what to try, bounded because it lands in a row, a
 * sidecar and a search index.
 */
const NOTES_MAX = 2000;

/** All gallery filters travel as URL params, so a view is a link (§11.2). */
function filtersFrom(url: URL): OutputFilters {
  const models = url.searchParams.getAll("models")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const filters: OutputFilters = {};
  const workflow = url.searchParams.get("workflow");
  if (workflow) filters.workflow = workflow;
  const kind = url.searchParams.get("kind");
  if (kind) {
    if (!(WORKFLOW_KINDS as readonly string[]).includes(kind)) {
      throw new CursorError(`kind: expected ${WORKFLOW_KINDS.join(", ")}`);
    }
    filters.kind = kind;
  }
  if (models.length > 0) filters.models = models;
  const q = url.searchParams.get("q");
  if (q && q.trim().length > 0) filters.q = q;
  // The origin block (§6.2). Exact matches: a project is a name the caller
  // already knows, not something to search for. No screen offers these yet —
  // they are here for the API and the MCP bridge's `search_gallery`.
  const project = url.searchParams.get("project");
  if (project && project.trim().length > 0) filters.project = project.trim();
  const source = url.searchParams.get("source");
  if (source && source.trim().length > 0) filters.source = source.trim();
  return filters;
}

function sortFrom(url: URL): OutputSort {
  const sort = url.searchParams.get("sort") ?? "newest";
  if (sort !== "newest" && sort !== "oldest") {
    throw new CursorError("sort: expected newest or oldest");
  }
  return sort;
}

function limitFrom(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (!raw) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > OUTPUTS_MAX_LIMIT) {
    throw new CursorError(`limit: expected 1 to ${OUTPUTS_MAX_LIMIT}`);
  }
  return limit;
}

/**
 * `?dates=2026-09-05,2026-09-04` with the client's `tz_offset` in minutes
 * (what `Date.prototype.getTimezoneOffset()` returns), so the counts line up
 * with the dividers the client drew from local time.
 */
function dayRangesFrom(url: URL): DayRange[] {
  const dates = url.searchParams.getAll("dates")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const rawOffset = Number(url.searchParams.get("tz_offset") ?? "0");
  if (!Number.isFinite(rawOffset) || Math.abs(rawOffset) > 900) {
    throw new CursorError(
      "tz_offset: expected minutes from getTimezoneOffset()",
    );
  }
  const offsetMs = rawOffset * 60_000;
  const day = 86_400_000;
  return dates.map((date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new CursorError(`dates: "${date}" is not YYYY-MM-DD`);
    }
    const midnightUtc = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(midnightUtc)) {
      throw new CursorError(`dates: "${date}" is not a date`);
    }
    const from = midnightUtc + offsetMs;
    return { date, from, to: from + day };
  });
}

export function outputRoutes(ctx: AppContext): Route[] {
  const store = ctx.outputs;
  return [
    {
      method: "GET",
      path: "/api/outputs",
      handler: (_req, { url }) => {
        const cursor = url.searchParams.get("cursor");
        return json(store.list({
          filters: filtersFrom(url),
          sort: sortFrom(url),
          limit: limitFrom(url),
          cursor: cursor ? decodeCursor(cursor) : null,
        }));
      },
    },
    {
      method: "GET",
      path: "/api/outputs/days",
      handler: (_req, { url }) =>
        json({ days: store.days(dayRangesFrom(url), filtersFrom(url)) }),
    },
    {
      method: "GET",
      path: "/api/outputs/count",
      handler: (_req, { url }) =>
        json({ count: store.count(filtersFrom(url)) }),
    },
    {
      method: "GET",
      path: "/api/outputs/:id",
      handler: async (_req, { params }) => json(await store.detail(params.id!)),
    },
    {
      // §6.2's note, the one thing about an output a person writes after the
      // fact. A PATCH rather than a POST because it edits the row it names,
      // and `notes` is the only field of it anyone may edit.
      method: "PATCH",
      path: "/api/outputs/:id",
      handler: async (req, { params }) => {
        const body = await readJson(req) as Record<string, unknown>;
        if (!("notes" in body)) {
          throw new BodyError("nothing to change: expected notes");
        }
        const notes = body.notes;
        if (notes !== null && typeof notes !== "string") {
          throw new BodyError("notes: expected a string or null");
        }
        if (typeof notes === "string" && notes.length > NOTES_MAX) {
          throw new BodyError(`notes: at most ${NOTES_MAX} characters`);
        }
        return json(await store.setNotes(params.id!, notes));
      },
    },
    {
      method: "GET",
      path: "/api/outputs/:id/lineage",
      handler: (_req, { params }) => json(store.lineage(params.id!)),
    },
    {
      method: "DELETE",
      path: "/api/outputs/:id",
      handler: (_req, { params }) => json(store.softDelete(params.id!)),
    },
    {
      method: "POST",
      path: "/api/outputs/:id/restore",
      handler: async (_req, { params }) =>
        json({ output: await store.restore(params.id!) }),
    },
    {
      method: "GET",
      path: "/api/media/*",
      handler: (req, { url }) =>
        serveMedia(req, ctx.paths, url.pathname.slice("/api/media/".length)),
    },
    {
      method: "HEAD",
      path: "/api/media/*",
      handler: (req, { url }) =>
        serveMedia(req, ctx.paths, url.pathname.slice("/api/media/".length)),
    },
  ];
}
