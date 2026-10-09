// ClaudeDriver: the Claude provider driver entry point.
//
// The composition root, owning no logic of its own: it binds the lifecycle (`lifecycle.ts`), the
// intervention dispatcher (`intervention.ts`) and the capability reporter (`capabilities.ts`). The
// dispatcher reaches a run's process and the choices it is held on through two narrow ports,
// `ClaudeRunProcessLookup` and `ClaudeInterventionSettlement`, so it changes no session state
// itself.

import type {
  ProviderMode,
  ProviderModel,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import type { ProviderCommandListResult } from "@ai-sidekicks/contracts/provider/driver/commands";
import type {
  ApplyInterventionParams,
  DriverInterventionResult,
  InterruptRunParams,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type {
  ClearSessionGoalParams,
  CloseSessionParams,
  CompactContextParams,
  CreateSessionParams,
  DriverAuthProbeResult,
  DriverGoalResult,
  DriverResumeResult,
  MoveSessionToForkParams,
  MoveSessionToForkResult,
  GetCapabilitiesResult,
  ListProviderCommandsParams,
  ProviderDriver,
  ProviderSessionHandle,
  RespondToRequestParams,
  ResumeSessionParams,
  SetSessionGoalParams,
  StartRunParams,
} from "../contract.js";
import type { RewindConversationParams, RewindConversationResult } from "../rewind.js";
import type {
  AnswerProviderChoiceParams,
  AnswerProviderChoiceResult,
  FasterModelRetryOutcome,
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
import { readSpawnedProviderVersion } from "../../spawned-version.js";
import {
  CLAUDE_DRIVER_NAME,
  ClaudeCapabilityReporter,
  resolveClaudeModelCatalog,
  type ClaudeCapabilityReporterDependencies,
} from "./capabilities.js";
import { ClaudeInterventionDispatcher } from "./intervention.js";
import { ClaudeSessionLifecycle } from "./lifecycle.js";
import type { ClaudeSessionLifecycleDependencies } from "./session/state.js";
import { composeClaudeSpawnEnvironment } from "./spawn/environment.js";
import { ClaudeProcessTransport, type ClaudeProcessTransportDependencies } from "./spawn/launch.js";

/** The composition root's dependencies: the lifecycle's and the build reads. */
type ClaudeDriverDependencies = ClaudeSessionLifecycleDependencies &
  Pick<ClaudeCapabilityReporterDependencies, "readSpawnedVersion" | "probe">;

/**
 * Builds the Claude driver over the real process transport, reading the build's version and
 * probing its capabilities through that transport, each from a process that keeps nothing; the
 * daemon's startup reaches it through the driver factory table.
 */
export function createDriver(
  dependencies: Omit<ClaudeDriverDependencies, "transport" | "readSpawnedVersion" | "probe"> &
    Pick<ClaudeProcessTransportDependencies, "providerCommand" | "toolServerRoute">,
): ProviderDriver {
  const { providerCommand, toolServerRoute, ...driverDependencies } = dependencies;
  const { providerBaseEnvironment, operatingSystem } = driverDependencies;
  const transport = new ClaudeProcessTransport({
    providerCommand,
    toolServerRoute,
    diagnostics: driverDependencies.diagnostics,
  });
  return new ClaudeDriver({
    ...driverDependencies,
    transport,
    readSpawnedVersion: async () =>
      await readSpawnedProviderVersion({
        driverName: CLAUDE_DRIVER_NAME,
        requestedCommand: await providerCommand(),
        handshake: async (request) => await transport.readBinaryVersion(request),
        baseEnv: providerBaseEnvironment,
        environmentNameMatch: operatingSystem.environmentNameMatch,
      }),
    probe: async (request) =>
      await transport.probeControlRequest({
        executablePath: request.boundExecutablePath,
        spawnEnvironment: composeClaudeSpawnEnvironment({
          providerBaseEnvironment,
          environmentNameMatch: operatingSystem.environmentNameMatch,
          environmentRows: undefined,
          accountFolders: undefined,
        }),
        probeName: request.probeName,
      }),
  });
}

/** The Claude provider driver: routes each contract operation to the owner that serves it. */
export class ClaudeDriver implements ProviderDriver {
  readonly #dependencies: ClaudeDriverDependencies;
  readonly #lifecycle: ClaudeSessionLifecycle;
  readonly #interventionDispatcher: ClaudeInterventionDispatcher;
  readonly #capabilityReporter: ClaudeCapabilityReporter;

  constructor(dependencies: ClaudeDriverDependencies) {
    this.#dependencies = dependencies;
    this.#lifecycle = new ClaudeSessionLifecycle(dependencies);
    this.#interventionDispatcher = new ClaudeInterventionDispatcher({
      channelLookup: this.#lifecycle,
      settlement: this.#lifecycle.interventionSettlement,
      onSteerSent: (runId, messageUuid) => {
        this.#lifecycle.recordSteerSent(runId, messageUuid);
      },
    });
    this.#capabilityReporter = new ClaudeCapabilityReporter(dependencies);
  }

  /** Spawns and registers a new session; see {@link ClaudeSessionLifecycle.createSession}. */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return await this.#lifecycle.createSession(params);
  }

  /** Resumes a session by its handle; see {@link ClaudeSessionLifecycle.resumeSession}. */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return await this.#lifecycle.resumeSession(params);
  }

  /** Starts a session that stayed down; see {@link ClaudeSessionLifecycle.restartSession}. */
  async restartSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return await this.#lifecycle.restartSession(params);
  }

  /** Writes a run's opening text; see {@link ClaudeSessionLifecycle.startRun}. */
  async startRun(params: StartRunParams): Promise<void> {
    await this.#lifecycle.startRun(params);
  }

  /** Interrupts a run's turn; see {@link ClaudeSessionLifecycle.interruptRun}. */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    await this.#lifecycle.interruptRun(params);
  }

  /** Applies a steer or an interrupt; see {@link ClaudeInterventionDispatcher}. */
  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return await this.#interventionDispatcher.applyIntervention(params);
  }

  /** Pauses a run from its next step; see {@link ClaudeSessionLifecycle.pauseRun}. */
  async pauseRun(params: PauseRunParams): Promise<void> {
    this.#lifecycle.pauseRun(params);
  }

  /** Continues a paused run; see {@link ClaudeSessionLifecycle.resumeRun}. */
  async resumeRun(params: ResumeRunParams): Promise<void> {
    await this.#lifecycle.resumeRun(params);
  }

  /** Takes back an unread steer; see {@link ClaudeSessionLifecycle.withdrawQueuedMessage}. */
  async withdrawQueuedMessage(
    params: WithdrawQueuedMessageParams,
  ): Promise<WithdrawQueuedMessageResult> {
    return await this.#lifecycle.withdrawQueuedMessage(params);
  }

  /** Answers a request a run is held on; see {@link ClaudeSessionLifecycle.respondToRequest}. */
  async respondToRequest(params: RespondToRequestParams): Promise<void> {
    await this.#lifecycle.respondToRequest(params);
  }

  /** Answers a choice a run is held on; see {@link ClaudeSessionLifecycle.answerProviderChoice}. */
  async answerProviderChoice(
    params: AnswerProviderChoiceParams,
  ): Promise<AnswerProviderChoiceResult> {
    return await this.#lifecycle.answerProviderChoice(params);
  }

  /** Overrules a reviewer's block; see {@link ClaudeSessionLifecycle.overrideDenial}. */
  async overrideDenial(params: OverrideDenialParams): Promise<void> {
    await this.#lifecycle.overrideDenial(params);
  }

  /** Claude Code holds no turn for a safety check, so there is never a turn to send again. */
  async retryTurnOnFasterModel(): Promise<FasterModelRetryOutcome> {
    return { state: "rejected", rejectionReason: "Claude Code holds no turn for a safety check." };
  }

  /** Moves a session to another level; see {@link ClaudeSessionLifecycle.updatePermissionLevel}. */
  async updatePermissionLevel(params: UpdatePermissionLevelParams): Promise<void> {
    await this.#lifecycle.updatePermissionLevel(params);
  }

  /** Moves sessions onto a new build; see {@link ClaudeSessionLifecycle.moveToProviderBuild}. */
  async moveToProviderBuild(change: ProviderBuildChange): Promise<void> {
    await this.#lifecycle.moveToProviderBuild(change);
  }

  /** Deletes the session's conversations; see {@link ClaudeSessionLifecycle.purgeSession}. */
  async purgeSession(params: PurgeSessionParams): Promise<void> {
    await this.#lifecycle.purgeSession(params);
  }

  /** Cuts the conversation in place; see {@link ClaudeSessionLifecycle.rewindConversation}. */
  async rewindConversation(params: RewindConversationParams): Promise<RewindConversationResult> {
    return await this.#lifecycle.rewindConversation(params);
  }

  /** Moves the session onto a fork; see {@link ClaudeSessionLifecycle.moveSessionToFork}. */
  async moveSessionToFork(params: MoveSessionToForkParams): Promise<MoveSessionToForkResult> {
    return await this.#lifecycle.moveSessionToFork(params);
  }

  /** Sets the session's goal; see {@link ClaudeSessionLifecycle.setSessionGoal}. */
  async setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#lifecycle.setSessionGoal(params);
  }

  /** Clears the session's goal; see {@link ClaudeSessionLifecycle.clearSessionGoal}. */
  async clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#lifecycle.clearSessionGoal(params);
  }

  /** Moves a session between Build and Plan; see {@link ClaudeSessionLifecycle}. */
  async updateSessionMode(params: UpdateSessionModeParams): Promise<void> {
    await this.#lifecycle.updateSessionMode(params);
  }

  /** Answers a command typed into the message box; see {@link ClaudeSessionLifecycle}. */
  async answerSessionCommand(params: AnswerSessionCommandParams): Promise<SessionCommandAnswer> {
    return await this.#lifecycle.answerSessionCommand(params);
  }

  /** Asks a side question; see {@link ClaudeSessionLifecycle.askSideQuestion}. */
  async askSideQuestion(params: AskSideQuestionParams): Promise<void> {
    await this.#lifecycle.askSideQuestion(params);
  }

  /** Starts Claude Code's own review; see {@link ClaudeSessionLifecycle.startReview}. */
  async startReview(params: StartReviewParams): Promise<void> {
    await this.#lifecycle.startReview(params);
  }

  /** Follows a session's command list; see {@link ClaudeSessionLifecycle}. */
  subscribeProviderCommands(
    params: SubscribeProviderCommandsParams,
    listener: ProviderCommandsListener,
  ): () => void {
    return this.#lifecycle.subscribeProviderCommands(params, listener);
  }

  /** Closes a session's channel; see {@link ClaudeSessionLifecycle.closeSession}. */
  async closeSession(params: CloseSessionParams): Promise<void> {
    await this.#lifecycle.closeSession(params);
  }

  /** Probes authentication without a turn; see {@link ClaudeSessionLifecycle.probeAuth}. */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    return await this.#lifecycle.probeAuth();
  }

  /**
   * The selectable model catalog, read live from a control-only process's `initialize` reply, each
   * row with the context window read for its model so far.
   */
  async listModels(): Promise<ProviderModel[]> {
    const { transport, providerBaseEnvironment, operatingSystem } = this.#dependencies;
    const spawnEnvironment = composeClaudeSpawnEnvironment({
      providerBaseEnvironment,
      environmentNameMatch: operatingSystem.environmentNameMatch,
      environmentRows: undefined,
      accountFolders: undefined,
    });
    return await resolveClaudeModelCatalog(
      async () => await transport.readModelCatalog({ spawnEnvironment }),
      this.#lifecycle.modelFigures,
      spawnEnvironment,
    );
  }

  /** The levels a session can run at here; see {@link ClaudeSessionLifecycle.listModes}. */
  async listModes(): Promise<ProviderMode[]> {
    return this.#lifecycle.listModes();
  }

  /**
   * The capability declaration of the installed build; see {@link ClaudeCapabilityReporter}. Its
   * version keys every figure sessions read once and share.
   */
  async getCapabilities(): Promise<GetCapabilitiesResult> {
    const result = await this.#capabilityReporter.getCapabilities();
    this.#lifecycle.noteProviderBuild(result.cliVersion.rawVersion);
    return result;
  }

  /** Compacts a session's context; see {@link ClaudeSessionLifecycle.compactContext}. */
  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    return await this.#lifecycle.compactContext(params);
  }

  /** Lists the provider's commands; see {@link ClaudeSessionLifecycle.listProviderCommands}. */
  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    return await this.#lifecycle.listProviderCommands(params);
  }

  /**
   * The output-speed state this session's binding holds from the process's `initialize` reply or
   * a later `system/init`; see {@link ClaudeSessionLifecycle.observedOutputSpeedFor}.
   */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    return this.#lifecycle.observedOutputSpeedFor(sessionId);
  }

  /** Ends every Claude Code process as the daemon stops; see {@link ClaudeSessionLifecycle}. */
  async shutdown(): Promise<void> {
    await this.#lifecycle.shutdown();
  }
}
