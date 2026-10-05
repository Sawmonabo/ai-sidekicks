// The Codex establishment legs: spawning or relaunching a session's process and starting,
// resuming or forking its thread, then installing the record and rebinding the routing band. A
// failed resume never becomes a new session: it returns the typed `recovery-needed` failure.

import type { SessionId } from "@ai-sidekicks/contracts/session";
import type { PendingCompactionRegistry } from "../../compaction-wait.js";
import type { UsageDeltaAccountant } from "../../usage-delta-accountant.js";
import type { RuntimeBindingQuarantine } from "../../outbound-frame.js";
import {
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexSessionRecord,
} from "./session-state.js";
import { CodexAppServerConnection, type CodexConnectionOptions } from "./app-server-connection.js";
import {
  classifyRewindForkFailure,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "./session-errors.js";
import { readThread, readThreadNetworkAccess, readThreadTurnIds } from "./thread-view.js";
import { classifyResumeRecoveryCondition } from "./auth-status.js";
import {
  type CodexDiagnosticSink,
  reportDiagnosticFromDetachedFrame,
} from "./transport-diagnostics.js";
import type { CodexSpawnPosture } from "./spawn-posture.js";
import { composeCodexServiceTier, type CodexOutputSpeed } from "./output-speed.js";
import type { CodexNotificationRouting } from "./notification-routing.js";
import type { CodexProviderCommandCache } from "./provider-command-cache.js";
import type { CodexTextNeutralization } from "./text-neutralization.js";
import type { CodexRunRoutes } from "./run-routes.js";
import {
  DriverResumeResultSchema,
  ForkConversationResultSchema,
  type CreateSessionParams,
  type DriverResumeResult,
  type ForkConversationParams,
  type ForkConversationResult,
  type ProviderSessionHandle,
  type ResumeSessionParams,
} from "../../provider-driver.js";

/**
 * Closes an abandoned connection, killing the child first under `kill-and-close`, and reports a
 * teardown fault (an injected disposer is caller code) rather than letting it change the outcome
 * of the operation that abandoned it. `closeSession` does not use it: a close has no other outcome
 * to protect.
 */
export async function releaseAbandonedConnection(
  connection: CodexAppServerConnection,
  reportDiagnostic: CodexDiagnosticSink,
  release: "close" | "kill-and-close" = "close",
): Promise<void> {
  try {
    await (release === "kill-and-close" ? connection.killAndClose() : connection.close());
  } catch (cause) {
    // `close()` throws only its disposer's fault; the transport is released either way.
    reportDiagnosticFromDetachedFrame(reportDiagnostic, {
      kind: "subscription-dispose-failed",
      detail: normalizeProviderFailureDetail(cause),
    });
  }
}

/** The record for a just-established thread; every per-turn register starts empty. */
function composeSessionRecord(
  established: Pick<
    CodexSessionRecord,
    | "sessionId"
    | "connection"
    | "threadId"
    | "turnBoundaries"
    | "executionPosture"
    | "providerNetworkAccess"
    | "subagentPolicy"
    | "spawnConfig"
    | "model"
    | "outputSpeedRequest"
    | "outputSpeed"
    | "declaredOutputSpeed"
  >,
): CodexSessionRecord {
  return {
    ...established,
    runIdByActiveTurnId: new Map(),
    bufferedTurnEvidence: new Map(),
    inFlightTurnStarts: 0,
    settledTurnIds: new Set(),
    inFlightSteers: 0,
    interruptedRunIdByTurnId: new Map(),
    unsettledOutputSpeedRuns: new Map(),
  };
}

/** The session records, dependencies and lifecycle accessors the establishment legs write into. */
export interface CodexSessionEstablishmentDependencies {
  readonly options: Pick<CodexLifecycleOptions, "reportDiagnostic">;
  readonly sessions: Map<SessionId, CodexSessionRecord>;
  readonly newBindingId: () => string;
  readonly runtimeBindingQuarantine: RuntimeBindingQuarantine;
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly spawnPosture: CodexSpawnPosture;
  readonly outputSpeed: CodexOutputSpeed;
  readonly notificationRouting: CodexNotificationRouting;
  readonly providerCommands: CodexProviderCommandCache;
  readonly textNeutralization: CodexTextNeutralization;
  readonly runRoutes: CodexRunRoutes;
  readonly connectionOptionsFor: (sessionId: SessionId) => CodexConnectionOptions;
  readonly usageAccountantFor: (sessionId: SessionId) => UsageDeltaAccountant;
}

/**
 * Runs the create, resume and rewind legs inside the slot the lifecycle claimed for them. A failed
 * create or resume closes the connection it opened, so no owned process outlives its slot.
 */
export class CodexSessionEstablishment {
  readonly #options: CodexSessionEstablishmentDependencies["options"];
  readonly #sessions: Map<SessionId, CodexSessionRecord>;
  readonly #newBindingId: () => string;
  readonly #runtimeBindingQuarantine: RuntimeBindingQuarantine;
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #spawnPosture: CodexSpawnPosture;
  readonly #outputSpeed: CodexOutputSpeed;
  readonly #notificationRouting: CodexNotificationRouting;
  readonly #providerCommands: CodexProviderCommandCache;
  readonly #textNeutralization: CodexTextNeutralization;
  readonly #runRoutes: CodexRunRoutes;
  readonly #connectionOptionsFor: (sessionId: SessionId) => CodexConnectionOptions;
  readonly #usageAccountantFor: (sessionId: SessionId) => UsageDeltaAccountant;

  constructor(dependencies: CodexSessionEstablishmentDependencies) {
    this.#options = dependencies.options;
    this.#sessions = dependencies.sessions;
    this.#newBindingId = dependencies.newBindingId;
    this.#runtimeBindingQuarantine = dependencies.runtimeBindingQuarantine;
    this.#pendingCompactions = dependencies.pendingCompactions;
    this.#spawnPosture = dependencies.spawnPosture;
    this.#outputSpeed = dependencies.outputSpeed;
    this.#notificationRouting = dependencies.notificationRouting;
    this.#providerCommands = dependencies.providerCommands;
    this.#textNeutralization = dependencies.textNeutralization;
    this.#runRoutes = dependencies.runRoutes;
    this.#connectionOptionsFor = dependencies.connectionOptionsFor;
    this.#usageAccountantFor = dependencies.usageAccountantFor;
  }

  /** Spawns a process and starts a fresh thread; a failure closes the process and rethrows. */
  async establishCreatedSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Composed before the connection exists, so an unresolvable posture costs no process. Create
    // has no result type, so it raises the same `CodexDriverConfigError` as its config parse.
    const config = await this.#spawnPosture.composeCreateSpawnConfig(params);
    // Before the connection exists too, so a level the model does not list reaches no provider.
    const outputSpeed = await this.#outputSpeed.resolveLevel(params.model, params.outputSpeed);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Inside the guard: `open()` tears down only the paths it owns, not a throwing
      // caller-supplied subscriber, and `close()` is idempotent.
      await connection.open(config);
      const response = await connection.request("thread/start", {
        cwd: config.cwd,
        // Spread so a session with no declared posture gets none: an invented posture would refuse
        // admitted tool calls or grant what was not.
        ...this.#spawnPosture.composeThreadEstablishmentLegs(
          params.executionPosture,
          params.subagentPolicy,
        ),
        // Defense in depth: no config or profile override may select an auto-review path that
        // bypasses the approval pipeline. The per-turn pin on `turn/start` is needed too.
        // Present on ThreadStartParams at codex-cli 0.150.1.
        approvalsReviewer: "user",
        model: params.model,
        ...composeCodexServiceTier(outputSpeed),
      });
      const thread = readThread(response, "thread/start");
      this.#spawnPosture.reportWithheldCallbackTools(params.sessionId, params.callbackTools);
      this.#sessions.set(
        params.sessionId,
        composeSessionRecord({
          sessionId: params.sessionId,
          connection,
          threadId: thread.id,
          turnBoundaries: [],
          executionPosture: params.executionPosture,
          providerNetworkAccess: readThreadNetworkAccess(response),
          subagentPolicy: params.subagentPolicy,
          spawnConfig: config,
          model: params.model,
          outputSpeedRequest: params.outputSpeed,
          outputSpeed,
          declaredOutputSpeed: this.#outputSpeed.readDeclaredTier(params.sessionId, response),
        }),
      );
      // A fresh process now answers for this session id, so a prior trip's refusal is released.
      this.#runtimeBindingQuarantine.releaseSession(params.sessionId);
      // Bases at zero: the provider's counter starts there, so the first turn is real spend.
      this.#notificationRouting.bindSessionThread(params.sessionId, thread.id, { mode: "fresh" });
      // `id` is the resume key; `sessionId` groups a thread tree (fork and subagent threads share
      // it), so the two are not interchangeable.
      return { providerSessionId: thread.sessionId, resumeHandle: thread.id };
    } catch (cause) {
      // Contained so a throwing disposer in `close()` cannot replace the spawn or handshake error.
      await releaseAbandonedConnection(connection, this.#options.reportDiagnostic);
      throw cause;
    }
  }

  /** Relaunches the session's process and resumes its thread; every failure returns `failed`. */
  async establishResumedSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Read inside the claimed establishment, after any predecessor installed its record.
    const existing = this.#sessions.get(params.sessionId);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Composed inside the `try` so a posture refusal arrives as the typed `failed` result, not as
      // an exception out of `resumeSession`.
      const spawnConfig = await this.#spawnPosture.composeResumeSpawnConfig(existing, params);
      // The level rebuilt from the spawn record; one the model no longer lists resumes the
      // conversation at standard rather than failing it.
      const outputSpeed = await this.#outputSpeed.resolveLevel(params.model, params.outputSpeed);
      await connection.open(spawnConfig);
      const response = await connection.request("thread/resume", {
        threadId: params.resumeHandle,
        // A resume is a fresh spawn, so the spawn-bound legs are re-realized; otherwise the
        // provider would apply caps reloaded from the thread's persisted config.
        ...this.#spawnPosture.composeThreadEstablishmentLegs(
          params.executionPosture,
          params.subagentPolicy,
        ),
        // The same pin as `thread/start`: a resumed thread must not inherit an auto-review path.
        approvalsReviewer: "user",
        model: params.model,
        // Re-realized like the posture: a resume without it relaunches at the provider's tier.
        ...composeCodexServiceTier(outputSpeed),
      });
      const thread = readThread(response, "thread/resume");
      // Checked before the position: Codex may answer an unhonorable resume with a different
      // thread, and a zero-turn one has `turns: []`, like a genuine resume.
      if (thread.id !== params.resumeHandle) {
        throw new CodexTransportError(
          `Resume handle ${params.resumeHandle} was answered by thread ${thread.id}; the ` +
            `provider started a replacement thread rather than resuming.`,
          {
            method: "thread/resume",
            requestedThreadId: params.resumeHandle,
            answeredThreadId: thread.id,
          },
        );
      }
      if (!Array.isArray(thread.turns)) {
        // Populated on `thread/resume` by contract; a fabricated 0 would make a fresh thread look
        // resumed.
        throw new CodexTransportError(
          "The Codex app-server resume response carried no turn history, so the session " +
            "position is unknown.",
          { threadId: thread.id },
        );
      }
      // Built before the swap: the caller's minter can throw, and after the install that would
      // leave the session mapped to a closed connection. Parsed because the schema is the only
      // check of the minted `bindingId` (length cap, no blank, no NUL) before it is persisted.
      const resumedResult = DriverResumeResultSchema.parse({
        status: "resumed",
        bindingId: this.#newBindingId(),
        sessionPosition: thread.turns.length,
      });
      // Re-reported on resume: this leg offers the provider no callback-tool registry either.
      this.#spawnPosture.reportWithheldCallbackTools(params.sessionId, params.callbackTools);
      this.#sessions.set(
        params.sessionId,
        composeSessionRecord({
          sessionId: params.sessionId,
          connection,
          threadId: thread.id,
          // Seeded from the thread's own history so a rewind indexes the same axis as before
          // restart.
          turnBoundaries: readThreadTurnIds(thread.turns),
          executionPosture: params.executionPosture,
          providerNetworkAccess: readThreadNetworkAccess(response),
          subagentPolicy: params.subagentPolicy,
          spawnConfig,
          model: params.model,
          outputSpeedRequest: params.outputSpeed,
          outputSpeed,
          declaredOutputSpeed: this.#outputSpeed.readDeclaredTier(params.sessionId, response),
        }),
      );
      // Discarded: the held enumeration is a read from the replaced process, and its
      // `skills/changed` cue would arrive on a dead connection.
      this.#providerCommands.discardProviderCommandEnumeration(params.sessionId);
      this.#runtimeBindingQuarantine.releaseSession(params.sessionId);
      // Bases at the daemon's prior-emitted sum: the provider's counter survives a resume, so a
      // zero base would re-meter the whole history onto the first turn.
      this.#notificationRouting.bindSessionThread(params.sessionId, thread.id, {
        mode: "resume",
        priorEmittedThreadId: thread.id,
      });
      // Fails the predecessor's unsettled frames on their runs before routes are swept
      // (`runIdForAbandonedFrame` reads the run routes). Not ruled swallowed, not dropped,
      // not quarantined: the runs keep their interrupt and intervention controls.
      this.#textNeutralization.failSupersededDeliveries(existing, params.sessionId);
      // A compaction wait armed against the superseded leg can never get its evidence, so
      // `binding_lost` is owed now. Keyed on the superseded record's thread; no wait exists yet
      // against the replacement, as installation and this release are one synchronous run.
      if (existing !== undefined) {
        this.#pendingCompactions.releaseBinding(
          codexCompactionWaitKey(params.sessionId, existing.threadId),
        );
      }
      // Every route to the superseded leg is dead. Swept here because `closeSession` reads the live
      // record and would leak one entry per in-flight run per resume.
      this.#runRoutes.forgetRunRoutes(params.sessionId);
      // Usually a no-op, as `failSupersededDeliveries` consumed the registrations; kept as the
      // budget release's one home.
      this.#textNeutralization.releaseOutboundFrameBudget(params.sessionId);
      // Released after the install so a failed resume leaves the prior leg live.
      if (existing !== undefined) {
        await releaseAbandonedConnection(existing.connection, this.#options.reportDiagnostic);
      }
      return resumedResult;
    } catch (cause) {
      // Classified before the release: it asks this connection whether the credential is still
      // good, and a refused resume leaves the transport open. The release is contained so its
      // fault cannot escape the typed result.
      const recoveryCondition = await classifyResumeRecoveryCondition(
        connection,
        cause,
        this.#options.reportDiagnostic,
      );
      await releaseAbandonedConnection(connection, this.#options.reportDiagnostic);
      return {
        status: "failed",
        recoveryCondition,
        providerFailureDetail: normalizeProviderFailureDetail(cause),
      };
    }
  }

  /** Forks the thread at a recorded boundary and re-points the session's record at the fork. */
  async establishRewoundSession(
    params: ForkConversationParams,
    record: CodexSessionRecord,
    boundaryTurnId: string,
  ): Promise<ForkConversationResult> {
    // One read of the mutable field: both the fork source and the usage-base key.
    const preForkThreadId = record.threadId;
    // Wraps the dispatch alone: a malformed result from `readThread` is not a missing capability.
    let response: unknown;
    try {
      response = await record.connection.request("thread/fork", {
        threadId: preForkThreadId,
        lastTurnId: boundaryTurnId,
        // A new thread must re-realize the posture and caps, as a resume does.
        ...this.#spawnPosture.composeThreadEstablishmentLegs(
          record.executionPosture,
          record.subagentPolicy,
        ),
        approvalsReviewer: "user",
        model: record.model,
        // The held level, already resolved for this model, so the fork runs at the same speed.
        ...composeCodexServiceTier(record.outputSpeed),
      });
    } catch (cause) {
      // A build without `ThreadForkParams.lastTurnId` becomes `driver.capability_unsupported`;
      // any other failure is rethrown as it arrived. Nothing has mutated yet.
      throw classifyRewindForkFailure(cause);
    }
    const forkedThread = readThread(response, "thread/fork");
    // Answering with the thread it was handed means no fork happened; adopting it would report
    // `applied` with no surviving pre-rewind thread.
    if (forkedThread.id === preForkThreadId) {
      return { status: "degraded", fallbackAction: "rewind-not-forked" };
    }
    // A thread this session already meters would have its spend registers reset. Ordered after the
    // fork check because the pre-fork thread is itself registered.
    if (this.#usageAccountantFor(params.sessionId).hasThread(forkedThread.id)) {
      return { status: "degraded", fallbackAction: "rewind-target-thread-already-registered" };
    }
    // Re-read after the await, before the first mutation; rebinding under a live turn would strand
    // the turn.
    if (record.runIdByActiveTurnId.size > 0) {
      return { status: "degraded", fallbackAction: "rewind-deferred-turn-in-progress" };
    }
    record.threadId = forkedThread.id;
    record.providerNetworkAccess = readThreadNetworkAccess(response);
    record.declaredOutputSpeed = this.#outputSpeed.readDeclaredTier(params.sessionId, response);
    // The routing and metering band moves with the record. Based like a resume on the pre-fork
    // thread, the only key the earlier spend exists under. The wire reference does not say whether
    // the counter continues across a fork: if it restarts, the decrease floor gives loud
    // under-metering, whereas `fresh` would silently double-count.
    this.#notificationRouting.bindSessionThread(params.sessionId, forkedThread.id, {
      mode: "resume",
      priorEmittedThreadId: preForkThreadId,
    });
    // The router retires the old thread in the registration above; the accountant holds one set
    // per thread. Released only after the successor exists, so a refused fork can still meter.
    this.#usageAccountantFor(params.sessionId).releaseThread(preForkThreadId);
    // Compaction waits on the predecessor settle `binding_lost`, their honest terminal.
    this.#pendingCompactions.releaseBinding(
      codexCompactionWaitKey(params.sessionId, preForkThreadId),
    );
    const forkedTurnIds = readThreadTurnIds(forkedThread.turns);
    // An absent or unreadable turn list reads as zero turns, which also disagrees.
    if (forkedTurnIds.length !== params.position) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "fork-turn-ledger-unconfirmed",
        expectedTurnCount: params.position,
        confirmedTurnCount: forkedTurnIds.length,
      });
    }
    if (forkedTurnIds.length > 0) {
      // The provider's account of the forked history wins over the local ordinal.
      record.turnBoundaries.splice(0, record.turnBoundaries.length, ...forkedTurnIds);
    } else {
      record.turnBoundaries.length = params.position;
    }
    // Parsed for the minted `bindingId`, which the schema alone caps before it is persisted.
    return ForkConversationResultSchema.parse({
      status: "applied",
      sessionPosition: params.position,
      bindingId: this.#newBindingId(),
    });
  }
}
