// The approval service: raises an ask, records its one answer, and cancels the asks a run's end or
// a session's close leaves open. Each step is one write carrying its row change, its guards and its
// `approval.*` event, so the log and the rows never disagree, and a decision read before the write
// is checked again by a guarded statement inside it.
//
//   * Nothing settles an ask on elapsed time: no deadline is stamped and no timer is armed. An ask
//     waits until it is answered, or until its run ends or its session closes, which cancel it.
//   * The first answer from any device settles an ask. The same answer sent again, under the same
//     client resolution id, is answered with what was saved; any other is refused.
//   * The run is told once an ask blocks it and once its answer lands, each after the commit, by
//     the listener the run engine registers; a cancellation tells it nothing, since the run has
//     already ended.
//   * An approval marks the session's working folder stale, after the commit, since work the person
//     has not seen may land there; a decline and a cancellation mark nothing.

import type { Database } from "better-sqlite3";

import {
  ApprovalRequestIdSchema,
  type ApprovalDecision,
  type ApprovalRequestedPayload,
  type ApprovalRequestId,
  type ApprovalResolveRequest,
  type ApprovalResolveResponse,
} from "@ai-sidekicks/contracts/approval";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import type { ServiceLogWriter } from "../daemon/service-log.js";
import { WriteRefusedError } from "../database/writer.js";
import type { SessionEventLog } from "../events/session/appender.js";
import type { WorkingFolderWatcher } from "../git/worktree/watch.js";
import { describeRejection } from "../rejection.js";
import { mintUuidV7 } from "../uuid-v7.js";
import { ApprovalEventEmitter } from "./event-emitter.js";
import {
  ApprovalAlreadyResolvedError,
  ApprovalLateCreateError,
  ApprovalNotFoundError,
  ApprovalPersistenceUnavailableError,
  ApprovalRequestCanceledError,
  ApprovalResolutionInvalidError,
} from "./refusals.js";
import {
  ApprovalRequestCreateRequestSchema,
  type ApprovalRequestCreateRequest,
  type ApprovalRequestCreateResponse,
  type ApprovalRequestOrigin,
} from "./request-create.js";
import {
  ApprovalRequestReader,
  askUnclaimedStatement,
  insertRequestStatement,
  insertResolutionStatement,
  runLiveStatement,
  sessionOpenStatement,
  settlePendingStatement,
  type StoredApprovalRequest,
} from "./store.js";

/**
 * Hears each ask that blocks a run, once it is recorded, and its answer, once that is recorded.
 * Every ask blocks its run as `waiting_for_approval`; a decline lets the run go on with the action
 * refused, never ends it.
 *
 * @consumedBy the run engine, which parks a run on its ask and resumes it on the answer
 */
export interface ApprovalOutcomeListener {
  onBlocking(
    runId: RunId,
    approvalRequestId: ApprovalRequestId,
    blockingState: "waiting_for_approval",
  ): Promise<void>;
  onResolved(
    runId: RunId,
    approvalRequestId: ApprovalRequestId,
    outcome: ApprovalDecision,
  ): Promise<void>;
}

/**
 * What the approval service reads, writes and follows.
 *
 * @consumedBy the daemon's start, which runs the approval service
 */
export interface ApprovalServiceDeps {
  /** The read-only connection the asks and the sessions are read on. */
  readonly reader: Database;
  readonly sessionEvents: SessionEventLog;
  /** Follows every session's events; `onGap` names a session whose missed events went unread. */
  readonly followAll: (
    onCommitted: (event: EventEnvelope) => void,
    onGap: (sessionId: SessionId) => void,
  ) => () => void;
  readonly workingFolders: Pick<WorkingFolderWatcher, "raiseStaleness">;
  readonly writeServiceLog: ServiceLogWriter;
  /** Source of every recorded instant (ISO 8601, millisecond precision). */
  readonly now?: () => string;
}

// The positions of the create's three guards among its statements.
const ASK_UNCLAIMED_GUARD_INDEX = 0;
const SESSION_OPEN_GUARD_INDEX = 1;
const RUN_LIVE_GUARD_INDEX = 2;
// The position of the answer's pending guard among its statements.
const PENDING_GUARD_INDEX = 0;

