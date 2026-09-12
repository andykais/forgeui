import { api } from "../api.ts";
import type { LoraRow, Manifest, Param, WorkflowDetail } from "../types.ts";
import { app } from "./app.svelte.ts";
import { plain } from "../lib/state.svelte.ts";

/**
 * The Generate param panel (§11.2, §11.3). Selecting a workflow fills the
 * panel from the most recent job for that workflow, falling back to manifest
 * defaults — the job history *is* the sticky-defaults store, there is no
 * separate one.
 */

export function defaultFor(param: Param): unknown {
  switch (param.type) {
    case "text":
      return (param.default as string) ?? "";
    case "int":
    case "float":
      return (param.default as number) ?? param.min ?? 0;
    case "bool":
      return (param.default as boolean) ?? false;
    case "enum":
      return (param.default as string) ?? param.options?.[0] ?? "";
    case "seed":
      return (param.default as number) ?? -1;
    case "size":
      return [...((param.default as [number, number]) ?? [1024, 1024])];
    case "model":
    case "text_encoder":
    case "vae":
      return (param.default as string) ?? "";
    case "lora_list":
      return ((param.default as LoraRow[]) ?? []).map((row) => ({ ...row }));
    default:
      return null;
  }
}

export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Reuse Parameters' mapping (§6.4): fill by key, keep manifest defaults for
 * keys the caller did not send, and report keys the manifest no longer has so
 * the panel can warn about them.
 */
export function fillValues(
  manifest: Manifest,
  params: Record<string, unknown>,
): { values: Record<string, unknown>; warnings: string[] } {
  const values: Record<string, unknown> = {};
  for (const param of manifest.params) {
    const provided = params[param.key];
    values[param.key] = provided === undefined
      ? defaultFor(param)
      : plain(provided);
  }
  const known = new Set(manifest.params.map((param) => param.key));
  return {
    values,
    warnings: Object.keys(params).filter((key) => !known.has(key)),
  };
}

class PanelState {
  workflowId = $state<string | null>(null);
  detail = $state<WorkflowDetail | null>(null);
  values = $state<Record<string, unknown>>({});
  /** Keys the last job had that this manifest no longer exposes (§6.4). */
  warnings = $state<string[]>([]);
  /** §11.3: 🔒 pins the field; unlocked means a fresh seed each run. */
  seedLocked = $state(false);
  /** The seed the last run actually used, shown greyed while unlocked. */
  lastSeed = $state<number | null>(null);
  submitting = $state(false);
  submitError = $state<string | null>(null);
  loading = $state(false);
  /**
   * Keys the user has edited since the current fill started. Filling the panel
   * from the last job is a round trip, and whatever was typed during it has to
   * survive.
   */
  #touched = new Set<string>();

  get manifest(): Manifest | null {
    return this.detail?.manifest ?? null;
  }

  get params(): Param[] {
    return this.manifest?.params ?? [];
  }

  get mainParams(): Param[] {
    return this.params.filter((param) => !param.advanced);
  }

  get advancedParams(): Param[] {
    return this.params.filter((param) => param.advanced);
  }

  /** §11.3: blocked while ComfyUI is away or a required param is empty. */
  get missingRequired(): string[] {
    return this.params
      .filter(
        (param) =>
          param.required && param.type !== "seed" &&
          isEmpty(this.values[param.key]),
      )
      .map((param) => param.label ?? param.key);
  }

  get canSubmit(): boolean {
    return (
      app.comfyReady &&
      this.manifest !== null &&
      this.detail?.runnable === true &&
      this.missingRequired.length === 0 &&
      !this.submitting
    );
  }

  async select(id: string): Promise<void> {
    if (this.workflowId === id && this.detail) return;
    this.workflowId = id;
    this.loading = true;
    this.submitError = null;
    this.#touched.clear();
    try {
      const detail = await api.workflow(id);
      this.detail = detail;
      const manifest = detail.manifest;
      if (!manifest) {
        this.values = {};
        return;
      }
      // The most recent job for this workflow is where the panel starts.
      const [last] = await api.jobs({ workflow_id: id, limit: 1 });
      this.#fill(manifest, last?.params ?? {});
      const seed = last?.params ? this.#seedOf(manifest, last.params) : null;
      this.lastSeed = seed;
      if (!this.seedLocked) this.#unlockSeed(manifest);
    } finally {
      this.loading = false;
    }
  }

  /** `Edit in Generate →`: fill by key, warn on keys that are gone (§6.4). */
  async editWith(id: string, params: Record<string, unknown>): Promise<void> {
    this.workflowId = id;
    this.loading = true;
    this.#touched.clear();
    try {
      const detail = await api.workflow(id);
      this.detail = detail;
      if (!detail.manifest) return;
      this.#fill(detail.manifest, params);
      const seed = this.#seedOf(detail.manifest, params);
      if (seed !== null && seed >= 0) {
        // Reusing parameters means reusing the seed, so it arrives locked.
        this.seedLocked = true;
        this.lastSeed = seed;
      }
    } finally {
      this.loading = false;
    }
  }

