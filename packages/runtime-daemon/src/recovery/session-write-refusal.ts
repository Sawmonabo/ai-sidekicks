// The one refusal a session with damaged history, or one the restart's pass is still rebuilding,
// gives each write: at the wire for a call that names it, and at the append for every event of
// it, whoever writes and however the writer found the session, until the pass comes to settle the
// session's runs.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  SESSION_WRITE_REFUSED_CODE,
  type SessionWriteRefusedDetails,
} from "@ai-sidekicks/contracts/session/recovery";

import { DAMAGED_EVENTS_SKIPPED_TYPE } from "../events/session/skipped-ranges.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import type { RecoveryStatusTracker } from "./status.js";

/**
 * Throws `session.write_refused` when the restart's pass is still rebuilding the session or its
 * history is damaged; `method` names the call refused.
 */
export function refuseCallNamingSession(
  status: Pick<RecoveryStatusTracker, "readSessionCallRefusal">,
  sessionId: SessionId,
  method: string,
): void {
  const refusal = status.readSessionCallRefusal(sessionId);
  if (refusal !== undefined) {
    throw sessionWriteRefusal(refusal, method);
  }
}

/**
 * Throws `session.write_refused` for an event of a session whose history is damaged, except the
 * one event that continues it from its last good point, or of a session the restart's pass is
 * still rebuilding and has yet to settle the runs of.
 */
export function refuseSessionEvent(
  status: Pick<RecoveryStatusTracker, "readSessionAppendRefusal">,
  sessionId: SessionId,
  eventType: string,
): void {
  const refusal =
    eventType === DAMAGED_EVENTS_SKIPPED_TYPE
      ? undefined
      : status.readSessionAppendRefusal(sessionId);
  if (refusal !== undefined) {
    throw sessionWriteRefusal(refusal, eventType);
  }
}

function sessionWriteRefusal(
  refusal: SessionWriteRefusedDetails,
  write: string,
): DaemonDomainError {
  const why =
    refusal.recovery === "rebuilding"
      ? "the restart's recovery is rebuilding it"
      : `its history is damaged (${refusal.recovery})`;
  return new DaemonDomainError(`Session ${refusal.sessionId} is not taking ${write}: ${why}`, {
    code: SESSION_WRITE_REFUSED_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
    detail: { ...refusal },
  });
}