/** Raises asks, records their answers and cancels the ones their run or session leaves open. */
export class ApprovalService {
  readonly #deps: ApprovalServiceDeps;
  readonly #requests: ApprovalRequestReader;
  readonly #events: ApprovalEventEmitter;
  readonly #now: () => string;
  // The sweeps of closed sessions under way, which a stop waits for.
  readonly #sweeps = new Set<Promise<void>>();
  #listener: ApprovalOutcomeListener | undefined;
  #detachFromLog: (() => void) | undefined;

  constructor(deps: ApprovalServiceDeps) {
    this.#deps = deps;
    this.#requests = new ApprovalRequestReader(deps.reader);
    this.#events = new ApprovalEventEmitter(deps.sessionEvents);
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Registers the one listener the run engine keeps on blocked and answered asks. Throws when one is
   * already registered. Until one is, no run hears of its asks.
   *
   * @consumedBy the run engine, which parks a run on its ask and resumes it on the answer
   */
  registerApprovalOutcomeListener(listener: ApprovalOutcomeListener): void {
    if (this.#listener !== undefined) {
      throw new Error("An approval outcome listener is already registered");
    }
    this.#listener = listener;
  }

  /**
   * Follows the log to cancel the asks of every session that closes, and cancels at once those of
   * sessions that closed while the daemon was down.
   *
   * @consumedBy the daemon's start, which runs the approval service
   */
  start(): void {
    this.#detachFromLog = this.#deps.followAll(
      (event) => {
        if (event.type === "session.closed") {
          this.#sweepEndedSession(event.sessionId);
        }
      },
      (sessionId) => {
        if (this.#requests.isSessionEnded(sessionId)) {
          this.#sweepEndedSession(sessionId);
        }
      },
    );
    for (const sessionId of this.#requests.listEndedSessionsWithPending()) {
      this.#sweepEndedSession(sessionId);
    }
  }

