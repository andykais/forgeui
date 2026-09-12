import { InputError, type StoredInput } from "../../inputs/store.ts";
import { BodyError, json, readJson } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * Input media (§9, §12). One endpoint, because there is one operation: get
 * these bytes into the store and tell me what to bind the param to. Where the
 * bytes came from — a file the user picked, something pasted out of the
 * clipboard, or an output of the app's own — changes only the provenance
 * recorded beside them.
 */

function view(input: StoredInput) {
  return {
    sha256: input.sha256,
    ext: input.ext,
    filename: input.filename,
    width: input.width,
    height: input.height,
    bytes: input.bytes,
    /** What the panel shows as a thumbnail, and the viewer as lineage. */
    url: `/api/media/${input.path}`,
    derived_from_output: input.derived_from_output,
  };
}

async function fileFrom(
  req: Request,
): Promise<{ bytes: Uint8Array; name: string }> {
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
    throw new BodyError("expected a `file` part holding the image");
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    // A pasted image has no name of its own, which is not an error.
    name: file.name || "pasted",
  };
}

export function inputRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/inputs",
      handler: async (req) => {
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.startsWith("multipart/form-data")) {
          const { bytes, name } = await fileFrom(req);
          const stored = await ctx.inputs.add(bytes, { originalName: name });
          return json(view(stored), { status: 201 });
        }
        // The other source is one of the app's own outputs, named rather
        // than uploaded: it is already on this disk, so sending it up to the
        // browser and back down again would be pure waste (§10).
        const body = await readJson(req) as Record<string, unknown>;
        const outputId = body.output_id;
        if (typeof outputId !== "string" || outputId.length === 0) {
          throw new BodyError(
            "expected a multipart upload or an `output_id` to adopt",
          );
        }
        return json(view(await ctx.inputs.adoptOutput(outputId)), {
          status: 201,
        });
      },
    },
    {
      method: "GET",
      path: "/api/inputs/:sha256",
      handler: (_req, { params }) => {
        const input = ctx.inputs.get(params.sha256!);
        if (!input) throw new InputError(`no input "${params.sha256}"`);
        return json(view(input));
      },
    },
  ];
}
