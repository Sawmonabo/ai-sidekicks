// This subtree's named bounds.
//
// `core/constants.ts` is the substrate's, and its header says a view family adds
// its own module beside its subtree rather than widening that one, so a bound
// always sits next to the code that spends it. These are the approvals surface's.

/**
 * The shortest a session goal may be.
 *
 * `api-payload-contracts.md §Plan-016 — Multi-Agent Channels And Orchestration`
 * bounds the goal text at "1–4096 chars, non-blank, NUL-rejected". One rather than
 * zero is what makes "an update with no
 * goal is malformed" true at the type level: clearing is `session.goalClear`, a
 * different operation, and an empty-text update is never treated as one.
 */
export const SESSION_GOAL_MIN_LENGTH = 1;

/**
 * The longest a session goal may be.
 *
 * The daemon's own bound, restated so the field refuses on the same rule rather
 * than truncating and sending something the participant did not write.
 */
export const SESSION_GOAL_MAX_LENGTH = 4096;
