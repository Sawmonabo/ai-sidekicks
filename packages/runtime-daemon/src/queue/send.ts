// Writes a person's send to a session's lead: a new message, which goes into the lead run that is
// live, continues the current one resting interrupted, or starts the next one; an edit of a waiting
// message, which takes its place; and a retry of one not delivered, which goes again as a new
// message with the same words and files while the failed one reads superseded. Each is one write,
// taken under the session's lock its caller holds.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import {
  QUEUE_PERSISTENCE_UNAVAILABLE_CODE,
  QUEUE_RUN_CHANGED_CODE,
  type QueueItemId,
} from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { WriteRefusedError } from "../database/writer.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { refuseUnchangeableSession } from "../session/changes.js";
import type { RunAgentReader } from "../session/run/agent.js";
import { mintUuidV7 } from "../uuid-v7.js";
import type { QueueAdmission } from "./admission.js";
import type { QueueDelivery } from "./delivery.js";
import {
  RETRY_GUARD_STATEMENT_INDEX,
  SEND_GUARD_STATEMENT_INDEX,
  SEND_SESSION_GUARD_STATEMENT_INDEX,
  type QueueRecorder,
  type RecordedSend,
} from "./recorder.js";
import {
  changeRefused,
  leftQueueRefusal,
  queueItemNotFound,
  unreturnedRefusal,
} from "./refusals.js";
import type { QueueRunLifecycle } from "./run-lifecycle.js";
import type { QueueItemBody, QueueItemReader, QueueItemRecord } from "./store.js";

// Reads and writes of a send before a run that keeps moving under it is refused.
const SEND_ATTEMPTS = 3;

/** One message as a send writes it: its new id, what it carries and the key it was sent under. */
export interface QueueSendMessage {
  readonly itemId: QueueItemId;
  readonly body: QueueItemBody;
  readonly clientIdempotencyKey: string;
}

/** What a send reads, writes and calls. */
export interface QueueSendsDeps {
  readonly items: QueueItemReader;
  readonly recorder: Pick<QueueRecorder, "recordSend">;
  readonly delivery: Pick<QueueDelivery, "acceptSend" | "takeBack">;
  readonly admission: Pick<QueueAdmission, "start">;
  readonly lifecycle: Pick<QueueRunLifecycle, "continueInterruptedRun">;
  readonly readLeadAgent: RunAgentReader["readLeadAgent"];
  /** Hands a lead run what waits for it, or moves it on, after a change took messages back. */
  readonly handOrContinue: (sessionId: SessionId, runId: RunId) => void;
  readonly now: () => string;
}

/** Writes a person's sends, edits and retries; the caller holds the session's lock. */
export class QueueSends {
  readonly #deps: QueueSendsDeps;

  constructor(deps: QueueSendsDeps) {
    this.#deps = deps;
  }

  /**
   * A new message: into the lead run that is live, or as the opening of the next one. `retries`
   * names a not-delivered message it sends again, which reads superseded in the same write.
   */
  async send(
    sessionId: SessionId,
    message: QueueSendMessage,
    deviceId: DeviceId,
    retries?: QueueItemRecord,
  ): Promise<QueueItemRecord> {
    const { items, delivery, lifecycle, admission } = this.#deps;
    for (let attempt = 1; ; attempt += 1) {
      const liveRunId = items.readLiveLeadRun(sessionId);
      const current = liveRunId === undefined ? items.readCurrentLeadRun(sessionId) : undefined;
      const interruptedRunId = current?.state === "interrupted" ? current.runId : undefined;
      const runId = liveRunId ?? interruptedRunId ?? RunIdSchema.parse(mintUuidV7());
      const send: RecordedSend = {
        item: {
          id: message.itemId,
          sessionId,
          body: message.body,
          targetRunId: runId,
          deviceId,
          clientIdempotencyKey: message.clientIdempotencyKey,
          replacesQueueItemId: undefined,
          now: this.#deps.now(),
        },
        deviceId,
        route:
          liveRunId !== undefined
            ? { kind: "live_run" }
            : interruptedRunId !== undefined
              ? { kind: "interrupted_run" }
              : {
                  kind: "new_run",
                  queued: {
                    sessionId,
                    runId,
                    runVersion: 0,
                    newState: "queued",
                    agentId: this.#deps.readLeadAgent(sessionId),
                  },
                },
        retries,
      };
      let recorded: QueueItemRecord;
      try {
        recorded = await this.#record(send);
      } catch (error) {
        if (retries !== undefined && isRefusalAt(error, RETRY_GUARD_STATEMENT_INDEX)) {
          // The agent took the failed message after all, or another retry replaced it, meanwhile.
          const left = items.get(retries.id);
          throw left === undefined ? queueItemNotFound(retries.id) : leftQueueRefusal(left);
        }
        // The lead run ended, started or was continued between the read and the write.
        if (!isRefusalAt(error, SEND_GUARD_STATEMENT_INDEX)) {
          throw error;
        }
        if (attempt < SEND_ATTEMPTS) {
          continue;
        }
        throw new DaemonDomainError(
          "The session's lead run kept changing while the message was queued; nothing was queued",
          {
            code: QUEUE_RUN_CHANGED_CODE,
            jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
            cause: error,
          },
        );
      }
      if (liveRunId !== undefined) {
        delivery.acceptSend(recorded, runId);
      } else if (interruptedRunId !== undefined) {
        lifecycle.continueInterruptedRun(sessionId, runId);
      } else {
        admission.start(sessionId, runId);
      }
      return recorded;
    }
  }

