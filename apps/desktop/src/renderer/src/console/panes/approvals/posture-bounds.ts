// The one number the posture chip spends, with its rationale.
//
// Kept beside `approvals-bounds.ts` rather than folded into it because the two
// answer different questions: that module bounds what a participant may TYPE, and
// this one is a reading threshold over what the daemon SENT.

/**
 * Allowed domains past which the list is called broad.
 *
 * `Spec-023 §Console Design (Meridian)` §7.9 requires the copy to say that a broad
 * allow-list is domain-fronting-weak, and leaves "broad" to the surface. Eight is
 * the point at which the list stops reading as a named set of endpoints and starts
 * reading as a policy nobody audits row by row — which is exactly when the caveat
 * earns its space, and below which it would be noise on a two-domain allow-list.
 */
export const BROAD_ALLOW_LIST_THRESHOLD = 8;
