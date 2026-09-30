// The composer's refusal vocabulary. A composer-side refusal is minted here from a closed code
// set; a daemon-side one is the daemon's own. Rejections are normalized once by `callDaemon`,
// so nothing here reads one, and the only daemon refusal built here is an intervention answered
// with a declining lifecycle state.

import type { InterventionState } from "@ai-sidekicks/contracts";

import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/** Origin of every refusal the composer itself raises. */
export const COMPOSER_REFUSAL_ORIGIN = "composer";

/** Origin of a carried daemon rejection, so a daemon rule never reads as the console's decision. */
export const DAEMON_REFUSAL_ORIGIN = "daemon";

/**
 * Why the composer refused before reaching the wire. Closed: each code carries its own copy,
 * and it is shown in mono beside the sentence, so people paste it into a search.
 */
export const COMPOSER_REFUSAL_CODES = [
  "empty-message",
  "run-version-unread",
  "identifier-unparseable",
  "command-unexecutable",
  "provider-command-discovery-only",
] as const;

/** One composer refusal code, derived from `COMPOSER_REFUSAL_CODES`. */
export type ComposerRefusalCode = (typeof COMPOSER_REFUSAL_CODES)[number];

/** Mint one composer-side refusal. */
export function composerRefusal(code: ComposerRefusalCode, detail: string): Refusal {
  return refuse(COMPOSER_REFUSAL_ORIGIN, code, detail);
}

/** The refusal for an identifier the registered wire schema would not accept. */
export function unparseableIdentifier(subject: string): Refusal {
  return composerRefusal(
    "identifier-unparseable",
    `The console is holding an identifier for ${subject} that the background service would not accept. Reopen the session so its identifiers are read again.`,
  );
}

/**
 * The refusal for an intervention the daemon answered and did not admit. Daemon-origin; the
 * code is the response's `rejectionReason` when sent, else the lifecycle state. The sentence
 * speaks of the user's text, which the line still holds.
 */
export function interventionNotApplied(
  state: InterventionState,
  rejectionReason: string | undefined,
): Refusal {
  return refuse(
    DAEMON_REFUSAL_ORIGIN,
    rejectionReason ?? state,
    "The run did not take this steer, so nothing was sent. Your message is still in the line — the console has read the run's current version, so sending again guards it against where the turn is now.",
  );
}
