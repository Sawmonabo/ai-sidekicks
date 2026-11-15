// The composer's refusal vocabulary. A composer-side refusal is minted here from a closed code
// set; a daemon-side one is the daemon's own. Rejections are normalized once by `callDaemon`,
// so nothing here reads one. A failed send's line reads its refusal's code as words, never the
// service's sentence, which can name an id.

import type { RefusalCode } from "@ai-sidekicks/contracts/jsonrpc/refusal";

import { refusalCause } from "#renderer/lib/code-words.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { formatCount } from "#renderer/lib/wire/figures.js";

/** Origin of every refusal the composer itself raises. */
export const COMPOSER_REFUSAL_ORIGIN = "composer";

/** Origin of a carried daemon rejection, so a daemon rule never reads as the console's decision. */
export const DAEMON_REFUSAL_ORIGIN = "daemon";

/**
 * Why the composer refused before reaching the wire. Closed: each code carries its own sentence.
 */
export const COMPOSER_REFUSAL_CODES = ["identifier-unparsable", "command-unexecutable"] as const;

/** One composer refusal code, derived from `COMPOSER_REFUSAL_CODES`. */
export type ComposerRefusalCode = (typeof COMPOSER_REFUSAL_CODES)[number];

/** Mint one composer-side refusal. */
export function composerRefusal(code: ComposerRefusalCode, detail: string): Refusal {
  return refuse(COMPOSER_REFUSAL_ORIGIN, code, detail);
}

/** The refusal for an identifier the registered wire schema would not accept. */
export function unparsableIdentifier(): Refusal {
  return composerRefusal("identifier-unparsable", "Send failed");
}

/**
 * The line a failed send leaves in the transcript: `Send failed · <cause>`, the cause the code's
 * words, and for a message the provider refused as too long, its name and the limit it named.
 */
export function sendFailedLabel(
  refusal: ExtendedRefusal,
  providerName: string | undefined,
): string {
  if (
    refusal.code === MESSAGE_TOO_LARGE_CODE &&
    refusal.limit !== undefined &&
    providerName !== undefined
  ) {
    const limit = formatCount(refusal.limit);
    return `Send failed · Too long for one ${providerName} message · ${limit} characters at most`;
  }
  return `Send failed · ${refusalCause(refusal.code, refusal.reason, refusal.detail)}`;
}

/** The refusal a provider's limit on one message's length raises. */
const MESSAGE_TOO_LARGE_CODE = "session.message.tooLarge" satisfies RefusalCode;
