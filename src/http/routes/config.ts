import { json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * §12: `GET /api/config` returns the effective `config.yaml` (after CLI
 * overrides); `PATCH` merges a partial document into the file. Settings has no
 * save button, so a PATCH is one field blur.
 */
export function configRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/config",
      handler: () => json(ctx.config.config),
    },
    {
      method: "PATCH",
      path: "/api/config",
      handler: async (req) => json(await ctx.config.patch(await readJson(req))),
    },
  ];
}
