// The settings family's named bounds.
//
// `console/core/constants.ts` holds the substrate's; its own header says each view
// family adds a module beside its subtree rather than widening that one, so a bound
// sits next to the code that spends it — the same shape `collaboration/constants.ts`
// and `agents/constants.ts` take. Append; never reorder.
//
// This one was in the collaboration family's module until the layering gate said
// what that really was: a settings page reaching across a family boundary for its
// own bound. The number and its rationale are unchanged.

/**
 * Mounts a settings inventory reads in full before it stops naming them.
 *
 * The mount inventory is composed from two reads — the session's workspace list
 * names the mounts, and each mount is then read for its path and its health — so
 * the second read's cost is one call per distinct mount. Twenty-four is far above
 * any session a person assembles by hand and low enough that a session with a
 * pathological mount count cannot turn one settings visit into an unbounded fan-out.
 * Past it the page names how many mounts it did not read rather than hiding them,
 * because a silently truncated inventory is the one thing worse than a long one.
 */
export const MOUNT_INVENTORY_READ_CAP = 24;
