// A daemon reply, unwrapped into the value it served or the refusal it is.
//
// SPLIT OUT OF `push-driven-read.ts` because these three answer a different question
// from the model beside them. The model owns a subscription, a scheduler, and a
// teardown; these are free functions over a reply's own discriminant, and a MUTATION
// — which has no read to route through — needs exactly the same translation. They sat
// in that module only because the first caller was that model.
//
// THE DIRECTION OF THE EDGE IS LOAD-BEARING. `push-driven-read.ts` imports this
// module and not the reverse: the model's failure arm is built by `consoleRefusalFrom`,
// while nothing here knows a push-driven read exists. The one thing both sides name —
// the fallback code set — therefore sits below both, in `read-failure-codes.ts`.

import {
  ConsoleRefusalError,
  isConsoleRefusal,
  normalizeWireRejection,
  type ConsoleRefusal,
} from "../../core/index.js";
import { wireRejectionToError } from "../../../../../shared/wire-errors.js";
import type { DaemonReply, GrowthOutcome } from "../../bridge/index.js";
import { READ_FAILED } from "./read-failure-codes.js";

/**
 * The refusal a rejection is, in the console's one refusal shape.
 *
 * TWO ARMS, and the first is the whole reason this function still exists beside
 * `core/wire-rejection.ts`. A refusal this console already built and threw is handed
 * back BY REFERENCE: a `GrowthUnavailable` carries `operationId`, `slateRow`, and
 * `owningDocument` beside the three members every refusal has, and the normalizer
 * REBUILDS from the three it reads — deliberately, so nothing of a hostile rejection
 * survives onto the answer — which would drop exactly the part that says who owes
 * the wire. So a value that is already a `ConsoleRefusal` is not renormalized.
 *
 * Everything else goes to `normalizeWireRejection`, which is total and owns every
 * other reading: a daemon envelope keeps its own code (folding those into
 * `read-failed` rendered one generic code for a permission denial, a missing
 * session, and a broken transport), a tRPC-shaped rejection keeps its dotted type,
 * and a value whose own property access throws still answers a refusal.
 *
 * A free function rather than a private method because a MUTATION's rejection needs
 * exactly this translation and has no read to route through: a second copy of these
 * lines is the duplicate refusal constructor `apps/desktop/AGENTS.md` forbids.
 *
 * `fallbackCode` names WHICH failure produced it, for a rejection that carried no
 * code of its own — and it is the CALLER's word rather than this module's set,
 * because a preference write that rejected is neither of the two a push-driven read
 * has, and reporting it as `read-failed` would tell a reader the wrong thing about
 * an act that changed something. The DETAIL that travels with it is the thrower's
 * own message, read through the repository's total stringifier, so a refusal this
 * console synthesizes still carries the author's words rather than a guess.
 */
export function consoleRefusalFrom(
  error: unknown,
  origin: string,
  fallbackCode: string = READ_FAILED,
): ConsoleRefusal {
  if (error instanceof ConsoleRefusalError) {
    return error.refusal;
  }
  if (isConsoleRefusal(error)) {
    return error;
  }
  return normalizeWireRejection(origin, error, {
    code: fallbackCode,
    detail: wireRejectionToError(error, { total: true }).message,
  });
}

/**
 * The value a daemon reply served, raised as a throw where it refused instead.
 *
 * The call door answers a closed `served | refused` value and never throws, and a
 * read body here has to answer a VALUE or throw, because rule 1 puts the subscribe
 * first and the failure arm this model settles into is fed by its own `catch`. So
 * the two shapes meet in exactly one place, here, rather than in a four-line branch
 * at each of the console's live reads.
 *
 * A `ConsoleRefusalError` and not a bare `Error`, so {@link consoleRefusalFrom} on
 * the other side of that `catch` recognises it and hands the door's refusal back
 * VERBATIM — the code the daemon wrote, the sentence it wrote, the origin that says
 * which seam answered. Wrapping it in anything else would relabel a permission
 * denial as `read-failed` on the way through the very mechanism that exists to stop
 * that.
 */
export function servedValueOrRaise<TValue>(reply: DaemonReply<TValue>): TValue {
  if (reply.status === "refused") {
    throw new ConsoleRefusalError(reply.refusal);
  }
  return reply.value;
}

/**
 * The value a growth operation served, raised as a throw where it refused instead.
 *
 * {@link servedValueOrRaise}'s twin, and two functions rather than one over both
 * unions: the two seams discriminate on different words (`refused` against
 * `unavailable`) because they refuse for different reasons — a registered wire that
 * answered badly, against a wire the corpus has not registered at all — and one
 * helper spanning them would have to accept either word, which is how a caller ends
 * up unable to tell those apart.
 *
 * `GrowthUnavailable` IS a `ConsoleRefusal`, so the throw carries the port's own
 * refusal whole: its code, its sentence, and the operation and owning document a
 * growth refusal names. Rebuilding it would drop exactly the part that says who owes
 * the wire.
 */
export function servedGrowthValueOrRaise<TValue>(outcome: GrowthOutcome<TValue>): TValue {
  if (outcome.status === "unavailable") {
    throw new ConsoleRefusalError(outcome);
  }
  return outcome.value;
}
