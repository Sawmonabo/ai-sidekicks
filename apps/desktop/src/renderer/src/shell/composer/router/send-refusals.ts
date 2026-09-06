// The composer's refusal vocabulary, and the two ways a refusal reaches the surface.
//
// Split from `send-router.ts` because it is a second job: that module decides which
// wire call a send resolves to, and this one decides what the console says when it
// resolves to none. The split is what keeps either file readable, and it gives the
// surface one import for the vocabulary it renders without pulling in the router.
//
// TWO PRODUCERS, ONE SHAPE. A composer-side refusal is minted here from the closed
// code set below; a daemon-side one is the daemon's own, and this module does not
// read a rejection to build it. Every call the composer makes goes through
// `callDaemon`, whose door normalizes a rejection once for the whole console
// (`core/wire-rejection.ts`) — so a rejection reader here would be a second reading
// of one seam, and the code `session.not_found` arrived under would become whichever
// word this file chose. What survives is the one refusal the daemon ANSWERED with:
// `run.intervene` settles with a lifecycle state, and a state that declined the
// message is a refusal nothing rejected. Both leave as `core/refusal.ts`'s one
// `ConsoleRefusal`, so `primitives/Refusal` renders either without knowing which it
// got.

import type { InterventionState } from "@ai-sidekicks/contracts";

import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";

/** The subsystem name every refusal the composer itself raises carries. */
export const COMPOSER_REFUSAL_ORIGIN = "composer";

/**
 * The subsystem name a carried daemon rejection carries.
 *
 * Named separately and deliberately: a refusal that surfaces three layers from
 * where it was raised still names its author, and a daemon rule rendered under the
 * composer's own origin would read as the console's decision.
 */
export const DAEMON_REFUSAL_ORIGIN = "daemon";

/**
 * Why the composer refused, before the wire was reached.
 *
 * Closed: another reason is a decision, and each of these carries copy of its own.
 * None is a governance id, and each reaches a person only through
 * `primitives/Refusal`, which puts the code in mono beside the sentence — so the
 * code is what somebody pastes into a search and `detail` is what they act on.
 */
export const COMPOSER_REFUSAL_CODES = [
  "empty-message",
  "unknown-command",
  "slash-prefix-unsupported",
  "run-version-unread",
  "no-running-turn",
  "identifier-unparseable",
  "command-unexecutable",
  "provider-command-discovery-only",
] as const;

/** One composer refusal code. Derived, so the vocabulary is declared exactly once. */
export type ComposerRefusalCode = (typeof COMPOSER_REFUSAL_CODES)[number];

/** Mint one composer-side refusal. */
export function composerRefusal(code: ComposerRefusalCode, detail: string): ConsoleRefusal {
  return refuse(COMPOSER_REFUSAL_ORIGIN, code, detail);
}

/** The refusal for an identifier the registered wire schema would not accept. */
export function unparseableIdentifier(subject: string): ConsoleRefusal {
  return composerRefusal(
    "identifier-unparseable",
    `The console is holding an identifier for ${subject} that the daemon would not accept. Reopen the session so its identifiers are read again.`,
  );
}

/**
 * The refusal for an intervention the daemon answered and did not admit.
 *
 * DAEMON-ORIGIN, because the daemon is who declined it. The code slot carries the
 * response's own machine-readable `rejectionReason` where it sent one — that member
 * is the cause, and `Spec-023 §Console Design (Meridian)` rule 9 puts the code in
 * mono — and the lifecycle state where it did not, which is the daemon's own word
 * for what happened and never a category this console invented. The sentence beside
 * it is about the participant's TEXT rather than about the daemon's rule: what the
 * console knows and the daemon does not is that the line still holds the message.
 */
export function interventionNotApplied(
  state: InterventionState,
  rejectionReason: string | undefined,
): ConsoleRefusal {
  return refuse(
    DAEMON_REFUSAL_ORIGIN,
    rejectionReason ?? state,
    "The run did not take this steer, so nothing was sent. Your message is still in the line — the console has read the run's current version, so sending again guards it against where the turn is now.",
  );
}
