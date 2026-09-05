/**
 * A router small enough to read: the URL is the state (§11.2 wants gallery
 * filters to be links), so navigation is pushState plus a popstate listener.
 */
export type ScreenName =
  "generate" | "gallery" | "workflows" | "workflow" | "comfy" | "settings";

export interface Route {
  screen: ScreenName;
  /** The `:id` of `/workflows/:id`. */
  id: string | null;
  path: string;
  query: URLSearchParams;
}

function parse(path: string, search: string): Route {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const query = new URLSearchParams(search);
  const [first, second] = segments;
  if (!first || first === "generate") {
    return { screen: "generate", id: null, path, query };
  }
  if (first === "gallery") return { screen: "gallery", id: null, path, query };
  if (first === "workflows") {
    return second
      ? { screen: "workflow", id: second, path, query }
      : { screen: "workflows", id: null, path, query };
  }
  if (first === "comfy") return { screen: "comfy", id: null, path, query };
  if (first === "settings") return { screen: "settings", id: null, path, query };
  return { screen: "generate", id: null, path, query };
}

export const router = $state<{ current: Route }>({
  current: parse(location.pathname, location.search),
});

function apply(url: string, replace: boolean): void {
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  router.current = parse(location.pathname, location.search);
}

export function navigate(url: string, options: { replace?: boolean } = {}): void {
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
  apply(`${location.pathname}${search ? `?${search}` : ""}`, options.replace ?? true);
}

export function href(screen: ScreenName, query?: Record<string, string>): string {
  const path = screen === "generate" ? "/generate" : `/${screen}`;
  const search = query ? new URLSearchParams(query).toString() : "";
  return `${path}${search ? `?${search}` : ""}`;
}

if (typeof window !== "undefined") {
  addEventListener("popstate", () => {
    router.current = parse(location.pathname, location.search);
  });
}
