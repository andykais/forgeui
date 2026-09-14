import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";

/**
 * jsdom implements no layout, so it ships no `scrollIntoView` at all — a
 * method the real code calls whenever it moves the caret or a highlight. The
 * calls have nothing to do in a test, but their absence throws, so they are
 * given somewhere to land rather than being guarded at every call site.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/**
 * And no `ResizeObserver`, which is how anything that draws to a measured box
 * — the telemetry timeline — learns its own width. Nothing resizes in a test,
 * so it is enough that the observer exists and never reports.
 */
if (!("ResizeObserver" in globalThis)) {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => cleanup());
