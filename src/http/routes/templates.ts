import {
  type StoredTemplate,
  templateProblems,
} from "../../templates/store.ts";
import { json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * One template as the Templates screen and the Upscale action read it
 * (§4.8, §12): the file's own fields, plus what its workflow says about it
 * now — its name and family, and anything that no longer fits.
 */
function view(ctx: AppContext, template: StoredTemplate) {
  const workflow = ctx.workflows.get(template.workflow);
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    workflow: template.workflow,
    workflow_name: workflow?.manifest?.name ?? null,
    family: workflow?.manifest?.family ?? null,
    action: template.action,
    values: template.values,
    ask: template.ask,
    source: template.source,
    has_bundled: template.hasBundled,
    problems: templateProblems(template, ctx.workflows),
  };
}

export function templateRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/templates",
      handler: () =>
        json({
          templates: ctx.templates.list().map((template) =>
            view(ctx, template)
          ),
        }),
    },
    {
      method: "POST",
      path: "/api/templates",
      handler: async (req) => {
        const body = await readJson(req) as Record<string, unknown>;
        const template = await ctx.templates.create(body, ctx.workflows);
        return json(view(ctx, template), { status: 201 });
      },
    },
    {
      method: "GET",
      path: "/api/templates/:id",
      handler: (_req, { params }) =>
        json(view(ctx, ctx.templates.require(params.id!))),
    },
    {
      method: "PUT",
      path: "/api/templates/:id",
      handler: async (req, { params }) => {
        const body = await readJson(req) as Record<string, unknown>;
        const template = await ctx.templates.save(
          params.id!,
          body,
          ctx.workflows,
        );
        return json(view(ctx, template));
      },
    },
    {
      method: "DELETE",
      path: "/api/templates/:id",
      handler: async (_req, { params }) => {
        await ctx.templates.remove(params.id!);
        return new Response(null, { status: 204 });
      },
    },
  ];
}
