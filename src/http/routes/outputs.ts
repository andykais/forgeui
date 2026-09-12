import type { DayRange, OutputFilters, OutputSort } from "../../db/queries.ts";
import { OUTPUTS_MAX_LIMIT } from "../../db/queries.ts";
import { CursorError, decodeCursor } from "../../outputs/cursor.ts";
import { serveMedia } from "../media.ts";
import { json } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

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
    if (kind !== "image" && kind !== "video") {
      throw new CursorError("kind: expected image or video");
    }
    filters.kind = kind;
  }
  if (models.length > 0) filters.models = models;
  const q = url.searchParams.get("q");
  if (q && q.trim().length > 0) filters.q = q;
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
