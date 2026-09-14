import { describe, expect, it } from "vitest";
import { afterRemoval } from "./neighbour.ts";

const list = (...ids: string[]) => ids.map((id) => ({ id }));

describe("afterRemoval", () => {
  it("steps to the next oldest", () => {
    // Newest first, so the one after the deleted tile is the older one.
    expect(afterRemoval(list("c", "b", "a"), "b")).toEqual({ id: "a" });
  });

  it("falls back to the newer one when the oldest goes", () => {
    expect(afterRemoval(list("c", "b", "a"), "a")).toEqual({ id: "b" });
  });

  it("with two left, deleting the newest leaves the older", () => {
    expect(afterRemoval(list("b", "a"), "b")).toEqual({ id: "a" });
  });

  it("with two left, deleting the oldest leaves the newer", () => {
    expect(afterRemoval(list("b", "a"), "a")).toEqual({ id: "b" });
  });

  it("returns nothing when that was the last one", () => {
    expect(afterRemoval(list("a"), "a")).toBeNull();
  });

  it("returns nothing when the id is not in the list", () => {
    expect(afterRemoval(list("c", "b"), "a")).toBeNull();
  });

  it("reads the other way round when the list is oldest first", () => {
    // Oldest first: older is the *previous* entry, not the next.
    expect(afterRemoval(list("a", "b", "c"), "b", { oldestFirst: true })).toEqual({
      id: "a",
    });
    expect(afterRemoval(list("a", "b", "c"), "a", { oldestFirst: true })).toEqual({
      id: "b",
    });
  });
});
