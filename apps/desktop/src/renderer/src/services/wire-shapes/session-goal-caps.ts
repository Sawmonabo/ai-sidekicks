// The session goal's length range.

// `SESSION_GOAL_MAX_LENGTH` is the bound of the two and is what brought them here;
// the minimum came with it on the sidebar range's rule above, because one schema
// clamps between them and a range split across two modules is a clamp a reviewer
// opens two files to check.

/**
 * The shortest a session goal may be.
 *
 * One rather than zero is what makes "an update with no goal is malformed" true at
 * the type level: clearing is a different operation, and an empty-text update is
 * never treated as one.
 */
export const SESSION_GOAL_MIN_LENGTH = 1;

/**
 * The longest a session goal may be.
 *
 * The daemon's own bound, restated so the field refuses on the same rule rather than
 * truncating and sending something the user did not write.
 */
export const SESSION_GOAL_MAX_LENGTH = 4096;
