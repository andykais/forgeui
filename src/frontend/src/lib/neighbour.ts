/**
 * What a viewer should show once the output it has open is deleted (§11.2).
 *
 * Deleting while looking at something is a way of working through a batch:
 * dropping back to the grid every time takes the run away and makes the next
 * delete a click and a scroll rather than a keystroke. So the viewer steps
 * instead — to the next one *older*, which is where the eye was going, and
 * back to the newer one only when there is nothing older left. Nothing at all
 * left is the one case that closes the viewer, because there is no longer
 * anything to look at.
 *
 * The list is the one the grid was showing, in the order it was showing it,
 * and the caller decides what "older" means by that order: newest-first (the
 * default everywhere) makes the next index older, oldest-first makes it the
 * previous one.
 */
export function afterRemoval<T extends { id: string }>(
  list: readonly T[],
  removedId: string,
  options: { oldestFirst?: boolean } = {},
): T | null {
  const index = list.findIndex((entry) => entry.id === removedId);
  if (index < 0) return null;
  const older = options.oldestFirst ? index - 1 : index + 1;
  const newer = options.oldestFirst ? index + 1 : index - 1;
  return list[older] ?? list[newer] ?? null;
}
