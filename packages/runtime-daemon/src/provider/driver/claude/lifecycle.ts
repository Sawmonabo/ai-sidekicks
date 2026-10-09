// The Claude driver's operations on sessions and runs, each an entry point over the owners that
// hold their state: the session slots, the run routes, the messages sent, the turn settlement, the
// conversation cuts, the handshakes, the frame routing, the establishment legs, the daemon's own
// hooks, the restart path, the delivery stream that hands every frame to the run engine, the
// requests and choices Claude Code holds a run on, and the session controls.
//
// Provider-process concerns sit behind the injected `ClaudeSessionTransport`: this module spawns
// nothing and reads no environment variable. Errors here carry a registered `driver.*` code.

import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import type { ProviderCommandListResult } from "@ai-sidekicks/contracts/provider/driver/commands";
import type { InterruptRunParams } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { ProviderMode } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { PendingCompactionRegistry } from "../../compaction-wait.js";
import type { SubagentLifecycleEmission } from "../../thread-frame-router.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import type { RewindConversationParams, RewindConversationResult } from "../rewind.js";
import type {
  AnswerProviderChoiceParams,
  AnswerProviderChoiceResult,
  OverrideDenialParams,
  PauseRunParams,
  ResumeRunParams,
  WithdrawQueuedMessageParams,
  WithdrawQueuedMessageResult,
} from "../run-control.js";
import type {
  AnswerSessionCommandParams,
  AskSideQuestionParams,
  ProviderBuildChange,
  ProviderCommandsListener,
  PurgeSessionParams,
  SessionCommandAnswer,
  StartReviewParams,
  SubscribeProviderCommandsParams,
  UpdatePermissionLevelParams,
  UpdateSessionModeParams,
} from "../session-control.js";
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
  type ListProviderCommandsParams,
  type ProviderSessionHandle,
  type RespondToRequestParams,
  type ResumeSessionParams,
  type SetSessionGoalParams,
  type StartRunParams,
} from "../contract.js";
import { ClaudeCompactionDispatch } from "./compaction.js";
import { ClaudeProviderDialogs } from "./delivery/dialogs.js";
import { ClaudeDeliveryDispatch } from "./delivery/dispatch.js";
import { ClaudeInboundRequests } from "./delivery/requests.js";
import { ClaudeReviewerCapture } from "./delivery/reviewer.js";
import { ClaudeDeliveryStream } from "./delivery/stream.js";
import { ClaudeFrameRouting } from "./frame-routing.js";
import { ClaudeGoalCommands } from "./goals.js";
import { ClaudeHandshakeRegister } from "./handshake-register.js";
import { ClaudeHookCallbacks } from "./hooks/callbacks.js";
import { ClaudeHelperLimit } from "./hooks/helper-limit.js";
import { ClaudeRunPauses } from "./hooks/pause.js";
import { limitsHelpersAtOnce } from "./hooks/registration.js";
import type { ClaudeInterventionSettlement } from "./intervention.js";
import { ClaudeRunControls } from "./run/controls.js";
import { ClaudeSentPrompts } from "./run/prompts.js";
import { ClaudeConversationCuts } from "./run/rewind.js";
import { ClaudeRunRoutes, type ClaudeBoundRun } from "./run/routes.js";
import { ClaudeTurnSettlement } from "./run/settlement.js";
import { ClaudeRunStart } from "./run/start.js";
import {
  CLAUDE_AUTH_PROBE_REACHED_DETAIL,
  ClaudeAuthenticationRequiredError,
  ClaudeSessionUnavailableError,
  describeFailure,
  sanitizeFailureDetail,
} from "./session/errors.js";
import { buildClaudeResumeFailure, ClaudeSessionEstablishment } from "./session/establishment.js";
import { findIgnoredSettingNotice } from "./session/ignored-settings.js";
import { ClaudeModelFigures } from "./session/model-figures.js";
import { listClaudeModes, moveClaudePermissionLevel } from "./session/permission-level.js";
import { purgeClaudeConversations } from "./session/purge.js";
import { scheduleUnrefTimer } from "./session/control-requests.js";
import { ClaudeSessionControls } from "./session/controls.js";
import { ClaudeSessionRestarts } from "./session/restart.js";
import { ClaudeSessionSlots } from "./session/slots.js";
import type { ClaudeSessionLifecycleDependencies, LiveClaudeSession } from "./session/state.js";
import {
  CLAUDE_COMPACTION_COMMAND_NAME,
  type ClaudeProviderProcess,
  type ClaudeRunProcessLookup,
} from "./session/transport.js";
import { composeClaudeSpawnEnvironment } from "./spawn/environment.js";
import { ClaudeSpawnLegComposer } from "./spawn/legs.js";

