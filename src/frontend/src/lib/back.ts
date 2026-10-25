import { app } from "../stores/app.svelte.ts";

/**
 * `close` (Escape, §11.4) on a page you opened from a list — a model, a
 * template, a workflow — does what that page's Back button does. One step
 * at a time, as everywhere: something open on top of the page (a popover,
 * a dialog, the mask editor) takes the key first, and text being typed
 * keeps it, which is what lets Escape revert an edit-in-place field.
 */
export function escapeGoesBack(event: KeyboardEvent, back: () => void): void {
  if (event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  ) {
    return;
  }
  if (app.keyAction(event) !== "close") return;
  if (document.querySelector('[role="dialog"]')) return;
  event.preventDefault();
  back();
}
