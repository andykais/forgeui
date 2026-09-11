import { describe, expect, test } from "vitest";
import { byChoice, byModel } from "./models.ts";
import type { ModelEntry } from "../types.ts";

/**
 * Two files that hashed the same share one `id`, because an id names a model
 * and the list walks files (§8.1). A keyed `{#each}` over that throws
 * `each_key_duplicate` and renders nothing, which is how the model picker
 * went blank. So each list keys on what its rows mean.
 */
function model(patch: Partial<ModelEntry>): ModelEntry {
  return {
    id: "sha",
    hash: "sha",
    path: "/models/checkpoints/a.safetensors",
    name: "a.safetensors",
    display_name: "a",
    ...patch,
  } as ModelEntry;
}

/** One checkpoint reachable through two configured folders — the usual way. */
const twoFolders = [
  model({ path: "/models/checkpoints/a.safetensors" }),
  model({ path: "/models/Stable-Diffusion/a.safetensors" }),
];

/** One file copied under a second name: same bytes, two real choices. */
const twoNames = [
  model({ name: "a.safetensors", path: "/models/checkpoints/a.safetensors" }),
  model({
    name: "a-copy.safetensors",
    path: "/models/checkpoints/a-copy.safetensors",
    display_name: "a-copy",
  }),
];

describe("what a picker lists", () => {
  test("one row per name, because a name is what choosing writes", () => {
    expect(byChoice(twoFolders).map((m) => m.path)).toEqual([
      "/models/checkpoints/a.safetensors",
    ]);
  });

  test("two names are two choices, even from identical files", () => {
    expect(byChoice(twoNames).map((m) => m.name)).toEqual([
      "a.safetensors",
      "a-copy.safetensors",
    ]);
  });

  test("the first wins, so the caller's sort decides", () => {
    const reversed = [...twoFolders].reverse();
    expect(byChoice(reversed)[0]!.path).toBe(
      "/models/Stable-Diffusion/a.safetensors",
    );
  });
});

describe("what a model-filter lists", () => {
  test("one row per model, because the row is a hash", () => {
    expect(byModel(twoNames)).toHaveLength(1);
    expect(byModel(twoFolders)).toHaveLength(1);
  });

  test("nothing unhashed is folded into anything else", () => {
    const waiting = [
      model({ id: "path:a", hash: null, path: "/a.safetensors", name: "a" }),
      model({ id: "path:b", hash: null, path: "/b.safetensors", name: "b" }),
    ];
    expect(byModel(waiting)).toHaveLength(2);
  });
});
