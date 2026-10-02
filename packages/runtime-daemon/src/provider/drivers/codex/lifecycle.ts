/**
 * Codex app-server transport (`CodexAppServerConnection`, JSONL JSON-RPC over one `PtyHost`) and
 * lifecycle (`CodexLifecycleManager`). No port separates them, so tests drive the real framing
 * through a fake `PtyHost`.
 * - `/bin/sh -c` spawns the provider (see the prelude): a PTY slave starts canonical with echo on,
 *   and `codex app-server` never calls `tcsetattr`. Canonical mode silently drops an input line
 *   over MAX_CANON (Darwin 1024 bytes; `codex-cli 0.149.1` answered a 1015-byte frame, not 1045).
 *   Splitting a frame across small writes does not help: the cap is per line, not per write, and
 *   it performs worse.
 * - The establishment legs, spawn posture, text-neutralization tripwire, steer dispatch, routing
 *   band, routed-ask attribution, command cache and compaction dispatch are dependencies this
 *   class builds once; it keeps the session slots, the run and turn entry
 *   points and teardown.
 * - Every spawn or dispose runs inside `#claimSessionSlot` (`establishing`, `live`, `closing`),
 *   held until fully settled, so no owned process exists without a held slot; a `startRun` that
 *   only installs a route re-reads the slot after its await.
 * - Errors use registered codes only: `driver.unavailable` (503), `driver.timeout` (504).
 */

