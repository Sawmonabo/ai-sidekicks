// Bounds on transcript structure: the run group row caps and the find walk. Spent in `feed/`,
// `run-groups/` and `find/`.

/**
 * Rows a single run group renders before its body clips.
 * A run group is a nested scroller, so the cap bounds how many rows one run mounts while
 * sibling runs stream beside it: about four screens, without four live run groups costing a frame.
 */
export const RUN_GROUP_VISIBLE_ROW_CAP = 120;
/**
 * Rows one run group's body holds at all: the mounted window plus the clipped head above it.
 * Derived from the visible cap so the two move together; the body's ring is allocated once at
 * this length, so retention does not grow with how long the run streams.
 */
export const RUN_GROUP_BODY_RETAINED_ROW_CAP: number = RUN_GROUP_VISIBLE_ROW_CAP * 2;
/**
 * Matches the find field ranks and offers next/previous over.
 * A one-character query matches most of the loaded window; the cap keeps the next/previous walk
 * terminating, and the true match count rides beside the capped denominator.
 */
export const FIND_MATCH_CAP = 500;