  /**
   * Stops following the log and waits for the sweeps under way.
   *
   * @consumedBy the daemon's stop
   */
  async stop(): Promise<void> {
    this.#detachFromLog?.();
    await Promise.all(this.#sweeps);
  }

  /**
   * Raises one ask, pending until it is answered or canceled, and tells the run it blocks once it
   * is recorded. `origin` carries what only the daemon knows: the provider ask it was minted for
   * and the tool call it holds. A provider ask sent again, as a replay after a reconnect, is
   * answered with the request it already has, whatever its state, and records and tells nothing.
   * Throws the schema's error for a request that does not parse, before anything is written;
   * `approval.request_canceled` with a `reason` when the session has closed or the run has ended;
   * and `approval.persistence_unavailable` when the record could not be kept.
   */
  async create(
    request: ApprovalRequestCreateRequest,
    origin: ApprovalRequestOrigin = {},
  ): Promise<ApprovalRequestCreateResponse> {
    const parsed = ApprovalRequestCreateRequestSchema.parse(request);
    const approvalRequestId = ApprovalRequestIdSchema.parse(mintUuidV7());
    const createdAt = this.#now();
    const payload: ApprovalRequestedPayload = {
      sessionId: parsed.sessionId,
      runId: parsed.runId,
      approvalRequestId,
      category: parsed.category,
      scope: parsed.scope,
      requestedBy: parsed.requestedBy,
      resourceDescriptor: parsed.resourceDescriptor,
      ...(origin.askId === undefined ? {} : { askId: origin.askId }),
      ...(origin.toolCallId === undefined ? {} : { toolCallId: origin.toolCallId }),
    };
    try {
      await this.#events.requested(payload, {
        occurredAt: createdAt,
        statements: [
          askUnclaimedStatement(parsed.runId, origin.askId),
          sessionOpenStatement(parsed.sessionId),
          runLiveStatement(parsed.sessionId, parsed.runId),
          insertRequestStatement({ ...parsed, approvalRequestId, askId: origin.askId, createdAt }),
        ],
      });
    } catch (error) {
      if (
        error instanceof WriteRefusedError &&
        error.statementIndex === ASK_UNCLAIMED_GUARD_INDEX &&
        origin.askId !== undefined
      ) {
        return this.#answerRepeatedAsk(parsed, origin.askId);
      }
      if (error instanceof WriteRefusedError && error.statementIndex === SESSION_OPEN_GUARD_INDEX) {
        throw new ApprovalLateCreateError(parsed.sessionId, parsed.runId, "session_closed");
      }
      if (error instanceof WriteRefusedError && error.statementIndex === RUN_LIVE_GUARD_INDEX) {
        throw new ApprovalLateCreateError(parsed.sessionId, parsed.runId, "run_ended");
      }
      throw new ApprovalPersistenceUnavailableError(error);
    }
    await this.#listener?.onBlocking(parsed.runId, approvalRequestId, "waiting_for_approval");
    return { approvalRequestId };
  }

  // The request a provider ask already has. Only its session's purge deletes the row the guard
  // found, so one gone since is an ask of a session being deleted.
  #answerRepeatedAsk(
    request: ApprovalRequestCreateRequest,
    askId: string,
  ): ApprovalRequestCreateResponse {
    const existing = this.#requests.readAskRequest(request.runId, askId);
    if (existing === undefined) {
      throw new ApprovalLateCreateError(request.sessionId, request.runId, "session_closed");
    }
    return { approvalRequestId: existing.approvalRequestId };
  }

  /**
   * Records one answer to an ask, stamped with `answeringDeviceId`, the device whose connection
   * carried it, and tells the run once it is recorded. The scope defaults to the ask's own. Throws
   * `approval.not_found`, `approval.request_canceled`, `approval.already_resolved` for an ask
   * another answer settled (the same client resolution id is answered with what was saved),
   * `approval.resolution_invalid` for an answer that does not fit its ask, and
   * `approval.persistence_unavailable` when the record could not be kept. The `approval.resolve`
   * handler reads the answering device off the call it arrived on.
   */
  async resolve(
    request: ApprovalResolveRequest,
    answeringDeviceId: DeviceId,
  ): Promise<ApprovalResolveResponse> {
    const stored = this.#requests.readRequest(request.approvalRequestId);
    if (stored === undefined) {
      throw new ApprovalNotFoundError(request.approvalRequestId);
    }
    if (stored.state !== "pending") {
      return answerSettled(stored, request);
    }
    const effectiveScope = request.effectiveScope ?? stored.scope;
    refuseUnfitAnswer(stored, request, effectiveScope);
    const resolvedAt = this.#now();
    try {
      await this.#events.resolved(
        request.decision,
        {
          sessionId: stored.sessionId,
          runId: stored.runId,
          approvalRequestId: stored.approvalRequestId,
          category: stored.category,
          scope: stored.scope,
          effectiveScope,
          deviceId: answeringDeviceId,
          clientResolutionId: request.clientResolutionId,
        },
        {
          occurredAt: resolvedAt,
          statements: [
            settlePendingStatement(stored.approvalRequestId, request.decision, resolvedAt),
            insertResolutionStatement({
              approvalRequestId: stored.approvalRequestId,
              deviceId: answeringDeviceId,
              clientResolutionId: request.clientResolutionId,
              decision: request.decision,
              effectiveScope,
              rememberedScope: request.rememberedScope,
              resolvedAt,
            }),
          ],
        },
      );
    } catch (error) {
      if (error instanceof WriteRefusedError && error.statementIndex === PENDING_GUARD_INDEX) {
        // Settled between the read and the write; rows are never deleted while the daemon holds
        // the session, so the ask reads back.
        const settled = this.#requests.readRequest(stored.approvalRequestId);
        if (settled === undefined) {
          throw new ApprovalNotFoundError(stored.approvalRequestId);
        }
        return answerSettled(settled, request);
      }
      throw new ApprovalPersistenceUnavailableError(error);
    }
    await this.#listener?.onResolved(stored.runId, stored.approvalRequestId, request.decision);
    if (request.decision === "approved") {
      await this.#raiseStaleness(stored.sessionId);
    }
    return {
      approvalRequestId: stored.approvalRequestId,
      state: request.decision,
      deviceId: answeringDeviceId,
      effectiveScope,
      resolvedAt,
    };
  }

  /**
   * Cancels every ask the run still holds pending, one `approval.canceled` each and no resolution
   * row; an ask answered meanwhile keeps its answer. A failed cancel does not stop the rest; their
   * errors are thrown together once all have run. The run engine's terminal hook runs it whenever
   * a run ends.
   */
  async cancelPendingForRun(runId: RunId): Promise<void> {
    await this.#cancelAll(this.#requests.listPendingForRun(runId), `run ${runId}`);
  }

  /**
   * Cancels every ask the session still holds pending, across all its runs, as
   * {@link cancelPendingForRun} does for one run.
   */
  async cancelPendingForSession(sessionId: SessionId): Promise<void> {
    await this.#cancelAll(this.#requests.listPendingForSession(sessionId), `session ${sessionId}`);
  }

  async #cancelAll(pending: readonly StoredApprovalRequest[], owner: string): Promise<void> {
    const failures: unknown[] = [];
    for (const request of pending) {
      try {
        await this.#cancel(request);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Canceling the pending approvals of ${owner} failed`);
    }
  }

  async #cancel(request: StoredApprovalRequest): Promise<void> {
    const canceledAt = this.#now();
    try {
      await this.#events.canceled(
        {
          sessionId: request.sessionId,
          runId: request.runId,
          approvalRequestId: request.approvalRequestId,
          category: request.category,
          scope: request.scope,
        },
        {
          occurredAt: canceledAt,
          statements: [settlePendingStatement(request.approvalRequestId, "canceled", canceledAt)],
        },
      );
    } catch (error) {
      // An answer that landed first keeps the ask.
      if (error instanceof WriteRefusedError && error.statementIndex === PENDING_GUARD_INDEX) {
        return;
      }
      throw error;
    }
  }

  // No caller waits on a sweep, so its failure goes to the service log; the next start retries.
  #sweepEndedSession(sessionId: SessionId): void {
    const sweep = this.cancelPendingForSession(sessionId)
      .catch((error: unknown) => {
        this.#deps.writeServiceLog(
          `Canceling the pending approvals of closed session ${sessionId} failed: ` +
            describeRejection(error),
        );
      })
      .finally(() => {
        this.#sweeps.delete(sweep);
      });
    this.#sweeps.add(sweep);
  }

  // The answer is already kept, so a folder that could not be marked goes to the service log rather
  // than failing an answer that stands.
  async #raiseStaleness(sessionId: SessionId): Promise<void> {
    try {
      await this.#deps.workingFolders.raiseStaleness(sessionId);
    } catch (error) {
      this.#deps.writeServiceLog(
        `Marking the working folder of session ${sessionId} stale after an approval failed: ` +
          describeRejection(error),
      );
    }
  }
}