  #fill(manifest: Manifest, params: Record<string, unknown>): void {
    const filled = fillValues(manifest, params);
    // Anything typed while this was in flight wins over the stored value.
    for (const key of this.#touched) {
      if (key in this.values) filled.values[key] = this.values[key];
    }
    this.values = filled.values;
    this.warnings = filled.warnings;
  }

  #seedOf(manifest: Manifest, params: Record<string, unknown>): number | null {
    const seedParam = manifest.params.find((param) => param.type === "seed");
    if (!seedParam) return null;
    const value = params[seedParam.key];
    return typeof value === "number" && value >= 0 ? value : null;
  }

  #unlockSeed(manifest: Manifest): void {
    const seedParam = manifest.params.find((param) => param.type === "seed");
    if (seedParam) this.set(seedParam.key, -1);
  }

  set(key: string, value: unknown): void {
    this.#touched.add(key);
    this.values = { ...this.values, [key]: value };
  }

  /**
   * §11.2: manifest defaults for everything except text params and attached
   * inputs — what the user authored is kept.
   */
  resetToDefaults(): void {
    if (!this.manifest) return;
    this.#touched.clear();
    const values = { ...this.values };
    for (const param of this.manifest.params) {
      if (
        param.type === "text" ||
        param.type === "image" ||
        param.type === "mask" ||
        param.type === "video"
      ) {
        continue;
      }
      values[param.key] = defaultFor(param);
    }
    this.values = values;
    this.seedLocked = false;
  }

  /**
   * Upscale (§10): take one of the app's own outputs into the input store,
   * then fill this workflow from the run that made it.
   *
   * Upscaling is not a special case in the pipeline and is not one here
   * either — it is `editWith` with the picture attached. What makes it one
   * click is that the workflow already carries the numbers that matter: a
   * creativity of 0.4 and a scale of 2 are its manifest defaults, so nothing
   * has to be preset on the way in and both are there to be changed before
   * generating.
   */
  async upscale(
    workflowId: string,
    output: { id: string },
    sourceParams: Record<string, unknown>,
  ): Promise<void> {
    const media = await api.adoptOutput(output.id);
    const manifest = (await api.workflow(workflowId)).manifest;
    const imageKey = manifest?.params.find((param) => param.type === "image")?.key;
    if (!imageKey) {
      throw new Error(`"${workflowId}" has no image param to upscale into`);
    }
    // Only the keys this workflow actually has. `editWith` warns about the
    // rest, which is right when a workflow has changed under a saved run and
    // wrong here: an upscale workflow has no `size` because it takes that
    // from the picture, and saying so on every upscale is noise.
    const shared: Record<string, unknown> = {};
    for (const param of manifest?.params ?? []) {
      if (param.key in sourceParams) shared[param.key] = sourceParams[param.key];
    }
    // The picture last: it is the one thing the source run cannot supply.
    await this.editWith(workflowId, { ...shared, [imageKey]: media.filename });
  }

  // -------------------------------------------------------------- the LoRAs

  /** The `lora_list` param, if this workflow has one at all. */
  get loraParam(): Param | null {
    return this.params.find((param) => param.type === "lora_list") ?? null;
  }

  /**
   * Put one LoRA into the panel's list at a strength somebody already ran it
   * at (§11.2). A LoRA is only worth anything at the strength it was tuned
   * to, and that number is sitting in the metadata of the output you are
   * looking at — copying it out by hand is the kind of transcription the app
   * exists to avoid.
   *
   * Already in the list: its strengths are moved to these rather than a
   * second row of the same file being added, which ComfyUI would apply
   * twice. The return says which happened, so the caller can say so.
   */
  addLora(row: LoraRow): "added" | "updated" | null {
    const param = this.loraParam;
    if (!param) return null;
    const rows = (this.values[param.key] as LoraRow[] | undefined) ?? [];
    const at = rows.findIndex((existing) => existing.name === row.name);
    if (at < 0) {
      this.set(param.key, [...rows, { ...row }]);
      return "added";
    }
    const before = rows[at]!;
    if (
      before.strength_model === row.strength_model &&
      before.strength_clip === row.strength_clip
    ) {
      return "updated";
    }
    this.set(
      param.key,
      rows.map((existing, i) => i === at ? { ...row } : existing),
    );
    return "updated";
  }

  // --------------------------------------------------------------- the seed

  get seedParam(): Param | null {
    return this.params.find((param) => param.type === "seed") ?? null;
  }

  /** 🎲 re-rolls immediately, in either state (§11.3). */
  rollSeed(): void {
    const param = this.seedParam;
    if (!param) return;
    const seed = Math.floor(Math.random() * 2 ** 32);
    this.set(param.key, seed);
    this.seedLocked = true;
  }

  /** 🔒 captures the last run's actual seed rather than what is displayed. */
  toggleSeedLock(): void {
    const param = this.seedParam;
    if (!param) return;
    if (this.seedLocked) {
      this.seedLocked = false;
      this.set(param.key, -1);
      return;
    }
    this.seedLocked = true;
    const seed = this.lastSeed ?? Math.floor(Math.random() * 2 ** 32);
    this.set(param.key, seed);
  }

  /** Typing in the field auto-locks to the typed value; `-1` unlocks. */
  editSeed(value: number): void {
    const param = this.seedParam;
    if (!param) return;
    if (value < 0) {
      this.seedLocked = false;
      this.set(param.key, -1);
      return;
    }
    this.seedLocked = true;
    this.set(param.key, value);
  }

  // ------------------------------------------------------------- submitting

  async submit(): Promise<void> {
    if (!this.workflowId || !this.canSubmit) return;
    this.submitting = true;
    this.submitError = null;
    try {
      const job = await api.submit(this.workflowId, this.values);
      // The resolved seed comes back on the job row (§11.3's greyed hint).
      const manifest = this.manifest;
      if (manifest) {
        const seed = this.#seedOf(manifest, job.params);
        if (seed !== null) this.lastSeed = seed;
      }
    } catch (cause) {
      this.submitError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.submitting = false;
    }
  }
}

export const panel = new PanelState();
