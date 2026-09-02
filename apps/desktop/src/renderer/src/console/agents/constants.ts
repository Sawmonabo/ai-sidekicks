// The agents subtree's named bounds.
//
// `console/core/constants.ts` holds the substrate's and its header puts a view
// family's beside its own subtree, so a bound sits next to the code that spends it —
// the same shape `collaboration/constants.ts` takes. Append; never reorder.

/**
 * Tool names rendered from a resolved allowlist before the list folds to a count.
 *
 * The allowlist is a snapshot taken at attach and can be long. Past this many names
 * the line stops telling a reader what the agent may do and starts being a wall, and
 * the useful residual fact is how many more there are.
 */
export const TOOL_ALLOWLIST_NAMED_CAP = 6;

/**
 * Child-run refusal rows rendered before the group scrolls.
 *
 * Refusals accumulate for the life of a run and are never garbage-collected by the
 * fold, so the group is unbounded by construction. A cap turns it into a bounded
 * region without hiding anything: past it the group scrolls rather than pushing the
 * links that DID happen off the surface.
 */
export const CHILD_RUN_REFUSAL_VISIBLE_CAP = 12;

/**
 * Characters of a resolved instruction or goal rendered inline before it clamps.
 *
 * Both are free prose an operator wrote and either may be pages. The echo's job at
 * the point of confirmation is to prove the daemon resolved what was asked, which a
 * leading passage does; the whole text belongs to the definition editor, which is
 * another plan's body.
 */
export const RESOLVED_PROSE_INLINE_CAP = 240;