// What an answer to an ask already settled gets: the saved answer when it is the same one sent
// again, else the refusal naming how the ask was settled.
function answerSettled(
  stored: StoredApprovalRequest,
  request: ApprovalResolveRequest,
): ApprovalResolveResponse {
  if (stored.state === "canceled") {
    throw new ApprovalRequestCanceledError(stored.approvalRequestId);
  }
  const { resolution } = stored;
  if (resolution === undefined || resolution.clientResolutionId !== request.clientResolutionId) {
    throw new ApprovalAlreadyResolvedError(stored.approvalRequestId);
  }
  return {
    approvalRequestId: stored.approvalRequestId,
    state: resolution.decision,
    deviceId: resolution.deviceId,
    effectiveScope: resolution.effectiveScope,
    resolvedAt: resolution.resolvedAt,
  };
}

// Refuses an answer its ask cannot take. The scope a free-text ask names has no order the daemon
// can check a narrowing against, so only the ask's own scope is taken. A rule names exactly the
// subject the card showed, only where the ask offers one, and a block only on a network request.
function refuseUnfitAnswer(
  stored: StoredApprovalRequest,
  request: ApprovalResolveRequest,
  effectiveScope: string,
): void {
  const { approvalRequestId } = stored;
  if (effectiveScope !== stored.scope) {
    throw new ApprovalResolutionInvalidError(approvalRequestId, "effective_scope_broader");
  }
  const rule = request.rememberedScope;
  if (rule === undefined) {
    return;
  }
  if (rule.sense === "block" && stored.category !== "network_access") {
    throw new ApprovalResolutionInvalidError(approvalRequestId, "block_outside_network_access");
  }
  if (!stored.standingAllowOffered || (rule.kind === "project" && !stored.projectScopeOffered)) {
    throw new ApprovalResolutionInvalidError(approvalRequestId, "rule_not_offered");
  }
  if (rule.pattern !== stored.resourceDescriptor.subject) {
    throw new ApprovalResolutionInvalidError(approvalRequestId, "subject_mismatch");
  }
}
