import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Config } from "../types.ts";

/**
 * What counts as one of §11.4's navigation keys. The bindings are bare keys
 * and several are now plain letters, so what does *not* count matters as
 * much as what does.
 */

vi.mock("../api.ts", () => ({ api: {} }));

const { app } = await import("./app.svelte.ts");

function press(key: string, modifiers: Partial<KeyboardEventInit> = {}) {
  return app.keyAction(new KeyboardEvent("keydown", { key, ...modifiers }));
}

describe("the key bindings", () => {
  beforeEach(() => {
    app.config = {
      keys: {
        select_prev: ["ArrowLeft", "a"],
        select_next: ["ArrowRight", "d"],
        select_up: ["ArrowUp", "w"],
        select_down: ["ArrowDown", "s"],
        fullscreen: ["f"],
        close: ["Escape"],
      },
    } as unknown as Config;
  });

  test("the arrows and their letters mean the same thing", () => {
    expect(press("ArrowLeft")).toBe("select_prev");
    expect(press("a")).toBe("select_prev");
    expect(press("ArrowRight")).toBe("select_next");
    expect(press("d")).toBe("select_next");
    expect(press("ArrowUp")).toBe("select_up");
    expect(press("w")).toBe("select_up");
    expect(press("ArrowDown")).toBe("select_down");
    expect(press("s")).toBe("select_down");
  });

  test("a chord is never one of them", () => {
    // Otherwise Ctrl+A would move the selection on its way to selecting all,
    // and Cmd+S would on its way to saving.
    expect(press("a", { ctrlKey: true })).toBeNull();
    expect(press("a", { metaKey: true })).toBeNull();
    expect(press("s", { ctrlKey: true })).toBeNull();
    expect(press("s", { metaKey: true })).toBeNull();
    expect(press("d", { altKey: true })).toBeNull();
    expect(press("f", { ctrlKey: true })).toBeNull();
    // The arrows are no different: Ctrl+ArrowLeft is a word jump, not this.
    expect(press("ArrowLeft", { ctrlKey: true })).toBeNull();
  });

  test("shift alone still counts, and an unbound key never does", () => {
    // Shift is how a capital arrives; it is not a chord of its own here.
    expect(press("a", { shiftKey: true })).toBe("select_prev");
    expect(press("q")).toBeNull();
    expect(press("Tab")).toBeNull();
  });

  test("no config means no bindings, rather than a guess at them", () => {
    app.config = null;
    expect(press("a")).toBeNull();
    expect(press("ArrowLeft")).toBeNull();
  });
});
