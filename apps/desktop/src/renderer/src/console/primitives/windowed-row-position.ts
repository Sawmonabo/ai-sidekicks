// Where one row of a windowed list sits in the whole list it is a slice of.
//
// TWO ATTRIBUTES AND ONE OFF-BY-ONE, WRITTEN ONCE. A window mounts only the rows a
// scroll position needs, so the accessibility tree holds the slice rather than the
// list: without these a screen reader reports the visible window as the complete
// enumeration and numbers each row inside it, which is a count and a position that are
// both wrong and both plausible.
//
// A PRIMITIVE RATHER THAN A PAIR OF ATTRIBUTES AT EACH CALL SITE, on the rule
// `apps/desktop/AGENTS.md` states for a helper's second use. Two console surfaces draw
// a windowed list — the changed-file list in the diff pane and the rollback path
// enumeration in the repos family — and a second copy of `index + 1` is exactly where
// two lists come to disagree about whether a position is counted from zero or one.
//
// It takes the ABSOLUTE index, which is the virtualizer's own `index` and never the
// position of the row inside the rendered window: the whole point of the pair is that
// the two numbers are different.

/** Say where one mounted row sits in the whole list, by its absolute index. */
export function windowedRowPosition(
  absoluteIndex: number,
  totalRowCount: number,
): { readonly "aria-setsize": number; readonly "aria-posinset": number } {
  return { "aria-setsize": totalRowCount, "aria-posinset": absoluteIndex + 1 };
}
