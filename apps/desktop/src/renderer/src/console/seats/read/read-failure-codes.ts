// The two codes a push-driven read mints when a failure carried none of its own.
//
// ITS OWN MODULE because two modules beside it derive from the set and one of them
// cannot import the other. `push-driven-read.ts` names the subscribe arm; the reply
// unwrappers in `served-value.ts` name the read arm as their fallback, and that
// module is imported BY the model rather than the other way round — so declaring the
// set in either one and importing it from the other closes a two-module cycle
// `no-circular` fails. `apps/desktop/AGENTS.md` §State and views requires the set be
// declared exactly once, and this is the only placement that satisfies both rules.

/**
 * The codes this family mints when a failure carried none of its own.
 *
 * Declared once and derived from, because both the read arm and the subscribe arm
 * name one of them and a second spelling in either place is a rename waiting to go
 * half-applied. A failure that arrives carrying a daemon code keeps that code —
 * these two are the fallback, never a translation.
 */
export const PUSH_DRIVEN_READ_FAILURE_CODES = ["read-failed", "subscribe-failed"] as const;

/** One such code. Derived, so the set is stated exactly once. */
export type PushDrivenReadFailureCode = (typeof PUSH_DRIVEN_READ_FAILURE_CODES)[number];

/**
 * The two, typed against that set rather than spelled at the call.
 *
 * `consoleRefusalFrom` takes any code, because its callers include mutations whose
 * failure is neither of these — so without these two bindings the set above would be
 * declared and consumed by nothing, which is a closed set that has stopped closing
 * anything. A typo in either one is a compile error here instead of a code no
 * reader recognises on screen.
 */
export const READ_FAILED: PushDrivenReadFailureCode = "read-failed";

/** The subscribe arm's, on the same reasoning as {@link READ_FAILED}. */
export const SUBSCRIBE_FAILED: PushDrivenReadFailureCode = "subscribe-failed";
