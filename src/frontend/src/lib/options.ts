/**
 * Arrow keys and Enter over a popover's list (§11.3). Every picker in the
 * app puts the caret in a search box and the choices underneath it, so the
 * keys arrive on the input and have to be carried to the list — which is
 * what this does.
 *
 * The highlight lives on the DOM rather than in each caller's state: the
 * list is rebuilt from scratch on every keystroke in the search box, so an
 * index held in a component would point at whatever happened to land in that
 * slot afterwards. Reading the buttons fresh on each key means the highlight
 * is only ever on an option that is on screen, and a filtered list starts
 * again from the top.
 */

/** Options are marked by class, which every picker already gives them. */
const OPTIONS = "button.option:not([disabled])";

export interface OptionKeysParams {
  /** Called instead of clicking, when a caller wants the value itself. */
  onenter?: (index: number) => void;
}

export function optionKeys(node: HTMLElement, params: OptionKeysParams = {}) {
  let current: OptionKeysParams = params;

  function options(): HTMLElement[] {
    return [...node.querySelectorAll<HTMLElement>(OPTIONS)];
  }

  function activeIndex(list: HTMLElement[]): number {
    return list.findIndex((option) => option.dataset.active === "true");
  }

  function highlight(list: HTMLElement[], index: number) {
    for (const option of list) delete option.dataset.active;
    const chosen = list[index];
    if (!chosen) return;
    chosen.dataset.active = "true";
    // `nearest` so the list does not lurch when the highlight is already in
    // view, which is most of the time.
    chosen.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step !== 0) {
      const list = options();
      if (list.length === 0) return;
      // Nothing highlighted yet: down takes the first, up takes the last.
      const at = activeIndex(list);
      const next = at === -1
        ? (step === 1 ? 0 : list.length - 1)
        : Math.min(list.length - 1, Math.max(0, at + step));
      event.preventDefault();
      highlight(list, next);
      return;
    }
    if (event.key !== "Enter") return;
    const list = options();
    const at = activeIndex(list);
    if (at === -1) return;
    event.preventDefault();
    // A picker can be nested inside something else that reads Enter — the
    // param panel runs the workflow on it — and choosing from a list is not
    // also a submit.
    event.stopPropagation();
    if (current.onenter) current.onenter(at);
    else list[at]!.click();
  }

  node.addEventListener("keydown", onKeyDown);
  return {
    update: (next: OptionKeysParams) => (current = next),
    destroy: () => node.removeEventListener("keydown", onKeyDown),
  };
}
