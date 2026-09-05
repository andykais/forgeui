import { join, resolve } from "@std/path";

/** Every path the app owns inside `<appdata>` (DESIGN.md §3). */
export interface DataPaths {
  root: string;
  db: string;
  configFile: string;
  extraModelPaths: string;
  workflows: string;
  bundledWorkflows: string;
  userWorkflows: string;
  outputs: string;
  inputs: string;
  samples: string;
  modelsMeta: string;
  staging: string;
  comfyInput: string;
}

export function dataPaths(root: string): DataPaths {
  const abs = resolve(root);
  return {
    root: abs,
    db: join(abs, "app.db"),
    configFile: join(abs, "config.yaml"),
    extraModelPaths: join(abs, "extra_model_paths.yaml"),
    workflows: join(abs, "workflows"),
    bundledWorkflows: join(abs, "workflows", "bundled"),
    userWorkflows: join(abs, "workflows", "user"),
    outputs: join(abs, "outputs"),
    inputs: join(abs, "inputs"),
    samples: join(abs, "samples"),
    modelsMeta: join(abs, "models-meta"),
    staging: join(abs, "staging"),
    comfyInput: join(abs, "comfy-input"),
  };
}

export async function ensureDataDirs(paths: DataPaths): Promise<void> {
  for (
    const dir of [
      paths.root,
      paths.bundledWorkflows,
      paths.userWorkflows,
      paths.outputs,
      paths.inputs,
      paths.samples,
      paths.modelsMeta,
      paths.staging,
      paths.comfyInput,
    ]
  ) {
    await Deno.mkdir(dir, { recursive: true });
  }
}
