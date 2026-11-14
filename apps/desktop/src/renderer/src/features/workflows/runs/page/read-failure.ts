// A run page read that failed: the box it stood in names no cause. A refusal a daemon call made is
// already in diagnostics, and an abandoned read is no failure, so only a refusal made on this
// side of the wire is recorded here.

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { DAEMON_REPLY_REFUSAL_ORIGIN } from "#renderer/services/daemon/reply.js";

/**
 * A failed read holding `refusal`, its cause recorded in diagnostics unless a daemon call already
 * did. Call it once per settle.
 */
export function recordedReadFailure(refusal: Refusal): {
  readonly kind: "failed";
  readonly refusal: Refusal;
} {
  recordReadFailure(refusal);
  return { kind: "failed", refusal };
}

/** Record a failed read's cause in diagnostics unless a daemon call already did. Once per settle. */
export function recordReadFailure(refusal: Refusal): void {
  if (refusal.origin !== DAEMON_REPLY_REFUSAL_ORIGIN) {
    recordRejectedRequest(refusal.origin, refusal.code, refusal);
  }
}
