// A thrown or rejected value, coerced into the one refusal shape.
//
// `store/reads/push-driven-read.ts` builds its failure arm with this, and a MUTATION —
// which has no read to route through — needs exactly the same translation, so it is a
// free function below both. The fallback code set it defaults from sits below it too,
// in `reads/read-failure-codes.ts`.

import { ConsoleRefusalError, isConsoleRefusal, type ConsoleRefusal } from "./refusal.js";
import { normalizeWireRejection } from "./wire-rejection.js";
import { wireRejectionToError } from "./wire-errors.js";
import { READ_FAILED } from "./reads/read-failure-codes.js";

/**
 * The refusal a rejection is, in the console's one refusal shape.
 *
 * TWO ARMS, and the first is the whole reason this function still exists beside
 * `core/wire-rejection.ts`. A refusal this console already built and threw is handed
 * back BY REFERENCE: the normalizer REBUILDS from the three members it reads —
 * deliberately, so nothing of a hostile rejection survives onto the answer — which
 * would drop any member a console-built refusal carries beyond those. So a value that
 * is already a `ConsoleRefusal` is not renormalized.
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
