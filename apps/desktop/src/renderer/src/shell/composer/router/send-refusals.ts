// The composer's refusal vocabulary, and the two ways a refusal reaches the surface.
//
// Split from `send-router.ts` because it is a second job: that module decides which
// wire call a send resolves to, and this one decides what the console says when it
// resolves to none. The split is what keeps either file readable, and it gives the
// surface one import for the vocabulary it renders without pulling in the router.
//
// TWO PRODUCERS, ONE SHAPE. A composer-side refusal is minted here from the closed
// code set below; a daemon-side rejection is CARRIED here, verbatim. Both leave as
// `core/refusal.ts`'s one `ConsoleRefusal`, so `primitives/Refusal` renders either
// without knowing which it got.

import type { InterventionState } from "@ai-sidekicks/contracts";

import { isWireErrorEnvelope, lossyStringify } from "../../../../../shared/wire-errors.js";
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
 * The code a rejection with no wire envelope is rendered under.
 *
 * A last resort rather than a category: the console did reach the daemon and the
 * daemon did say no, so the honest reading is "rejected, shape unrecognised" — not
 * a composer-side code, which would claim the console refused, and not silence.
 */
export const DAEMON_UNTYPED_REJECTION_CODE = "rejected";

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
  "intervention-unreadable",
  "queue-unreadable",
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
 * Carry a daemon rejection through, WITHOUT paraphrasing it.
 *
 * `Spec-023 §Console Design (Meridian)` rule 9 puts the code in mono and the
 * daemon's message verbatim, and the console "never re-derives the daemon's rule".
 * So there is deliberately no table here mapping a wire code onto console prose: the
 * code the daemon sent is the code a person sees, and the sentence beside it is the
 * daemon's own.
 *
 * Two envelope positions are checked because a rejection arrives both ways — as a
 * plain wire object, and as an `Error` subclass carrying the refusal on a property.
 * Anything else is rendered through the total stringifier rather than as a sentence
 * the console invented.
 */
export function carriedDaemonRefusal(cause: unknown): ConsoleRefusal {
  if (isWireErrorEnvelope(cause)) {
    return refuse(DAEMON_REFUSAL_ORIGIN, cause.code, cause.message);
  }
  const carried = (cause as { readonly refusal?: unknown } | null | undefined)?.refusal;
  if (isWireErrorEnvelope(carried)) {
    return refuse(DAEMON_REFUSAL_ORIGIN, carried.code, carried.message);
  }
  return refuse(DAEMON_REFUSAL_ORIGIN, DAEMON_UNTYPED_REJECTION_CODE, lossyStringify(cause));
}

/**
 * The refusal for an intervention reply the registered response shape does not admit.
 *
 * A composer-side code and not a carried one, because nothing was carried: the call
 * was answered and the answer is unreadable, so what refuses is this console's own
 * parse. The DRAFT IS KEPT on this arm, which is the whole reason it is a refusal
 * rather than a success — the daemon may or may not have taken the steer, and losing
 * the participant's words to an ambiguity is worse than letting them decide to send
 * again.
 */
export function unreadableInterventionReply(): ConsoleRefusal {
  return composerRefusal(
    "intervention-unreadable",
    "The daemon answered this steer with a shape the console could not read, so it cannot confirm the message reached the run. Your message is still in the line.",
  );
}

/**
 * The refusal for a queue-create reply the registered response shape does not admit.
 *
 * The sibling of the one above, and composer-side for the same reason: the call was
 * answered, and the answer is unreadable, so what refuses is this console's own
 * parse rather than anything the daemon said. The DRAFT IS KEPT here too — a reply
 * carrying no readable queue item is a reply that confirms no queued message, and
 * clearing the line on it would lose the participant's words to a protocol mismatch.
 */
export function unreadableQueueReply(): ConsoleRefusal {
  return composerRefusal(
    "queue-unreadable",
    "The daemon answered this message with a shape the console could not read, so it cannot confirm the message was queued. Your message is still in the line.",
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
