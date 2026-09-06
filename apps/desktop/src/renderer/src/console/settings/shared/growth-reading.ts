// What a surface holds for ONE growth-port read: the port's answer, or why there is none.
//
// The growth port's contract is that every operation RESOLVES with a
// `GrowthOutcome` — served, or `unavailable` with the reason on it — so the ordinary
// refusal already travels inside the outcome. A REJECTION is a different fact: the
// call produced no outcome at all, and the outcome union has no member for it,
// because its refusal arm carries a closed code vocabulary the port owns and this
// console does not.
//
// A cell holding only the outcome therefore had one arm too few, and the missing arm
// is the one that matters most: a `.then` with no rejection handler leaves the cell
// untouched, so the surface keeps rendering its not-loaded absence — "reading this
// session's receipt" — for the life of the window while an unhandled rejection
// reaches the window. That is a read that FAILED reported as a read still IN FLIGHT,
// which is the conflation the console's five kinds of nothing exist to prevent.
//
// GENERIC IN THE OUTCOME because the shape is the same for every one-shot read and
// two copies of it would be two vocabularies for one fact. It lives in `settings/`
// beside the two pages that hold it today; `collaboration/invites/invite-ledger.ts`
// declares the same two arms for its own read, and the home those two could share is
// `bridge/`, beside `GrowthOutcome` itself. The SESSIONS family is deliberately not
// counted in: `sessions/invitations/invite-shelf-reading.ts` folds a fan-out over many
// sessions into a completeness scope, which is a different shape and not a third copy
// of this one.

import type { ConsoleRefusal } from "../../core/index.js";

/** The port's own answer, or the refusal a call that produced none was read as. */
export type GrowthReading<TOutcome> =
  | { readonly kind: "answered"; readonly outcome: TOutcome }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal };
