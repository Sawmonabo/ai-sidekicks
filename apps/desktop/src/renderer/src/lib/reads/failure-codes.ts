// The two codes a push-driven read mints when a failure carried none of its own. They live in
// their own module so `coerce-to-refusal.ts` in `lib/` can use them without importing from
// `store/reads/push-driven.ts`, which itself imports the coercion.

/**
 * The codes the shared read helpers mint when a failure carried none of its own. A failure that
 * carries a daemon code keeps it; these are a fallback, never a translation.
 */
export const PUSH_DRIVEN_READ_FAILURE_CODES = ["read-failed", "subscribe-failed"] as const;

/** One of {@link PUSH_DRIVEN_READ_FAILURE_CODES}. */
export type PushDrivenReadFailureCode = (typeof PUSH_DRIVEN_READ_FAILURE_CODES)[number];

/**
 * The read arm's fallback code, typed against the set so a typo is a compile error.
 * `coerceToRefusal` accepts any code because mutations fail with neither of these.
 */
export const READ_FAILED: PushDrivenReadFailureCode = "read-failed";

/** The subscribe arm's fallback code, typed like {@link READ_FAILED}. */
export const SUBSCRIBE_FAILED: PushDrivenReadFailureCode = "subscribe-failed";
