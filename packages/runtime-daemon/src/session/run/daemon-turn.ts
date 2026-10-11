// The queued run of a turn the daemon or its provider starts on a session as the session's own
// run. A session has one live lead run, so such a run is queued only while none is live, and a
// turn the daemon starts also waits while a lead message waits for the session's interrupted lead
// run, whose continue is the session's next turn. A turn in a process of its own takes no turn of
// the session's, so its run is no lead run and waits for neither.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import { ProviderAccountIdSchema } from "@ai-sidekicks/contracts/provider/account/record";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";

import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError } from "../../database/writer.js";
import type { SessionEventAppender } from "../../events/session/appender.js";
import { noContinueWaitingStatement, noLiveLeadRunStatement } from "../../queue/store.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { insertQueuedRunStatement } from "./projection.js";
import { SessionTurnHeldError } from "./refusals.js";
import type { DaemonTurnStartRequest } from "./start-request.js";

/**
 * Writes `run.queued` for a daemon turn's run under a new id, naming the session's lead `agentId`
 * and no parent, and resolves with that id. Refuses with {@link SessionTurnHeldError}, writing
 * nothing, while a lead run of the session is live, and for a turn the daemon starts while a lead
 * message waits for the session's interrupted lead run; a turn apart from the session's process
 * is never refused, and its run is marked apart.
 */
export async function queueDaemonTurnRun(
  appender: Pick<SessionEventAppender, "append">,
  request: DaemonTurnStartRequest,
  agentId: AgentId,
): Promise<RunId> {
  const accountId = request.admittedProviderAccountId;
  const queued: RunQueuedPayload = {
    sessionId: request.sessionId,
    runId: RunIdSchema.parse(mintUuidV7()),
    runVersion: 0,
    newState: "queued",
    agentId,
    ...(accountId === null
      ? {}
      : { admittedProviderAccountId: ProviderAccountIdSchema.parse(accountId) }),
    ...(request.isApart === true ? { isApart: true } : {}),
  };
  const guards: WriteStatement[] = [];
  if (request.isApart !== true) {
    guards.push(noLiveLeadRunStatement(request.sessionId));
    if (!request.isProviderStarted) {
      guards.push(noContinueWaitingStatement(request.sessionId));
    }
  }
  try {
    await appender.append("run.queued", queued, {
      transactionalPrelude: [...guards, insertQueuedRunStatement(queued)],
    });
  } catch (error) {
    if (error instanceof WriteRefusedError && error.statementIndex < guards.length) {
      throw new SessionTurnHeldError(request.sessionId);
    }
    throw error;
  }
  return queued.runId;
}
