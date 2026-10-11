// The approval service: raises an ask, records its one answer, and cancels the asks a run's end or
// a session's close leaves open. Each step is one write carrying its row change, its guards and its
// `approval.*` event, so the log and the rows never disagree, and a decision read before the write
// is checked again by a guarded statement inside it.
//
//   * Nothing settles an ask on elapsed time: no deadline is stamped and no timer is armed. An ask
//     waits until it is answered, or until its run ends or its session closes, which cancel it.
//   * The first answer from any device settles an ask. The same answer sent again, under the same
//     client resolution id, is answered with what was saved; any other is refused.
//   * The run is told once an ask blocks it and once the ask settles, each after the commit, by the
//     listener the run engine registers: an answer, or the provider taking its ask back. A
//     cancellation with the run's or the session's end tells it nothing, since the run has ended.
//   * An approval marks the session's working folder stale, after the commit, since work the person
//     has not seen may land there, as does an allow the daemon gives an ask itself; a decline and a
//     cancellation mark nothing.
//   * An approval that corrected the command or path records the corrected words with the answer,
//     and the provider's ask that carries them out takes the correction once, in a guarded write.
//   * A card the daemon raised itself, for a call no provider asked about, is waited on until it
//     settles: answered, or canceled with its run or its session.

import type { Database } from "better-sqlite3";

import {
  ApprovalRequestIdSchema,
  type ApprovalRequestedPayload,
  type ApprovalRequestId,
  type ApprovalResolveRequest,
  type ApprovalResolveResponse,
  type ApprovalState,
} from "@ai-sidekicks/contracts/approval";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import type { ServiceLogWriter } from "../daemon/service-log.js";
import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
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
  insertCorrectionUseStatement,
  insertRequestStatement,
  insertResolutionStatement,
  runLiveStatement,
  sessionOpenStatement,
  settlePendingStatement,
  type StoredApprovalRequest,
} from "./store.js";

/**
 * Hears each ask that blocks a run, once it is recorded, and each that settles while its run goes
 * on, once that is recorded: answered, or taken back by its provider. Every ask blocks its run as
 * `waiting_for_approval`; a decline lets the run go on with the action refused, never ends it.
 */
export interface ApprovalOutcomeListener {
  onBlocking(runId: RunId, approvalRequestId: ApprovalRequestId): Promise<void>;
  onSettled(runId: RunId, approvalRequestId: ApprovalRequestId): Promise<void>;
}

/** What the approval service reads, writes and follows. */
export interface ApprovalServiceDeps {
  /** The read-only connection the asks and the sessions are read on. */
  readonly reader: Database;
  /** The writer a correction's one use is recorded through. */
  readonly writer: Pick<DatabaseWriter, "write">;
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

// The positions of the create's two guards among its statements.
const SESSION_OPEN_GUARD_INDEX = 0;
const RUN_LIVE_GUARD_INDEX = 1;
// The positions of the answer's pending guard and its run's live guard among its statements.
const PENDING_GUARD_INDEX = 0;
const ANSWER_RUN_LIVE_GUARD_INDEX = 1;

/**
 * One answer as `resolve` settled it: what the caller is answered, and whether this call recorded
 * it, false for the same answer sent again, which hands nothing on.
 */
export interface ResolvedAnswer {
  readonly response: ApprovalResolveResponse;
  readonly wasRecorded: boolean;
}

/** How an ask settled. */
export type SettledApprovalState = Exclude<ApprovalState, "pending">;

// The events that settle an ask, which wake whoever waits on it.
const SETTLING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "approval.approved",
  "approval.rejected",
  "approval.canceled",
]);

interface SettleWaiter {
  readonly resolve: (state: SettledApprovalState) => void;
  readonly reject: (error: unknown) => void;
}

/** Raises asks, records their answers and cancels the ones their run or session leaves open. */
export class ApprovalService {
  readonly #deps: ApprovalServiceDeps;
  readonly #requests: ApprovalRequestReader;
  readonly #events: ApprovalEventEmitter;
  readonly #now: () => string;
  // The sweeps of closed sessions under way, which a stop waits for.
  readonly #sweeps = new Set<Promise<void>>();
  // Whoever waits on each card until it settles, by the card's id.
  readonly #settleWaiters = new Map<ApprovalRequestId, SettleWaiter[]>();
  #listener: ApprovalOutcomeListener | undefined;
  #detachFromLog: (() => void) | undefined;

