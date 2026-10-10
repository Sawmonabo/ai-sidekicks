/**
 * The Codex session lifecycle's operation entry points (`CodexLifecycleManager`). It builds the
 * services, slots, establishment, recovery and run control once, routes each service's frames to
 * the session they belong to, and answers each driver operation through them.
 * - Every establishment, close, rewind and disposal runs inside a claimed session slot.
 * - One service serves every session on one credential home; a session's own fault ends only its
 *   conversation, never the service.
 */

import { isDeepStrictEqual } from "node:util";

import type { ProviderModel } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import type { ProviderCommandListResult } from "@ai-sidekicks/contracts/provider/driver/commands";
import type { InterruptRunParams } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { PendingCompactionRegistry } from "../../compaction-wait.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import type { CapabilityProbeRequest } from "../../capability/probe.js";
import {
  classifyCodexAuthStatus,
  CODEX_AUTH_PROBE_TIMEOUT_MS,
  requestCodexAuthStatus,
} from "./auth-status.js";
import { getCodexCapabilities, readCodexCapabilityDetection } from "./capabilities.js";
import { CodexProviderCommandCache } from "./commands.js";
import { CodexCompactionDispatch } from "./compaction.js";
import { CodexAskHandOff } from "./delivery/asks.js";
import { CodexDeliveryDispatch } from "./delivery/dispatch.js";
import { CodexFrameDelivery } from "./delivery/frames.js";
import {
  CODEX_ITEM_COMPLETED_METHOD,
  CODEX_SKILLS_CHANGED_METHOD,
  CODEX_TURN_COMPLETED_METHOD,
} from "./event-normalizer.js";
import { clearCodexSessionGoal, setCodexSessionGoal } from "./goals.js";
import { CodexRunPauses } from "./hooks/pause.js";
import { CodexHookServer } from "./hooks/server.js";
import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "./intervention.js";
import { joinCodexModelWindows, readCodexServiceModelWindows } from "./model-windows.js";
import { CodexNotificationRouting } from "./notification-routing.js";
import { CodexOutputSpeed } from "./output-speed.js";
import { composeCodexLevelSettings } from "./permission-level.js";
import {
  correctCodexPermissionProfileDrift,
  noteCodexPermissionProfileAsked,
} from "./thread/permission-profiles.js";
import { CodexRoutedAskAttributor } from "./routed-ask-attribution.js";
import { CodexRunControl } from "./run/control.js";
import { retryCodexTurnOnFasterModel } from "./run/faster-model-retry.js";
import { CodexRunRoutes } from "./run/routes.js";
import { CodexSelfStartedTurns } from "./run/self-started-turns.js";
import { CodexRunStart } from "./run/start.js";
import { CodexTurnEndWaiters } from "./run/turn-end-waiters.js";
import { readCodexServerRequestAnswer } from "./server-requests.js";
import { createCodexServiceLauncher, runCodexCommand } from "./service/process.js";
import type { CodexServiceEvents } from "./service/dependencies.js";
import { CodexServiceRegistry } from "./service/registry.js";
import { CODEX_CONFIG_WARNING_METHOD, type CodexService } from "./service/supervisor.js";
import {
  CodexProviderRequestError,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "./session/errors.js";
import {
  observeCodexReasoningEffort,
  overrideCodexReviewerDenial,
  startCodexReview,
  updateCodexSessionMode,
} from "./session/controls.js";
import { CodexConfigForks } from "./session/config-fork.js";
import { CodexConversationRelease } from "./session/conversation-release.js";
import { CodexSessionEstablishment } from "./session/establishment.js";
import { CodexConversationForks } from "./session/fork.js";
import { purgeCodexConversations } from "./session/purge.js";
import { CodexServiceRecovery } from "./session/recovery.js";
import { CodexConversationRewind } from "./session/rewind.js";
import { CodexSideQuestions } from "./session/side-questions.js";
import { CodexSessionSlots } from "./session/slots.js";
import {
  type CodexLifecycleOptions,
  readCodexTerminalTurnId,
  rememberSettledTurn,
} from "./session/state.js";
import {
  CODEX_DEFAULT_REQUEST_TIMEOUT_MS,
  defaultScheduleTimeout,
} from "./transport/connection.js";
import { composeCodexLevelConfig } from "./thread/settings.js";
import { reportDiagnosticFromDetachedFrame } from "./transport/diagnostics.js";
import { createCodexServiceSocketConnector } from "./transport/socket.js";
import {
  buildAuthProbeResult,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CompactContextParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverGoalResult,
  type DriverResumeResult,
  type MoveSessionToForkParams,
  type MoveSessionToForkResult,
  type GetCapabilitiesResult,
  type ListProviderCommandsParams,
  type ProviderSessionHandle,
  type RespondToRequestParams,
  type ResumeSessionParams,
  type SetSessionGoalParams,
  type StartRunParams,
} from "../contract.js";
import type { RewindConversationParams, RewindConversationResult } from "../rewind.js";
import type {
  FasterModelRetryOutcome,
  FasterModelRetryParams,
  OverrideDenialParams,
  PauseRunParams,
  ResumeRunParams,
} from "../run-control.js";
import type {
  AskSideQuestionParams,
  ProviderBuildChange,
  ProviderCommandsListener,
  PurgeSessionParams,
  StartReviewParams,
  SubscribeProviderCommandsParams,
  UpdatePermissionLevelParams,
  UpdateSessionModeParams,
} from "../session-control.js";

// The method family of a conversation's item frames: a command's start, output and end.
const CODEX_ITEM_METHOD_PREFIX = "item/";

/** Lifecycle operations as Codex service calls, one service per credential home. */
export class CodexLifecycleManager {
  readonly #options: CodexLifecycleOptions;
  readonly #runRoutes = new CodexRunRoutes();
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #dispatch: CodexDeliveryDispatch;
  readonly #providerCommands: CodexProviderCommandCache;
  readonly #slots: CodexSessionSlots;
  readonly #pauses: CodexRunPauses;
  readonly #services: CodexServiceRegistry;
  readonly #hooks: CodexHookServer | undefined;
  readonly #outputSpeed: CodexOutputSpeed;
  readonly #frames: CodexFrameDelivery;
  readonly #notificationRouting: CodexNotificationRouting;
  readonly #routedAsks: CodexRoutedAskAttributor;
  readonly #compactionDispatch: CodexCompactionDispatch;
  readonly #release: CodexConversationRelease;
  readonly #forks: CodexConversationForks;
  readonly #configForks: CodexConfigForks;
  readonly #establishment: CodexSessionEstablishment;
  readonly #recovery: CodexServiceRecovery;
  readonly #runStart: CodexRunStart;
  readonly #runControl: CodexRunControl;
  readonly #turnEnds: CodexTurnEndWaiters;
  readonly #sideQuestions: CodexSideQuestions;
  readonly #selfStartedTurns: CodexSelfStartedTurns;
  readonly #askHandOff: CodexAskHandOff;
  readonly #rewind: CodexConversationRewind;

  constructor(options: CodexLifecycleOptions) {
    this.#options = options;
    const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
    const now = options.now ?? Date.now;
    const reportDiagnostic = options.reportDiagnostic;
    this.#pendingCompactions = new PendingCompactionRegistry();
    this.#dispatch = new CodexDeliveryDispatch(options.inbound, reportDiagnostic);
    this.#providerCommands = new CodexProviderCommandCache({
      diagnostics: options.diagnostics,
      reportDiagnostic,
      serverPrompts: options.serverPrompts,
      recordFor: (sessionId) => this.#slots.recordFor(sessionId),
    });
    this.#pauses = new CodexRunPauses({
      onTookEffect: (pause) => {
        this.#runControl.deliverPaused(pause);
      },
      isRunLive: (runId) => this.#runRoutes.bindingFor(runId) !== undefined,
    });
    this.#release = new CodexConversationRelease({
      reportDiagnostic,
      routing: {
        admitHeldThread: (sessionId, threadId) => {
          this.#slots.admitHeldThread(sessionId, threadId);
        },
        releaseHeldThread: (sessionId, threadId) => {
          this.#slots.releaseHeldThread(sessionId, threadId);
        },
      },
    });
    this.#slots = new CodexSessionSlots({
      options,
      runRoutes: this.#runRoutes,
      pendingCompactions: this.#pendingCompactions,
      providerCommands: this.#providerCommands,
      pauses: this.#pauses,
      release: this.#release,
      // A turn waiting on the record's running turn would otherwise wait for good.
      onRecordLeft: (record) => {
        this.#configForks.stopWaiting(record);
      },
    });
    this.#hooks =
      options.hookEndpoint === undefined
        ? undefined
        : new CodexHookServer({
            endpoint: options.hookEndpoint,
            operatingSystem: options.operatingSystem,
            answerers: [this.#pauses.answer],
            reportDiagnostic,
            scheduleTimeout,
            now,
          });
    this.#services = new CodexServiceRegistry({
      homes: options.homes,
      providerCommand: options.providerCommand,
      providerBaseEnvironment: options.providerBaseEnvironment,
      environmentNameMatch: options.operatingSystem.environmentNameMatch,
      launchProcess:
        options.launchProcess ??
        createCodexServiceLauncher(options.operatingSystem.endChildProcess),
      runCommand: options.runCommand ?? runCodexCommand,
      connectSocket:
        options.connectSocket ?? createCodexServiceSocketConnector(options.operatingSystem),
      hooks: this.#hooks,
      additionalConfigOverrides: options.additionalConfigOverrides ?? [],
      reportDiagnostic,
      diagnostics: options.diagnostics,
      scheduleTimeout: options.scheduleTimeout,
      now: options.now,
      startupTimeoutMs: options.startupTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      events: this.#composeServiceEvents(),
    });
    this.#outputSpeed = new CodexOutputSpeed({
      diagnostics: options.diagnostics,
      onRunOutputSpeedSettled: (sessionId, runId, state) => {
        options.runEngine
          .recordSettledOutputSpeed(sessionId, runId, state)
          .catch((cause: unknown) => {
            reportDiagnosticFromDetachedFrame(reportDiagnostic, {
              kind: "port-delivery-failed",
              port: "output-speed",
              sessionId,
              detail: normalizeProviderFailureDetail(cause),
            });
          });
      },
      readModelCatalog: async (service: CodexService): Promise<ProviderModel[]> =>
        await this.#recovery.readModelCatalog(service),
    });
    this.#askHandOff = new CodexAskHandOff({
      dispatch: this.#dispatch,
      owners: { permissionAsks: options.permissionAsks, questions: options.questions },
      reportDiagnostic,
    });
    this.#frames = new CodexFrameDelivery({
      recordFor: (sessionId) => this.#slots.recordFor(sessionId),
      terminalGateFor: (sessionId) => this.#slots.terminalEmissionGateFor(sessionId),
      runRoutes: this.#runRoutes,
      dispatch: this.#dispatch,
      reviewerDenials: options.reviewerDenials,
      commandOutput: options.commandOutput,
      withdrawAsk: (sessionId, requestId, askKind) => {
        this.#askHandOff.withdraw(sessionId, requestId, askKind);
      },
      reportDiagnostic,
      diagnostics: options.diagnostics,
      cutOversizedTurn: (record, turnId) => {
        void this.#rewind.cutOversizedTurn(record, turnId);
      },
      pendingCompactions: this.#pendingCompactions,
      now,
    });
    this.#notificationRouting = new CodexNotificationRouting({
      options,
      delivery: {
        deliver: (sessionId, frame, route) => {
          this.#frames.deliver(sessionId, frame, route);
        },
        startChild: (sessionId, childThreadId, parentThreadId, subagentId) => {
          this.#frames.startChild(sessionId, childThreadId, parentThreadId, subagentId);
        },
        completeChild: (sessionId, childThreadId, turnParams) => {
          // A helper that ended has no call left to hold and no next call to steer.
          this.#pauses.forgetThread(childThreadId);
          this.#frames.completeChild(sessionId, childThreadId, turnParams);
        },
      },
      pendingCompactions: this.#pendingCompactions,
      frameRouterFor: (sessionId) => this.#slots.frameRouterFor(sessionId),
      usageAccountantFor: (sessionId) => this.#slots.usageAccountantFor(sessionId),
    });
    this.#routedAsks = new CodexRoutedAskAttributor({
      options,
      slots: this.#slots,
      askHandOff: this.#askHandOff,
      bindingIdFor: (runId) => this.#runRoutes.bindingIdFor(runId),
    });
    this.#compactionDispatch = new CodexCompactionDispatch(options, this.#pendingCompactions);
    const newBindingId = options.newBindingId ?? mintUuidV7;
    this.#forks = new CodexConversationForks({
      options,
      slots: this.#slots,
      pendingCompactions: this.#pendingCompactions,
      outputSpeed: this.#outputSpeed,
      notificationRouting: this.#notificationRouting,
      release: this.#release,
    });
    this.#configForks = new CodexConfigForks({
      options,
      slots: this.#slots,
      forks: this.#forks,
    });
    this.#establishment = new CodexSessionEstablishment({
      options,
      newBindingId,
      slots: this.#slots,
      services: this.#services,
      pendingCompactions: this.#pendingCompactions,
      outputSpeed: this.#outputSpeed,
      notificationRouting: this.#notificationRouting,
      providerCommands: this.#providerCommands,
      runRoutes: this.#runRoutes,
      forks: this.#forks,
      release: this.#release,
    });
    const requestTimeoutMs = options.requestTimeoutMs ?? CODEX_DEFAULT_REQUEST_TIMEOUT_MS;
    this.#turnEnds = new CodexTurnEndWaiters(scheduleTimeout, requestTimeoutMs);
    this.#recovery = new CodexServiceRecovery({
      options,
      slots: this.#slots,
      establishment: this.#establishment,
      services: this.#services,
      runRoutes: this.#runRoutes,
      pendingCompactions: this.#pendingCompactions,
      dispatch: this.#dispatch,
      turnEnds: this.#turnEnds,
      release: this.#release,
      configForks: this.#configForks,
      scheduleTimeout,
      unloadTimeoutMs: requestTimeoutMs,
      deliverTurnEnd: (sessionId, params) => {
        this.#ingestFrame(sessionId, CODEX_TURN_COMPLETED_METHOD, params);
      },
    });
    this.#runStart = new CodexRunStart({
      slots: this.#slots,
      configForks: this.#configForks,
      forks: this.#forks,
      runRoutes: this.#runRoutes,
      outputSpeed: this.#outputSpeed,
      providerCommands: this.#providerCommands,
      runEngine: options.runEngine,
      daemonTurnBindings: options.daemonTurnBindings,
      reportDiagnostic,
      scheduleTimeout,
      turnStartTimeoutMs: options.turnStartTimeoutMs,
    });
    this.#runControl = new CodexRunControl({
      options,
      slots: this.#slots,
      configForks: this.#configForks,
      runRoutes: this.#runRoutes,
      runStart: this.#runStart,
      pauses: this.#pauses,
      dispatch: this.#dispatch,
    });
    this.#rewind = new CodexConversationRewind({
      slots: this.#slots,
      configForks: this.#configForks,
      runControl: this.#runControl,
      turnEnds: this.#turnEnds,
      reportDiagnostic,
    });
    this.#sideQuestions = new CodexSideQuestions({
      dispatch: this.#dispatch,
      reportDiagnostic,
    });
    this.#selfStartedTurns = new CodexSelfStartedTurns({
      recordFor: (sessionId) => this.#slots.recordFor(sessionId),
      runStart: this.#runStart,
      ingest: (sessionId, method, params) => {
        this.#ingestFrame(sessionId, method, params);
      },
      reportDiagnostic,
      scheduleTimeout,
    });
  }

  /** Starts a fresh conversation for the session on its account's service. */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Refused before anything is asked, with no `await` before the claim: overlapping creates
    // would start two conversations for one session.
    this.#slots.assertFree(params.sessionId);
    const handle = await this.#slots.claim(
      params.sessionId,
      "establishing",
      async () => await this.#establishment.establishCreatedSession(params),
    );
    this.#replayConfigWarnings(params.sessionId);
    return handle;
  }

  /**
   * Resumes a conversation from its handle. Every failure returns the typed `failed` result; it
   * never falls back to a fresh conversation.
   */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Claims rather than refusing a held slot: a resume supersedes a live record.
    const result = await this.#slots.claim(
      params.sessionId,
      "establishing",
      async () => await this.#establishment.establishResumedSession(params),
    );
    this.#replayConfigWarnings(params.sessionId);
    return result;
  }

  /**
   * Restarts the service a session's conversation ran on after it stayed down, resumes every
   * other conversation it held, then this one.
   */
  async restartSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    const service = await this.#services.serviceFor(params.providerAccountId);
    return await this.#recovery.restart(
      service,
      params.sessionId,
      async () => await this.resumeSession(params),
    );
  }

  /** Starts one provider turn for a run. */
  async startRun(params: StartRunParams): Promise<void> {
    await this.#runStart.startRun(params);
  }

  /** Interrupts the run's live turn and ends the commands it left running. */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    await this.#runControl.interruptRun(params);
  }

  /** Steers the run's live turn; the intervention dispatcher routes steers here. */
  async steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> {
    return await this.#runControl.steerRun(request);
  }

  /**
   * Allows once a call Codex's reviewer blocked, on the conversation it was made in; with no turn
   * running there, as the session's own run.
   */
  async overrideDenial(params: OverrideDenialParams): Promise<void> {
    await overrideCodexReviewerDenial(
      await this.#configForks.requireAfterForks(params.sessionId),
      params.providerDenial,
      this.#runStart,
    );
  }

  /** Sends a held turn's message again on a faster model; see the retry's own docs. */
  async retryTurnOnFasterModel(params: FasterModelRetryParams): Promise<FasterModelRetryOutcome> {
    return await retryCodexTurnOnFasterModel(
      {
        slots: this.#slots,
        runRoutes: this.#runRoutes,
        runStart: this.#runStart,
        forks: this.#forks,
        turnEnds: this.#turnEnds,
        dispatch: this.#dispatch,
      },
      params,
    );
  }

  /** Pauses the run from its next tool call; see {@link CodexRunControl.pauseRun}. */
  pauseRun(params: PauseRunParams): void {
    this.#runControl.pauseRun(params);
  }

  /** Continues a paused or pausing run; see {@link CodexRunControl.resumeRun}. */
  async resumeRun(params: ResumeRunParams): Promise<void> {
    await this.#runControl.resumeRun(params);
  }

  /**
   * Answers an ask a run is held on, on the service that holds it. Throws `CodexTransportError`
   * when no service holds it, and `TypeError` for an answer that is neither allow nor refuse.
   */
  async respondToRequest(params: RespondToRequestParams): Promise<void> {
    const answer = readCodexServerRequestAnswer(params.response);
    const sessionId = this.#runRoutes.sessionIdFor(params.runId);
    const routed = sessionId === undefined ? undefined : this.#slots.recordFor(sessionId);
    // Request ids are unique per service only, so the run's own service is asked first.
    const service =
      routed?.service.holdsRequest(params.requestId) === true
        ? routed.service
        : this.#services.services().find((candidate) => candidate.holdsRequest(params.requestId));
    if (service === undefined) {
      throw new CodexTransportError(`No Codex service holds request "${params.requestId}".`, {
        runId: params.runId,
        requestId: params.requestId,
      });
    }
    await service.answerHeldRequest(params.requestId, answer);
  }

  /**
   * Moves the session's conversation to another level from its next turn. A move that changes
   * config `thread/settings/update` cannot carry forks the conversation onto it: an idle one at
   * once, a busy one when its running turn settles.
   */
  async updatePermissionLevel(params: UpdatePermissionLevelParams): Promise<void> {
    // A move made while a fork runs lands on the fork, and owes the next fork if it needs one.
    const record = await this.#configForks.requireAfterForks(params.sessionId);
    const { profileFolders } = record.threadSettings;
    const posture = composeCodexLevelSettings(params.level, profileFolders);
    noteCodexPermissionProfileAsked(record.permissionProfiles, posture.permissions);
    await record.service.request("thread/settings/update", {
      threadId: record.threadId,
      ...posture,
    });
    const configBefore = composeCodexLevelConfig(record.threadSettings.level, profileFolders);
    // A resume after a crash sends the level it runs at now, and a turn the daemon starts runs
    // at it.
    record.threadSettings = { ...record.threadSettings, level: params.level };
    record.executionPosture = { ...record.executionPosture, mode: params.level };
    if (!isDeepStrictEqual(configBefore, composeCodexLevelConfig(params.level, profileFolders))) {
      this.#configForks.owe(record);
    }
  }

  /**
   * Forks the thread at a recorded turn boundary and re-points the session, and the run's binding,
   * at the fork. Degrades on a live turn or an unknown position.
   */
  async moveSessionToFork(params: MoveSessionToForkParams): Promise<MoveSessionToForkResult> {
    // Read before the claim: `require` refuses while the slot is `establishing`.
    const record = await this.#configForks.requireAfterForks(params.sessionId);
    if (record.runIdByActiveTurnId.size > 0) {
      return { status: "degraded", fallbackAction: "rewind-deferred-turn-in-progress" };
    }
    // Position 0 must not become an omitted `lastTurnId`, which forks the whole thread.
    const boundaryTurnId =
      params.position >= 1 ? record.turnBoundaries[params.position - 1] : undefined;
    if (boundaryTurnId === undefined) {
      return { status: "degraded", fallbackAction: "rewind-target-not-a-recorded-boundary" };
    }
    // Held across the fork, so no turn starts on the thread the fork leaves behind.
    return await this.#slots.claim(
      params.sessionId,
      "establishing",
      async () => await this.#forks.establishRewoundSession(params, record, boundaryTurnId),
    );
  }

  /**
   * Cuts the conversation in place back to before one of the person's messages with
   * `thread/revert`; a running turn is stopped and its end awaited first, up to the request
   * deadline. A message the daemon has no turn for is looked up in the conversation's history.
   * Degrades for a message not in the conversation and for a turn that did not stop; throws
   * `CodexTransportError` when the session was re-established meanwhile.
   */
  async rewindConversation(params: RewindConversationParams): Promise<RewindConversationResult> {
    return await this.#rewind.rewind(params);
  }

  /** Moves every conversation onto a service started on the new build; see recovery. */
  async moveToProviderBuild(change: ProviderBuildChange): Promise<void> {
    await this.#recovery.moveToProviderBuild(change);
  }

  /** Deletes Codex's own copy of every conversation the session opened, and its role files. */
  async purgeSession(params: PurgeSessionParams): Promise<void> {
    await purgeCodexConversations(this.#services, this.#options.helperRolesFolder, params);
  }

  /** Binds the session's goal on Codex's own thread goal; a turn Codex starts on it is a run. */
  async setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    return await setCodexSessionGoal(
      await this.#configForks.requireAfterForks(params.sessionId),
      params.goalText,
    );
  }

  /** Clears the session's goal on Codex's own thread goal. */
  async clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return await clearCodexSessionGoal(await this.#configForks.requireAfterForks(params.sessionId));
  }

  /**
   * Triggers a native context compaction and settles on the `thread/compacted` frame, not on the
   * request's empty acknowledgement.
   */
  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    const record = await this.#configForks.requireAfterForks(params.sessionId);
    return await this.#compactionDispatch.dispatchCompaction(params.sessionId, record);
  }

  /** Moves the session between Build and Plan from its next turn; a resume keeps the mode. */
  async updateSessionMode(params: UpdateSessionModeParams): Promise<void> {
    const record = await this.#configForks.requireAfterForks(params.sessionId);
    await updateCodexSessionMode(record, params.mode);
    record.sessionMode = params.mode;
  }

  /** Asks a side question on a read-only copy of the conversation; resolves once it is asked. */
  async askSideQuestion(params: AskSideQuestionParams): Promise<void> {
    await this.#sideQuestions.ask(
      await this.#configForks.requireAfterForks(params.sessionId),
      params,
    );
  }

  /** Starts Codex's own review of a set of changes in the session's conversation, as its run. */
  async startReview(params: StartReviewParams): Promise<void> {
    await startCodexReview(
      await this.#configForks.requireAfterForks(params.sessionId),
      params.target,
      this.#dispatch,
      this.#runStart,
    );
  }

  /** Follows the session's live command list until the returned function is called. */
  subscribeProviderCommands(
    params: SubscribeProviderCommandsParams,
    listener: ProviderCommandsListener,
  ): () => void {
    return this.#providerCommands.subscribe(params.sessionId, listener);
  }

  /** The provider's commands and skills for the session, held until `skills/changed`. */
  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    const record = await this.#configForks.requireAfterForks(params.sessionId);
    return await this.#providerCommands.composeProviderCommandList(params.sessionId, record);
  }

  /**
   * Closes the session's conversation: its running commands end, then it unsubscribes; the
   * service stays. Idempotent: an unknown session resolves.
   */
  async closeSession(params: CloseSessionParams): Promise<void> {
    this.#providerCommands.forgetSubscribers(params.sessionId);
    await this.#sideQuestions.forgetSession(params.sessionId);
    await this.#slots.close(params.sessionId);
    await this.#release.forgetSession(params.sessionId);
    this.#recovery.forgetSession(params.sessionId);
    for (const service of this.#services.services()) {
      service.configWarnings.forgetSession(params.sessionId);
    }
  }

  /**
   * Stops every service the daemon started, as a deliberate stop that no crash restart follows,
   * disconnects from the person's own, then closes the hook socket. Idempotent; throws the stops
   * that failed once everything was tried.
   */
  async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    await this.#services.shutdown().catch((cause: unknown) => {
      failures.push(cause);
    });
    // After the services, so no hook a stopping service runs finds the daemon away.
    await this.#hooks?.close().catch((cause: unknown) => {
      failures.push(cause);
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, "The Codex driver did not shut down cleanly.");
    }
  }

  /**
   * The tier the session's thread declared, from its establishment reply and then each
   * `thread/settings/updated`, or `undefined` with no live session or no reading.
   */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    return this.#slots.recordFor(sessionId)?.declaredOutputSpeed;
  }

  /**
   * The default account's live model catalog, restarting the service where Codex asks to, each
   * row carrying the window Codex's own catalog gives it.
   */
  async listModels(): Promise<ProviderModel[]> {
    const service = await this.#services.serviceFor(undefined);
    const [models, windows] = await Promise.all([
      this.#recovery.readModelCatalog(service),
      readCodexServiceModelWindows(service, this.#options.diagnostics),
    ]);
    return joinCodexModelWindows(models, windows);
  }

  /**
   * Whether the default account is signed in, asked of its service; claims no session slot.
   * Never throws: any unresolvable outcome becomes `indeterminate`.
   */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    try {
      const service = await this.#services.serviceFor(undefined);
      await service.ensureStarted();
      return classifyCodexAuthStatus(
        await requestCodexAuthStatus(service, CODEX_AUTH_PROBE_TIMEOUT_MS),
      );
    } catch (cause) {
      return buildAuthProbeResult("indeterminate", normalizeProviderFailureDetail(cause));
    }
  }

  /**
   * The capabilities of the build the default account's service runs, probed on a connection of
   * its own that starts no conversation. Throws when the service cannot start.
   */
  async getCapabilities(): Promise<GetCapabilitiesResult> {
    const service = await this.#services.serviceFor(undefined);
    await service.ensureStarted();
    const reading = service.versionReading;
    if (reading === undefined) {
      throw new CodexTransportError("The Codex service reported no build at its start.", {
        codexHome: service.home.codexHome,
      });
    }
    const connection = await service.openDetachedConnection();
    try {
      const detection = await readCodexCapabilityDetection(
        reading,
        async (request: CapabilityProbeRequest): Promise<unknown> => {
          // The reply's own shape, as the probe classifier reads it.
          try {
            return { result: await connection.request(request.probeName, {}) };
          } catch (cause) {
            if (cause instanceof CodexProviderRequestError) {
              return { error: { code: cause.providerErrorCode, message: cause.providerMessage } };
            }
            throw cause;
          }
        },
        this.#options.diagnostics,
      );
      return getCodexCapabilities(reading, detection);
    } finally {
      connection.close();
    }
  }

  /** What every service tells the lifecycle about its conversations. */
  #composeServiceEvents(): CodexServiceEvents {
    return {
      onSessionFrame: (service, sessionId, method, params) => {
        // A conversation the session moved off reaches it only through the rows of the commands
        // it still runs, which stay live until each ends.
        if (
          this.#release.observeFrame(service, method, params) &&
          !method.startsWith(CODEX_ITEM_METHOD_PREFIX)
        ) {
          return;
        }
        this.#ingestFrame(sessionId, method, params);
      },
      onProcessExited: (service, exit) => {
        this.#release.forgetService(service);
        this.#recovery.onProcessExited(service, exit);
      },
      onRecovered: (service, cause) => {
        this.#recovery.onRecovered(service, cause);
      },
      onServiceLost: (service, detail) => {
        this.#release.forgetService(service);
        this.#recovery.onServiceLost(service, detail);
      },
      onCrashLoop: (service, exit) => {
        this.#recovery.onCrashLoop(service, exit);
      },
      onHeldRequestsDropped: (sessionId, dropped) => {
        for (const request of dropped) {
          this.#askHandOff.withdraw(sessionId, request.requestId, request.askKind);
        }
      },
      responderFor: (sessionId) => this.#routedAsks.composeServerRequestResponder(sessionId),
    };
  }

  /**
   * One frame for one session. A side question's copy takes its own frames, and the session's wait
   * while the run of a turn Codex started by itself opens; every other frame is routed and
   * delivered while its turn's route still stands, then the turn bookkeeping retires a route its
   * own terminal ended, and run control acts on the step or turn that ended.
   */
  #ingestFrame(sessionId: SessionId, method: string, params: unknown): void {
    if (this.#sideQuestions.divert(method, params)) {
      return;
    }
    // A frame that outlives its session's close would bring back the session's frame router,
    // usage accountant and terminal gate, which the close let go.
    if (!this.#slots.isOccupied(sessionId)) {
      return;
    }
    if (this.#selfStartedTurns.holds(sessionId, method, params)) {
      return;
    }
    // Codex's skill-file invalidation signal: the held list is read again in full.
    if (method === CODEX_SKILLS_CHANGED_METHOD) {
      this.#providerCommands.discardProviderCommandEnumeration(sessionId);
      this.#providerCommands.refreshSubscribers(sessionId);
    }
    const record = this.#slots.recordFor(sessionId);
    const endedTurnId =
      record !== undefined && method === CODEX_TURN_COMPLETED_METHOD
        ? readCodexTerminalTurnId(params)
        : null;
    let endedRunId: RunId | undefined;
    if (record !== undefined && endedTurnId !== null) {
      rememberSettledTurn(record, endedTurnId);
      endedRunId = record.runIdByActiveTurnId.get(endedTurnId);
    }
    this.#outputSpeed.observeServerNotification(record, method, params);
    if (record !== undefined) {
      observeCodexReasoningEffort(record, method, params);
      correctCodexPermissionProfileDrift(record, method, params, this.#options.reportDiagnostic);
    }
    try {
      this.#notificationRouting.routeInboundNotification(sessionId, method, params);
    } catch (cause) {
      // The band is total, so this is a backstop: an escaping throw would unwind the
      // connection's message handler and take unrelated frames down with it.
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "notification-consumer-failed",
        method,
        detail: normalizeProviderFailureDetail(cause),
      });
    }
    if (record === undefined) {
      return;
    }
    if (endedTurnId !== null) {
      // Retired by turn id, never run id, so a stale terminal cannot retire a newer turn.
      this.#runRoutes.retireTurnRoute(record, endedTurnId);
      record.interruptedRunIdByTurnId.delete(endedTurnId);
    }
    if (method === CODEX_ITEM_COMPLETED_METHOD) {
      void this.#runControl.observeItemCompleted(record, params);
    }
    if (endedTurnId !== null) {
      // Before run control acts on the end, so a fork owed meanwhile runs ahead of the next turn.
      this.#configForks.noteTurnSettled(record);
      void this.#runControl.observeTurnEnded(record, endedTurnId, endedRunId);
      this.#recovery.noteTurnSettled(record);
      this.#turnEnds.settle();
    }
  }

  /** Sends a session that just attached the config warnings its service sent it has not heard. */
  #replayConfigWarnings(sessionId: SessionId): void {
    const record = this.#slots.recordFor(sessionId);
    for (const warning of record?.service.configWarnings.takeOwed(sessionId) ?? []) {
      this.#ingestFrame(sessionId, CODEX_CONFIG_WARNING_METHOD, warning);
    }
  }
}
