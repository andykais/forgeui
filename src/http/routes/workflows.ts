import { workflowUsage } from "../../db/queries.ts";
import { literalInputs } from "../../workflows/inputs.ts";
import type { Workflow } from "../../workflows/types.ts";
import { isRunnable } from "../../workflows/types.ts";
import { json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/** Shape of one row in the Workflows table and the workflow picker (§12). */
function summary(
  workflow: Workflow,
  usage: ReturnType<typeof workflowUsage>,
) {
  const manifest = workflow.manifest;
  const exposed = manifest?.params ?? [];
  return {
    id: workflow.id,
    name: manifest?.name ?? workflow.id,
    family: manifest?.family ?? null,
    kind: manifest?.kind ?? "image",
    category: manifest?.category ?? null,
    description: manifest?.description ?? null,
    source: workflow.source,
    has_user_copy: workflow.hasUserCopy,
    has_bundled: workflow.hasBundled,
    hash: workflow.hash,
    // The table lists exposed keys and counts the advanced ones (§11.2).
    params: {
      keys: exposed.filter((param) => !param.advanced).map((param) =>
        param.key
      ),
      advanced: exposed.filter((param) => param.advanced).length,
    },
    runnable: isRunnable(workflow),
    error: workflow.error,
    last_job_at: usage.get(workflow.id)?.last_job_at ?? null,
    last_output_id: usage.get(workflow.id)?.last_output_id ?? null,
    has_ui_json: workflow.uiGraph !== null,
  };
}

function detail(ctx: AppContext, workflow: Workflow) {
  const usage = workflowUsage(ctx.db);
  return {
    ...summary(workflow, usage),
    manifest: workflow.manifest,
    api_json: workflow.apiGraph,
    /** Rebuilt from the api graph when the workflow has no saved document. */
    ui_json: ctx.workflows.uiGraph(workflow),
  };
}

export function workflowRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/workflows",
      handler: () => {
        const usage = workflowUsage(ctx.db);
        return json({
          workflows: ctx.workflows.list().map((workflow) =>
            summary(workflow, usage)
          ),
        });
      },
    },
    {
      method: "POST",
      path: "/api/workflows",
      handler: async (req) => {
        const body = await readJson(req) as Record<string, unknown>;
        const workflow = await ctx.workflows.create(body);
        return json(detail(ctx, workflow), { status: 201 });
      },
    },
    {
      method: "GET",
      path: "/api/workflows/:id",
      handler: (_req, { params }) =>
        json(detail(ctx, ctx.workflows.require(params.id!))),
    },
    {
      method: "PUT",
      path: "/api/workflows/:id",
      handler: async (req, { params }) => {
        const body = await readJson(req) as Record<string, unknown>;
        const workflow = await ctx.workflows.save(params.id!, body);
        return json(detail(ctx, workflow));
      },
    },
    {
      method: "DELETE",
      path: "/api/workflows/:id",
      handler: async (_req, { params }) => {
        await ctx.workflows.remove(params.id!);
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "GET",
      path: "/api/workflows/:id/inputs",
      handler: (_req, { params }) => {
        const workflow = ctx.workflows.require(params.id!);
        return json({
          inputs: literalInputs(workflow.apiGraph, workflow.manifest),
        });
      },
    },
    {
      method: "POST",
      path: "/api/workflows/:id/duplicate",
      handler: async (_req, { params }) =>
        json(detail(ctx, await ctx.workflows.duplicate(params.id!)), {
          status: 201,
        }),
    },
    {
      method: "POST",
      path: "/api/workflows/:id/reset",
      handler: async (_req, { params }) =>
        json(detail(ctx, await ctx.workflows.reset(params.id!))),
    },
  ];
}
