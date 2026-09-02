// How a growth read ENDS, when the seam it travels can also REJECT.
//
// A growth operation answers with an outcome a surface narrows on, and both workflow
// reads were written as though that were the only way one could finish. It is not.
// The scripted-reply seam has a fourth settlement the outcome union deliberately has
// no arm for: a scenario that scripts a DAEMON refusal is thrown verbatim and
// unwrapped, because a growth-scoped code for it would paraphrase the daemon's own
// envelope — and the live seam will throw the same shape the day the wire lands and
// the operation becomes an ordinary bridge call.
//
// Attaching only a fulfilment handler therefore left the rejection unhandled and the
// surface in `reading` for the life of the window: a spinner over an answer that had
// already arrived. That is the one shape a read must never take, because rule 8's
// `not-loaded` promises an answer that is still coming, and here none is.
//
// THREE CLASSES OF REJECTION, AND THEY ARE THREE BECAUSE THREE DIFFERENT AUTHORS
// RAISE THEM. `origin` exists so a refusal surfacing three layers from where it was
// raised still names its author, and collapsing these would throw that away:
//
//   • A `ConsoleRefusal` — thrown bare, or carried by a `ConsoleRefusalError` — is
//     already the console's one refusal shape. It travels verbatim, its own origin
//     included, and this module adds nothing to it.
//   • A wire envelope is the DAEMON's refusal. Its `code` is the string a person
//     pastes into a search and its `message` is the text rule 9 forbids paraphrasing,
//     so both are carried unreworded and the origin says the daemon refused.
//   • Anything else is a read that failed before it produced an answer at all. It
//     refuses BY NAME rather than being swallowed: a caught-and-dropped rejection is
//     how a surface ends up drawing an empty list for a read that never ran.
//
// WHY THIS IS NOT A SECOND REFUSAL VOCABULARY. `GrowthUnavailable` already extends
// `ConsoleRefusal`, so an outcome the port itself refused passes through untouched and
// both arms reach one `RefusalBanner` with no translation between them. What this adds
// is the settlement, not a shape.
//
// WHY NOT `normalizeWireRejection`. That helper answers a different question — how to
// render an arbitrary rejection as an `Error` — and it folds the wire code into
// `Error.name`, where a renderer can no longer tell a code from a class name. Its
// stringifier is reused here for exactly the arm that needs one, so the totality rule
// (a null-prototype object's `String(...)` can itself throw) has one implementation.

import { isWireErrorEnvelope, normalizeWireRejection } from "../../../../shared/wire-errors.js";
import {
  ConsoleRefusalError,
  isConsoleRefusal,
  refuse,
  type ConsoleRefusal,
} from "../core/index.js";

/** The origin on a refusal this module composes, rather than relays. */
export const READ_SETTLEMENT_REFUSAL_ORIGIN = "growth-read";

/** The origin on a refusal the daemon itself raised, so the relay keeps its author. */
export const DAEMON_REFUSAL_ORIGIN = "daemon";

/** The code a read that rejected carrying no refusal of its own refuses with. */
export const READ_REJECTED_REFUSAL_CODE = "read-rejected";

/**
 * A refusal a settled read carries, whichever of the three authors raised it.
 *
 * The console's one refusal shape plus the discriminant the outcome union narrows on,
 * and nothing more: `GrowthUnavailable` widens this same shape with what the growth
 * port knows, so a port refusal satisfies it without being rebuilt.
 */
export type SettledReadRefusal = ConsoleRefusal & { readonly status: "unavailable" };

/**
 * Settle a growth read, so its caller has one value to narrow on.
 *
 * Generic over the whole outcome rather than over its served value: what the port
 * answers with is the port's business, and this seam only adds the arm a rejection
 * takes. Typed the other way it would have to name `GrowthOutcome`, which does not
 * leave the bridge's door, and a second declaration of the served arm here would be
 * one closed shape with two homes.
 */
export async function settleGrowthRead<TOutcome>(
  read: Promise<TOutcome>,
): Promise<TOutcome | SettledReadRefusal> {
  try {
    return await read;
  } catch (rejection) {
    return refusalFromRejection(rejection);
  }
}

/**
 * The refusal one rejection becomes.
 *
 * Ordered from the most specific author to the least, and the order is load-bearing
 * only at the last step: an `Error` carrying a refusal is not structurally a refusal,
 * a refusal is not structurally a wire envelope, and a wire envelope is not
 * structurally a refusal — the three guards are disjoint, and the terminal arm is
 * what everything else falls to.
 */
function refusalFromRejection(rejection: unknown): SettledReadRefusal {
  if (rejection instanceof ConsoleRefusalError) {
    return { ...rejection.refusal, status: "unavailable" };
  }
  if (isConsoleRefusal(rejection)) {
    return { ...rejection, status: "unavailable" };
  }
  if (isWireErrorEnvelope(rejection)) {
    // The daemon's own code and its own sentence, neither reworded. Rule 9 puts the
    // code in mono and the message verbatim, and a console that composed its own
    // sentence here would be quoting a refusal it had edited.
    return {
      ...refuse(DAEMON_REFUSAL_ORIGIN, rejection.code, rejection.message),
      status: "unavailable",
    };
  }
  return {
    ...refuse(
      READ_SETTLEMENT_REFUSAL_ORIGIN,
      READ_REJECTED_REFUSAL_CODE,
      // The thrown text is carried rather than summarized: it is the only account of
      // what happened, and a read that failed for a reason nobody can read is
      // indistinguishable from one that was never put.
      `The read failed before it produced an answer — ${normalizeWireRejection(rejection, { total: true }).message}`,
    ),
    status: "unavailable",
  };
}
