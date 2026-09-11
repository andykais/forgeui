/**
 * A router small enough to read: the URL is the state (§11.2 wants gallery
 * filters to be links), so navigation is pushState plus a popstate listener.
 */
export type ScreenName =
  | "generate"
  | "gallery"
  | "models"
  | "model"
  | "workflows"
  | "workflow"
  | "comfy"
  | "telemetry"
  | "settings";

export interface Route {
  screen: ScreenName;
  /** The `:id` of `/workflows/:id`. */
  id: string | null;
  path: string;
  query: URLSearchParams;
}

export function parseRoute(path: string, search: string): Route {
  // Decoded, because an id can carry characters that had to be escaped to
  // survive a path segment — a model with no hash is `path:<base64url>`.
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const query = new URLSearchParams(search);
  const [first, second] = segments;
  if (!first || first === "generate") {
    return { screen: "generate", id: null, path, query };
  }
  if (first === "gallery") return { screen: "gallery", id: null, path, query };
  if (first === "models") {
    return second
      ? { screen: "model", id: second, path, query }
      : { screen: "models", id: null, path, query };
  }
  if (first === "workflows") {
    return second
      ? { screen: "workflow", id: second, path, query }
      : { screen: "workflows", id: null, path, query };
  }
  if (first === "comfy") return { screen: "comfy", id: null, path, query };
  if (first === "telemetry") {
    return { screen: "telemetry", id: null, path, query };
  }
  if (first === "settings") {
    return { screen: "settings", id: null, path, query };
  }
  return { screen: "generate", id: null, path, query };
}

export const router = $state<{ current: Route }>({
  current: parseRoute(location.pathname, location.search),
});

function apply(url: string, replace: boolean): void {
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  router.current = parseRoute(location.pathname, location.search);
}

/**
 * Whether the browser should handle this click on a link rather than the
 * app. Every in-app link is an `<a href>` whose handler calls
 * `preventDefault()`, which is what makes routing work — and what took
 * ctrl-click away with it, so a model could never be opened beside the list
 * it was in.
 *
 * Ctrl, ⌘ and the middle button are the browser's. Shift is left to the
 * caller: the metadata sidebar gives it a meaning of its own (§11.2).
 *
 * The middle button only ever shows up here on an `auxclick`: `click` is not
 * fired for it at all. An `<a href>` therefore middle-clicks natively — its
 * `onclick` never runs, so nothing is prevented — but anything that is not a
 * link has to say so itself, with `newTab` on an `onauxclick`.
 */
export function opensElsewhere(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey || event.button === 1;
}

/**
 * Open an in-app URL in a new tab, the way the browser would have. `noopener`
 * because the new tab has no business reaching back into this one.
 */
export function newTab(url: string): void {
  globalThis.open(url, "_blank", "noopener");
}

export function navigate(
  url: string,
  options: { replace?: boolean } = {},
): void {
  if (url === `${location.pathname}${location.search}`) return;
  apply(url, options.replace ?? false);
}

/** Patch the query string in place; `null` removes a param. */
export function setQuery(
  patch: Record<string, string | null>,
  options: { replace?: boolean } = {},
): void {
  const query = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") query.delete(key);
    else query.set(key, value);
  }
  const search = query.toString();
  apply(
    `${location.pathname}${search ? `?${search}` : ""}`,
    options.replace ?? true,
  );
}

export function href(
  screen: ScreenName,
  query?: Record<string, string>,
): string {
  const path = screen === "generate" ? "/generate" : `/${screen}`;
  const search = query ? new URLSearchParams(query).toString() : "";
  return `${path}${search ? `?${search}` : ""}`;
}

if (typeof window !== "undefined") {
  addEventListener("popstate", () => {
    router.current = parseRoute(location.pathname, location.search);
  });
}
