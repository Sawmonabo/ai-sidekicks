// The agents family's bounds: what a resolved allowlist and a resolved prose echo show
// before each folds to a count.

/**
 * Tool names rendered from a resolved allowlist before the list folds to a count.
 *
 * The allowlist is a snapshot taken at attach and can be long. Past this many names
 * the line stops telling a reader what the agent may do and starts being a wall, and
 * the useful residual fact is how many more there are.
 */
export const TOOL_ALLOWLIST_NAMED_CAP = 6;

/**
 * Characters of a resolved instruction or goal rendered inline before it clamps.
 *
 * Both are free prose an operator wrote and either may be pages. The echo's job at
 * the point of confirmation is to prove the daemon resolved what was asked, which a
 * leading passage does; the whole text belongs to the definition editor, which is
 * another plan's body.
 */
export const RESOLVED_PROSE_INLINE_CAP = 240;
