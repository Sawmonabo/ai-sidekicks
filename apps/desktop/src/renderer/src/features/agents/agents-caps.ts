// Bounds on what a resolved allowlist and a resolved prose echo show before folding to a count.

/**
 * Tool names rendered from a resolved allowlist before the list folds to a count of the rest.
 * The allowlist is a snapshot taken when the agent starts and can be long.
 */
export const TOOL_ALLOWLIST_NAMED_CAP = 6;

/**
 * Characters of a resolved instruction or goal rendered inline before it clamps. The echo
 * proves the daemon resolved what was asked, which a leading passage does; the whole text
 * belongs to the definition editor.
 */
export const RESOLVED_PROSE_INLINE_CAP = 240;
