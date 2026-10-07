// The composer's refusal vocabulary. A composer-side refusal is minted here from a closed code
// set; a daemon-side one is the daemon's own. Rejections are normalized once by `callDaemon`,
// so nothing here reads one, and the only daemon refusal built here is an intervention answered
// with a declining lifecycle state.

import type { InterventionRequestResponse } from "@ai-sidekicks/contracts/run/control";

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";

/** Origin of every refusal the composer itself raises. */
export const COMPOSER_REFUSAL_ORIGIN = "composer";

/** Origin of a carried daemon rejection, so a daemon rule never reads as the console's decision. */
export const DAEMON_REFUSAL_ORIGIN = "daemon";

/**
 * Why the composer refused before reaching the wire. Closed: each code carries its own sentence.
 */
export const COMPOSER_REFUSAL_CODES = [
  "empty-message",
  "run-version-unread",
  "identifier-unparseable",
  "command-unexecutable",
] as const;

/** One composer refusal code, derived from `COMPOSER_REFUSAL_CODES`. */
export type ComposerRefusalCode = (typeof COMPOSER_REFUSAL_CODES)[number];

/** A message the background service took and could not deliver, which `Try again` sends again. */
export interface UndeliveredMessageRefusal extends Refusal {
  readonly isUndelivered: true;
}

/** Mint one composer-side refusal. */
export function composerRefusal(code: ComposerRefusalCode, detail: string): Refusal {
  return refuse(COMPOSER_REFUSAL_ORIGIN, code, detail);
}

/** The refusal for an identifier the registered wire schema would not accept. */
export function unparseableIdentifier(): Refusal {
  return composerRefusal("identifier-unparseable", "Send failed");
}

/**
 * The refusal for an intervention the daemon answered and did not admit. Daemon-origin; the
 * code is the response's `rejectionReason` or `failureReason` when sent, else the lifecycle
 * state. The sentence speaks of the user's text, which the line still holds; a dispatch that
 * failed reads that the message was not delivered, which `Try again` sends again.
 */
export function interventionNotApplied(response: InterventionRequestResponse): Refusal {
  if (response.state === "failed") {
    const undelivered: UndeliveredMessageRefusal = {
      ...refuse(DAEMON_REFUSAL_ORIGIN, response.failureReason, "This message was not delivered."),
      isUndelivered: true,
    };
    return undelivered;
  }
  return refuse(
    DAEMON_REFUSAL_ORIGIN,
    response.rejectionReason ?? response.state,
    "The run did not take this steer, so nothing was sent. The " +
      "message is still in the line — the console has read the run's " +
      "current version, so sending again guards it against where the " +
      "turn is now.",
  );
}

/** Whether a held refusal is a message the background service took and could not deliver. */
export function isUndeliveredMessage(refusal: Refusal): refusal is UndeliveredMessageRefusal {
  return "isUndelivered" in refusal && refusal.isUndelivered === true;
}
