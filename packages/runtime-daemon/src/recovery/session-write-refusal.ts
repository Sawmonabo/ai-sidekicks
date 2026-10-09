// The one refusal a session with damaged history gives each write: at the wire for a call that
// names it, and at the append for every event of it, whoever writes.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { SESSION_WRITE_REFUSED_CODE } from "@ai-sidekicks/contracts/session/recovery";

import { DAMAGED_EVENTS_SKIPPED_TYPE } from "../events/session/skipped-ranges.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import type { RecoveryStatusTracker } from "./status.js";

/**
 * Throws `session.write_refused` when the session's history is damaged; `write` names what was
 * refused, a method or an event type.
 */
export function refuseWriteToDamagedSession(
  status: Pick<RecoveryStatusTracker, "readSessionWriteRefusal">,
  sessionId: SessionId,
  write: string,
): void {
  const refusal = status.readSessionWriteRefusal(sessionId);
  if (refusal === undefined) {
    return;
  }
  throw new DaemonDomainError(
    `Session ${sessionId} is not taking ${write}: its history is damaged (${refusal.recovery})`,
    {
      code: SESSION_WRITE_REFUSED_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { ...refusal },
    },
  );
}

/**
 * Throws `session.write_refused` for an event of a session whose history is damaged, except the
 * one event that continues it from its last good point.
 */
export function refuseEventOfDamagedSession(
  status: Pick<RecoveryStatusTracker, "readSessionWriteRefusal">,
  sessionId: SessionId,
  eventType: string,
): void {
  if (eventType !== DAMAGED_EVENTS_SKIPPED_TYPE) {
    refuseWriteToDamagedSession(status, sessionId, eventType);
  }
}
