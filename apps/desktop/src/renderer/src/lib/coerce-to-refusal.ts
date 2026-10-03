// A thrown or rejected value, coerced into the one refusal shape. A mutation, which has no read
// to route through, needs the same translation as `store/reads/push-driven-read.ts`.

import { RefusalError, isRefusal, type Refusal } from "./refusal.js";
import { normalizeWireRejection } from "./wire-rejection.js";
import { wireRejectionToError } from "./wire-errors.js";
import { READ_FAILED } from "./reads/read-failure-codes.js";

/**
 * The refusal a rejection is, in the app's one refusal shape.
 *
 * A value that is already a `Refusal` is returned by reference, because
 * `normalizeWireRejection` rebuilds from three members and would drop any others a
 * app-built refusal carries. Everything else goes to `normalizeWireRejection`, which is
 * total. `fallbackCode` is the caller's code for a rejection that carried none of its own, so a
 * failed write is not reported as `read-failed`; the detail is the thrower's own message.
 */
export function coerceToRefusal(
  error: unknown,
  origin: string,
  fallbackCode: string = READ_FAILED,
): Refusal {
  if (error instanceof RefusalError) {
    return error.refusal;
  }
  if (isRefusal(error)) {
    return error;
  }
  return normalizeWireRejection(origin, error, {
    code: fallbackCode,
    detail: wireRejectionToError(error).message,
  });
}
