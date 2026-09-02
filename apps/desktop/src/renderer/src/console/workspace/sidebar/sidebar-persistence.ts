// The two durable records the sidebar keeps, encoder and decoder in one module.
//
// `apps/desktop/AGENTS.md`: "Two sides of one seam (producer and consumer,
// encoder and decoder) share a module." These two are exactly that seam — what
// the model writes under `expansion` and `layout` and what it reads back — and
// splitting them would be two shapes to keep in step, which is how a value class
// silently starts round-tripping into something else.
//
// NOTHING HERE APPLIES A BOUND OR A DEFAULT. A decoder answers `undefined` when
// the store holds nothing this build can read, and the model decides what that
// means: the width bounds and the "everything shut until the read answers" rule
// are the sidebar's, and a decoder that also owned them would be a second place
// the bounds live.

import { SIDEBAR_SECTION_IDS, type SidebarSectionId } from "../../seats/index.js";

/** The `layout` value's shape: one named surface, one named measurement. */
export type SidebarLayoutValue = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * The `expansion` value for the collapsed set.
 *
 * Sorted, so two runs that shut the same sections write the same bytes and a
 * byte-comparing store does not record a change nobody made. A section id is
 * identifier-shaped by construction, which is what the value class requires.
 */
export function encodeCollapsedSectionIds(ids: ReadonlySet<SidebarSectionId>): readonly string[] {
  return [...ids].sort();
}

/**
 * Read a stored collapsed set back, or `undefined` when there is nothing to read.
 *
 * An id this build does not know is DROPPED rather than kept: the record may
 * predate or postdate this build, and a set carrying an id no section has would
 * hold a section shut that nothing can ever re-open. This is the same answer the
 * pane-kind validator gives the same problem.
 */
export function decodeCollapsedSectionIds(
  value: unknown,
): ReadonlySet<SidebarSectionId> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const known = new Set<SidebarSectionId>();
  for (const candidate of value) {
    const match = SIDEBAR_SECTION_IDS.find((id) => id === candidate);
    if (match !== undefined) {
      known.add(match);
    }
  }
  return known;
}

/** The `layout` value for the sidebar's width. */
export function encodeSidebarWidth(widthPx: number): SidebarLayoutValue {
  return { sidebar: { widthPx } };
}

/** Read a stored width back, unbounded, or `undefined` when there is none to read. */
export function decodeSidebarWidth(value: unknown): number | undefined {
  const sidebar = propertyOf(value, "sidebar");
  const widthPx = propertyOf(sidebar, "widthPx");
  return typeof widthPx === "number" && Number.isFinite(widthPx) ? widthPx : undefined;
}

/** One property of a value that may not be an object at all. */
function propertyOf(value: unknown, property: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[property]
    : undefined;
}
