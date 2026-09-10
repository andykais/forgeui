import { MODEL_CLASSES, type ModelClass } from "../../config/types.ts";
import { FAMILIES } from "../../workflows/types.ts";
import type { ModelPatch } from "../../models/library.ts";
import { BodyError, json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * The model library's read and edit surface (§12). A model is listed as soon
 * as it is scanned and can only be edited once it has a hash, which is why
 * `PATCH` answers 409 rather than 404 while the hasher is still behind.
 */

function optionalString(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BodyError(`${field}: expected a string or null`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readMetaPatch(body: Record<string, unknown>): ModelPatch {
  const patch: ModelPatch = {};
  const displayName = optionalString(body.display_name, "display_name");
  if (displayName !== undefined) patch.display_name = displayName;
  const notes = optionalString(body.notes, "notes");
  if (notes !== undefined) patch.notes = notes;

  if (body.family !== undefined) {
    const family = optionalString(body.family, "family");
    if (family !== null && family !== undefined && family !== "unset") {
      if (!(FAMILIES as readonly string[]).includes(family)) {
        throw new BodyError(
          `family: expected one of ${FAMILIES.join(", ")} or unset`,
        );
      }
    }
    // `unset` is how the UI spells "no family"; the row stores null (§8.1).
    patch.family = family === "unset" ? null : family;
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) throw new BodyError("tags: expected a list");
    const tags: string[] = [];
    for (const tag of body.tags) {
      if (typeof tag !== "string") {
        throw new BodyError("tags: expected a list of strings");
      }
      const trimmed = tag.trim();
      if (trimmed.length > 0 && !tags.includes(trimmed)) tags.push(trimmed);
    }
    patch.tags = tags;
  }

  // "Set as thumbnail" (§8.3); null goes back to the newest output.
  if (body.thumb_sample_id !== undefined) {
    if (
      body.thumb_sample_id !== null && typeof body.thumb_sample_id !== "string"
    ) {
      throw new BodyError("thumb_sample_id: expected a sample id or null");
    }
    patch.thumb_sample_id = body.thumb_sample_id;
  }

  if (Object.keys(patch).length === 0) {
    throw new BodyError(
      "nothing to change: expected display_name, family, notes, tags or thumb_sample_id",
    );
  }
  return patch;
}

export function modelRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/families",
      handler: () => {
        const workflows = new Map<string, number>();
        for (const workflow of ctx.workflows.list()) {
          const family = workflow.manifest?.family ?? "unset";
          workflows.set(family, (workflows.get(family) ?? 0) + 1);
        }
        return json({
          families: ctx.models.familyCounts().map((count) => ({
            ...count,
            workflows: workflows.get(count.family) ?? 0,
          })),
        });
      },
    },
    {
      method: "GET",
      path: "/api/models",
      handler: async (_req, { url }) => {
        const kind = url.searchParams.get("kind") ?? undefined;
        const raw = url.searchParams.get("class");
        if (
          raw !== null && !(MODEL_CLASSES as readonly string[]).includes(raw)
        ) {
          throw new BodyError(
            `class: expected one of ${MODEL_CLASSES.join(", ")}`,
          );
        }
        const modelClass = (raw ?? undefined) as ModelClass | undefined;
        // The scan is what makes a model visible, so a request that arrives
        // before the background pass reached this kind still answers with the
        // folder's contents rather than with nothing. Kinds already walked
        // are left alone, so this never re-reads the disk; a class asks for
        // every kind under it.
        const wanted = kind
          ? [kind]
          : modelClass
          ? ctx.models.kindsOfClass(modelClass)
          : [];
        for (const each of wanted) {
          if (!ctx.models.scanner.hasScanned(each)) {
            await ctx.models.scanner.list(each);
          }
        }
        return json({
          kind: kind ?? null,
          class: modelClass ?? null,
          folders: ctx.models.folders({ kind, class: modelClass }),
          models: ctx.models.list({
            kind,
            class: modelClass,
            family: url.searchParams.get("family") ?? undefined,
            q: url.searchParams.get("q") ?? undefined,
          }),
          progress: ctx.models.progress,
        });
      },
    },
    {
      method: "GET",
      path: "/api/models/:hash",
      handler: (_req, { params }) => json(ctx.models.require(params.hash!)),
    },
    {
      method: "PATCH",
      path: "/api/models/:hash",
      handler: async (req, { params }) => {
        const body = await readJson(req) as Record<string, unknown>;
        return json(ctx.models.patch(params.hash!, readMetaPatch(body)));
      },
    },
  ];
}
