import { NotImplementedError, SampleError } from "../../samples/store.ts";
import { BodyError, json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * Samples (§8.3, §12). Phase 2 imports them two ways: a file dropped on the
 * model page, and Promote to sample on an output. The Civitai URL form is
 * Phase 3 and says so — a 501 is a better answer than a field that silently
 * does nothing.
 */

/** The multipart upload the drop zone sends. */
async function fileFrom(
  req: Request,
): Promise<{ bytes: Uint8Array; filename: string }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (cause) {
    throw new BodyError(
      `expected a multipart upload: ${
        cause instanceof Error ? cause.message : cause
      }`,
    );
  }
  const file = form.get("file") ?? form.get("image");
  if (!(file instanceof File)) {
    throw new BodyError("expected a `file` part holding the media");
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name || "sample",
  };
}

export function sampleRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/models/:hash/samples",
      handler: async (req, { params }) => {
        const model = ctx.models.require(params.hash!);
        if (model.hash === null) {
          throw new SampleError(
            `"${model.name}" is still being hashed; a sample needs a model to belong to`,
          );
        }
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.startsWith("multipart/form-data")) {
          const body = await readJson(req) as Record<string, unknown>;
          if (typeof body.civitai_url === "string") {
            throw new NotImplementedError(
              "importing a sample from a Civitai URL arrives in Phase 3",
            );
          }
          throw new BodyError("expected a multipart upload");
        }
        const { bytes, filename } = await fileFrom(req);
        const sample = await ctx.samples.import({
          modelHash: model.hash,
          bytes,
          filename,
        });
        return json(sample, { status: 201 });
      },
    },
    {
      method: "DELETE",
      path: "/api/samples/:id",
      handler: async (_req, { params }) =>
        json({ sample: await ctx.samples.remove(params.id!) }),
    },
    {
      method: "POST",
      path: "/api/outputs/:id/promote",
      handler: async (req, { params }) => {
        const body = await readJson(req) as Record<string, unknown>;
        const hashes = body.model_hashes;
        if (!Array.isArray(hashes) || hashes.length === 0) {
          throw new BodyError("model_hashes: expected a non-empty list");
        }
        for (const hash of hashes) {
          if (typeof hash !== "string") {
            throw new BodyError("model_hashes: expected a list of strings");
          }
        }
        const output = ctx.outputs.require(params.id!);
        return json(
          { samples: await ctx.samples.promote(output, hashes as string[]) },
          { status: 201 },
        );
      },
    },
  ];
}
