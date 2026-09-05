// How a growth read ENDS, when the seam it travels can also REJECT.
//
// A growth operation answers with an outcome a surface narrows on, and the reads
// built on it were written as though that were the only way one could finish. It is
// not. The scripted-reply seam has a fourth settlement the outcome union deliberately
// has no arm for: a scenario that scripts a DAEMON refusal is thrown verbatim and
// unwrapped, because a growth-scoped code for it would paraphrase the daemon's own
// envelope — and the live seam will throw the same shape the day the wire lands and
// the operation becomes an ordinary bridge call.
//
// Attaching only a fulfilment handler therefore left the rejection unhandled and the
// surface in `reading` for the life of the window: a spinner over an answer that had
// already arrived. That is the one shape a read must never take, because rule 8's
// `not-loaded` promises an answer that is still coming, and here none is.
//
// WHY IT LIVES IN `bridge/` RATHER THAN IN THE FAMILY THAT FIRST NEEDED IT. It is
// generic over the whole outcome and knows nothing about workflows: what it settles
// is a promise the GROWTH PORT returned, so `bridge/` is the lowest family on the
// console's DAG that owns its input. It was written inside `workflows/`, which made
// it unreachable to `bridge/session-directory.ts` — the fourth read on this same
// seam, one family below — and that read went without it, attaching a fulfilment
// handler alone and leaving a rejecting directory reading forever. A view family
// reaches it through this family's door; the two modules inside `bridge/` that need
// it reach it directly.
//
// WHAT IS LEFT HERE IS THE SETTLEMENT, AND THE CLASSIFICATION IS NOT. This module
// used to carry its own four-armed reading of a thrown value — a bare refusal, one
// carried inside a `ConsoleRefusalError`, a flat wire envelope, and everything else —
// and it is one of six families that each wrote that reading down. `core/
// wire-rejection.ts` is now the one that runs, and it is strictly better on two
// counts this copy got wrong: it recovers the dotted project code the JSON-RPC
// envelope carries at `data.type`, which this copy dropped on the floor, and it
// rebuilds every arm from bounded strings rather than letting the thrown value ride
// onto the refusal, where its next property access is a throw outside every `catch`.
//
// ONE ORIGIN, WHERE THIS MODULE USED TO NAME TWO. A wire envelope was attributed to
// `daemon` and everything else to this seam, and the distinction does not need the
// origin to carry it: the daemon's own CODE arrives verbatim under rule 9 and a
// synthesized one is built from the origin, so `workflow.session_not_found` and
// `growth-read-call-failed` are already the two different things a reader is being
// told. What the origin says now is which seam the refusal surfaced at, which is what
// it says everywhere else in the console.
//
// WHY THIS IS NOT A SECOND REFUSAL VOCABULARY. `GrowthUnavailable` already extends
// `ConsoleRefusal`, so an outcome the port itself refused passes through untouched and
// both arms reach one `RefusalBanner` with no translation between them. What this adds
// is the settlement, not a shape.

import { normalizeWireRejection, type WireRefusal } from "../core/index.js";

/** The origin on a refusal this seam composes, and the one it relays under. */
export const READ_SETTLEMENT_REFUSAL_ORIGIN = "growth-read";

/**
 * A refusal a settled read carries, whoever raised it.
 *
 * The console's one refusal shape plus the discriminant the outcome union narrows on,
 * and nothing more: `GrowthUnavailable` widens this same shape with what the growth
 * port knows, so a port refusal satisfies it without being rebuilt. `WireRefusal` and
 * not `ConsoleRefusal`, so the retry bound a rate-limited refusal carries is on the
 * type a surface reads rather than riding along unannounced.
 */
export type SettledReadRefusal = WireRefusal & { readonly status: "unavailable" };

/**
 * Settle a growth read, so its caller has one value to narrow on.
 *
 * Generic over the whole outcome rather than over its served value: what the port
 * answers with is the port's business, and this seam only adds the arm a rejection
 * takes. Typed the other way it would have to name `GrowthOutcome`, which does not
 * leave the bridge's door, and a second declaration of the served arm here would be
 * one closed shape with two homes.
 *
 * No fallback is supplied, and that is the reading rather than an omission: the
 * fallback arm answers a FIXED sentence, and the text a rejection carried is the only
 * account of what happened. The normalizer's terminal arm keeps it — an `Error` gives
 * up its message and anything else goes through the total stringifier — under a code
 * built from the origin above, so a read that failed for a reason nobody can read is
 * still distinguishable from one that was never put.
 */
export async function settleGrowthRead<TOutcome>(
  read: Promise<TOutcome>,
): Promise<TOutcome | SettledReadRefusal> {
  try {
    return await read;
  } catch (rejection) {
    return {
      ...normalizeWireRejection(READ_SETTLEMENT_REFUSAL_ORIGIN, rejection),
      status: "unavailable",
    };
  }
}