  constructor(deps: ApprovalServiceDeps) {
    this.#deps = deps;
    this.#requests = new ApprovalRequestReader(deps.reader);
    this.#events = new ApprovalEventEmitter(deps.sessionEvents);
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Registers the one listener the run engine keeps on blocked and settled asks. Throws when one is
   * already registered. Until one is, no run hears of its asks.
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
   */
  start(): void {
    this.#detachFromLog = this.#deps.followAll(
      (event) => {
        if (event.type === "session.closed") {
          this.#sweepEndedSession(event.sessionId);
        }
        if (SETTLING_EVENT_TYPES.has(event.type)) {
          const { approvalRequestId } = event.payload as { approvalRequestId: ApprovalRequestId };
          this.#wakeSettleWaiters(approvalRequestId);
        }
      },
      (sessionId) => {
        if (this.#requests.isSessionEnded(sessionId)) {
          this.#sweepEndedSession(sessionId);
        }
        // A settle among the missed events is read back from its row.
        for (const approvalRequestId of [...this.#settleWaiters.keys()]) {
          this.#wakeSettleWaiters(approvalRequestId);
        }
      },
    );
    for (const sessionId of this.#requests.listEndedSessionsWithPending()) {
      this.#sweepEndedSession(sessionId);
    }
  }

  /**
   * Stops following the log and waits for the sweeps under way; whoever still waits on a card is
   * rejected, since no settle can reach them now.
   */
  async stop(): Promise<void> {
    this.#detachFromLog?.();
    const stopped = new Error("The approval service stopped before the card settled");
    for (const waiters of this.#settleWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(stopped);
      }
    }
    this.#settleWaiters.clear();
    await Promise.all(this.#sweeps);
  }

  /**
   * Resolves once the card under `approvalRequestId` settles, with how it settled: at once for one
   * settled already. Rejects with `approval.not_found` for a card the daemon holds none of, and
   * when the service stops first. Settles are heard from the log the service follows once started.
   */
  waitForSettle(approvalRequestId: ApprovalRequestId): Promise<SettledApprovalState> {
    return new Promise((resolve, reject) => {
      const waiters = this.#settleWaiters.get(approvalRequestId) ?? [];
      waiters.push({ resolve, reject });
      this.#settleWaiters.set(approvalRequestId, waiters);
      // Read after the wait is listed, so a settle committed in between still wakes it.
      this.#wakeSettleWaiters(approvalRequestId);
    });
  }

  #wakeSettleWaiters(approvalRequestId: ApprovalRequestId): void {
    const waiters = this.#settleWaiters.get(approvalRequestId);
    if (waiters === undefined) {
      return;
    }
    const stored = this.#requests.readRequest(approvalRequestId);
    if (stored?.state === "pending") {
      return;
    }
    this.#settleWaiters.delete(approvalRequestId);
    for (const waiter of waiters) {
      if (stored === undefined) {
        waiter.reject(new ApprovalNotFoundError(approvalRequestId));
      } else {
        waiter.resolve(stored.state);
      }
    }
  }

