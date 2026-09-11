import { describe, expect, test } from "vitest";
import { opensElsewhere, parseRoute } from "./router.svelte.ts";

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
    expect(parseRoute("/models", "")).toMatchObject({
      screen: "models",
      id: null,
    });
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

  test("carries a telemetry report and its filters in the query", () => {
    // Every part of a telemetry view is a URL param (§11.2), so the whole
    // thing — report, graph shape, filters and the open entry — is a link.
    const route = parseRoute(
      "/telemetry",
      "?report=api_requests&graph=line&method=GET,POST&entry=42",
    );
    expect(route.screen).toBe("telemetry");
    expect(route.id).toBe(null);
    expect(route.query.get("report")).toBe("api_requests");
    expect(route.query.get("graph")).toBe("line");
    expect(route.query.get("method")).toBe("GET,POST");
    expect(route.query.get("entry")).toBe("42");
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

/**
 * What counts as "the browser's, not the app's". The middle button only ever
 * reaches a handler as an `auxclick` — `click` is not fired for it — so a row
 * that is not a link has to listen for that event and ask this.
 */
describe("a click that belongs to the browser", () => {
  const click = (init: MouseEventInit) => new MouseEvent("click", init);

  test("ctrl, ⌘ and the middle button all mean elsewhere", () => {
    expect(opensElsewhere(click({ ctrlKey: true }))).toBe(true);
    expect(opensElsewhere(click({ metaKey: true }))).toBe(true);
    expect(opensElsewhere(click({ button: 1 }))).toBe(true);
  });

  test("a plain or shifted left click is the app's own", () => {
    // Shift is left to the caller: the sidebar gives it a meaning of its own.
    expect(opensElsewhere(click({ button: 0 }))).toBe(false);
    expect(opensElsewhere(click({ button: 0, shiftKey: true }))).toBe(false);
    // The right button opens a menu; it is nobody's navigation.
    expect(opensElsewhere(click({ button: 2 }))).toBe(false);
  });
});
