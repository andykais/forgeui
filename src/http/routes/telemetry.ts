import { CursorError } from "../../outputs/cursor.ts";
import {
  decodeEntryCursor,
  ENTRIES_MAX_LIMIT,
  type TelemetryFilters,
} from "../../telemetry/queries.ts";
import { reportDef } from "../../telemetry/reports.ts";
import { json, notFound } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * The telemetry reports (§12): the catalogue, one series per report for the
 * graph, and a keyset-paginated page of entries for the table. Read-only —
 * nothing here writes, and these routes are the one part of the API the
 * `api_requests` report does not record (§7.1).
 */

function values(url: URL, key: string): string[] {
  return url.searchParams.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Only the filters the report declares are read, so a param that belongs to
 * another report cannot quietly narrow this one.
 */
function filtersFrom(url: URL, report: string): TelemetryFilters {
  const def = reportDef(report);
  if (!def) return {};
  const filters: TelemetryFilters = {};
  for (const filter of def.filters) {
    if (filter.kind === "min") {
      const raw = url.searchParams.get(filter.key);
      if (raw === null || raw.trim().length === 0) continue;
      const min = Number(raw);
      if (!Number.isFinite(min)) {
        throw new CursorError(`${filter.key}: expected a number`);
      }
      filters.min_value = min;
      continue;
    }
    const column = filter.column!;
    const picked = values(url, filter.key);
    if (picked.length === 0) continue;
    if (filter.numeric) {
      const numbers = picked.map((value) => {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          throw new CursorError(`${filter.key}: expected a number`);
        }
        return number;
      });
      filters[column] = numbers as never;
      continue;
    }
    filters[column] = picked as never;
  }
  return filters;
}

function limitFrom(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (!raw) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > ENTRIES_MAX_LIMIT) {
    throw new CursorError(`limit: expected 1 to ${ENTRIES_MAX_LIMIT}`);
  }
  return limit;
}

export function telemetryRoutes(ctx: AppContext): Route[] {
  const store = ctx.telemetry;
  return [
    {
      method: "GET",
      path: "/api/telemetry/reports",
      handler: () => json({ reports: store.catalogue(), bytes: store.bytes() }),
    },
    {
      method: "GET",
      path: "/api/telemetry/:report/series",
      handler: (_req, { params, url }) => {
        const report = params.report!;
        if (!reportDef(report)) return notFound(`no report "${report}"`);
        const filters = filtersFrom(url, report);
        const result = store.series(report, filters);
        // The graph fits everything it is given into the width it has
        // (§11.2), so the count it is about to draw comes with it. A report
        // that draws one line still answers with a list of one.
        return json({
          report,
          series: result.series,
          truncated: result.truncated,
          total: store.count(report, filters),
        });
      },
    },
    {
      method: "GET",
      path: "/api/telemetry/:report/entries",
      handler: (_req, { params, url }) => {
        const report = params.report!;
        if (!reportDef(report)) return notFound(`no report "${report}"`);
        const filters = filtersFrom(url, report);
        const cursorParam = url.searchParams.get("cursor");
        const page = store.entries(report, {
          filters,
          cursor: cursorParam ? decodeEntryCursor(cursorParam) : null,
          limit: limitFrom(url),
        });
        return json({ report, ...page });
      },
    },
  ];
}