import {
  type DriverCompactionResult,
  type ProviderCommandListResult,
  type InterruptRunParams,
  type RunId,
  type SessionId,
} from "@ai-sidekicks/contracts";
import { PendingCompactionRegistry } from "../../compaction-wait.js";
import { ThreadFrameRouter } from "../../thread-frame-router.js";
import { UsageDeltaAccountant } from "../../usage-delta-accountant.js";
import {
  AmbiguousDeliveryReconciler,
  classifyProviderRequestFailure,
  PermanentStructuralRefusalError,
} from "../../transcript/failure-mapping.js";
import { CODEX_SKILLS_CHANGED_METHOD } from "./event-normalizer.js";
import { CodexTerminalEmissionGate } from "./turn-evidence.js";
import {
  OutboundFrameTripwire,
  OutboundTextFrameWriter,
  RuntimeBindingQuarantine,
  type OutboundTextFrame,
} from "../../outbound-frame.js";
import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "./intervention.js";
import { mintUuidV7 } from "../../../ids/uuid-v7.js";
import {
  CODEX_THREAD_FRAME_ROUTER_CONFIG,
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexRoutableFrame,
  type CodexSessionRecord,
  type CodexSessionTransition,
  type CodexSessionTransitionKind,
  newestActiveTurnForRun,
  observeCodexTurnStartFailure,
  rememberInterruptedRun,
} from "./session-state.js";
import {
  CodexAppServerConnection,
  type CodexConnectionOptions,
  defaultScheduleTimeout,
} from "./app-server-connection.js";
import {
  assertRealizedTurnPostureMembers,
  type CodexRunConfig,
  parseCodexRunConfig,
} from "./session-config.js";
import {
  CodexSessionAlreadyLiveError,
  type CodexSessionSlotState,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "./session-errors.js";
import { readTurnId } from "./thread-view.js";
import {
  buildAuthProbeResult,
  classifyCodexAuthStatus,
  CODEX_AUTH_PROBE_TIMEOUT_MS,
  requestCodexAuthStatus,
} from "./auth-status.js";
import { reportDiagnosticFromDetachedFrame } from "./transport-diagnostics.js";
import { CodexRunRoutes } from "./run-routes.js";
import { CodexTextNeutralization } from "./text-neutralization.js";
import { CodexNotificationRouting } from "./notification-routing.js";
import { CodexProviderCommandCache } from "./provider-command-cache.js";
import { CodexSpawnPosture } from "./spawn-posture.js";
import { CodexRoutedAskAttributor } from "./routed-ask-attribution.js";
import { CodexSteerDispatch } from "./steer-dispatch.js";
import { CodexCompactionDispatch } from "./compaction-dispatch.js";
import { CodexSessionEstablishment, releaseAbandonedConnection } from "./session-establishment.js";
import {
  ForkConversationResultSchema,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CompactContextParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type ListProviderCommandsParams,
  type DriverResumeResult,
  type ForkConversationResult,
  type ProviderSessionHandle,
  type ResumeSessionParams,
  type ForkConversationParams,
  type SetSessionGoalParams,
  type StartRunParams,
} from "../../provider-driver.js";

// `turn/start` is believed to answer once the turn is accepted, so this matches the ordinary
// request deadline. Separate so a wrong reading is a configuration change, not a code change.
const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;

/**
 * Deadline for the courtesy `thread/unsubscribe`; short so a wedged provider cannot hold close.
 */
const UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/** Lifecycle operations as Codex `app-server` calls, one connection per session. */
export class CodexLifecycleManager {
  readonly #options: CodexLifecycleOptions;
  readonly #turnStartTimeoutMs: number;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #runtimeBindingQuarantine = new RuntimeBindingQuarantine();
  readonly #sessions = new Map<SessionId, CodexSessionRecord>();
  /**
   * Settles an ambiguous `turn/start` positionally; its per-thread serialization keeps one
   * reconcile's read and ruling atomic. A concurrent successful start can only inflate the read,
   * which can only settle `delivered` (re-sends nothing), never `cleared-for-retry`.
   */
  readonly #ambiguousDeliveryReconciler: AmbiguousDeliveryReconciler;
  // The intended-close producer: one gate per session, latched at the top of `closeSession`, which
  // `event-normalizer.ts` stamps on the terminal payload. Keyed beside the record map because a
  // close during establishment holds no installed record.
  readonly #terminalEmissionGates = new Map<SessionId, CodexTerminalEmissionGate>();
  // One router and one usage accountant per provider session, keyed beside the record map: a frame
  // can arrive while the slot is establishing, before a record exists.
  readonly #frameRouters = new Map<SessionId, ThreadFrameRouter<CodexRoutableFrame>>();
  readonly #usageAccountants = new Map<SessionId, UsageDeltaAccountant>();
  // Manager-scoped so disposal settles a compaction wait armed against a torn-down session.
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #runRoutes = new CodexRunRoutes();
  /** In-flight create, resume, fork or close per session, held until it fully settles. */
  readonly #sessionTransitions = new Map<SessionId, CodexSessionTransition>();
  readonly #providerCommands: CodexProviderCommandCache;
  readonly #spawnPosture: CodexSpawnPosture;
  readonly #textNeutralization: CodexTextNeutralization;
  readonly #notificationRouting: CodexNotificationRouting;
  readonly #routedAsks: CodexRoutedAskAttributor;
  readonly #compactionDispatch: CodexCompactionDispatch;
  readonly #establishment: CodexSessionEstablishment;
  readonly #steerDispatch: CodexSteerDispatch;

  constructor(options: CodexLifecycleOptions) {
    this.#options = options;
    this.#turnStartTimeoutMs = options.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
    // The same injected scheduler as the transport's deadlines.
    this.#pendingCompactions = new PendingCompactionRegistry(
      options.scheduleTimeout ?? defaultScheduleTimeout,
    );
    this.#ambiguousDeliveryReconciler = new AmbiguousDeliveryReconciler(options.userTurnReadback);
    // The only composer of provider-bound text on this leg: `turn/start` and `turn/steer` take
    // their input from a frame it minted.
    const outboundTextFrameWriter = new OutboundTextFrameWriter({
      mechanismGrade: options.textNeutralityMechanismGrade ?? "emulated",
      mintCorrelationId: options.mintOutboundFrameCorrelationId,
    });
    // Built here because the predicate reads later-declared fields. A retired session's pending
    // frames are pure occupancy, reclaimed only when a write would otherwise be refused.
    this.#outboundFrameTripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey: string): boolean =>
        !this.#sessions.has(scopeKey as SessionId) ||
        this.#runtimeBindingQuarantine.isSessionDisposed(scopeKey),
    });
    this.#providerCommands = new CodexProviderCommandCache(options);
    this.#spawnPosture = new CodexSpawnPosture(options);
    this.#textNeutralization = new CodexTextNeutralization({
      options,
      outboundTextFrameWriter,
      outboundFrameTripwire: this.#outboundFrameTripwire,
      runtimeBindingQuarantine: this.#runtimeBindingQuarantine,
      sessions: this.#sessions,
      runRoutes: this.#runRoutes,
      disposeQuarantinedSession: (record: CodexSessionRecord): void => {
        this.#disposeQuarantinedSession(record);
      },
    });
    this.#steerDispatch = new CodexSteerDispatch({
      outboundTextFrameWriter,
      outboundFrameTripwire: this.#outboundFrameTripwire,
      textNeutralization: this.#textNeutralization,
    });
    this.#notificationRouting = new CodexNotificationRouting({
      options,
      pendingCompactions: this.#pendingCompactions,
      frameRouterFor: (sessionId: SessionId): ThreadFrameRouter<CodexRoutableFrame> =>
        this.frameRouterFor(sessionId),
      usageAccountantFor: (sessionId: SessionId): UsageDeltaAccountant =>
        this.usageAccountantFor(sessionId),
    });
    this.#routedAsks = new CodexRoutedAskAttributor(options, this.#sessions);
    this.#compactionDispatch = new CodexCompactionDispatch(options, this.#pendingCompactions);
    this.#establishment = new CodexSessionEstablishment({
      options,
      sessions: this.#sessions,
      newBindingId: options.newBindingId ?? mintUuidV7,
      runtimeBindingQuarantine: this.#runtimeBindingQuarantine,
      pendingCompactions: this.#pendingCompactions,
      spawnPosture: this.#spawnPosture,
      notificationRouting: this.#notificationRouting,
      providerCommands: this.#providerCommands,
      textNeutralization: this.#textNeutralization,
      runRoutes: this.#runRoutes,
      connectionOptionsFor: (sessionId: SessionId): CodexConnectionOptions =>
        this.#connectionOptionsFor(sessionId),
      usageAccountantFor: (sessionId: SessionId): UsageDeltaAccountant =>
        this.usageAccountantFor(sessionId),
    });
  }

  /** Spawns a process and starts a fresh Codex thread. */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Refused before anything is spawned, reading every view of the slot with no `await` before
    // the claim: overlapping creates would orphan a process. A `closing` holder refuses too.
    const holderState = this.#describeSlotHolder(params.sessionId);
    if (holderState !== undefined) {
      throw new CodexSessionAlreadyLiveError(params.sessionId, holderState);
    }
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishment.establishCreatedSession(params),
    );
  }

  /**
   * Resumes an existing Codex thread from its provider-owned handle. Every failure tears its
   * process down and returns the typed `failed` result; it never falls back to a fresh thread.
   */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Claims the slot rather than refusing a held one (unlike the Claude leg): this driver
    // supersedes a live leg on resume, which serializing behind the holder makes reachable.
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishment.establishResumedSession(params),
    );
  }

  /** Starts one provider turn for a run. */
  async startRun(params: StartRunParams): Promise<void> {
    const runConfig = parseCodexRunConfig(params.agentConfig);
    const record = this.#requireSession(runConfig.sessionId);
    const openingFrame = this.#textNeutralization.composeRunOpeningFrame(params, runConfig);
    let turnId: string;
    // Raised until the answer is in hand: a terminal ingested by the synchronous read drain may
    // belong to the turn about to be named, so `rememberUnmatchedTurn` must not evict. Lowered in
    // a `finally` so a failed start cannot leak the count.
    record.inFlightTurnStarts += 1;
    try {
      turnId = readTurnId(
        await this.#requestTurnStart(record, runConfig, params, openingFrame),
        "turn/start",
      );
    } catch (cause) {
      // Dropped by frame, not key: nothing serializes two starts for one run, and a key-wide drop
      // would strand a concurrent attempt's frame so its turn passes uncorrelated. Safe here: the
      // reconcile proves the turn never started or kills the child (a steer's turn runs on).
      this.#outboundFrameTripwire.forgetFrame(openingFrame);
      // Classified before any teardown, as some dispositions need the live connection. Routing is
      // exhaustive over the shared classifier's union, not this leg's own error classes.
      const disposition = classifyProviderRequestFailure(
        observeCodexTurnStartFailure(cause),
      ).disposition;
      if (disposition === "permanent-structural-refusal") {
        // Condemned, not just torn down: the history was typed unacceptable, so only a fresh spawn
        // leads back. Session is quarantined first so a synchronous caller cannot resolve it.
        this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
        this.#runtimeBindingQuarantine.disposeRun(params.runId, record.sessionId);
        await this.#disposeAmbiguousSession(record);
        throw new PermanentStructuralRefusalError({
          providerSessionId: record.threadId,
          runId: params.runId,
          cause,
        });
      }
      if (disposition === "reconcile-ambiguous-delivery") {
        await this.#settleAmbiguousTurnStart(record);
      }
      // `fail-consumed-and-declined` disposes nothing: the provider answered "no", so the session
      // stays usable. `retry-definitely-unsent` cannot occur, as `observeCodexTurnStartFailure`
      // never reports `unsent`; narrowing that needs a retry branch here.
      throw cause;
    } finally {
      record.inFlightTurnStarts -= 1;
    }
    // Frame-scoped like the drop above: the frame moves onto the key the terminal will carry, and
    // a key-wide re-key would drag a concurrent attempt's unnamed frame onto this turn.
    this.#outboundFrameTripwire.recorrelateFrame(openingFrame, turnId);
    // One synchronous run from here, so one slot check covers the install and the consume.
    if (!this.#stillHoldsSlot(record)) {
      // Reached only via a transition begun after dispatch. A failed supersede-resume leaves the
      // predecessor live, so the accepted turn would run with no route to interrupt it: dispose
      // unconditionally (idempotent) and refuse the run, which would strand a route no sweep
      // reaches.
      await this.#disposeAmbiguousSession(record);
      throw new CodexTransportError(
        `Codex session "${record.sessionId}" stopped holding its slot while a turn was starting.`,
        { sessionId: record.sessionId, method: "turn/start" },
      );
    }
    // A second accepted start on this run adds a route; the turn axis is never overwritten.
    record.runIdByActiveTurnId.set(turnId, params.runId);
    this.#runRoutes.bindRun(params.runId, record.sessionId);
    // Appended at acceptance, not completion: a completion-time ledger would omit interrupted and
    // failed turns and misname later positions.
    record.turnBoundaries.push(turnId);
    this.#textNeutralization.replayRememberedTurnEvidence(record, params.runId, turnId);
  }

  /**
   * Settles an ambiguous `turn/start` by reading the thread's user-turn count back against
   * `turnBoundaries` (positional: a user may repeat words). The run fails on every arm;
   * `delivered` and `unrecoverable` dispose the session so no re-dispatch duplicates spend.
   */
  async #settleAmbiguousTurnStart(record: CodexSessionRecord): Promise<void> {
    await this.#ambiguousDeliveryReconciler.reconcileThenAct(
      {
        targetProviderSessionId: record.threadId,
        acknowledgedUserSends: record.turnBoundaries.length,
      },
      async (settlement) => {
        if (settlement.settlement === "cleared-for-retry") {
          return;
        }
        await this.#disposeAmbiguousSession(record);
      },
    );
  }

  /** The `turn/start` request itself, split out so `startRun` reads as its policy. */
  async #requestTurnStart(
    record: CodexSessionRecord,
    runConfig: CodexRunConfig,
    params: StartRunParams,
    openingFrame: OutboundTextFrame,
  ): Promise<unknown> {
    const turnStartParams: Record<string, unknown> = {
      threadId: record.threadId,
      // The bytes come off a frame this method cannot construct, so neutralization is on the
      // path; `runConfig.input` is unread on purpose: the author's text stays on the frame.
      input: [{ type: "text", text: openingFrame.wireText, text_elements: [] }],
      // The pin that carries the security property: `approvalsReviewer` on a turn overrides routing
      // for it and later turns, so a config-selected `auto_review` would otherwise win.
      // `turn/steer` creates no turn and needs none. Present on TurnStartParams at codex-cli
      // 0.150.1, unchanged back to the 0.141.0 floor.
      approvalsReviewer: "user",
      // The run's posture wins and the session's spawn posture is the floor, so a turn never goes
      // out with no policy; both send the roots the thread-level selector cannot carry.
      ...this.#spawnPosture.composeTurnPostureParams(record, params),
      ...(runConfig.model === undefined ? {} : { model: runConfig.model }),
      ...(runConfig.clientUserMessageId === undefined
        ? {}
        : { clientUserMessageId: runConfig.clientUserMessageId }),
      ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    };
    assertRealizedTurnPostureMembers(turnStartParams);
    return await record.connection.request("turn/start", turnStartParams, this.#turnStartTimeoutMs);
  }

  /**
   * Kills the child first, then releases the session, when a turn may be live with no route to it.
   * Scoped to the record, not the session id, so a resume that already superseded it is untouched.
   * There is no `thread/unsubscribe`: this connection's answers cannot be trusted.
   */
  async #disposeAmbiguousSession(record: CodexSessionRecord): Promise<void> {
    await this.#claimSessionSlot(record.sessionId, "closing", async () => {
      if (this.#sessions.get(record.sessionId) === record) {
        this.#sessions.delete(record.sessionId);
        // Rule before the sweeps, while the routes still exist: with the record dropped no
        // terminal is ingested, so pending frames become unrulable.
        this.#textNeutralization.ruleAbandonedFramesFailClosed(record);
        this.#runRoutes.forgetRunRoutes(record.sessionId);
        // Covers the quarantine path too: `#disposeQuarantinedSession` delegates here.
        this.#pendingCompactions.releaseBinding(
          codexCompactionWaitKey(record.sessionId, record.threadId),
        );
        this.#providerCommands.discardProviderCommandEnumeration(record.sessionId);
        this.#textNeutralization.releaseOutboundFrameBudget(record.sessionId);
      }
      try {
        await record.connection.killAndClose();
      } catch {
        // The caller is already throwing the typed cause; a teardown artifact must not displace it.
      }
    });
  }

  /**
   * Zero-turn authentication probe on its own child; claims no session slot. Never throws: any
   * unresolvable outcome becomes `indeterminate`, fail-closed for admission yet distinct from
   * `unauthenticated`.
   */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    const connection = new CodexAppServerConnection(this.#probeConnectionOptions());
    try {
      await connection.open(this.#options.resumeSpawnConfig);
      return classifyCodexAuthStatus(
        await requestCodexAuthStatus(connection, CODEX_AUTH_PROBE_TIMEOUT_MS),
      );
    } catch (cause) {
      return buildAuthProbeResult("indeterminate", normalizeProviderFailureDetail(cause));
    } finally {
      // Contained so a teardown fault cannot displace the answer; `close()` is idempotent.
      await releaseAbandonedConnection(connection);
    }
  }

  // Not `#connectionOptionsFor`: a probe's notifications must never enter a session's stream.
  #probeConnectionOptions(): CodexConnectionOptions {
    const reportDiagnostic = this.#options.reportDiagnostic;
    return {
      ...this.#options,
      onServerNotification: (method: string): void => {
        reportDiagnosticFromDetachedFrame(reportDiagnostic, {
          kind: "unconsumed-server-notification",
          method,
        });
      },
    };
  }

  /**
   * Interrupts the provider turn bound to a run and retires its route, so a later steer or second
   * interrupt is refused. The turn correlation is retained for the `turn/completed` that follows.
   */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    const { record, turnId } = this.#requireActiveTurn(params.runId);
    await record.connection.request("turn/interrupt", {
      threadId: record.threadId,
      turnId,
    });
    // A settled turn's terminal was already ruled; retaining it would leave an entry nothing
    // releases.
    if (!record.settledTurnIds.has(turnId)) {
      if (!rememberInterruptedRun(record, turnId, params.runId)) {
        // The interrupt succeeded, so this resolves; quarantining rules the pending frame
        // fail-closed and the run hears `run.failed`.
        this.#textNeutralization.refuseUnretainableInterruptedRoute(record);
        return;
      }
    }
    // Retires this turn's route only; a run holding a second live turn keeps that route.
    this.#runRoutes.retireTurnRoute(record, turnId);
  }

  /**
   * Forks the thread at a recorded turn boundary, re-points the session at the fork and returns a
   * fresh `bindingId`; files on disk are not restored. Degrades on a live turn or an unknown
   * position, and refuses when the build lacks the boundary member
   * ({@link CodexRewindBoundaryUnsupportedError}).
   */
  async forkConversation(params: ForkConversationParams): Promise<ForkConversationResult> {
    // Read before the claim: `#requireSession` refuses while the slot is `establishing`.
    const record = this.#requireSession(params.sessionId);
    if (record.runIdByActiveTurnId.size > 0) {
      // The provider refuses to fork through a live turn; answer locally with a typed result.
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-deferred-turn-in-progress",
      });
    }
    // Position 0 must not become an omitted `lastTurnId`, which forks the whole thread.
    const boundaryTurnId =
      params.position >= 1 ? record.turnBoundaries[params.position - 1] : undefined;
    if (boundaryTurnId === undefined) {
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-target-not-a-recorded-boundary",
      });
    }
    // Held across the fork: a `startRun` meanwhile would register on the pre-fork thread and its
    // frames would be shed, and two rewinds would both report `applied`. `establishing` because a
    // fork mints the thread the session continues on; the entrance refuses turns in that state.
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishment.establishRewoundSession(params, record, boundaryTurnId),
    );
  }

  /**
   * Binds the session's goal on the provider natively. Only `objective` is sent; `status` and
   * `tokenBudget` are provider-side state the daemon does not own.
   */
  async setSessionGoal(params: SetSessionGoalParams): Promise<void> {
    const record = this.#requireSession(params.sessionId);
    await record.connection.request("thread/goal/set", {
      threadId: record.threadId,
      objective: params.goalText,
    });
  }

  /** Clears the session's goal natively; a `cleared: false` answer still resolves. */
  async clearSessionGoal(params: ClearSessionGoalParams): Promise<void> {
    const record = this.#requireSession(params.sessionId);
    await record.connection.request("thread/goal/clear", { threadId: record.threadId });
  }

  /**
   * Triggers a native context compaction and settles on the `thread/compacted` frame, not on the
   * request's empty acknowledgement. The wait is armed before dispatch so an early frame is seen.
   * Never returns `refused`; the daemon's gates answer that before any driver is called.
   */
  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    const record = this.#requireSession(params.sessionId);
    return await this.#compactionDispatch.dispatchCompaction(params.sessionId, record);
  }

  /**
   * Enumerates the provider's command and skill surface, held for the session's life until
   * `skills/changed` discards it. The entry cap trims the reply, not the held list
   * (`complete: false` marks a trimmed tail); `runId` is the sole live run or `null`.
   */
  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    const record = this.#requireSession(params.sessionId);
    return await this.#providerCommands.composeProviderCommandList(params.sessionId, record);
  }

  /** Unsubscribes and tears down the process. Idempotent: an unknown session resolves. */
  async closeSession(params: CloseSessionParams): Promise<void> {
    // Claiming a free slot would refuse a concurrent create, hence the early return. A close during
    // establishment chains behind it; the wait cannot deadlock, as no establishment path calls
    // `closeSession` and each closes its own connection directly. The latch comes first so every
    // later terminal counts as clean.
    this.#intendedCloseGateFor(params.sessionId).signalIntendedClose();
    if (this.#describeSlotHolder(params.sessionId) === undefined) {
      // No session: drop the latch just set rather than accumulate one per redundant close.
      this.#terminalEmissionGates.delete(params.sessionId);
      this.#frameRouters.delete(params.sessionId);
      this.#usageAccountants.delete(params.sessionId);
      this.#providerCommands.discardProviderCommandEnumeration(params.sessionId);
      return;
    }
    await this.#claimSessionSlot(params.sessionId, "closing", async () => {
      await this.#tearDownSession(params.sessionId);
    });
    // After teardown: a terminal it provokes must still find the latch set.
    this.#terminalEmissionGates.delete(params.sessionId);
    this.#frameRouters.delete(params.sessionId);
    this.#usageAccountants.delete(params.sessionId);
    this.#providerCommands.discardProviderCommandEnumeration(params.sessionId);
  }

  /**
   * The terminal-emission gate, which stamps `intendedClose` and suppresses a duplicate terminal
   * per `(runId, runVersion)`. Read live at each terminal, never captured.
   */
  terminalEmissionGateFor(sessionId: SessionId): CodexTerminalEmissionGate {
    return this.#intendedCloseGateFor(sessionId);
  }

  /** The thread-frame router for one session; read live so a widened thread set is seen. */
  frameRouterFor(sessionId: SessionId): ThreadFrameRouter<CodexRoutableFrame> {
    const existing = this.#frameRouters.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const router = new ThreadFrameRouter<CodexRoutableFrame>({
      provider: "codex",
      diagnostics: this.#options.diagnostics,
      config: CODEX_THREAD_FRAME_ROUTER_CONFIG,
    });
    this.#frameRouters.set(sessionId, router);
    return router;
  }

  /** The usage-delta accountant for one session. */
  usageAccountantFor(sessionId: SessionId): UsageDeltaAccountant {
    const existing = this.#usageAccountants.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const accountant = new UsageDeltaAccountant({
      provider: "codex",
      diagnostics: this.#options.diagnostics,
    });
    this.#usageAccountants.set(sessionId, accountant);
    return accountant;
  }

  // Get-or-create, so the latch survives whichever of close and establishment comes first.
  #intendedCloseGateFor(sessionId: SessionId): CodexTerminalEmissionGate {
    const existing = this.#terminalEmissionGates.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const gate = new CodexTerminalEmissionGate();
    this.#terminalEmissionGates.set(sessionId, gate);
    return gate;
  }

  /**
   * Graceful teardown inside a claimed slot. The record is deleted in a `finally`: deleting first
   * would let a create spawn into the slot, and only on success would leave it permanently stuck.
   */
  async #tearDownSession(sessionId: SessionId): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      // The establishment this close chained behind failed and released its connection.
      return;
    }
    // Dropped up front so `hasActiveTurn` stops reporting a live run once teardown begins.
    this.#runRoutes.forgetRunRoutes(sessionId);
    try {
      if (!record.connection.isClosed) {
        try {
          // Best effort and bounded: a refusal or a wedged provider must not block teardown.
          await record.connection.request(
            "thread/unsubscribe",
            { threadId: record.threadId },
            UNSUBSCRIBE_TIMEOUT_MS,
          );
        } catch {
          /* teardown proceeds */
        }
      }
      await record.connection.close();
    } finally {
      this.#sessions.delete(sessionId);
      // In the `finally` so a teardown that threw still releases the compaction waiters.
      this.#pendingCompactions.releaseBinding(codexCompactionWaitKey(sessionId, record.threadId));
      this.#providerCommands.discardProviderCommandEnumeration(sessionId);
      // After the record delete: a turn terminating mid-teardown must still be ingested and ruled.
      this.#textNeutralization.releaseOutboundFrameBudget(sessionId);
    }
  }

  /** Steers the run's active turn; the intervention dispatcher routes steers here. */
  async steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> {
    const { record, turnId } = this.#requireActiveTurn(request.runId);
    return await this.#steerDispatch.steerActiveTurn(record, turnId, request);
  }

  /** True when the run has at least one live provider turn (scans the turn-keyed routes). */
  hasActiveTurn(runId: RunId): boolean {
    const sessionId = this.#runRoutes.sessionIdFor(runId);
    if (sessionId === undefined) {
      return false;
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return false;
    }
    for (const routedRunId of record.runIdByActiveTurnId.values()) {
      if (routedRunId === runId) {
        return true;
      }
    }
    return false;
  }

  /** Names the current holder of a session slot, or `undefined` when it is free. */
  #describeSlotHolder(sessionId: SessionId): CodexSessionSlotState | undefined {
    // Transition first: during a supersede-resume both views are occupied and a dying record
    // stays installed, so the in-flight kind is the more specific truth.
    const transition = this.#sessionTransitions.get(sessionId);
    if (transition !== undefined) {
      return transition.kind;
    }
    return this.#sessions.has(sessionId) ? "live" : undefined;
  }

  /**
   * True when `record` is still the session's settled, live holder; identity on `#sessions` alone
   * would call a record mid-teardown usable.
   */
  #stillHoldsSlot(record: CodexSessionRecord): boolean {
    return (
      this.#describeSlotHolder(record.sessionId) === "live" &&
      this.#sessions.get(record.sessionId) === record
    );
  }

  /**
   * Claims the session slot in one state and runs the transition behind any predecessor. The only
   * way a slot is taken. Reads the predecessor and publishes the claim in one synchronous run: an
   * `await` between them lets two same-tick callers both see an empty slot and run their
   * transitions concurrently.
   */
  async #claimSessionSlot<TSettled>(
    sessionId: SessionId,
    kind: CodexSessionTransitionKind,
    runTransition: () => Promise<TSettled>,
  ): Promise<TSettled> {
    const predecessor = this.#sessionTransitions.get(sessionId)?.settled ?? Promise.resolve();
    const transition = predecessor.then(runTransition);
    const claim: CodexSessionTransition = {
      kind,
      settled: transition.then(
        () => undefined,
        () => undefined,
      ),
    };
    this.#sessionTransitions.set(sessionId, claim);
    try {
      return await transition;
    } finally {
      // Identity-checked: a later caller chains onto this claim and publishes its own, so
      // clearing unconditionally would free an occupied slot.
      if (this.#sessionTransitions.get(sessionId) === claim) {
        this.#sessionTransitions.delete(sessionId);
      }
    }
  }

  /**
   * Per-session connection options, with the manager interposed on the server notification
   * stream: frames reach the delegate unchanged and in order. Which stream a frame belongs to is
   * decided only in `provider/thread-frame-router.ts`; a second decision here would disagree with
   * it.
   */
  #connectionOptionsFor(sessionId: SessionId): CodexConnectionOptions {
    const reportDiagnostic = this.#options.reportDiagnostic;
    const answerServerRequest = this.#options.answerServerRequest;
    return {
      ...this.#options,
      // Overridden rather than spread: the transport port carries no session or run identity.
      serverRequestResponder:
        answerServerRequest === undefined
          ? undefined
          : this.#routedAsks.composeServerRequestResponder(sessionId, answerServerRequest),
      onServerNotification: (method: string, params: unknown): void => {
        this.#observeServerNotification(sessionId, method, params);
        // Every inbound frame goes through the router before any projection; the delegate is
        // reached only from inside the routing band's normalize hand-off. That inner guard has no
        // test of its own: the outer catch reports an identical diagnostic.
        try {
          this.#notificationRouting.routeInboundNotification(sessionId, method, params);
        } catch (cause) {
          // The routing band is total, so this is a backstop: an escaping throw would unwind the
          // `#ingest` read-chunk drain and take unrelated frames down with it.
          reportDiagnosticFromDetachedFrame(reportDiagnostic, {
            kind: "notification-consumer-failed",
            method,
            detail: normalizeProviderFailureDetail(cause),
          });
        }
      },
    };
  }

  /**
   * Observes every inbound server notification ahead of routing: invalidates the held command
   * list on `skills/changed`, accrues turn evidence, and on a terminal `turn/completed` rules the
   * tripwire and retires the turn's route.
   */
  #observeServerNotification(sessionId: SessionId, method: string, params: unknown): void {
    // The provider's skill-file invalidation signal (empty payload): discarding the held list
    // forces a full re-read. Observed ahead of the router so it lands even for a frame the router
    // disposes.
    if (method === CODEX_SKILLS_CHANGED_METHOD) {
      this.#providerCommands.discardProviderCommandEnumeration(sessionId);
    }
    this.#textNeutralization.observeTurnNotification(sessionId, method, params);
  }

  /**
   * Tears down a session a tripwire trip condemned, reusing the ambiguous-turn disposal.
   * Detached: callers are inside the synchronous read-chunk drain or a settlement path that must
   * not wait on or be unwound by a child's death.
   */
  #disposeQuarantinedSession(record: CodexSessionRecord): void {
    void this.#disposeAmbiguousSession(record).catch(() => {
      // Unreachable by construction: the ambiguous-disposal path contains its own teardown fault.
      // Guarded because an unhandled rejection out of the read-chunk drain would be a second
      // failure.
    });
  }

  /**
   * The retained tripwire decision for a turn, read by the intervention dispatcher so a steer
   * whose turn was already ruled settles `degraded` with the refusal code. Asked once; never
   * waits.
   */
  textNeutralizationDecisionForTurn(turnId: string): { readonly refused: boolean } {
    return { refused: this.#outboundFrameTripwire.decisionFor(turnId)?.tripped === true };
  }

  #requireSession(sessionId: SessionId): CodexSessionRecord {
    // Quarantine first: otherwise a new run would resolve the surviving record by session id and
    // dispatch into the process that swallowed the user's words. A fresh spawn lifts it.
    this.#runtimeBindingQuarantine.assertSessionAttachable(sessionId);
    // Both transition states refuse, not only `closing`: a record stays installed across its
    // whole transition, so a turn could reach a connection a supersede-resume is about to
    // release.
    const holderState = this.#describeSlotHolder(sessionId);
    if (holderState === "closing") {
      throw new CodexTransportError(`Codex session "${sessionId}" is being torn down.`, {
        sessionId,
        holderState,
      });
    }
    if (holderState === "establishing") {
      throw new CodexTransportError(
        `Codex session "${sessionId}" is being re-established; the leg it runs on is about to change.`,
        { sessionId, holderState },
      );
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      throw new CodexTransportError(`No live Codex session for "${sessionId}".`, { sessionId });
    }
    return record;
  }

  /**
   * Resolves the live turn a steer or an interrupt acts on. The quarantine is checked first: a
   * trip retires the route, so the next steer would fail with a plausible wrong "no active turn"
   * and invite a retry into the process that swallowed the user's words.
   */
  #requireActiveTurn(runId: RunId): { record: CodexSessionRecord; turnId: string } {
    this.#runtimeBindingQuarantine.assertRunAttachable(runId);
    const sessionId = this.#runRoutes.sessionIdFor(runId);
    const record = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    const turnId = record === undefined ? undefined : newestActiveTurnForRun(record, runId);
    if (record === undefined || turnId === undefined) {
      throw new CodexTransportError(`No active Codex turn for run "${runId}".`, { runId });
    }
    return { record, turnId };
  }
}
