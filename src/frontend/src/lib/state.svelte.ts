/**
 * A plain deep copy of possibly-reactive data.
 *
 * `$state` deep-proxies objects, and a proxy cannot go through
 * `structuredClone` — it throws `DataCloneError`. Anything read out of a store
 * and copied has to come through here instead. Getting this wrong is silent:
 * the throw happens inside an event handler, so the assignment that was meant
 * to follow it simply never runs.
 */
export function plain<T>(value: T): T {
  return $state.snapshot(value) as T;
}