  /**
   * Raises one ask, pending until it is answered or canceled, and tells the run it blocks once it
   * is recorded. `origin` carries what only the daemon knows: the provider ask it was minted for
   * and the tool call it holds. Throws the schema's error for a request that does not parse,
   * before anything is written; `approval.request_canceled` with a `reason` when the session has
   * closed or the run has ended; and `approval.persistence_unavailable` when the record could not
   * be kept.
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
          sessionOpenStatement(parsed.sessionId),
          runLiveStatement(parsed.sessionId, parsed.runId),
          insertRequestStatement({ ...parsed, approvalRequestId, askId: origin.askId, createdAt }),
        ],
      });
    } catch (error) {
      if (error instanceof WriteRefusedError && error.statementIndex === SESSION_OPEN_GUARD_INDEX) {
        throw new ApprovalLateCreateError(parsed.sessionId, parsed.runId, "session_closed");
      }
      if (error instanceof WriteRefusedError && error.statementIndex === RUN_LIVE_GUARD_INDEX) {
        throw new ApprovalLateCreateError(parsed.sessionId, parsed.runId, "run_ended");
      }
      throw new ApprovalPersistenceUnavailableError(error);
    }
    await this.#listener?.onBlocking(parsed.runId, approvalRequestId);
    return { approvalRequestId };
  }

  /**
   * Records one answer to an ask, stamped with `answeringDeviceId`, the device whose connection
   * carried it, and tells the run once it is recorded. The scope defaults to the ask's own. Throws
   * `approval.not_found`, `approval.request_canceled` for an ask canceled or whose run has ended,
   * `approval.already_resolved` for an ask another answer settled (the same client resolution id
   * is answered with what was saved), `approval.resolution_invalid` for an answer that does not fit
   * its ask, and `approval.persistence_unavailable` when the record could not be kept. The rule
   * the answer asks for is not recorded here: its record follows once its provider kept it. The
   * `approval.resolve` handler reads the answering device off the call it arrived on.
   */
  async resolve(
    request: ApprovalResolveRequest,
    answeringDeviceId: DeviceId,
  ): Promise<ResolvedAnswer> {
    const stored = this.#requests.readRequest(request.approvalRequestId);
    if (stored === undefined) {
      throw new ApprovalNotFoundError(request.approvalRequestId);
    }
    if (stored.state !== "pending") {
      return { response: answerSettled(stored, request), wasRecorded: false };
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
          ...(request.editedAction === undefined ? {} : { editedAction: request.editedAction }),
        },
        {
          occurredAt: resolvedAt,
          statements: [
            settlePendingStatement(stored.approvalRequestId, request.decision, resolvedAt),
            runLiveStatement(stored.sessionId, stored.runId),
            insertResolutionStatement({
              approvalRequestId: stored.approvalRequestId,
              deviceId: answeringDeviceId,
              clientResolutionId: request.clientResolutionId,
              decision: request.decision,
              effectiveScope,
              editedAction: request.editedAction,
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
        return { response: answerSettled(settled, request), wasRecorded: false };
      }
      // The run ended before its end canceled the ask, which that cancel is about to do.
      if (
        error instanceof WriteRefusedError &&
        error.statementIndex === ANSWER_RUN_LIVE_GUARD_INDEX
      ) {
        throw new ApprovalRequestCanceledError(stored.approvalRequestId);
      }
      throw new ApprovalPersistenceUnavailableError(error);
    }
    await this.#listener?.onSettled(stored.runId, stored.approvalRequestId);
    if (request.decision === "approved") {
      await this.markWorkingFolderStale(stored.sessionId);
    }
    return {
      response: {
        approvalRequestId: stored.approvalRequestId,
        state: request.decision,
        deviceId: answeringDeviceId,
        effectiveScope,
        resolvedAt,
      },
      wasRecorded: true,
    };
  }

  /**
   * Cancels one ask its provider took back before anyone answered it, and tells the run once that
   * is recorded; an ask already settled keeps how it settled and tells nothing.
   */
  async withdraw(approvalRequestId: ApprovalRequestId): Promise<void> {
    const stored = this.#requests.readRequest(approvalRequestId);
    if (stored?.state !== "pending" || !(await this.#cancel(stored))) {
      return;
    }
    await this.#listener?.onSettled(stored.runId, approvalRequestId);
  }

  /**
   * Takes the correction an approved card carries for the provider ask that carries it out: true
   * once, for an ask on the card's own run whose command or path is exactly the corrected one, and
   * false for any other ask, a card that is not approved or names no correction, and a correction
   * already carried out, which the guarded write refuses even across a restart. Throws
   * `approval.persistence_unavailable` when the use could not be recorded.
   */
  async takeCorrection(
    approvalRequestId: ApprovalRequestId,
    ask: { readonly runId: RunId; readonly correctedSubject: string },
  ): Promise<boolean> {
    const stored = this.#requests.readRequest(approvalRequestId);
    if (
      stored?.state !== "approved" ||
      stored.runId !== ask.runId ||
      stored.resolution?.editedAction !== ask.correctedSubject
    ) {
      return false;
    }
    try {
      await this.#deps.writer.write([
        insertCorrectionUseStatement({
          approvalRequestId,
          sessionId: stored.sessionId,
          usedAt: this.#now(),
        }),
      ]);
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        return false;
      }
      throw new ApprovalPersistenceUnavailableError(error);
    }
    return true;
  }

  /** The ask under `approvalRequestId`, or `undefined` when the daemon holds none. */
  readRequest(approvalRequestId: ApprovalRequestId): StoredApprovalRequest | undefined {
    return this.#requests.readRequest(approvalRequestId);
  }

  /** The request minted for the run's provider ask `askId`, or `undefined` when it has none. */
  readAskRequest(runId: RunId, askId: string): StoredApprovalRequest | undefined {
    return this.#requests.readAskRequest(runId, askId);
  }

  /** Whether the run still holds an ask no one has answered. */
  hasPendingForRun(runId: RunId): boolean {
    return this.#requests.listPendingForRun(runId).length > 0;
  }

  /** The session's runs that still hold an ask no one has answered. */
  listRunsHoldingAsks(sessionId: SessionId): readonly RunId[] {
    return [
      ...new Set(this.#requests.listPendingForSession(sessionId).map((request) => request.runId)),
    ];
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

  // Answers whether this cancel settled the ask.
  async #cancel(request: StoredApprovalRequest): Promise<boolean> {
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
        return false;
      }
      throw error;
    }
    return true;
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

  /**
   * Marks the session's working folder stale once an action was allowed, since work the person has
   * not seen may land there. The allow already stands, so a folder that could not be marked goes to
   * the service log rather than failing it.
   */
  async markWorkingFolderStale(sessionId: SessionId): Promise<void> {
    try {
      await this.#deps.workingFolders.raiseStaleness(sessionId);
    } catch (error) {
      this.#deps.writeServiceLog(
        `Marking the working folder of session ${sessionId} stale after an allow failed: ` +
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
// can check a narrowing against, so only the ask's own scope is taken. A correction is taken only
// where the ask offers one, and never beside a rule. A rule names exactly the subject the card
// showed, only where the ask offers one, and a block only on a network request.
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
  if (request.editedAction !== undefined && !stored.resourceDescriptor.editable) {
    throw new ApprovalResolutionInvalidError(approvalRequestId, "edit_not_offered");
  }
  if (rule === undefined) {
    return;
  }
  if (request.editedAction !== undefined) {
    throw new ApprovalResolutionInvalidError(approvalRequestId, "edit_with_rule");
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
