import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { ModelDetail as ModelDetailType } from "../types.ts";

/**
 * The model page's edit-in-place header (§8.1): blur commits, Esc reverts,
 * and a model the hasher has not reached yet cannot be edited at all — which
 * is the 409 the API answers, shown as the badge and disabled fields.
 */

const patchModel = vi.fn();
const model = vi.fn();

vi.mock("../api.ts", () => ({
  ApiError: class ApiError extends Error {
    status = 409;
    code = "hashing";
  },
  api: {
    model: (...args: unknown[]) => model(...args),
    patchModel: (...args: unknown[]) => patchModel(...args),
    outputs: () => Promise.resolve({ outputs: [], cursor: null }),
    models: () => Promise.resolve({ models: [] }),
    modelsOfKind: () => Promise.resolve([]),
    output: () => Promise.resolve({}),
  },
}));

const { default: ModelDetail } = await import("./ModelDetail.svelte");

function detail(overrides: Partial<ModelDetailType> = {}): ModelDetailType {
  return {
    id: "a".repeat(64),
    hash: "a".repeat(64),
    path: "/models/loras/film-grain-35mm.safetensors",
    name: "film-grain-35mm.safetensors",
    filename: "film-grain-35mm.safetensors",
    display_name: "Film grain 35mm",
    family: "sd15",
    kind: "loras",
    class: "lora",
    size: 145_000_000,
    mtime: 1_780_000_000_000,
    notes: null,
    tags: ["film"],
    strength_min: -2,
    strength_max: 2,
    thumb_path: null,
    thumb_url: null,
    output_count: 0,
    last_used_at: null,
    hashing: false,
    present: true,
    samples: [],
    ...overrides,
  };
}

describe("the model page header", () => {
  beforeEach(() => {
    patchModel.mockReset();
    patchModel.mockImplementation(() => Promise.resolve(detail()));
    model.mockReset();
  });

  test("blur commits a new display name", async () => {
    model.mockResolvedValue(detail());
    patchModel.mockResolvedValue(detail({ display_name: "Grain" }));
    render(ModelDetail, { id: "a".repeat(64) });

    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    expect(input.value).toBe("Film grain 35mm");
    await fireEvent.input(input, { target: { value: "Grain" } });
    await fireEvent.blur(input);

    await waitFor(() => expect(patchModel).toHaveBeenCalledTimes(1));
    expect(patchModel.mock.calls[0]?.[1]).toEqual({ display_name: "Grain" });
  });

  test("esc reverts instead of committing", async () => {
    model.mockResolvedValue(detail());
    render(ModelDetail, { id: "a".repeat(64) });

    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Something else" } });
    await fireEvent.keyDown(input, { key: "Escape" });
    await fireEvent.blur(input);

    expect(input.value).toBe("Film grain 35mm");
    expect(patchModel).not.toHaveBeenCalled();
  });

  test("an unchanged name is not written back", async () => {
    model.mockResolvedValue(detail());
    render(ModelDetail, { id: "a".repeat(64) });

    const input = await screen.findByLabelText("Display name");
    await fireEvent.blur(input);
    expect(patchModel).not.toHaveBeenCalled();
  });

  test("a model still being hashed shows the badge and refuses edits", async () => {
    model.mockResolvedValue(
      detail({ hash: null, id: "path:abc", hashing: true, family: "unset" }),
    );
    render(ModelDetail, { id: "path:abc" });

    expect(await screen.findByText("hashing")).toBeTruthy();
    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("Add a tag") as HTMLInputElement).disabled).toBe(true);
    // No hash to show, and no samples strip to hang media off.
    expect(screen.getByText("still being read")).toBeTruthy();
    expect(screen.queryByText("Samples")).toBeNull();
  });

  test("the full sha256 is shown whole, with no button beside it", async () => {
    model.mockResolvedValue(detail());
    render(ModelDetail, { id: "a".repeat(64) });

    // §11.2: on its own line, `user-select: all`, no truncation, no button.
    const hash = await screen.findByText("a".repeat(64));
    expect(hash.textContent).toHaveLength(64);
    expect(hash.className).toContain("value");
    expect(hash.closest("button")).toBeNull();
  });

  test("a tag is added on Enter and removed from its chip", async () => {
    model.mockResolvedValue(detail());
    patchModel.mockResolvedValue(detail({ tags: ["film", "grain"] }));
    render(ModelDetail, { id: "a".repeat(64) });

    const tags = await screen.findByLabelText("Add a tag");
    await fireEvent.input(tags, { target: { value: "grain" } });
    await fireEvent.keyDown(tags, { key: "Enter" });
    await waitFor(() => expect(patchModel).toHaveBeenCalledTimes(1));
    expect(patchModel.mock.calls[0]?.[1]).toEqual({ tags: ["film", "grain"] });

    await fireEvent.click(screen.getByLabelText("Remove the tag film"));
    await waitFor(() => expect(patchModel).toHaveBeenCalledTimes(2));
    expect(patchModel.mock.calls[1]?.[1]).toEqual({ tags: ["grain"] });
  });

  test("a reply to one field does not overwrite another being typed into", async () => {
    // The tag write returns the row as it was before the notes were typed;
    // resyncing every draft from it would throw the notes away.
    model.mockResolvedValue(detail());
    let resolveTags: (value: unknown) => void = () => {};
    patchModel.mockImplementation((_id: string, body: Record<string, unknown>) => {
      if ("tags" in body) {
        return new Promise((resolve) => {
          resolveTags = resolve;
        });
      }
      return Promise.resolve(detail({ notes: "typed while the tag was saving" }));
    });
    render(ModelDetail, { id: "a".repeat(64) });

    const tags = await screen.findByLabelText("Add a tag");
    await fireEvent.input(tags, { target: { value: "grain" } });
    await fireEvent.keyDown(tags, { key: "Enter" });

    const notes = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    await fireEvent.input(notes, { target: { value: "typed while the tag was saving" } });
    resolveTags(detail({ tags: ["film", "grain"] }));
    await waitFor(() => expect(patchModel).toHaveBeenCalledTimes(1));

    expect(notes.value).toBe("typed while the tag was saving");
    await fireEvent.blur(notes);
    await waitFor(() => expect(patchModel).toHaveBeenCalledTimes(2));
    expect(patchModel.mock.calls[1]?.[1]).toEqual({
      notes: "typed while the tag was saving",
    });
  });
});
