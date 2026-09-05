import { type JobStatus, listJobs } from "../../db/queries.ts";
import { JobRequestError } from "../../jobs/pipeline.ts";
import { json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

const STATUSES: JobStatus[] = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
];

/** `?status=active` means queued or running: what the queue strip shows. */
function statusFilter(value: string | null): JobStatus[] | undefined {
  if (!value || value === "all") return undefined;
  if (value === "active") return ["queued", "running"];
  const requested = value.split(",").map((entry) => entry.trim());
  const statuses = requested.filter((entry): entry is JobStatus =>
    (STATUSES as string[]).includes(entry)
  );
  if (statuses.length !== requested.length) {
    throw new JobRequestError(
      `status: expected active, all, or any of ${STATUSES.join(", ")}`,
    );
  }
  return statuses;
}

function limitFilter(value: string | null): number | undefined {
  if (!value) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new JobRequestError("limit: expected a positive integer");
  }
  return limit;
}

export function jobRoutes(ctx: AppContext): Route[] {
  const runner = ctx.jobs;
  return [
    {
      method: "GET",
      path: "/api/jobs",
      handler: (_req, { url }) => {
        const jobs = listJobs(ctx.db, {
          statuses: statusFilter(url.searchParams.get("status")),
          workflow_id: url.searchParams.get("workflow_id") ?? undefined,
          limit: limitFilter(url.searchParams.get("limit")),
        });
        return json({
          jobs: jobs.map((job) => runner.jobWithOutputs(job.id)),
        });
      },
    },
    {
      method: "POST",
      path: "/api/jobs",
      handler: async (req) => {
        const body = await readJson(req) as Record<string, unknown>;
        return json(await runner.submit(body), { status: 201 });
      },
    },
    {
      method: "POST",
      path: "/api/jobs/rerun",
      handler: async (req) => {
        const body = await readJson(req) as Record<string, unknown>;
        return json(await runner.rerun(body), { status: 201 });
      },
    },
    {
      method: "POST",
      path: "/api/jobs/clear",
      handler: async () => json({ cancelled: await runner.clearQueue() }),
    },
    {
      method: "POST",
      path: "/api/jobs/:id/cancel",
      handler: async (_req, { params }) =>
        json(await runner.cancel(params.id!)),
    },
    {
      method: "GET",
      path: "/api/jobs/:id",
      handler: (_req, { params }) => json(runner.jobWithOutputs(params.id!)),
    },
  ];
}
