/**
 * Codex app-server transport (`CodexAppServerConnection`, JSONL JSON-RPC over one `PtyHost`) and
 * lifecycle (`CodexLifecycleManager`). No port separates them, so tests drive the real framing
 * through a fake `PtyHost`.
 * - `/bin/sh -c` spawns the provider (see the prelude): a PTY slave starts canonical with echo on,
 *   and `codex app-server` never calls `tcsetattr`. Canonical mode silently drops an input line
 *   over MAX_CANON (Darwin 1024 bytes; `codex-cli 0.149.1` answered a 1015-byte frame, not 1045).
 * - A failed resume never becomes a new session: it returns the typed `recovery-needed` failure.
 * - Every spawn or dispose runs inside `#claimSessionSlot` (`establishing`, `live`, `closing`),
 *   held until fully settled, so no owned process exists without a held slot; a `startRun` that
 *   only installs a route re-reads the slot after its await.
 * - Errors use registered codes only: `driver.unavailable` (503), `driver.timeout` (504).
 */

import {
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DriverResumeResultSchema,
  ForkConversationResultSchema,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CompactContextParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverCompactionResult,
  type ListProviderCommandsParams,
  type ProviderCommandEntry,
  type ProviderCommandListResult,
  type DriverResumeResult,
  type ForkConversationResult,
  type ExecutionPosture,
  type InterruptRunParams,
  type DriverTranscriptReplayResult,
  type ProviderSessionHandle,
  type ReplayTranscriptParams,
  type ResumeSessionParams,
  type ForkConversationParams,
  type RunId,
  type SessionId,
  type SetSessionGoalParams,
  type SubagentPolicy,
  type StartRunParams,
} from "@ai-sidekicks/contracts";
import { PendingCompactionRegistry } from "../../compaction-wait.js";
import { ThreadFrameRouter, type ThreadFrameRoute } from "../../thread-frame-router.js";
import { UsageDeltaAccountant, type CumulativeAxisReadings } from "../../usage-delta-accountant.js";
import { type CredentialEnvPolicy } from "../../spawn-env.js";
import {
  AmbiguousDeliveryReconciler,
  classifyProviderRequestFailure,
  PermanentStructuralRefusalError,
} from "../../transcript/failure-mapping.js";
import {
  assertReplayReconstituted,
  PostReplayAssertionFailedError,
  ReplayTargetLedger,
  type PostReplayVerdict,
  type ReplayTargetAbandonmentCause,
  type ReplayTargetReadback,
  type ReplayTargetReadbackReader,
  type SeededTranscriptFrame,
} from "../../transcript/replay-assertion.js";
import {
  CODEX_SKILLS_CHANGED_METHOD,
  CODEX_THREAD_COMPACTED_METHOD,
  CODEX_THREAD_STARTED_METHOD,
  CODEX_THREAD_TOKEN_USAGE_METHOD,
  CODEX_TURN_COMPLETED_METHOD,
  classifyCodexFrameFamilyForRouting,
} from "./event-normalizer.js";
import {
  classifyCodexTurnEvidence,
  classifyCodexTurnEvidenceObservation,
  CodexTerminalEmissionGate,
} from "./turn-evidence.js";
import {
  OutboundFrameTripwire,
  OutboundTextFrameWriter,
  RuntimeBindingQuarantine,
  UNRECOGNIZED_TURN_EVIDENCE,
  observedTurnEvidence,
  composeSupersededDeliveryRunFailure,
  composeTextNeutralizationRunFailure,
  type OutboundTextFrame,
  type TextNeutralizationRunFailure,
  type TripwireDecision,
} from "../outbound-frame.js";
import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "./intervention.js";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import { mintUuidV7 } from "../../../ids/uuid-v7.js";
import {
  CODEX_TERMINAL_TURN_STATUSES,
  CODEX_THREAD_FRAME_ROUTER_CONFIG,
  CODEX_TURN_COMPLETED_NOTIFICATION,
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexRoutableFrame,
  type CodexSessionRecord,
  type CodexSessionTransition,
  type CodexSessionTransitionKind,
  type CodexUsageEstablishment,
  newestActiveTurnForRun,
  observeCodexTurnStartFailure,
  readCodexChildThreadAnnouncement,
  readCodexCumulativeUsageReading,
  readCodexFrameThreadId,
  readCodexTerminalTurnStatus,
  rememberInterruptedRun,
  rememberSettledTurn,
  rememberUnmatchedTurn,
  soleActiveRunIdIn,
} from "./session-state.js";
import {
  CodexAppServerConnection,
  type CodexConnectionOptions,
  type CodexRequestAttempt,
  type CodexRequestDelivery,
  defaultScheduleTimeout,
} from "./app-server-connection.js";
import {
  assertRealizedTurnPostureMembers,
  CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
  type CodexRunConfig,
  type CodexSessionConfig,
  composeCodexSubagentConfigOverrides,
  composeCodexThreadPosture,
  composeCodexThreadPostureConfig,
  composeCodexTurnSandboxPolicy,
  describeCodexPostureDivergence,
  parseCodexRunConfig,
  parseCodexSessionConfig,
  resolveBoundProviderAccountId,
  RUN_OPENING_FRAME_ORIGIN,
} from "./session-config.js";
import {
  classifyRewindForkFailure,
  CodexDriverConfigError,
  CodexSessionAlreadyLiveError,
  type CodexSessionSlotState,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "./session-errors.js";
import {
  codexResponsesItemForFrame,
  readRenderedTranscriptFrameForReplay,
  readSteeredTurnId,
  readThread,
  readThreadTurnIds,
  readTurnId,
} from "./thread-view.js";
import {
  buildAuthProbeResult,
  classifyCodexAuthStatus,
  classifyResumeRecoveryCondition,
  CODEX_AUTH_PROBE_TIMEOUT_MS,
  requestCodexAuthStatus,
} from "./auth-status.js";
import {
  type CodexTransportDiagnostic,
  reportDiagnosticFromDetachedFrame,
} from "./transport-diagnostics.js";
import {
  CODEX_COMPACTION_WAIT_MS,
  CODEX_SKILLS_LIST_METHOD,
  CODEX_THREAD_COMPACT_START_METHOD,
  CODEX_THREAD_INJECT_ITEMS_METHOD,
  type CodexProviderCommandRejection,
  readCodexCompactionBoundaryPosition,
  readCodexProviderCommandEntries,
} from "./provider-commands.js";
import {
  CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
  type CodexInboundServerRequest,
  type CodexRoutedAskAttribution,
  type CodexRoutedAskTurnIdReading,
  type CodexServerRequestDecision,
  composeRoutedAskRefusalReason,
  readRoutedAskTurnId,
} from "./server-requests.js";
import { CODEX_ASK_OPTION_SET_MAX, readCodexAskOptionSet } from "./ask-option-sets.js";
import { isPlainObject } from "./record-readers.js";

const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;

/**
 * Deadline for the courtesy `thread/unsubscribe`; short so a wedged provider cannot hold close.
 */
const UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/** Lifecycle operations as Codex `app-server` calls, one connection per session. */
export class CodexLifecycleManager {
  readonly #options: CodexLifecycleOptions;
  readonly #newBindingId: () => string;
  readonly #turnStartTimeoutMs: number;
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #runtimeBindingQuarantine = new RuntimeBindingQuarantine();
  readonly #sessions = new Map<SessionId, CodexSessionRecord>();
  /** Burned replay targets by provider session id; they outlive the daemon-side session. */
  readonly #replayTargets: ReplayTargetLedger = new ReplayTargetLedger();
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
  // Live command enumeration per session, held uncapped: the cap applies when a result is
  // composed. Discarded on `skills/changed` and with the session.
  readonly #providerCommandEnumerations = new Map<SessionId, readonly ProviderCommandEntry[]>();
  // The invalidation epoch each held enumeration was read under: a `skills/list` in flight during
  // `skills/changed` would otherwise store a pre-change listing. Symbols, not a counter, since a
  // reused session id could match a reset counter.
  readonly #providerCommandEnumerationEpochs = new Map<SessionId, symbol>();
  readonly #sessionIdByRunId = new Map<RunId, SessionId>();
  /** In-flight create, resume, fork or close per session, held until it fully settles. */
  readonly #sessionTransitions = new Map<SessionId, CodexSessionTransition>();

  constructor(options: CodexLifecycleOptions) {
    this.#options = options;
    this.#newBindingId = options.newBindingId ?? mintUuidV7;
    this.#turnStartTimeoutMs = options.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
    // The same injected scheduler as the transport's deadlines.
    this.#pendingCompactions = new PendingCompactionRegistry(
      options.scheduleTimeout ?? defaultScheduleTimeout,
    );
    this.#ambiguousDeliveryReconciler = new AmbiguousDeliveryReconciler(options.userTurnReadback);
    this.#outboundTextFrameWriter = new OutboundTextFrameWriter({
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
  }

  /**
   * Composes and registers the run's opening text frame before any byte is written: text the
   * tripwire cannot watch must not be sent, or a turn settling against no frame would pass.
   *
   * @throws {OutboundFrameCapacityRefusedError} when the session holds more unsettled frames than
   *   the tripwire will watch.
   */
  #composeRunOpeningFrame(params: StartRunParams, runConfig: CodexRunConfig): OutboundTextFrame {
    // A literal, not read from the caller's config: `driver_command` skips neutralization and the
    // tripwire, so it must not be nameable through an untyped record.
    const frame = this.#outboundTextFrameWriter.compose({
      text: runConfig.input,
      origin: RUN_OPENING_FRAME_ORIGIN,
    });
    this.#outboundFrameTripwire.register({
      scopeKey: runConfig.sessionId,
      joinKey: params.runId,
      frameRole: "turn-opening",
      frame,
    });
    return frame;
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
      async () => await this.#establishCreatedSession(params),
    );
  }

  async #establishCreatedSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Composed before the connection exists, so an unresolvable posture costs no process. Create
    // has no result type, so it raises the same `CodexDriverConfigError` as its config parse.
    const config = await this.#composeCreateSpawnConfig(params);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Inside the guard: `open()` tears down only the paths it owns, not a throwing
      // caller-supplied subscriber, and `close()` is idempotent.
      await connection.open(config);
      const response = await connection.request("thread/start", {
        cwd: config.cwd,
        // Spread so a session with no declared posture gets none: an invented posture would refuse
        // admitted tool calls or grant what was not.
        ...this.#composeThreadEstablishmentLegs(params.executionPosture, params.subagentPolicy),
        // Defense in depth: no config or profile override may select an auto-review path that
        // bypasses the approval pipeline. The per-turn pin in `#requestTurnStart` is needed too.
        approvalsReviewer: "user",
      });
      const thread = readThread(response, "thread/start");
      this.#assertPostureRealized(params.executionPosture, response);
      this.#reportWithheldCallbackTools(params.sessionId, params.callbackTools);
      this.#sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        connection,
        threadId: thread.id,
        turnBoundaries: [],
        executionPosture: params.executionPosture,
        subagentPolicy: params.subagentPolicy,
        spawnConfig: config,
        runIdByActiveTurnId: new Map(),
        unmatchedTurnEvidence: new Map(),
        inFlightTurnStarts: 0,
        settledTurnIds: new Set(),
        inFlightSteers: 0,
        interruptedRunIdByTurnId: new Map(),
      });
      // A fresh process now answers for this session id, so a prior trip's refusal is released.
      this.#runtimeBindingQuarantine.releaseSession(params.sessionId);
      // Bases at zero: the provider's counter starts there, so the first turn is real spend.
      this.#bindSessionThread(params.sessionId, thread.id, { mode: "fresh" });
      // `id` is the resume key; `sessionId` groups a thread tree (fork and subagent threads share
      // it), so the two are not interchangeable.
      return { providerSessionId: thread.sessionId, resumeHandle: thread.id };
    } catch (cause) {
      // Contained so a throwing disposer in `close()` cannot replace the spawn or handshake error.
      await this.#releaseAbandonedConnection(connection);
      throw cause;
    }
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
      async () => await this.#establishResumedSession(params),
    );
  }

  /**
   * `cwd` and `env` come from the untyped `params.config`, parsed fail-closed on every create; the
   * credential policy is posture-derived. Members are built one by one, never spread, so a policy
   * the posture resolved away is not carried through.
   */
  async #composeCreateSpawnConfig(params: CreateSessionParams): Promise<CodexSessionConfig> {
    const declared = parseCodexSessionConfig(params.config);
    const credentialEnvPolicy = await this.#resolveCredentialEnvPolicyForPosture(
      declared.credentialEnvPolicy,
      params.executionPosture,
      "CreateSessionParams.executionPosture.credentialPolicyRef",
    );
    // The typed and config channels can both name the credential home; the typed one is checked
    // against the other, so a typed caller cannot silently spawn against the node default.
    const providerAccountId = resolveBoundProviderAccountId({
      requested: params.providerAccountId,
      requestedField: "CreateSessionParams.providerAccountId",
      recorded: declared.providerAccountId,
      recordedField: "CreateSessionParams.config.providerAccountId",
    });
    return {
      cwd: declared.cwd,
      env: declared.env,
      ...(providerAccountId === undefined ? {} : { providerAccountId }),
      ...(credentialEnvPolicy === undefined ? {} : { credentialEnvPolicy }),
    };
  }

  /**
   * `cwd` and `env` come from the live record's spawn config, else the manager default; the
   * credential policy is entirely posture-derived, since inheriting it would relaunch a session
   * created `trusted` and resumed sandboxed unfiltered. Members are built one by one, never spread.
   */
  async #composeResumeSpawnConfig(
    existing: CodexSessionRecord | undefined,
    params: ResumeSessionParams,
  ): Promise<CodexSessionConfig> {
    const processContext = existing?.spawnConfig ?? this.#options.resumeSpawnConfig;
    const credentialEnvPolicy = await this.#resolveCredentialEnvPolicyForPosture(
      processContext.credentialEnvPolicy,
      params.executionPosture,
      "ResumeSessionParams.executionPosture.credentialPolicyRef",
    );
    // Re-derived so a posture change reaches the child. The account is pinned for the leg's
    // lifetime, so a typed member contradicting the live record refuses.
    const requestedAccountId = resolveBoundProviderAccountId({
      requested: params.providerAccountId,
      requestedField: "ResumeSessionParams.providerAccountId",
      recorded: existing?.spawnConfig.providerAccountId,
      recordedField: "the live session record's own spawn config",
    });
    // A mismatch (an unbound environment account counts) refuses: this driver is handed a built
    // credential environment and cannot build another account's. Rebinding to the admitted account
    // happens above this seam, which supplies a resume spawn config built for it.
    const environmentAccountId = processContext.providerAccountId;
    if (requestedAccountId !== undefined && requestedAccountId !== environmentAccountId) {
      const environmentSource =
        existing === undefined
          ? `no live session record survives, so the only environment available is the node-wide default's, constructed for ${environmentAccountId ?? "no bound account"}`
          : `the live session record this resume relaunches from was established for ${environmentAccountId ?? "no bound account"}, so its environment is not that account's`;
      throw new CodexDriverConfigError(
        `ResumeSessionParams.providerAccountId names provider account ${requestedAccountId}, but ${environmentSource}; this driver is handed a constructed credential environment and cannot build another account's, so the relaunch is refused rather than spawned against an environment that bills elsewhere.`,
        "ResumeSessionParams.providerAccountId",
      );
    }
    const providerAccountId = environmentAccountId;
    return {
      cwd: processContext.cwd,
      env: processContext.env,
      ...(providerAccountId === undefined ? {} : { providerAccountId }),
      ...(credentialEnvPolicy === undefined ? {} : { credentialEnvPolicy }),
    };
  }

  /**
   * Answers which credential policy filters a spawned child; create and resume both call it, and a
   * new spawn path must too. No posture keeps the declared policy, `trusted` drops it, and an
   * unresolved sandboxed reference is refused rather than degraded to "deny nothing".
   */
  async #resolveCredentialEnvPolicyForPosture(
    declaredPolicy: CredentialEnvPolicy | undefined,
    posture: ExecutionPosture | undefined,
    postureRefusalField: string,
  ): Promise<CredentialEnvPolicy | undefined> {
    if (posture === undefined) {
      return declaredPolicy;
    }
    if (posture.mode === "trusted") {
      return undefined;
    }
    const resolved = await this.#options.resolveCredentialEnvPolicy(posture);
    if (resolved === undefined) {
      throw new CodexDriverConfigError(
        `The execution posture "${posture.mode}" carries a credential policy reference that resolved to no policy, so the spawned child cannot be filtered.`,
        postureRefusalField,
      );
    }
    return resolved;
  }

  async #establishResumedSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Read inside the claimed establishment, after any predecessor installed its record.
    const existing = this.#sessions.get(params.sessionId);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Composed inside the `try` so a posture refusal arrives as the typed `failed` result, not as
      // an exception out of `resumeSession`.
      const spawnConfig = await this.#composeResumeSpawnConfig(existing, params);
      await connection.open(spawnConfig);
      const response = await connection.request("thread/resume", {
        threadId: params.resumeHandle,
        // A resume is a fresh spawn, so the spawn-bound legs are re-realized; otherwise the
        // provider would apply caps reloaded from the thread's persisted config.
        ...this.#composeThreadEstablishmentLegs(params.executionPosture, params.subagentPolicy),
        // The same pin as `thread/start`: a resumed thread must not inherit an auto-review path.
        approvalsReviewer: "user",
      });
      const thread = readThread(response, "thread/resume");
      this.#assertPostureRealized(params.executionPosture, response);
      // Checked before the position: Codex may answer an unhonorable resume with a different
      // thread, and a zero-turn one has `turns: []`, like a genuine resume.
      if (thread.id !== params.resumeHandle) {
        throw new CodexTransportError(
          `Resume handle ${params.resumeHandle} was answered by thread ${thread.id}; the provider started a replacement thread rather than resuming.`,
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
          "The Codex app-server resume response carried no turn history, so the session position is unknown.",
          { threadId: thread.id },
        );
      }
      // Built and validated before the swap: the caller's minter can throw, and after the install
      // that would leave the session mapped to a closed connection.
      const resumedResult = DriverResumeResultSchema.parse({
        status: "resumed",
        bindingId: this.#newBindingId(),
        sessionPosition: thread.turns.length,
      });
      // Re-reported on resume: this leg offers the provider no callback-tool registry either.
      this.#reportWithheldCallbackTools(params.sessionId, params.callbackTools);
      this.#sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        connection,
        threadId: thread.id,
        // Seeded from the thread's own history so a rewind indexes the same axis as before restart.
        turnBoundaries: readThreadTurnIds(thread.turns),
        executionPosture: params.executionPosture,
        subagentPolicy: params.subagentPolicy,
        spawnConfig,
        runIdByActiveTurnId: new Map(),
        unmatchedTurnEvidence: new Map(),
        inFlightTurnStarts: 0,
        settledTurnIds: new Set(),
        inFlightSteers: 0,
        interruptedRunIdByTurnId: new Map(),
      });
      // Discarded: the held enumeration is a read from the replaced process, and its
      // `skills/changed` cue would arrive on a dead connection.
      this.#discardProviderCommandEnumeration(params.sessionId);
      this.#runtimeBindingQuarantine.releaseSession(params.sessionId);
      // Bases at the daemon's prior-emitted sum: the provider's counter survives a resume, so a
      // zero base would re-meter the whole history onto the first turn.
      this.#bindSessionThread(params.sessionId, thread.id, {
        mode: "resume",
        priorEmittedThreadId: thread.id,
      });
      // Fails the predecessor's unsettled frames on their runs before routes are swept
      // (`#runIdForAbandonedFrame` reads `#sessionIdByRunId`). Not ruled swallowed, not dropped,
      // not quarantined: the runs keep their interrupt and intervention controls.
      this.#failSupersededDeliveries(existing, params.sessionId);
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
      this.#forgetRunRoutes(params.sessionId);
      // Usually a no-op, as `#failSupersededDeliveries` consumed the registrations; kept as the
      // budget release's one home.
      this.#releaseOutboundFrameBudget(params.sessionId);
      // Released after the install so a failed resume leaves the prior leg live.
      if (existing !== undefined) {
        await this.#releaseAbandonedConnection(existing.connection);
      }
      return resumedResult;
    } catch (cause) {
      // Classified before the release: it asks this connection whether the credential is still
      // good, and a refused resume leaves the transport open. The release is contained so its
      // fault cannot escape the typed result.
      const recoveryCondition = await classifyResumeRecoveryCondition(connection, cause);
      await this.#releaseAbandonedConnection(connection);
      return DriverResumeResultSchema.parse({
        status: "failed",
        recoveryCondition,
        // The driver saw a refused resume, not the span of work in flight; classifying that needs
        // run state it lacks.
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: normalizeProviderFailureDetail(cause),
      });
    }
  }

  /** Starts one provider turn for a run. */
  async startRun(params: StartRunParams): Promise<void> {
    const runConfig = parseCodexRunConfig(params.agentConfig);
    const record = this.#requireSession(runConfig.sessionId);
    const openingFrame = this.#composeRunOpeningFrame(params, runConfig);
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
    this.#sessionIdByRunId.set(params.runId, record.sessionId);
    // Appended at acceptance, not completion: a completion-time ledger would omit interrupted and
    // failed turns and misname later positions.
    record.turnBoundaries.push(turnId);
    // The turn can already be over: this continuation is a microtask while `#ingest` drains the
    // chunk synchronously, so the sweep may have matched nothing. The remembered evidence closes
    // that window and is replayed onto the re-keyed frame so the terminal is ruled here.
    const remembered = record.unmatchedTurnEvidence.get(turnId);
    if (remembered === undefined) {
      return;
    }
    record.unmatchedTurnEvidence.delete(turnId);
    for (const observation of remembered.observations) {
      this.#outboundFrameTripwire.observe(turnId, observation);
    }
    const rememberedTerminal = remembered.terminal;
    if (rememberedTerminal === undefined) {
      // In-flight evidence only: the turn is still running; its own terminal settles the frame.
      return;
    }
    this.#retireTurnRoute(record, turnId);
    const decision = this.#outboundFrameTripwire.settle(turnId, rememberedTerminal);
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#runtimeBindingQuarantine.disposeRun(params.runId, record.sessionId);
    this.#reportTextNeutralizationFailure(
      record.sessionId,
      params.runId,
      composeTextNeutralizationRunFailure(decision),
    );
    this.#disposeQuarantinedSession(record);
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
      // `turn/steer` creates no turn and needs none.
      approvalsReviewer: "user",
      // The run's posture wins and the session's spawn posture is the floor, so a turn never goes
      // out with no policy; both send the roots the thread-level selector cannot carry.
      ...this.#composeTurnPostureParams(record, params),
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
        this.#ruleAbandonedFramesFailClosed(record);
        this.#forgetRunRoutes(record.sessionId);
        // Covers the quarantine path too: `#disposeQuarantinedSession` delegates here.
        this.#pendingCompactions.releaseBinding(
          codexCompactionWaitKey(record.sessionId, record.threadId),
        );
        this.#discardProviderCommandEnumeration(record.sessionId);
        this.#releaseOutboundFrameBudget(record.sessionId);
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
      await this.#releaseAbandonedConnection(connection);
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
        this.#refuseUnretainableInterruptedRoute(record);
        return;
      }
    }
    // Retires this turn's route only; a run holding a second live turn keeps that route.
    this.#retireTurnRoute(record, turnId);
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
      async () => await this.#establishRewoundSession(params, record, boundaryTurnId),
    );
  }

  async #establishRewoundSession(
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
        ...this.#composeThreadEstablishmentLegs(record.executionPosture, record.subagentPolicy),
        approvalsReviewer: "user",
      });
    } catch (cause) {
      // A build without `ThreadForkParams.lastTurnId` becomes `driver.capability_unsupported`;
      // any other failure is rethrown as it arrived. Nothing has mutated yet.
      throw classifyRewindForkFailure(cause);
    }
    const forkedThread = readThread(response, "thread/fork");
    this.#assertPostureRealized(record.executionPosture, response);
    // Answering with the thread it was handed means no fork happened; adopting it would report
    // `applied` with no surviving pre-rewind thread.
    if (forkedThread.id === preForkThreadId) {
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-not-forked",
      });
    }
    // A thread this session already meters would have its spend registers reset. Ordered after the
    // fork check because the pre-fork thread is itself registered.
    if (this.usageAccountantFor(params.sessionId).hasThread(forkedThread.id)) {
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-target-thread-already-registered",
      });
    }
    // Re-read after the await, before the first mutation; rebinding under a live turn would strand
    // the turn.
    if (record.runIdByActiveTurnId.size > 0) {
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-deferred-turn-in-progress",
      });
    }
    record.threadId = forkedThread.id;
    // The routing and metering band moves with the record. Based like a resume on the pre-fork
    // thread, the only key the earlier spend exists under. The wire reference does not say whether
    // the counter continues across a fork: if it restarts, the decrease floor gives loud
    // under-metering, whereas `fresh` would silently double-count.
    this.#bindSessionThread(params.sessionId, forkedThread.id, {
      mode: "resume",
      priorEmittedThreadId: preForkThreadId,
    });
    // The router retires the old thread in the registration above; the accountant holds one set
    // per thread. Released only after the successor exists, so a refused fork can still meter.
    this.usageAccountantFor(params.sessionId).releaseThread(preForkThreadId);
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
    return ForkConversationResultSchema.parse({
      status: "applied",
      sessionPosition: params.position,
      bindingId: this.#newBindingId(),
    });
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
    const wait = this.#pendingCompactions.arm(
      codexCompactionWaitKey(params.sessionId, record.threadId),
      CODEX_COMPACTION_WAIT_MS,
    );
    try {
      await record.connection.request(CODEX_THREAD_COMPACT_START_METHOD, {
        threadId: record.threadId,
      });
    } catch (cause) {
      wait.abandon();
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "compaction_wait_terminal",
        rawWireType: CODEX_THREAD_COMPACT_START_METHOD,
        dispositionReason: normalizeProviderFailureDetail(cause),
        details: { sessionId: params.sessionId, terminal: "provider_error" },
      });
      return { status: "failed", reason: "provider_error" };
    }
    const settlement = await wait.settled;
    if (settlement.terminal === "observed") {
      return { status: "applied", boundaryPosition: settlement.boundaryPosition };
    }
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "compaction_wait_terminal",
      rawWireType: CODEX_THREAD_COMPACT_START_METHOD,
      dispositionReason:
        settlement.terminal === "wait_expired"
          ? "the declared compaction bound elapsed with no typed compaction frame; a later frame still normalizes into its boundary row"
          : "the binding stopped being live before a typed compaction frame arrived",
      details: {
        sessionId: params.sessionId,
        terminal: settlement.terminal,
        declaredBoundMs: CODEX_COMPACTION_WAIT_MS,
      },
    });
    return { status: "failed", reason: settlement.terminal };
  }

  /**
   * Reconstitutes the transcript into a fresh session, one `thread/inject_items` request per frame
   * so a failure leaves a known applied prefix, and returns only after the readback confirms it.
   * Every failure abandons the target ({@link ReplayTargetLedger}) and throws; a frame this leg
   * cannot represent is refused, never skipped, so `applied` carries no losses.
   */
  async replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult> {
    const targetProviderSessionId: string = params.target.providerSessionId;
    this.#replayTargets.assertUsable(targetProviderSessionId);

    const record: CodexSessionRecord = this.#requireReplayTargetRecord(params.target);

    // A non-empty turn ledger proves the target already held a conversation.
    if (record.turnBoundaries.length > 0) {
      this.#abandonReplayTarget(record, targetProviderSessionId, "target-not-fresh");
      throw new CodexTransportError(
        `Refusing to replay into Codex thread "${record.threadId}": it already holds ${String(record.turnBoundaries.length)} turn(s), and a replay target must be fresh.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    const seeded: SeededTranscriptFrame[] = [];
    for (const frame of params.frames) {
      // Fail closed before any write: a skipped frame would falsify the empty loss list.
      seeded.push(readRenderedTranscriptFrameForReplay(frame));
    }
    if (seeded.length === 0) {
      throw new CodexTransportError(
        "Refusing to replay an empty transcript into a Codex thread: there is nothing to reconstitute, and a post-replay assertion over no frames confirms nothing.",
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    for (const frame of seeded) {
      const attempt: CodexRequestAttempt = await record.connection.attemptRequest(
        CODEX_THREAD_INJECT_ITEMS_METHOD,
        { threadId: record.threadId, items: [codexResponsesItemForFrame(frame)] },
      );
      if (attempt.settled === "answered") {
        continue;
      }
      // `indeterminate` (bytes left, arrival unknowable) must not be recorded as a refusal.
      const cause: ReplayTargetAbandonmentCause =
        attempt.delivery === "indeterminate" ? "ambiguous-delivery" : "interior-refusal";
      this.#abandonReplayTarget(record, targetProviderSessionId, cause);
      throw new CodexTransportError(
        `Codex replay seeding stopped at transcript position ${String(frame.position)} (${attempt.delivery}); the target was abandoned and must not be reused.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    const readReadback: ReplayTargetReadbackReader | undefined =
      this.#options.transcriptReplayReadback;
    if (readReadback === undefined) {
      // Answered seeding calls are not proof; without a readback a discarded seed looks faithful.
      this.#abandonReplayTarget(record, targetProviderSessionId, "readback-unavailable");
      throw new CodexTransportError(
        `Codex replay into thread "${record.threadId}" seeded ${String(seeded.length)} frame(s) but no target-readback reader is bound, so the post-replay assertion cannot run; the target was abandoned.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    let readback: ReplayTargetReadback;
    try {
      readback = await readReadback(targetProviderSessionId);
    } catch (error: unknown) {
      // A rejecting reader is the `unreadable` arm of the readback contract.
      readback = {
        kind: "unreadable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const verdict: PostReplayVerdict = assertReplayReconstituted(seeded, readback);
    if (verdict.outcome === "refuted") {
      const cause: ReplayTargetAbandonmentCause =
        verdict.refutation === "target-unreadable" ? "readback-unavailable" : "assertion-refuted";
      this.#abandonReplayTarget(record, targetProviderSessionId, cause);
      throw new PostReplayAssertionFailedError(targetProviderSessionId, seeded.length, verdict);
    }

    // Retired on success too: `thread/inject_items` leaves `turnBoundaries` empty, so the
    // freshness gate would not stop a second seeding through the same handle.
    this.#replayTargets.consume(targetProviderSessionId);

    return { status: "applied", declaredLosses: [] };
  }

  /** Finds the record whose current thread id is the handle's `resumeHandle`; a miss throws. */
  #requireReplayTargetRecord(target: ProviderSessionHandle): CodexSessionRecord {
    for (const record of this.#sessions.values()) {
      if (record.threadId === target.resumeHandle) {
        return record;
      }
    }
    throw new CodexTransportError(
      `No live Codex session is bound to replay target thread "${target.resumeHandle}".`,
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }

  /**
   * Records the abandonment first, so the target is unusable even if disposal fails, then closes
   * its process. A disposal failure stays in `#sessions` and is swallowed: the caller is throwing.
   */
  #abandonReplayTarget(
    record: CodexSessionRecord,
    targetProviderSessionId: string,
    cause: ReplayTargetAbandonmentCause,
  ): void {
    this.#replayTargets.abandon(targetProviderSessionId, cause);
    void this.closeSession({ sessionId: record.sessionId }).catch(() => {
      // The caller is already throwing the replay error.
    });
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
    const providerAccountId = record.spawnConfig.providerAccountId ?? null;
    const held = await this.#heldProviderCommandsFor(params.sessionId, record, providerAccountId);
    const complete = held.length <= DRIVER_PROVIDER_COMMAND_ENTRIES_MAX;
    const entries = complete ? [...held] : held.slice(0, DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
    if (!complete) {
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "provider_command_entries_truncated",
        rawWireType: CODEX_SKILLS_LIST_METHOD,
        dispositionReason:
          "the provider published more entries than the wire-and-render cap admits; the reply's tail was dropped and the driver's held enumeration was left whole",
        details: {
          sessionId: params.sessionId,
          heldCount: held.length,
          returnedCount: entries.length,
        },
      });
    }
    return {
      bindings: [
        {
          // From this read's record, not by session id: a resume landing mid-request must not
          // stamp the successor's run here.
          runId: soleActiveRunIdIn(record),
          binding: { driverName: CODEX_DRIVER_NAME, providerAccountId },
          entries,
          complete,
        },
      ],
    };
  }

  /**
   * The held enumeration, read from the provider if absent. The epoch captured before the request
   * is re-checked before storing, so an invalidation mid-flight leaves the reading uncached.
   */
  async #heldProviderCommandsFor(
    sessionId: SessionId,
    record: CodexSessionRecord,
    providerAccountId: string | null,
  ): Promise<readonly ProviderCommandEntry[]> {
    const held = this.#providerCommandEnumerations.get(sessionId);
    if (held !== undefined) {
      return held;
    }
    const readEpoch = this.#providerCommandEnumerationEpochFor(sessionId);
    const response = await record.connection.request(CODEX_SKILLS_LIST_METHOD, {});
    const reading = readCodexProviderCommandEntries(response, providerAccountId);
    for (const rejection of reading.rejections) {
      this.#reportProviderCommandEntryRejected(sessionId, rejection);
    }
    if (this.#providerCommandEnumerationEpochs.get(sessionId) === readEpoch) {
      this.#providerCommandEnumerations.set(sessionId, reading.entries);
    }
    return reading.entries;
  }

  /**
   * Reports a field the contract's bounds refused; absence is a positive claim, so a silent drop
   * would misstate the provider. Only lengths are carried, never the refused value.
   */
  #reportProviderCommandEntryRejected(
    sessionId: SessionId,
    rejection: CodexProviderCommandRejection,
  ): void {
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "provider_command_entry_rejected",
      rawWireType: CODEX_SKILLS_LIST_METHOD,
      dispositionReason: rejection.dropped
        ? "the provider published a command or skill entry the contract's own bounds refuse; it is dropped from this reply and its siblings are unaffected"
        : "the provider declared a command or skill field the contract's own bounds refuse; the entry is kept and the field reads ABSENT, which on this contract means the provider declared none",
      details: {
        sessionId,
        entryKind: "skill",
        rejectedField: rejection.rejectedField,
        dropped: rejection.dropped,
        nameLength: rejection.nameLength,
        rejectedValueLength: rejection.rejectedValueLength,
      },
    });
  }

  #providerCommandEnumerationEpochFor(sessionId: SessionId): symbol {
    const current = this.#providerCommandEnumerationEpochs.get(sessionId);
    if (current !== undefined) {
      return current;
    }
    const minted = Symbol("codex-provider-command-enumeration");
    this.#providerCommandEnumerationEpochs.set(sessionId, minted);
    return minted;
  }

  /** Clears list and epoch together; deleting the epoch fails an in-flight read's re-check. */
  #discardProviderCommandEnumeration(sessionId: SessionId): void {
    this.#providerCommandEnumerations.delete(sessionId);
    this.#providerCommandEnumerationEpochs.delete(sessionId);
  }

  /** Unsubscribes and tears down the process. Idempotent: an unknown session resolves. */
  async closeSession(params: CloseSessionParams): Promise<void> {
    // Claiming a free slot would refuse a concurrent create, hence the early return. A close during
    // establishment chains behind it. The latch comes first so every later terminal counts as
    // clean.
    this.#intendedCloseGateFor(params.sessionId).signalIntendedClose();
    if (this.#describeSlotHolder(params.sessionId) === undefined) {
      // No session: drop the latch just set rather than accumulate one per redundant close.
      this.#terminalEmissionGates.delete(params.sessionId);
      this.#frameRouters.delete(params.sessionId);
      this.#usageAccountants.delete(params.sessionId);
      this.#discardProviderCommandEnumeration(params.sessionId);
      return;
    }
    await this.#claimSessionSlot(params.sessionId, "closing", async () => {
      await this.#tearDownSession(params.sessionId);
    });
    // After teardown: a terminal it provokes must still find the latch set.
    this.#terminalEmissionGates.delete(params.sessionId);
    this.#frameRouters.delete(params.sessionId);
    this.#usageAccountants.delete(params.sessionId);
    this.#discardProviderCommandEnumeration(params.sessionId);
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

  /**
   * Binds the session's thread into the routing and metering band at every establishment. Base
   * registers come first because a released usage frame meters immediately. Registering
   * overwrites the router's session-thread identity, which is how a rewind retires the old thread.
   */
  #bindSessionThread(
    sessionId: SessionId,
    threadId: string,
    establishment: CodexUsageEstablishment,
  ): void {
    const accountant = this.usageAccountantFor(sessionId);
    if (establishment.mode === "fresh") {
      accountant.establishThread(threadId, { mode: "fresh" });
    } else {
      const priorEmittedCumulative = this.#readPriorEmittedSum(
        sessionId,
        threadId,
        establishment.priorEmittedThreadId,
      );
      accountant.establishThread(threadId, {
        mode: "resume",
        priorEmittedCumulative: priorEmittedCumulative ?? {},
      });
    }
    const releasedFrames = this.frameRouterFor(sessionId).registerSessionThread(threadId);
    this.#deliverRoutedFrames(sessionId, releasedFrames);
  }

  /**
   * Reads the daemon's prior-emitted cumulative sum, reporting only a missing or throwing reader
   * (`undefined` is correct for a session that emitted nothing). The throw is contained because the
   * base is telemetry and must not fail an already-applied fork or resume.
   */
  #readPriorEmittedSum(
    sessionId: SessionId,
    threadId: string,
    priorEmittedThreadId: string,
  ): CumulativeAxisReadings | undefined {
    const reader = this.#options.readPriorEmittedUsage;
    if (reader === undefined) {
      this.#emitResumeBaseUnavailable(
        sessionId,
        threadId,
        priorEmittedThreadId,
        "no prior-emitted usage reader is bound, so the daemon's own emitted sum could not be rebuilt; base registers start at zero, so the first reading meters already-emitted spend again",
      );
      return undefined;
    }
    try {
      return reader(sessionId, priorEmittedThreadId);
    } catch (cause) {
      this.#emitResumeBaseUnavailable(
        sessionId,
        threadId,
        priorEmittedThreadId,
        `the prior-emitted usage reader failed, so the daemon's own emitted sum could not be rebuilt (${normalizeProviderFailureDetail(cause)}); base registers start at zero, so the first reading meters already-emitted spend again`,
      );
      return undefined;
    }
  }

  // On a rewind the two thread ids differ: the sum is under the pre-fork thread, the registers
  // belong to the forked one.
  #emitResumeBaseUnavailable(
    sessionId: SessionId,
    threadId: string,
    priorEmittedThreadId: string,
    dispositionReason: string,
  ): void {
    this.#options.diagnostics.emit({
      provider: "codex",
      kind: "usage_resume_base_unavailable",
      rawWireType: null,
      dispositionReason,
      details: { sessionId, threadId, priorEmittedThreadId },
    });
  }

  /**
   * Routes one inbound notification and delivers what it releases. Must not throw: it runs inside
   * the transport's `#ingest` drain. A child is registered before its announcement is routed.
   */
  #routeInboundNotification(sessionId: SessionId, method: string, params: unknown): void {
    const router = this.frameRouterFor(sessionId);
    if (method === CODEX_THREAD_STARTED_METHOD) {
      const announcement = readCodexChildThreadAnnouncement(params);
      if (announcement !== null) {
        const registration = router.registerChildThread(announcement);
        if (registration.registered) {
          const accountant = this.usageAccountantFor(sessionId);
          if (accountant.hasThread(registration.childThreadId)) {
            // Re-establishing would zero the register and re-meter reported spend, and a second
            // `subagent.started` would duplicate a timeline entry.
            this.#options.diagnostics.emit({
              provider: "codex",
              kind: "thread_duplicate_child_announcement",
              rawWireType: method,
              dispositionReason:
                "duplicate child-thread announcement for an already-registered child; usage base retained and no second started emission",
              details: { sessionId, childThreadId: registration.childThreadId },
            });
          } else {
            accountant.establishThread(registration.childThreadId, { mode: "fresh" });
            // A provider-internal child (a compaction thread) has no subagent identity.
            if (registration.attribution.kind === "subagent") {
              this.#options.onSubagentLifecycle?.(sessionId, {
                eventType: "subagent.started",
                subagentId: registration.attribution.subagentId,
                parentReference: announcement.declaredParentThreadId,
              });
            }
          }
          this.#deliverRoutedFrames(sessionId, registration.releasedFrames);
        }
      }
    }

    const frame: CodexRoutableFrame = {
      rawWireType: method,
      familyClass: classifyCodexFrameFamilyForRouting(method),
      threadId: readCodexFrameThreadId(method, params),
      params,
    };
    this.#deliverRoutedFrames(sessionId, [frame]);
  }

  /**
   * Applies the router's decision to each frame. A child's usage still meters and its interactive
   * request still routes, though its transcript never projects.
   */
  #deliverRoutedFrames(sessionId: SessionId, frames: readonly CodexRoutableFrame[]): void {
    const router = this.frameRouterFor(sessionId);
    const nowMs = Date.now();
    for (const frame of frames) {
      const route = router.routeFrame(frame, nowMs);
      this.#applyRouteDecision(sessionId, frame, route);
    }
  }

  #applyRouteDecision(
    sessionId: SessionId,
    frame: CodexRoutableFrame,
    route: ThreadFrameRoute,
  ): void {
    switch (route.decision) {
      case "project":
      case "route-connection-scoped":
        // Metering first, so the normalize band never forwards a cumulative counter as per-turn.
        this.#meterUsageFrame(sessionId, frame);
        this.#observeCompactionBoundary(sessionId, frame);
        this.#completeChildOnTerminal(sessionId, frame);
        this.#handOffToNormalizeBand(frame);
        return;
      case "carve-out-usage":
        this.#meterUsageFrame(sessionId, frame);
        return;
      case "carve-out-interactive-request":
        // Same pipeline as the parent's, on the child's own correlation identity; suppressing it
        // would hang the child.
        this.#handOffToNormalizeBand(frame);
        return;
      case "suppress-child-transcript":
        this.#completeChildOnTerminal(sessionId, frame);
        return;
      case "held-pending-registration":
      case "quarantined":
        // The router already recorded both as diagnostics.
        return;
    }
  }

  /**
   * Settles a pending compaction wait on `thread/compacted`, beside the normalize hand-off so the
   * boundary row is still produced. Keyed on the frame's own thread id, not the record's, which
   * has moved to the successor at a rewind; an unarmed key is a no-op.
   */
  #observeCompactionBoundary(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_THREAD_COMPACTED_METHOD || frame.threadId === null) {
      return;
    }
    this.#pendingCompactions.observeBoundary(
      codexCompactionWaitKey(sessionId, frame.threadId),
      readCodexCompactionBoundaryPosition(frame.params),
    );
  }

  #meterUsageFrame(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_THREAD_TOKEN_USAGE_METHOD) {
      return;
    }
    const reading = readCodexCumulativeUsageReading(frame.params);
    if (reading === null) {
      // A silent drop is spend that never reaches a receipt.
      this.#options.diagnostics.emit({
        provider: "codex",
        kind: "usage_axis_reading_rejected",
        rawWireType: frame.rawWireType,
        dispositionReason:
          "the provider's token-usage notification carried no readable cumulative breakdown at the pinned payload shape; nothing was metered for this reading",
        details: { sessionId, threadId: frame.threadId },
      });
      return;
    }
    const metered = this.usageAccountantFor(sessionId).meterReading(reading);
    if (metered !== null) {
      this.#options.onMeteredUsage?.(sessionId, metered);
    }
  }

  /**
   * Releases a child's router state on its `turn/completed` with a terminal `turn.status`.
   * `thread/status/changed` has no terminal arm, and `thread/closed` is left unclassified because
   * nothing shows the app-server emits it for subagent threads.
   */
  #completeChildOnTerminal(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_TURN_COMPLETED_METHOD || frame.threadId === null) {
      return;
    }
    if (!readCodexTerminalTurnStatus(frame.params)) {
      return;
    }
    const attribution = this.frameRouterFor(sessionId).childAttributionFor(frame.threadId);
    const completion = this.frameRouterFor(sessionId).completeChildThread(frame.threadId);
    if (!completion.wasRegistered) {
      return;
    }
    this.usageAccountantFor(sessionId).releaseThread(frame.threadId);
    if (attribution?.kind === "subagent") {
      this.#options.onSubagentLifecycle?.(sessionId, {
        eventType: "subagent.completed",
        subagentId: attribution.subagentId,
        parentReference: null,
      });
    }
  }

  #handOffToNormalizeBand(frame: CodexRoutableFrame): void {
    const delegate = this.#options.onServerNotification;
    if (delegate === undefined) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "unconsumed-server-notification",
        method: frame.rawWireType,
      });
      return;
    }
    try {
      delegate(frame.rawWireType, frame.params);
    } catch (cause) {
      // Guarded here so this class does not depend on the transport's own containment.
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "notification-consumer-failed",
        method: frame.rawWireType,
        detail: normalizeProviderFailureDetail(cause),
      });
    }
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
    this.#forgetRunRoutes(sessionId);
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
      this.#discardProviderCommandEnumeration(sessionId);
      // After the record delete: a turn terminating mid-teardown must still be ingested and ruled.
      this.#releaseOutboundFrameBudget(sessionId);
    }
  }

  /** Steers the run's active turn; the intervention dispatcher routes steers here. */
  async steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> {
    const { record, turnId } = this.#requireActiveTurn(request.runId);
    // A caller-supplied expectation wins, so the provider refuses a stale steer rather than
    // retargeting it; kept local because the dispatcher grades against what went on the wire.
    const targetedTurnId = request.expectedTurnId ?? turnId;
    // Registered against the targeted turn: a steer joins an existing turn and is never re-keyed.
    const steerFrame = this.#outboundTextFrameWriter.compose({
      text: request.content,
      origin: request.frameOrigin,
    });
    // Refuses before the write: a steer the tripwire cannot watch could be swallowed invisibly.
    this.#outboundFrameTripwire.register({
      scopeKey: record.sessionId,
      joinKey: targetedTurnId,
      // No stream item vouches for a steer; it is consumed on its own request's answer.
      frameRole: "turn-joining",
      frame: steerFrame,
    });
    // Pins the settled-turn memory across the whole round trip, acknowledgement read included.
    record.inFlightSteers += 1;
    try {
      const attempt = await this.#requestTurnSteer(record, request, steerFrame, targetedTurnId);
      if (attempt.settled === "answered") {
        const acknowledgedTurnId = readSteeredTurnId(attempt.result);
        // The answer proves the provider took the frame; stream items credit only the opening
        // frame, so without this every steer would trip a healthy session. Also for a null ack.
        this.#outboundFrameTripwire.recordRequestAnswered(steerFrame);
        if (acknowledgedTurnId !== null && acknowledgedTurnId !== targetedTurnId) {
          // The provider says where the bytes went, so the frame follows the acknowledged turn;
          // left on the wrong turn it would trip a turn that swallowed nothing. A settled turn
          // emits no second terminal, so its frame is consumed on its recorded acknowledgment.
          if (this.#canStillRuleFrameOnTurn(record, acknowledgedTurnId)) {
            this.#outboundFrameTripwire.recorrelateFrame(steerFrame, acknowledgedTurnId);
          } else {
            this.#consumeAnsweredSteerFrame(record, request.runId, steerFrame);
          }
        }
        return { targetedTurnId, acknowledgedTurnId };
      }
      this.#ruleFailedSteerFrame(record, request.runId, steerFrame, attempt.delivery);
      throw attempt.cause;
    } finally {
      record.inFlightSteers -= 1;
    }
  }

  /**
   * Decides what a failed steer's frame is owed by how far its bytes got. One that never reached
   * the wire is forgotten; one handed to the host is retained for the turn's terminal to rule,
   * and a dead connection rules it here, fail-closed. A connection that dies later leaves it to
   * scope release, since ruling there would false-trip clean shutdowns.
   */
  #ruleFailedSteerFrame(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
    delivery: CodexRequestDelivery,
  ): void {
    if (delivery !== "indeterminate") {
      // `unsent` never left and `refused` is a provider answer, so nothing was swallowed.
      this.#outboundFrameTripwire.forgetFrame(steerFrame);
      return;
    }
    if (!record.connection.isClosed) {
      return;
    }
    this.#ruleSteerFrameFailClosed(record, runId, steerFrame);
  }

  /**
   * Rules one steer frame fail-closed when its response phase died with the connection, so no
   * terminal will ever rule it. Frame-scoped: settling the whole turn would trip the opening
   * frame, whose delivery was never in doubt. A frame already consumed settles as
   * `no-correlated-frame`.
   */
  #ruleSteerFrameFailClosed(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
  ): void {
    const decision = this.#outboundFrameTripwire.settleFrame(
      steerFrame,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (!decision.tripped) {
      return;
    }
    // The settlement path's disposal, session arm first, so a consumer reacting synchronously to
    // the run failure cannot attach to the condemned process.
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, decision);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Consumes a steer's frame on its own answered request when no terminal can rule the
   * acknowledged turn. The expected outcome is a pass, but a trip is handled with the full
   * disposal, not dropped.
   */
  #consumeAnsweredSteerFrame(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
  ): void {
    const decision = this.#outboundFrameTripwire.settleFrame(steerFrame, observedTurnEvidence());
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, decision);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Whether a terminal on `record` can still rule a frame correlated to `turnId`: the turn has
   * not settled and `record` is still the session's record (identity, not presence).
   */
  #canStillRuleFrameOnTurn(record: CodexSessionRecord, turnId: string): boolean {
    if (this.#sessions.get(record.sessionId) !== record) {
      return false;
    }
    return !record.settledTurnIds.has(turnId);
  }

  async #requestTurnSteer(
    record: CodexSessionRecord,
    request: CodexSteerRunRequest,
    steerFrame: OutboundTextFrame,
    targetedTurnId: string,
  ): Promise<CodexRequestAttempt> {
    // The classifying entry point: a rejection from `request` cannot say whether the provider
    // acted.
    return await record.connection.attemptRequest("turn/steer", {
      threadId: record.threadId,
      input: [{ type: "text", text: steerFrame.wireText, text_elements: [] }],
      expectedTurnId: targetedTurnId,
      // The requester's key, verbatim and never re-minted, or the intervention dedupe guard is
      // defeated. `clientUserMessageId` is the provider's caller-supplied message id field, as on
      // `turn/start`.
      clientUserMessageId: request.clientIdempotencyKey,
    });
  }

  /** True when the run has at least one live provider turn (scans the turn-keyed routes). */
  hasActiveTurn(runId: RunId): boolean {
    const sessionId = this.#sessionIdByRunId.get(runId);
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
   * way a slot is taken.
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
      // Overridden rather than spread: the transport port carries no session or run identity. The
      // run id is resolved at answer time, since one captured at connection build could name a
      // retired turn.
      serverRequestResponder:
        answerServerRequest === undefined
          ? undefined
          : {
              answer: async (
                request: CodexInboundServerRequest,
              ): Promise<CodexServerRequestDecision> => {
                const attribution = this.#attributeRoutedAsk(sessionId, request);
                if (attribution.outcome === "refused") {
                  // Refused before adjudication and before the option-set read: an ask that
                  // cannot be attributed is not decided.
                  return { decision: "refuse", reason: attribution.reason };
                }
                // Normalized where both the raw ask and the session the diagnostic names are
                // known; `params` still travels verbatim.
                const optionSet = readCodexAskOptionSet(request.method, request.params);
                if (optionSet.kind === "dropped") {
                  // Never silent, never a refusal: the ask stays answerable through the free-text
                  // arm, so dropping the options degrades the card, not the turn.
                  this.#options.diagnostics.emit({
                    provider: CODEX_DRIVER_NAME,
                    kind: "interactive_request_option_set_dropped",
                    rawWireType: request.method,
                    dispositionReason: optionSet.reason,
                    details: {
                      sessionId,
                      declaredOptionCount: optionSet.declaredCount,
                      optionSetMax: CODEX_ASK_OPTION_SET_MAX,
                    },
                  });
                }
                return await answerServerRequest.answer({
                  ...request,
                  sessionId,
                  runId: attribution.runId,
                  // Conditionally spread: under `exactOptionalPropertyTypes` an absent key
                  // differs from undefined.
                  ...(optionSet.kind === "read" ? { options: optionSet.options } : {}),
                });
              },
            },
      onServerNotification: (method: string, params: unknown): void => {
        this.#observeServerNotification(sessionId, method, params);
        // Every inbound frame goes through the router before any projection; the delegate is
        // reached only from inside it (`#handOffToNormalizeBand`). That inner guard has no test
        // of its own: the outer catch reports an identical diagnostic.
        try {
          this.#routeInboundNotification(sessionId, method, params);
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
   * The thread-establishment legs one posture and one subagent policy realize. Both write the
   * `config` table, so they merge here; used by `thread/start` and `thread/fork`.
   */
  #composeThreadEstablishmentLegs(
    posture: ExecutionPosture | undefined,
    subagentPolicy: SubagentPolicy | undefined,
  ): Record<string, unknown> {
    const configOverrides: Record<string, unknown> = {
      ...(posture === undefined ? {} : composeCodexThreadPostureConfig(posture)),
      ...(subagentPolicy === undefined ? {} : composeCodexSubagentConfigOverrides(subagentPolicy)),
    };
    this.#reportWithheldSubagentDefinitions(subagentPolicy);
    return {
      ...this.#composeSpawnPostureParams(posture),
      ...(Object.keys(configOverrides).length === 0 ? {} : { config: configOverrides }),
    };
  }

  /**
   * The spawn-time posture legs (`sandbox`, `approvalPolicy`), plus the diagnostic for the one
   * axis this provider cannot express.
   */
  #composeSpawnPostureParams(posture: ExecutionPosture | undefined): Record<string, unknown> {
    if (posture === undefined) {
      return {};
    }
    this.#reportNarrowedNetworkAllowlist(posture);
    const { sandbox, approvalPolicy } = composeCodexThreadPosture(posture);
    return { sandbox, approvalPolicy };
  }

  /**
   * Compares the realized sandbox against the requested posture and records a divergence; called
   * on every path that establishes a thread.
   */
  #assertPostureRealized(posture: ExecutionPosture | undefined, response: unknown): void {
    if (posture === undefined || !isPlainObject(response)) {
      return;
    }
    const divergence = describeCodexPostureDivergence(posture, response["sandbox"]);
    if (divergence === null) {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "posture-realization-diverged",
      requestedNetworkAccess: divergence.requestedNetworkAccess,
      realizedNetworkAccess: divergence.realizedNetworkAccess,
    });
  }

  #composeTurnPostureParams(
    record: CodexSessionRecord,
    params: StartRunParams,
  ): Record<string, unknown> {
    const posture = params.executionPosture ?? record.executionPosture;
    if (posture === undefined) {
      return {};
    }
    // Reported per turn too: a run adding an allow-list to a session spawned without one would
    // otherwise narrow silently.
    if (params.executionPosture !== undefined) {
      this.#reportNarrowedNetworkAllowlist(params.executionPosture);
    }
    return { sandboxPolicy: composeCodexTurnSandboxPolicy(posture) };
  }

  #reportNarrowedNetworkAllowlist(posture: ExecutionPosture): void {
    if (posture.networkAccess !== "allowed-domains") {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "posture-network-allowlist-narrowed",
      deniedDomainCount: posture.allowedDomains.length,
    });
  }

  /**
   * Records every subagent definition this spawn withheld. The concurrency caps are still sent
   * (the half the provider enforces natively) by `composeCodexSubagentConfigOverrides`.
   */
  #reportWithheldSubagentDefinitions(policy: SubagentPolicy | undefined): void {
    if (policy === undefined || !policy.enabled) {
      return;
    }
    for (const definition of policy.definitions) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "subagent-definition-withheld",
        definitionName: definition.name,
        reason: CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
      });
      this.#options.diagnostics.emit({
        provider: "codex",
        kind: "subagent_definition_disabled",
        rawWireType: null,
        dispositionReason: CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
        // Untrusted caller-supplied text, carried verbatim as data.
        details: { definitionName: definition.name },
      });
    }
  }

  /**
   * Records that a spawn offered the provider no callback-tool registry; the session is degraded,
   * not failed.
   */
  #reportWithheldCallbackTools(
    sessionId: SessionId,
    callbackTools: readonly unknown[] | undefined,
  ): void {
    const withheldToolCount = callbackTools?.length ?? 0;
    if (withheldToolCount === 0) {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "callback-tools-withheld",
      withheldToolCount,
      reason: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
    });
    // Both sinks: the local transport arm is this driver's structured record; the censused kind
    // is the one the daemon's counters name.
    this.#options.diagnostics.emit({
      provider: "codex",
      kind: "callback_tool_registry_withheld",
      rawWireType: null,
      dispositionReason: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
      details: {
        sessionId,
        reason: "provider-registration-unavailable",
        withheldToolCount,
      },
    });
  }

  /**
   * Attributes one routed ask to the run that raised it, by the turn the ask names, before the
   * daemon's responder sees it. A named turn that cannot be resolved is refused, never attributed
   * to the sole active run.
   */
  #attributeRoutedAsk(
    sessionId: SessionId,
    request: CodexInboundServerRequest,
  ): CodexRoutedAskAttribution {
    const turnIdReading = readRoutedAskTurnId(request.params);
    const resolvableTurnId = turnIdReading.resolvableTurnId;
    if (resolvableTurnId !== null) {
      const routedRunId = this.#sessions.get(sessionId)?.runIdByActiveTurnId.get(resolvableTurnId);
      if (routedRunId !== undefined) {
        return { outcome: "attributed", runId: routedRunId };
      }
    }
    if (turnIdReading.recordedTurnId === null && request.askKind !== "callback-tool") {
      // No turn claim on a shape whose params need none (a legacy approval, an elicitation with a
      // `null` turn id): the sole-active fallback applies. `callback-tool` requires a turn, so
      // its absence is itself the fault and refuses.
      return { outcome: "unattributed", runId: this.#activeRunIdFor(sessionId) };
    }
    this.#reportRoutedAskTurnUnresolved(sessionId, request.method, turnIdReading, request.askKind);
    return {
      outcome: "refused",
      // Refused for every kind: the sole-active run would judge the ask under a newer run's
      // identity, and a decline is retryable where a wrong approval is not. An over-bound
      // `turnId` counts as named, since a truncated prefix could match another live turn. The
      // provider reads the reason.
      reason: composeRoutedAskRefusalReason(request.method, turnIdReading),
    };
  }

  /**
   * Records one refused routed ask that named an unresolvable turn. The transport arm takes every
   * refusal; the censused kind only callback-tool ones, since `callback_tool_invocation_refused`
   * counts those and other refusals would corrupt that count.
   */
  #reportRoutedAskTurnUnresolved(
    sessionId: SessionId,
    method: string,
    turnIdReading: CodexRoutedAskTurnIdReading,
    askKind: "callback-tool" | "approval",
  ): void {
    const turnId = turnIdReading.recordedTurnId;
    const turnIdTruncated = turnIdReading.recordedTurnIdTruncated;
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "routed-ask-turn-unresolved",
      method,
      turnId,
      turnIdTruncated,
      disposition: "refused",
    });
    if (askKind !== "callback-tool") {
      return;
    }
    this.#options.diagnostics.emit({
      provider: "codex",
      kind: "callback_tool_invocation_refused",
      rawWireType: method,
      dispositionReason:
        "the invocation named no turn this daemon holds a live route for, so no run's tool registry could adjudicate it",
      // Untrusted provider text, bounded at the reader, carried verbatim to correlate with its
      // log.
      details: { sessionId, method, turnId, turnIdTruncated },
    });
  }

  /**
   * The run that owns every live turn on a session, or `null` when none does or two runs are
   * live. The id-keyed form of {@link soleActiveRunIdIn}; a caller holding the record calls that
   * directly, since re-resolving by id after an await can answer about a successor record.
   */
  #activeRunIdFor(sessionId: SessionId): RunId | null {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return null;
    }
    return soleActiveRunIdIn(record);
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
      this.#discardProviderCommandEnumeration(sessionId);
    }
    // Evidence accrues across the turn because the terminal notification may not carry the item
    // list (`itemsView` can read `notLoaded`); keyed by turn id, which item notifications carry.
    const inFlightEvidence = classifyCodexTurnEvidenceObservation(method, params);
    if (inFlightEvidence !== null) {
      this.#outboundFrameTripwire.observe(inFlightEvidence.turnId, inFlightEvidence.observation);
      const observingRecord = this.#sessions.get(sessionId);
      if (
        observingRecord !== undefined &&
        !this.#outboundFrameTripwire.hasPendingFrame(inFlightEvidence.turnId)
      ) {
        // No frame is correlated onto this turn yet; it may still wait on the `turn/start`
        // continuation that re-keys it. Remembering the observation avoids tripping on the
        // terminal alone.
        const remembered = rememberUnmatchedTurn(observingRecord, inFlightEvidence.turnId);
        if (remembered === null) {
          this.#refuseUnretainableTurnEvidence(observingRecord);
          return;
        }
        remembered.observations.add(inFlightEvidence.observation);
      }
    }
    if (method !== CODEX_TURN_COMPLETED_NOTIFICATION) {
      return;
    }
    const payload = isPlainObject(params) ? params : {};
    const rawTurn = payload["turn"];
    const turn = isPlainObject(rawTurn) ? rawTurn : {};
    const turnId = turn["id"];
    const status = turn["status"];
    if (typeof turnId !== "string" || turnId.length === 0) {
      return;
    }
    if (typeof status !== "string" || !CODEX_TERMINAL_TURN_STATUSES.has(status)) {
      return;
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return;
    }
    // Marked for every terminal before any ruling: the other two memories are conditional, so
    // neither answers "has this turn ended", which `steerRun` needs. A refusal returns without
    // ruling: its teardown rules every frame pending on the scope fail-closed, this turn's
    // included.
    if (!rememberSettledTurn(record, turnId)) {
      this.#refuseUnretainableSettledTurn(record);
      return;
    }
    // Keyed by turn id, never run id, so a terminal cannot clear another live turn of the same
    // run. The tripwire retains the decision so the dispatcher can answer a steer already ruled
    // on.
    const classification = classifyCodexTurnEvidence(params);
    const decision = this.#outboundFrameTripwire.settle(turnId, classification);
    if (decision.tripped) {
      // Quarantine first, then report, so a consumer reacting synchronously to the terminal
      // cannot attach to the process that swallowed the text. Both axes: a later `startRun`
      // resolves the session record by session id.
      this.#runtimeBindingQuarantine.disposeSession(sessionId);
    }

    let matchedRoute = false;
    // Direct lookup on the settling turn's own route leaves the run's other live turns
    // correlated.
    const routedRunId = record.runIdByActiveTurnId.get(turnId);
    if (routedRunId !== undefined) {
      this.#retireTurnRoute(record, turnId);
      this.#ruleTurnTerminalAgainstRun(sessionId, routedRunId, decision);
      matchedRoute = true;
    }
    // A run whose route an interrupt retired is not in the live map. The two maps are disjoint:
    // `interruptRun` deletes the live route in the step that records this correlation, and turn
    // ids are never reused.
    const interruptedRunId = record.interruptedRunIdByTurnId.get(turnId);
    if (interruptedRunId !== undefined) {
      // Released whatever the ruling was: the terminal this entry waited for has arrived.
      record.interruptedRunIdByTurnId.delete(turnId);
      this.#ruleTurnTerminalAgainstRun(sessionId, interruptedRunId, decision);
      matchedRoute = true;
    }
    if (decision.tripped) {
      // The recovery is a fresh spawn, so the condemned process is torn down. Detached: this runs
      // in the synchronous read-chunk drain, where awaiting stalls frames and a throw unwinds the
      // drain.
      this.#disposeQuarantinedSession(record);
    }
    if (!matchedRoute) {
      const remembered = rememberUnmatchedTurn(record, turnId);
      if (remembered === null) {
        this.#refuseUnretainableTurnEvidence(record);
        return;
      }
      remembered.terminal = classification;
    }
  }

  /**
   * Applies a settled turn's tripwire ruling to one run: quarantines its binding and reports the
   * failure. The caller applies the session arm once per terminal first, so a consumer reacting
   * to the first run's failure cannot attach to the process in between.
   */
  #ruleTurnTerminalAgainstRun(
    sessionId: SessionId,
    runId: RunId,
    decision: TripwireDecision,
  ): void {
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeRun(runId, sessionId);
    this.#reportTextNeutralizationFailure(
      sessionId,
      runId,
      composeTextNeutralizationRunFailure(decision),
    );
  }

  /**
   * The loud path for a turn-evidence memory at its ceiling while a `turn/start` is in flight,
   * when every entry may be the terminal that start will claim. Dropping or evicting would
   * silently lose a terminal and report a swallowed turn as completed.
   */
  #refuseUnretainableTurnEvidence(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "turn-evidence-memory-overflowed",
      retainedTurnCount: record.unmatchedTurnEvidence.size,
    });
  }

  /**
   * The same loud path for the settled-turn memory at its ceiling while a `turn/steer` is in
   * flight: evicting could answer "still running" for an ended turn and strand a frame nothing
   * rules.
   */
  #refuseUnretainableSettledTurn(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "settled-turn-memory-overflowed",
      retainedTurnCount: record.settledTurnIds.size,
    });
  }

  /**
   * The same loud path for the interrupted-route memory: every entry is still owed its terminal.
   */
  #refuseUnretainableInterruptedRoute(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "interrupted-route-memory-overflowed",
      retainedTurnCount: record.interruptedRunIdByTurnId.size,
    });
  }

  /**
   * Refuses a binding whose per-session turn memory overflowed: quarantines and tears down the
   * session, which rules every pending frame fail-closed. One body keeps the three memories
   * equally loud.
   */
  #refuseUnretainableTurnMemory(
    record: CodexSessionRecord,
    diagnostic: CodexTransportDiagnostic,
  ): void {
    if (this.#runtimeBindingQuarantine.isSessionDisposed(record.sessionId)) {
      // Already condemned: the overflowing drain keeps running and would bury the one report that
      // matters under duplicates.
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, diagnostic);
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Rules every frame a departing binding leaves unsettled, fail-closed, with
   * `UNRECOGNIZED_TURN_EVIDENCE` (exempt frames still pass): those turns will never deliver a
   * terminal. Reported at most once per run; a disposed run's `run.failed` was already composed.
   */
  #ruleAbandonedFramesFailClosed(record: CodexSessionRecord): void {
    const rulings = this.#outboundFrameTripwire.settleScope(
      record.sessionId,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (rulings.length === 0) {
      return;
    }
    const reportedRunIds = new Set<RunId>();
    for (const ruling of rulings) {
      if (!ruling.decision.tripped) {
        continue;
      }
      const runId = this.#runIdForAbandonedFrame(record, ruling.joinKey);
      if (runId === undefined || this.#runtimeBindingQuarantine.isRunDisposed(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, ruling.decision);
    }
    // Emitted even if every ruling duplicated: the counts are the operator's only sight of these
    // writes.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "abandoned-frames-ruled",
      ruledFrameCount: rulings.length,
      reportedRunCount: reportedRunIds.size,
    });
  }

  /**
   * Fails the runs whose frames a resume superseded, once per run, with
   * `composeSupersededDeliveryRunFailure`, which claims only what is known. `record` is the
   * superseded leg, `undefined` only when the resume found no predecessor.
   */
  #failSupersededDeliveries(record: CodexSessionRecord | undefined, sessionId: SessionId): void {
    const abandoned = this.#outboundFrameTripwire.abandonScope(sessionId);
    if (abandoned.length === 0) {
      return;
    }
    const reportedRunIds = new Set<RunId>();
    for (const frame of abandoned) {
      const runId =
        record === undefined
          ? this.#runIdBoundToSession(frame.joinKey, sessionId)
          : this.#runIdForAbandonedFrame(record, frame.joinKey);
      if (runId === undefined || reportedRunIds.has(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeSupersededDeliveryRunFailure(frame.detailOrigin),
      );
    }
    // Emitted even if no frame resolved to a run: the counts are the operator's only sight of the
    // writes.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "superseded-frames-failed",
      abandonedFrameCount: abandoned.length,
      reportedRunCount: reportedRunIds.size,
    });
  }

  /** The run a join key names when there is no record (matched against the run axis, not cast). */
  #runIdBoundToSession(joinKey: string, sessionId: SessionId): RunId | undefined {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (runId === joinKey && boundSessionId === sessionId) {
        return runId;
      }
    }
    return undefined;
  }

  /**
   * The run an abandoned frame's join key names: a live turn's route, an interrupted turn's
   * correlation, or the run id the frame was registered under when the provider never named a
   * turn (matched against the run axis, not cast).
   */
  #runIdForAbandonedFrame(record: CodexSessionRecord, joinKey: string): RunId | undefined {
    const routed = record.runIdByActiveTurnId.get(joinKey);
    if (routed !== undefined) {
      return routed;
    }
    const interrupted = record.interruptedRunIdByTurnId.get(joinKey);
    if (interrupted !== undefined) {
      return interrupted;
    }
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (runId === joinKey && boundSessionId === record.sessionId) {
        return runId;
      }
    }
    return undefined;
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

  // A throwing consumer must not become a second failure: the run terminal is the guarantee, and
  // losing it would leave the swallowed turn with no record.
  #reportTextNeutralizationFailure(
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ): void {
    try {
      this.#options.onTextNeutralizationFailure(sessionId, runId, failure);
    } catch (cause) {
      this.#options.diagnostics.emit({
        provider: "codex",
        kind: "text_neutralization_trip_report_failed",
        rawWireType: null,
        dispositionReason: normalizeProviderFailureDetail(cause),
        details: { sessionId, runId, providerFailureDetail: failure.providerFailureDetail },
      });
    }
  }

  /**
   * Closes an abandoned connection without letting a teardown fault (an injected disposer is
   * caller code) change the outcome of the operation that abandoned it. `closeSession` does not
   * use it: a close has no other outcome to protect.
   */
  async #releaseAbandonedConnection(connection: CodexAppServerConnection): Promise<void> {
    try {
      await connection.close();
    } catch {
      // Deliberately swallowed: the transport is abandoned either way, and a refusing teardown is
      // a host-level condition, not a result.
    }
  }

  /**
   * Retires one turn's route, and the run's session binding only when that turn was the run's
   * last: dropping it earlier would strand the steer and interrupt paths of the run's other live
   * turn.
   */
  #retireTurnRoute(record: CodexSessionRecord, turnId: string): void {
    const runId = record.runIdByActiveTurnId.get(turnId);
    if (runId === undefined) {
      return;
    }
    record.runIdByActiveTurnId.delete(turnId);
    if (newestActiveTurnForRun(record, runId) === undefined) {
      this.#sessionIdByRunId.delete(runId);
    }
  }

  /**
   * Drops every run route bound to a session, scanning by value: the record that could enumerate
   * them is gone or replaced by the time a sweep is owed.
   */
  #forgetRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
  }

  /**
   * Drops the unsettled frames of a binding this manager no longer holds. Retained decisions
   * survive: they are keyed by turn and the intervention dispatcher reads them after teardown.
   */
  #releaseOutboundFrameBudget(sessionId: SessionId): void {
    this.#outboundFrameTripwire.forgetScope(sessionId);
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
    const sessionId = this.#sessionIdByRunId.get(runId);
    const record = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    const turnId = record === undefined ? undefined : newestActiveTurnForRun(record, runId);
    if (record === undefined || turnId === undefined) {
      throw new CodexTransportError(`No active Codex turn for run "${runId}".`, { runId });
    }
    return { record, turnId };
  }
}