/** Drives Claude sessions over a `ClaudeSessionTransport`, one slot and process per session. */
export class ClaudeSessionLifecycle implements ClaudeRunProcessLookup {
  readonly #dependencies: ClaudeSessionLifecycleDependencies;
  readonly #runRoutes: ClaudeRunRoutes = new ClaudeRunRoutes();
  readonly #pauses: ClaudeRunPauses = new ClaudeRunPauses();
  readonly #helpers: ClaudeHelperLimit = new ClaudeHelperLimit();
  readonly #goals: ClaudeGoalCommands = new ClaudeGoalCommands(async (live, opening) => {
    await this.#runStart.startDaemonTurn(live, opening);
  });
  readonly #prompts: ClaudeSentPrompts = new ClaudeSentPrompts();
  // The stored figures of the installed build; replaced when the daemon reads another build.
  #modelFigures: ClaudeModelFigures = new ClaudeModelFigures(undefined);
  readonly #dispatch: ClaudeDeliveryDispatch;
  readonly #handshakes: ClaudeHandshakeRegister;
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #reviewer: ClaudeReviewerCapture;
  readonly #dialogs: ClaudeProviderDialogs;
  readonly #stream: ClaudeDeliveryStream;
  readonly #requests: ClaudeInboundRequests;
  readonly #controls: ClaudeSessionControls;
  readonly #frameRouting: ClaudeFrameRouting;
  readonly #slots: ClaudeSessionSlots;
  readonly #establishment: ClaudeSessionEstablishment;
  readonly #compactionDispatch: ClaudeCompactionDispatch;
  readonly #runStart: ClaudeRunStart;
  readonly #hookCallbacks: ClaudeHookCallbacks;
  readonly #runControls: ClaudeRunControls;
  readonly #restarts: ClaudeSessionRestarts;
  readonly #cuts: ClaudeConversationCuts;
  readonly #settlement: ClaudeTurnSettlement;

  constructor(dependencies: ClaudeSessionLifecycleDependencies) {
    this.#dependencies = dependencies;
    const diagnostics = dependencies.diagnostics;
    const now = dependencies.now ?? Date.now;
    const dispatch = new ClaudeDeliveryDispatch({ inbound: dependencies.inbound, diagnostics });
    this.#dispatch = dispatch;
    this.#handshakes = new ClaudeHandshakeRegister({
      diagnostics,
      readBoundProviderAccountId: dependencies.readBoundProviderAccountId,
      onRunOutputSpeedSettled: (sessionId, runId, state) => {
        dependencies.runEngine
          .recordSettledOutputSpeed(sessionId, runId, state)
          .catch((error: unknown) => {
            this.#restarts.recordReportFailure(sessionId, "the settled output speed", error);
          });
      },
    });
    this.#pendingCompactions = new PendingCompactionRegistry();
    this.#reviewer = new ClaudeReviewerCapture({
      reviewerDenials: dependencies.reviewerDenials,
      diagnostics,
    });
    this.#dialogs = new ClaudeProviderDialogs({
      dispatch,
      diagnostics,
      eventIdsForMessages: async (sessionId, messageUuids) =>
        await this.#stream.eventIdsForMessages(sessionId, messageUuids),
      daemonEnds: {
        markDaemonEnded: (runId, confirmed) => {
          this.#stream.markDaemonEnded(runId, confirmed);
        },
        confirmDaemonEnd: (runId) => {
          this.#stream.confirmDaemonEnd(runId);
        },
        releaseDaemonEnd: (runId) => {
          this.#stream.releaseDaemonEnd(runId);
        },
      },
    });
    this.#stream = new ClaudeDeliveryStream({
      dispatch,
      diagnostics,
      runRoutes: this.#runRoutes,
      prompts: this.#prompts,
      dialogs: this.#dialogs,
      reviewer: this.#reviewer,
      gateFor: (sessionId) => this.#slots.intendedCloseGateFor(sessionId),
      takeLeadPauseEffect: (sessionId) => this.#pauses.takeLeadPauseEffect(sessionId),
      onTooLongTurn: (live) => {
        this.#cuts.cutTooLongTurn(live);
      },
      onRunningModelMoved: (live) => {
        this.#establishment.readReplyReserveForRunningModel(live);
      },
      observeLeadFrame: (sessionId, frameKind, frame) => {
        this.#goals.observeLeadFrame(sessionId, frameKind, frame);
        this.#controls.observeLeadFrame(sessionId, frameKind, frame);
      },
      now,
    });
    this.#requests = new ClaudeInboundRequests({
      dispatch,
      permissionAsks: dependencies.permissionAsks,
      questions: dependencies.questions,
      dialogs: this.#dialogs,
      reviewer: this.#reviewer,
      diagnostics,
      runFor: (live, agentId) => this.#runFor(live.sessionId, agentId),
      permissionModeFor: (sessionId) => this.#stream.permissionModeFor(sessionId),
      childRunStarting: (sessionId, agentId) => this.#stream.childRunStarting(sessionId, agentId),
    });
    this.#controls = new ClaudeSessionControls({
      transport: dependencies.transport,
      handshakes: this.#handshakes,
      dispatch,
      diagnostics,
      stagedChanges: dependencies.stagedChanges,
      runRoutes: this.#runRoutes,
      startDaemonTurn: async (live, opening) => {
        await this.#runStart.startDaemonTurn(live, opening);
      },
      readCommands: (sessionId) => {
        const live = this.#slots.findLiveSession(sessionId);
        return live === undefined ? undefined : this.#composeCommands(live);
      },
      now,
    });
    this.#frameRouting = new ClaudeFrameRouting({
      ...dependencies,
      onSubagentLifecycle: (sessionId, emission) => {
        this.#observeHelperLifecycle(sessionId, emission);
        this.#stream.observeHelperLifecycle(sessionId, emission);
      },
      pendingCompactions: this.#pendingCompactions,
      handshakes: this.#handshakes,
    });
    this.#hookCallbacks = new ClaudeHookCallbacks({
      pauses: this.#pauses,
      helpers: this.#helpers,
      onHelperHeld: (sessionId, agentId) => {
        this.#reportHelperPaused(sessionId, agentId);
      },
      forward: (live, event) => {
        this.#requests.handle(live, event);
      },
      diagnostics,
    });
    this.#slots = new ClaudeSessionSlots({
      diagnostics,
      runRoutes: this.#runRoutes,
      handshakes: this.#handshakes,
      pendingCompactions: this.#pendingCompactions,
      dispatch,
      bindSessionThread: (band, live) => {
        this.#frameRouting.bindSessionThread(
          band,
          live.sessionId,
          live.providerSessionId,
          live.establishment,
        );
      },
      listeners: {
        onTurnTerminal: (live) => {
          this.#settlement.settleTurn(live);
        },
        onInboundFrame: (band, live, observation) =>
          this.#frameRouting.observeInboundFrame(
            band,
            live.sessionId,
            live.providerSessionId,
            observation,
          ),
        onDeliveredFrame: (live, frame, route) => {
          this.#stream.deliverFrame(live, frame, route);
        },
        onInboundRequest: (live, event) => {
          this.#hookCallbacks.handle(live, event);
        },
        onUnrequestedExit: (live, exit) => {
          this.#prompts.forgetSession(live.sessionId);
          this.#restarts.handleUnrequestedExit(live, exit).catch((error: unknown) => {
            this.#restarts.recordReportFailure(live.sessionId, "a process exit", error);
          });
        },
      },
    });
    this.#restarts = new ClaudeSessionRestarts({
      slots: this.#slots,
      runRoutes: this.#runRoutes,
      runEngine: dependencies.runEngine,
      dispatch,
      diagnostics,
      resume: async (params) => await this.resumeSession(params),
      onSessionRelaunched: dependencies.onSessionRelaunched,
      forgetProcessState: (sessionId) => {
        this.#forgetProcessState(sessionId);
      },
      scheduler: dependencies.restartScheduler ?? scheduleUnrefTimer,
      now,
    });
    this.#compactionDispatch = new ClaudeCompactionDispatch({
      pendingCompactions: this.#pendingCompactions,
      runRoutes: this.#runRoutes,
      diagnostics,
    });
    this.#establishment = new ClaudeSessionEstablishment({
      transport: dependencies.transport,
      mintProviderSessionId: dependencies.mintProviderSessionId ?? mintUuidV7,
      mintBindingId: dependencies.mintBindingId ?? mintUuidV7,
      spawnLegs: new ClaudeSpawnLegComposer(dependencies),
      operatingSystem: dependencies.operatingSystem,
      diagnostics,
      modelFigures: () => this.#modelFigures,
      rebindRuntimeBinding: dependencies.rebindRuntimeBinding,
      registerLiveSession: (live) => {
        // What the daemon held for the process this one replaces goes first, so nothing the new
        // process sets up from here is lost with it.
        this.#forgetProcessState(live.sessionId);
        this.#slots.registerLiveSession(live);
        const policy = live.spawnBoundLegs.subagentPolicy;
        if (limitsHelpersAtOnce(policy)) {
          this.#helpers.limitSession(live.sessionId, policy.helpersAtOnce);
        }
      },
      reportSettingsReadback: async (sessionId, attachment) => {
        // The process is adopted either way, so a failed check is recorded, not thrown.
        await findIgnoredSettingNotice(
          sessionId,
          attachment.settingsReadback,
          dependencies.operatingSystem.claudeManagedSettingsFolder,
          (error) => {
            this.#restarts.recordReportFailure(sessionId, "a managed settings read", error);
          },
        )
          .then(async (notice) => {
            if (notice !== undefined) {
              await dispatch.send({ kind: "session_notice", notice }, null);
            }
          })
          .catch((error: unknown) => {
            this.#restarts.recordReportFailure(sessionId, "the settings readback", error);
          });
      },
      releaseSupersededPredecessor: (sessionId) => {
        this.#slots.releaseSupersededPredecessor(sessionId);
      },
    });
    this.#runStart = new ClaudeRunStart({
      runDispatchResolver: dependencies.runDispatchResolver,
      runEngine: dependencies.runEngine,
      slots: this.#slots,
      runRoutes: this.#runRoutes,
      handshakes: this.#handshakes,
      diagnostics,
      prompts: this.#prompts,
    });
    this.#runControls = new ClaudeRunControls({
      slots: this.#slots,
      runRoutes: this.#runRoutes,
      pauses: this.#pauses,
      hookCallbacks: this.#hookCallbacks,
      dialogs: this.#dialogs,
      requests: this.#requests,
      stream: this.#stream,
      startDaemonTurn: async (live, opening) => await this.#runStart.startDaemonTurn(live, opening),
      prompts: this.#prompts,
    });
    this.#cuts = new ClaudeConversationCuts({
      runRoutes: this.#runRoutes,
      slots: this.#slots,
      prompts: this.#prompts,
      dialogs: this.#dialogs,
      recordReportFailure: (sessionId, step, error) => {
        this.#restarts.recordReportFailure(sessionId, step, error);
      },
    });
    this.#settlement = new ClaudeTurnSettlement({
      handshakes: this.#handshakes,
      runRoutes: this.#runRoutes,
      helpers: this.#helpers,
      hookCallbacks: this.#hookCallbacks,
      pendingCompactions: this.#pendingCompactions,
      moveAfterTurn: (live) => {
        this.#restarts.moveAfterTurn(live);
      },
    });
  }

  /**
   * Spawns a new provider process for `params.sessionId` and registers it. Throws
   * `ClaudeSessionUnavailableError` when the slot is held or the provider account is empty;
   * throwing is the only failure channel.
   */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Fail closed, not replace: an existing channel has its own posture, cap and schema.
    const slotHolder = this.#slots.describeSlotHolder(params.sessionId);
    if (slotHolder !== undefined) {
      throw new ClaudeSessionUnavailableError("session_already_live", {
        sessionId: params.sessionId,
        detail: slotHolder,
      });
    }
    return await this.#slots.withSessionSlotClaimed(
      params.sessionId,
      async () => await this.#establishment.establishCreatedSession(params),
    );
  }

  /** Resumes a provider session by its handle; every failure returns through the `failed` arm. */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Resuming beside a live channel would leave two processes for one canonical session, and an
    // in-flight establishment belongs to a caller with different spawn-bound legs.
    const slotHolder = this.#slots.describeSlotHolder(params.sessionId);
    if (slotHolder !== undefined) {
      return buildClaudeResumeFailure(
        "recovery-needed",
        `${slotHolder} Resuming beside it would replace it silently.`,
      );
    }
    return await this.#slots.withSessionSlotClaimed(
      params.sessionId,
      async () => await this.#establishment.establishResumedSession(params),
    );
  }

  /**
   * Starts a session whose process ended and stayed down, counting its crashes from the first
   * again, and tells the person it runs again. Every failure returns through the `failed` arm.
   */
  async restartSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    this.#restarts.cancelPendingRestart(params.sessionId);
    this.#restarts.clearCrashWindow(params.sessionId);
    const result = await this.resumeSession(params);
    if (result.status === "resumed") {
      await this.#restarts.reportRestarted(params.sessionId);
    }
    return result;
  }

  /** Writes a run's opening text; see {@link ClaudeRunStart.startRun}. */
  async startRun(params: StartRunParams): Promise<void> {
    await this.#runStart.startRun(params);
  }

  /**
   * Zero-turn authentication probe; never throws. `ClaudeAuthenticationRequiredError` is
   * `unauthenticated`, any other throw `indeterminate`. It claims no session slot.
   */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    try {
      // Built like every other spawn, on the captured base, so the probe cannot update the build
      // underneath the readings.
      const reading = await this.#dependencies.transport.probeAuth({
        spawnEnvironment: composeClaudeSpawnEnvironment({
          providerBaseEnvironment: this.#dependencies.providerBaseEnvironment,
          environmentNameMatch: this.#dependencies.operatingSystem.environmentNameMatch,
          environmentRows: undefined,
          accountFolders: undefined,
        }),
      });
      return buildAuthProbeResult(
        "authenticated",
        sanitizeFailureDetail(reading.detail ?? CLAUDE_AUTH_PROBE_REACHED_DETAIL),
      );
    } catch (cause) {
      // Typed, not sniffed from the message, which provider rewording would break.
      return buildAuthProbeResult(
        cause instanceof ClaudeAuthenticationRequiredError ? "unauthenticated" : "indeterminate",
        sanitizeFailureDetail(describeFailure(cause)),
      );
    }
  }

  /**
   * The settlement an intervention's interrupt and steer make before and after they go; see
   * {@link ClaudeRunControls}.
   */
  get interventionSettlement(): ClaudeInterventionSettlement {
    return this.#runControls;
  }

  /** The figures held for the installed build; the model list reads its windows. */
  get modelFigures(): ClaudeModelFigures {
    return this.#modelFigures;
  }

  /** Starts an empty figure store when the daemon reads a build other than the one held. */
  noteProviderBuild(version: string): void {
    if (version !== this.#modelFigures.buildVersion) {
      this.#modelFigures = new ClaudeModelFigures(version);
    }
  }

  /** Stops a run's turn; see {@link ClaudeRunControls.interruptRun}. */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    await this.#runControls.interruptRun(params);
  }

  /** Pauses a lead or helper run from its next step; see {@link ClaudeRunControls.pauseRun}. */
  pauseRun(params: PauseRunParams): void {
    this.#runControls.pauseRun(params);
  }

  /** Continues a paused run; see {@link ClaudeRunControls.resumeRun}. */
  async resumeRun(params: ResumeRunParams): Promise<void> {
    await this.#runControls.resumeRun(params);
  }

  /** Takes back an unread message; see {@link ClaudeRunControls.withdrawQueuedMessage}. */
  async withdrawQueuedMessage(
    params: WithdrawQueuedMessageParams,
  ): Promise<WithdrawQueuedMessageResult> {
    return await this.#runControls.withdrawQueuedMessage(params);
  }

  /** Answers a request a run is held on; see {@link ClaudeRunControls.respondToRequest}. */
  async respondToRequest(params: RespondToRequestParams): Promise<void> {
    await this.#runControls.respondToRequest(params);
  }

  /** Answers a choice a run is held on; see {@link ClaudeRunControls.answerProviderChoice}. */
  async answerProviderChoice(
    params: AnswerProviderChoiceParams,
  ): Promise<AnswerProviderChoiceResult> {
    return await this.#runControls.answerProviderChoice(params);
  }

  /** Overrules a reviewer's block; see {@link ClaudeRunControls.overrideDenial}. */
  async overrideDenial(params: OverrideDenialParams): Promise<void> {
    await this.#runControls.overrideDenial(params);
  }

  /**
   * Moves a live session to another permission level from its next request; see
   * {@link moveClaudePermissionLevel}. Throws with no live session.
   */
  async updatePermissionLevel(params: UpdatePermissionLevelParams): Promise<void> {
    await moveClaudePermissionLevel(
      this.#requireLive(params.sessionId),
      params.level,
      this.#dependencies.operatingSystem,
    );
  }

  /** The permission levels a Claude Code session can run at on this machine. */
  listModes(): ProviderMode[] {
    return listClaudeModes(this.#dependencies.operatingSystem);
  }

  /** Moves a session between Build and Plan; see {@link ClaudeSessionControls}. */
  async updateSessionMode(params: UpdateSessionModeParams): Promise<void> {
    await this.#controls.updateSessionMode(this.#requireLive(params.sessionId), params.mode);
  }

  /** Answers a command typed into the message box itself; see {@link ClaudeSessionControls}. */
  async answerSessionCommand(params: AnswerSessionCommandParams): Promise<SessionCommandAnswer> {
    return await this.#controls.answerSessionCommand(
      this.#requireLive(params.sessionId),
      params.text,
    );
  }

  /** Asks a side question; see {@link ClaudeSessionControls.askSideQuestion}. */
  async askSideQuestion(params: AskSideQuestionParams): Promise<void> {
    const live = this.#requireLive(params.sessionId);
    this.#controls.askSideQuestion(live, params.sideQuestionId, params.question);
  }

  /** Starts Claude Code's own review; see {@link ClaudeSessionControls.startReview}. */
  async startReview(params: StartReviewParams): Promise<void> {
    await this.#controls.startReview(this.#requireLive(params.sessionId), params.target);
  }

  /** Follows a session's command list; see {@link ClaudeSessionControls}. */
  subscribeProviderCommands(
    params: SubscribeProviderCommandsParams,
    listener: ProviderCommandsListener,
  ): () => void {
    return this.#controls.subscribeProviderCommands(params.sessionId, listener);
  }

  /**
   * Cuts the live conversation in place to before one of the person's messages; see
   * {@link ClaudeConversationCuts.rewind}. Throws with no live session.
   */
  async rewindConversation(params: RewindConversationParams): Promise<RewindConversationResult> {
    return await this.#cuts.rewind(this.#requireLive(params.sessionId), params.targetMessageId);
  }

  /**
   * Moves the session onto a fork of its provider conversation at a recorded message; the
   * conversation it left and the files on disk stay untouched. An `applied` move has rewritten
   * `params.bindingId` to the new provider session; a failed one restores the predecessor.
   */
  async moveSessionToFork(params: MoveSessionToForkParams): Promise<MoveSessionToForkResult> {
    // Thrown, not degraded: `degraded` is for a driver that could act and reported a fallback.
    const live = this.#requireLive(params.sessionId);
    return await this.#slots.withRewindSlotClaimed(
      params.sessionId,
      live,
      async () => await this.#establishment.establishRewoundSession(params, live),
    );
  }

  /** Sets or replaces the session's goal; see {@link ClaudeGoalCommands.send}. */
  async setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    const live = this.#requireLive(params.sessionId);
    return await this.#goals.send(live, this.#handshakes, params.goalText);
  }

  /** Clears the session's goal; see {@link ClaudeGoalCommands.send}. */
  async clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#goals.send(this.#requireLive(params.sessionId), this.#handshakes, undefined);
  }

  /** Moves sessions onto a new build; see {@link ClaudeSessionRestarts.moveToProviderBuild}. */
  async moveToProviderBuild(change: ProviderBuildChange): Promise<void> {
    await this.#restarts.moveToProviderBuild(change);
  }

  /**
   * Deletes Claude Code's own copy of each conversation the session opened, from the home each ran
   * in; see {@link purgeClaudeConversations}.
   */
  async purgeSession(params: PurgeSessionParams): Promise<void> {
    await purgeClaudeConversations(
      params,
      this.#dependencies.spawnContext,
      this.#dependencies.providerBaseEnvironment,
      this.#dependencies.operatingSystem.environmentNameMatch,
    );
  }

  /**
   * Triggers a context compaction by sending the provider's `/compact` for Claude Code to run.
   * Refuses `command_absent` unless the binding lists the command; `applied` needs the typed
   * compaction frame. Throws with no live session, and `session_turn_in_flight` while a turn holds
   * the session, since the command runs as a turn of its own.
   */
  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    const live = this.#requireLive(params.sessionId);
    // The held enumeration, matched by stamp: stricter than the composed entries'
    // `(driverName, providerAccountId)` pair, which would refuse every accountless session.
    const held = this.#handshakes.heldHandshakeFor(params.sessionId, live.providerSessionId);
    if (held === undefined || !held.invocableCommandNames.has(CLAUDE_COMPACTION_COMMAND_NAME)) {
      // No prompt-based fallback: a model summary spends a turn and produces no boundary.
      return { status: "refused", reason: "command_absent" };
    }
    return await this.#compactionDispatch.dispatchCompaction(params.sessionId, live.channel);
  }

  /**
   * Enumerates the provider's command and skill surface for one binding from the held handshake,
   * with terminal slash commands carried as `scope: "terminal"`; before the handshake it answers
   * empty.
   */
  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    return this.#composeCommands(this.#requireLive(params.sessionId));
  }

  /**
   * The output-speed state the provider declared: from the process's `initialize` reply at spawn,
   * before any turn, then from each `system/init` that reports one. `undefined` with no live
   * session or no state reported; a declaration the contract's bounds reject reads as absent,
   * with a diagnostic; `cooldown` is carried as declared.
   */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    const live = this.#slots.findLiveSession(sessionId);
    if (live === undefined) {
      return undefined;
    }
    return this.#handshakes.observedOutputSpeedFor(sessionId, live.providerSessionId);
  }

  /**
   * Closes the session's channel, chaining behind any in-flight transition and retrying a
   * quarantined channel. Idempotent; rejects if the process will not exit.
   */
  async closeSession(params: CloseSessionParams): Promise<void> {
    // Latch first, so every terminal from here, including an in-flight establishment's, is a clean
    // shutdown.
    this.#slots.intendedCloseGateFor(params.sessionId).signalIntendedClose();
    // A closed session is not brought back by a restart that was waiting.
    this.#restarts.forgetSession(params.sessionId);
    this.#controls.forgetSession(params.sessionId);
    this.#reviewer.forgetSession(params.sessionId);
    // Chains on any in-flight transition and re-reads: the slot may settle as live, empty or
    // quarantined.
    for (;;) {
      const slot = this.#slots.slotFor(params.sessionId);
      // Idempotent: a double close is normal teardown; the latch set above goes so gates do not
      // pile up.
      if (slot === undefined) {
        this.#slots.forgetIntendedCloseGate(params.sessionId);
        return;
      }
      // Exhaustive: a new slot state must decide whether close chains on it or acts on it.
      switch (slot.state) {
        case "establishing":
        case "closing":
          await slot.settled;
          continue;
        case "live":
          // Routes first: a route into a dying process would aim a later interrupt at a dead run.
          this.#runRoutes.retireRunRoutes(params.sessionId);
          this.#runRoutes.forgetSessionBindings(params.sessionId);
          this.#forgetProcessState(params.sessionId);
          this.#prompts.forgetSession(params.sessionId);
          await this.#slots.disposeHeldChannel(params.sessionId, slot.session.channel);
          return;
        case "quarantined":
          // Retry the retained channel, the only handle on a process that would not exit.
          await this.#slots.disposeHeldChannel(params.sessionId, slot.channel);
          return;
      }
    }
  }

  /**
   * Ends every Claude Code process as a deliberate stop while the daemon stops: no restart starts
   * from here, every session closes as `closeSession` closes it, and the transport ends every
   * process still running after its bounded wait. Rejects with what failed once all have ended.
   */
  async shutdown(): Promise<void> {
    this.#restarts.stop();
    const closes = this.#slots
      .sessionIds()
      .map(async (sessionId) => await this.closeSession({ sessionId }));
    await this.#dependencies.transport.stopEveryProcess();
    const failures = (await Promise.allSettled(closes)).flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Closing the Claude Code sessions at the stop failed");
    }
  }

  /** The live channel a run's turn is bound to, or `undefined` when no channel is bound to it. */
  findProcessForRun(runId: RunId): ClaudeProviderProcess | undefined {
    const sessionId = this.#runRoutes.sessionIdFor(runId);
    return sessionId === undefined ? undefined : this.#slots.findLiveSession(sessionId)?.channel;
  }

  /** The capabilities the process of a run's session advertised on its newest `system/init`. */
  advertisedCapabilitiesForRun(runId: RunId): ReadonlySet<string> {
    const sessionId = this.#runRoutes.sessionIdFor(runId);
    const live = sessionId === undefined ? undefined : this.#slots.findLiveSession(sessionId);
    if (sessionId === undefined || live === undefined) {
      return new Set();
    }
    const held = this.#handshakes.heldHandshakeFor(sessionId, live.providerSessionId);
    return new Set(held?.declaration.capabilities ?? []);
  }

  /** Records a steer written into a run's turn as its session's newest message. */
  recordSteerSent(runId: RunId, messageUuid: string): void {
    const sessionId = this.#runRoutes.sessionIdFor(runId);
    if (sessionId !== undefined) {
      this.#prompts.recordSent(sessionId, messageUuid);
    }
  }

  #requireLive(sessionId: SessionId): LiveClaudeSession {
    const live = this.#slots.findLiveSession(sessionId);
    if (live === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_session", { sessionId });
    }
    return live;
  }

  #composeCommands(live: LiveClaudeSession): ProviderCommandListResult {
    const enumeration = this.#handshakes.enumerateProviderCommands(live.sessionId, live);
    return {
      bindings: [{ runId: this.#runRoutes.soleLiveRunOn(live.sessionId), ...enumeration }],
    };
  }

  // The run a request belongs to: a helper's child run by its id, else the lead run.
  #runFor(sessionId: SessionId, agentId: string | undefined): ClaudeBoundRun | undefined {
    if (agentId === undefined) {
      return this.#runRoutes.leadRunOn(sessionId);
    }
    const childRunId = this.#runRoutes.childRunFor(sessionId, agentId);
    const route = childRunId === undefined ? undefined : this.#runRoutes.childRouteFor(childRunId);
    return childRunId === undefined || route === undefined
      ? undefined
      : { runId: childRunId, bindingId: route.bindingId };
  }

  // A paused helper's next call is held: its child run is paused.
  #reportHelperPaused(sessionId: SessionId, agentId: string): void {
    const childRunId = this.#runRoutes.childRunFor(sessionId, agentId);
    const route = childRunId === undefined ? undefined : this.#runRoutes.childRouteFor(childRunId);
    if (childRunId === undefined || route === undefined) {
      return;
    }
    void this.#dispatch.send(
      {
        kind: "run_lifecycle",
        bindingId: route.bindingId,
        change: { runId: childRunId, expectedState: "pausing", newState: "paused" },
      },
      null,
    );
  }

  // Feeds the helper limit from each helper's announcement and end, answering the starts it frees.
  #observeHelperLifecycle(sessionId: SessionId, emission: SubagentLifecycleEmission): void {
    if (emission.eventType === "subagent.started") {
      this.#helpers.helperStarted(
        sessionId,
        emission.subagentId,
        emission.parentToolCallId ?? null,
      );
      return;
    }
    const live = this.#slots.findLiveSession(sessionId);
    const released = this.#helpers.helperFinished(sessionId, emission.subagentId);
    if (live !== undefined) {
      this.#hookCallbacks.admitHelperStarts(live, released);
    }
  }

  // What the daemon held for a process that is gone: its pauses, helper holds and helper routes,
  // the stream's readings, the requests and choices it held and the command waiting on it.
  #forgetProcessState(sessionId: SessionId): void {
    this.#pauses.forgetSession(sessionId);
    this.#helpers.forgetSession(sessionId);
    this.#runRoutes.retireChildRoutes(sessionId);
    this.#stream.forgetSession(sessionId);
    this.#dialogs.forgetSession(sessionId);
    this.#requests.forgetSession(sessionId);
    this.#goals.forgetSession(sessionId);
    this.#controls.forgetProcess(sessionId);
  }
}
