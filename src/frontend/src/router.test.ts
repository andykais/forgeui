import { describe, expect, test } from "vitest";
import { parseRoute } from "./router.svelte.ts";

/**
 * The URL is the state (§11.2), so a route has to survive being written into
 * a link and read back — including an id that had to be escaped to fit in a
 * path segment.
 */
describe("the router", () => {
  test("names the screen and the id", () => {
    expect(parseRoute("/gallery", "?models=abc")).toMatchObject({
      screen: "gallery",
      id: null,
    });
    expect(parseRoute("/models", "")).toMatchObject({ screen: "models", id: null });
    expect(parseRoute("/models/deadbeef", "")).toMatchObject({
      screen: "model",
      id: "deadbeef",
    });
    expect(parseRoute("/workflows/krea2", "")).toMatchObject({
      screen: "workflow",
      id: "krea2",
    });
    expect(parseRoute("/", "")).toMatchObject({ screen: "generate" });
  });

  test("decodes an id that was escaped to fit in the path", () => {
    // A model with no hash yet is addressed by its path (§8.1), which is
    // base64url behind a `path:` prefix — and the colon is escaped in a link.
    const id = "path:L2hvbWUvbW9kZWxzL2Euc2FmZXRlbnNvcnM";
    const route = parseRoute(`/models/${encodeURIComponent(id)}`, "");
    expect(route.screen).toBe("model");
    expect(route.id).toBe(id);
  });
});
