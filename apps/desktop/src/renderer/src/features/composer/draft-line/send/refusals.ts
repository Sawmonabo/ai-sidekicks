// The composer's refusal vocabulary. A composer-side refusal is minted here from a closed code
// set; a daemon-side one is the daemon's own. Rejections are normalized once by `callDaemon`,
// so nothing here reads one.

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
  "identifier-unparseable",
  "command-unexecutable",
] as const;

/** One composer refusal code, derived from `COMPOSER_REFUSAL_CODES`. */
export type ComposerRefusalCode = (typeof COMPOSER_REFUSAL_CODES)[number];

/** Mint one composer-side refusal. */
export function composerRefusal(code: ComposerRefusalCode, detail: string): Refusal {
  return refuse(COMPOSER_REFUSAL_ORIGIN, code, detail);
}

/** The refusal for an identifier the registered wire schema would not accept. */
export function unparseableIdentifier(): Refusal {
  return composerRefusal("identifier-unparseable", "Send failed");
}
