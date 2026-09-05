import { ModelScanner } from "../../models/scan.ts";
import { json } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * Phase 1 exposes only what the pickers need (§M4): a read-only listing of
 * the configured folders. `GET /api/models` grows metadata, counts and hashes
 * in Phase 2.
 */
export function modelRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/models",
      handler: async (_req, { url }) => {
        const kind = url.searchParams.get("kind") ?? "loras";
        const q = url.searchParams.get("q") ?? "";
        const refresh = url.searchParams.get("refresh") === "1";
        const models = (await ctx.models.list(kind, { refresh }))
          .filter((model) => ModelScanner.matches(model, q));
        return json({
          kind,
          folders: ctx.config.config.model_folders[kind] ?? [],
          models,
        });
      },
    },
  ];
}