  /**
   * Replaces the lead's message `replacesQueueItemId`: one still waiting is edited in its place, and
   * one not delivered is sent again with its own words and files. Refuses an item the lead's queue
   * of the session does not hold (`queue.item_not_found`), one that has left the queue otherwise
   * (`queue.change_refused`), and a retry whose words differ from the failed message's
   * (`not_delivered`).
   */
  async replace(
    sessionId: SessionId,
    replacesQueueItemId: QueueItemId,
    message: QueueSendMessage,
    deviceId: DeviceId,
  ): Promise<QueueItemRecord> {
    const replaces = this.#deps.items.get(replacesQueueItemId);
    if (
      replaces === undefined ||
      replaces.sessionId !== sessionId ||
      replaces.childHandle !== undefined
    ) {
      throw queueItemNotFound(replacesQueueItemId);
    }
    if (replaces.state === "not_delivered") {
      return await this.#retry(replaces, message, deviceId);
    }
    // Admitted reads taken; replaced or removed, it has left the queue.
    if (replaces.state !== "queued") {
      throw leftQueueRefusal(replaces);
    }
    // An edit goes into its message's run; a waiting message the daemon wrote for no run has none.
    if (replaces.targetRunId === undefined) {
      throw queueItemNotFound(replacesQueueItemId);
    }
    return await this.#edit(replaces, replaces.targetRunId, message, deviceId);
  }

  // A retry: the failed message's own body goes again as a new message at the queue's end. Its
  // question was marked answered by the first send's row, so the new row marks it no second time.
  async #retry(
    failed: QueueItemRecord,
    message: QueueSendMessage,
    deviceId: DeviceId,
  ): Promise<QueueItemRecord> {
    if (message.body.content !== failed.body.content) {
      throw changeRefused(
        "not_delivered",
        `Queue item ${failed.id} reads not delivered; only its own words can be sent again`,
      );
    }
    const { answersQuestionId: _answered, ...body } = failed.body;
    return await this.send(failed.sessionId, { ...message, body }, deviceId, failed);
  }

  // An edit: the message takes the waiting one's place, which reads `superseded`. Claude Code
  // gives back the old message and every one after it first, and they go again in order after.
  async #edit(
    replaces: QueueItemRecord,
    runId: RunId,
    message: QueueSendMessage,
    deviceId: DeviceId,
  ): Promise<QueueItemRecord> {
    const { sessionId } = replaces;
    // The edited message and every one after it are taken back at once; one the provider took or
    // kept meanwhile stays out, and the rest go again after the edit.
    const later = this.#deps.items
      .listWaitingForRun(runId)
      .filter((item) => item.id !== replaces.id && item.position > replaces.position);
    try {
      const withdrawal =
        (await this.#deps.delivery.takeBack(sessionId, [replaces, ...later])).get(replaces.id) ??
        "taken";
      if (withdrawal !== "returned") {
        throw unreturnedRefusal(replaces.id, withdrawal);
      }
      return await this.#record({
        item: {
          id: message.itemId,
          sessionId,
          body: message.body,
          targetRunId: runId,
          deviceId,
          clientIdempotencyKey: message.clientIdempotencyKey,
          replacesQueueItemId: replaces.id,
          now: this.#deps.now(),
        },
        deviceId,
        route: { kind: "edit", replaces },
        retries: undefined,
      });
    } catch (error) {
      if (isRefusalAt(error, SEND_GUARD_STATEMENT_INDEX)) {
        throw changeRefused("already_taken", `Queue item ${replaces.id} has left the queue`);
      }
      throw error;
    } finally {
      this.#deps.handOrContinue(sessionId, runId);
    }
  }

  // Writes a send: a session that stopped taking messages is refused as such, and a store that
  // cannot keep it as unavailable.
  async #record(send: RecordedSend): Promise<QueueItemRecord> {
    try {
      return await this.#deps.recorder.recordSend(send);
    } catch (error) {
      if (isRefusalAt(error, SEND_SESSION_GUARD_STATEMENT_INDEX)) {
        refuseClosedSession(this.#deps.items, send.item.sessionId);
      }
      if (error instanceof WriteRefusedError) {
        throw error;
      }
      throw new DaemonDomainError("The queue could not store the message; nothing was queued", {
        code: QUEUE_PERSISTENCE_UNAVAILABLE_CODE,
        cause: error,
      });
    }
  }
}

/** Refuses a session that no longer takes messages: closed, or being purged. */
export function refuseClosedSession(
  items: Pick<QueueItemReader, "readSessionState">,
  sessionId: SessionId,
): void {
  const state = items.readSessionState(sessionId);
  if (state !== undefined) {
    refuseUnchangeableSession(sessionId, state);
  }
}

function isRefusalAt(error: unknown, statementIndex: number): boolean {
  return error instanceof WriteRefusedError && error.statementIndex === statementIndex;
}
