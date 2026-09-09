// Which arm the workspace sidebar rendered, and the refusal every whole-frame capture
// takes before it is photographed.
//
// HOISTED BECAUSE TWO FILES PIN A WHOLE FRAME. `workspace.test.tsx` is about the
// sidebar and states the hazard in its own header: the collapse a person makes is
// DURABLE, so a case that arrived carrying another case's arrangement once put a
// collapsed sidebar under the dark expanded capture. `ledger.test.tsx`'s flagship
// pair is not about the sidebar at all and is exposed to exactly the same thing —
// the sidebar is in that frame, so a restored collapse moves the image the flagship
// capture is named for. A per-file copy of the reading would be two answers to
// "which arm is this", and the copy in the file that is not about the sidebar is the
// one that would rot.
//
// Not a test file — no `include` glob reaches it.

/** The sidebar's own column, which both of its arms render and neither omits. */
const SIDEBAR_SELECTOR = ".meridian-sidebar";

/**
 * The marker the collapsed arm puts on that column.
 *
 * Read off the column rather than inferred from which control is on screen: it is
 * what the stylesheet keys on, so it is the one reading that cannot be true while
 * the picture disagrees with it.
 */
const SIDEBAR_COLLAPSED_CLASS = "meridian-sidebar--collapsed";

/**
 * The sidebar column this mount rendered, or a throw.
 *
 * A throw rather than a nullable, on the tier's own doctrine: a capture helper that
 * answered "not collapsed" for a window with no sidebar in it would let a frame be
 * photographed without one and report a pass.
 */
export function requireSidebarColumn(container: HTMLElement): Element {
  const column = container.querySelector(SIDEBAR_SELECTOR);
  if (column === null) {
    throw new Error(
      `the console rendered no ${SIDEBAR_SELECTOR} element, so there is no sidebar arm to read`,
    );
  }
  return column;
}

/** Which arm the sidebar rendered, as the column itself reports it. */
export function sidebarIsCollapsed(container: HTMLElement): boolean {
  return requireSidebarColumn(container).classList.contains(SIDEBAR_COLLAPSED_CLASS);
}

/**
 * Refuse a capture of a sidebar that is not in the arm this capture is named for.
 *
 * A throw rather than the assert-then-return-early shape, on the tier's own doctrine:
 * a case that photographed the wrong arm and reported a pass is exactly what put a
 * collapsed sidebar under the dark expanded capture. The collapsed case in
 * `workspace.test.tsx` needs no mirror of this before its click — the collapse control
 * exists only on the expanded arm, so a mount that arrived collapsed is refused by
 * that file's own `collapseSidebar` for having no control to press.
 */
export function requireSidebarExpanded(container: HTMLElement): void {
  if (sidebarIsCollapsed(container)) {
    throw new Error(
      "the sidebar rendered its collapsed arm, so this capture would put a collapsed sidebar under " +
        "a capture taken with the expanded one — an earlier case's arrangement was restored into " +
        "this mount",
    );
  }
}
