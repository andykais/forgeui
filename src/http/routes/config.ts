import type { Config } from "../../config/types.ts";
import { json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * §12: `GET /api/config` returns the effective `config.yaml` (after CLI
 * overrides); `PATCH` merges a partial document into the file. Settings has no
 * save button, so a PATCH is one field blur.
 *
 * With one exception: `import.civitai_token` never leaves this process. It is
 * a credential, and this route answers anything that can reach the port — the
 * browser, the MCP bridge an LLM drives, and whatever else is on a container's
 * published port. Keeping the token *safe on disk* is out of scope; not
 * handing it to every HTTP client is not the same problem, and is not.
 */

/**
 * What a set token reads as. Not a plausible key (those are hex), so a client
 * that echoes a whole config back cannot overwrite the real one with it.
 */
export const REDACTED_TOKEN = "(hidden)";

export function redact(config: Config): Config {
  if (config.import.civitai_token === null) return config;
  return {
    ...config,
    import: { ...config.import, civitai_token: REDACTED_TOKEN },
  };
}

/**
 * A PATCH that carries the redaction marker back is a client round-tripping
 * what it was given, not someone setting the token to "(hidden)". Dropped, so
 * the stored key survives it.
 */
function withoutEchoedToken(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const record = body as Record<string, unknown>;
  const section = record.import;
  if (typeof section !== "object" || section === null) return body;
  const importing = section as Record<string, unknown>;
  if (importing.civitai_token !== REDACTED_TOKEN) return body;
  const { civitai_token: _echoed, ...rest } = importing;
  return { ...record, import: rest };
}

export function configRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/config",
      handler: () => json(redact(ctx.config.config)),
    },
    {
      method: "PATCH",
      path: "/api/config",
      handler: async (req) =>
        json(
          redact(
            await ctx.config.patch(withoutEchoedToken(await readJson(req))),
          ),
        ),
    },
  ];
}
