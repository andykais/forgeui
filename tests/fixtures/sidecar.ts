import {
  buildSidecar,
  type Sidecar,
  type SidecarInit,
} from "../../src/jobs/sidecar.ts";
import { serializeSidecar } from "../../src/jobs/sidecar.ts";
import { simpleImageGraph } from "./graphs.ts";

/**
 * A realistic sidecar (§6.2) with every block filled in, so tests can pin one
 * field without spelling out the rest.
 */
export function fixtureSidecar(
  overrides: Partial<SidecarInit> = {},
): Sidecar {
  const jobId = overrides.job_id ?? "01J8ZQ7T4V2A9K3M5N7P9R1ZM4T";
  const init: SidecarInit = {
    job_id: jobId,
    created_at: "2026-09-03T18:12:04Z",
    workflow: {
      id: "krea2",
      name: "Flux Krea 2",
      hash:
        "sha256:1ec5ff4a9f2c4b8d92c4f9d1e5a7b3c60f1d2e3a4b5c6d7e8f90123456789abc",
      family: "flux",
      kind: "image",
    },
    params: {
      prompt: "a granite bowl of figs, north light",
      negative: "",
      seed: 123456,
      steps: 28,
      cfg: 3.5,
      size: [1024, 1024],
      loras: [{
        name: "film-grain.safetensors",
        hash:
          "sha256:aa11bb22cc33dd44ee55ff6607788990a1b2c3d4e5f60718293a4b5c6d7e8f90",
        strength_model: 0.8,
        strength_clip: 0.8,
      }],
    },
    models: [{
      role: "checkpoint",
      name: "krea2.safetensors",
      hash:
        "sha256:99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa",
    }],
    api_graph: simpleImageGraph({ jobId, width: 1024, height: 1024 }),
    outputs: [{
      file: `${jobId}-0.png`,
      kind: "image",
      width: 1024,
      height: 1024,
    }],
    timing: { total_ms: 12034, nodes: { "3": 9800, "8": 1200 } },
    raw: null,
    ...overrides,
  };
  return buildSidecar(init);
}

export async function writeFixtureSidecar(
  path: string,
  overrides: Partial<SidecarInit> = {},
): Promise<Sidecar> {
  const sidecar = fixtureSidecar(overrides);
  await Deno.writeTextFile(path, serializeSidecar(sidecar));
  return sidecar;
}
