/**
 * Codex driver entry point: `CodexLifecycleManager` (services, sessions, runs, rewinds, goals,
 * compaction, provider commands) and `CodexInterventionDispatcher` behind `ProviderDriver`.
 *
 * No operation is capability-gated here. The registry's `checkCapability` is the static refusal
 * and reads the snapshot captured at registration; a second gate in this class would read a live
 * snapshot and could disagree with the one that already admitted the call.
 */

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

import { CodexInterventionDispatcher, type CodexCapabilitySnapshotReader } from "./intervention.js";
import { CodexLifecycleManager } from "./lifecycle.js";
import { listCodexModes } from "./permission-level.js";
import type { CodexLifecycleOptions } from "./session/state.js";
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
  FasterModelRetryParams,
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

/** Construction inputs for the Codex driver. */
export interface CodexDriverOptions extends CodexLifecycleOptions {
  /** Read live at every intervention dispatch. */
  readonly readCapabilities: CodexCapabilitySnapshotReader;
}

/** Builds the Codex driver; the daemon's startup reaches it through the driver factory table. */
export function createDriver(dependencies: CodexDriverOptions): ProviderDriver {
  return new CodexDriver(dependencies);
}

/** The Codex provider driver. */
export class CodexDriver implements ProviderDriver {
  readonly #lifecycle: CodexLifecycleManager;
  readonly #interventions: CodexInterventionDispatcher;

  constructor(options: CodexDriverOptions) {
    this.#lifecycle = new CodexLifecycleManager(options);
    this.#interventions = new CodexInterventionDispatcher({
      // The manager satisfies `CodexInterventionRuntime`; composing them here avoids a cycle.
      runtime: this.#lifecycle,
      readCapabilities: options.readCapabilities,
    });
  }

  /** Starts a fresh conversation for the session on its account's service. */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return await this.#lifecycle.createSession(params);
  }

  /** Resumes the session's conversation; a failure is the typed `failed` result. */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return await this.#lifecycle.resumeSession(params);
  }

  /** Restarts the session's service after it stayed down and resumes its conversations. */
  async restartSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return await this.#lifecycle.restartSession(params);
  }

  /** Starts one provider turn for the run. */
  async startRun(params: StartRunParams): Promise<void> {
    await this.#lifecycle.startRun(params);
  }

  /** Interrupts the run's live turn. */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    await this.#lifecycle.interruptRun(params);
  }

  /** Routes a steer or interrupt onto the provider, or returns `degraded`. */
  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return await this.#interventions.applyIntervention(params);
  }

  /** Forks the thread at a recorded turn boundary and moves the session onto the fork. */
  async moveSessionToFork(params: MoveSessionToForkParams): Promise<MoveSessionToForkResult> {
    return await this.#lifecycle.moveSessionToFork(params);
  }

  /** Cuts the conversation back to before one of the person's messages. */
  async rewindConversation(params: RewindConversationParams): Promise<RewindConversationResult> {
    return await this.#lifecycle.rewindConversation(params);
  }

  /** Answers an ask a run is held on. */
  async respondToRequest(params: RespondToRequestParams): Promise<void> {
    await this.#lifecycle.respondToRequest(params);
  }

  /** Allows once a call Codex's own reviewer blocked at Reviewed. */
  async overrideDenial(params: OverrideDenialParams): Promise<void> {
    await this.#lifecycle.overrideDenial(params);
  }

  /** Stops a turn Codex holds for a safety check and sends it again on a faster model. */
  async retryTurnOnFasterModel(params: FasterModelRetryParams): Promise<FasterModelRetryOutcome> {
    return await this.#lifecycle.retryTurnOnFasterModel(params);
  }

  /** Pauses the run from its next tool call. */
  async pauseRun(params: PauseRunParams): Promise<void> {
    this.#lifecycle.pauseRun(params);
  }

  /** Continues the run with the messages that waited for it. */
  async resumeRun(params: ResumeRunParams): Promise<void> {
    await this.#lifecycle.resumeRun(params);
  }

  /**
   * The driver sends every steer on as it is handed over, behind any steer Codex has yet to
   * answer, and keeps none it could take back, so a withdrawal is always too late.
   */
  async withdrawQueuedMessage(
    _params: WithdrawQueuedMessageParams,
  ): Promise<WithdrawQueuedMessageResult> {
    return { status: "already_delivered" };
  }

  /** Codex holds no run on a refusal or a usage-credits choice, so none is ever pending. */
  async answerProviderChoice(
    _params: AnswerProviderChoiceParams,
  ): Promise<AnswerProviderChoiceResult> {
    return { status: "not_pending" };
  }

  /** Moves the session to another permission level from its next turn. */
  async updatePermissionLevel(params: UpdatePermissionLevelParams): Promise<void> {
    await this.#lifecycle.updatePermissionLevel(params);
  }

  /** Moves every conversation onto the new provider build. */
  async moveToProviderBuild(change: ProviderBuildChange): Promise<void> {
    await this.#lifecycle.moveToProviderBuild(change);
  }

  /** Deletes Codex's own copy of every conversation the session opened. */
  async purgeSession(params: PurgeSessionParams): Promise<void> {
    await this.#lifecycle.purgeSession(params);
  }

  /** Sets the thread's goal on the provider. */
  async setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#lifecycle.setSessionGoal(params);
  }

  /** Clears the thread's goal on the provider. */
  async clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#lifecycle.clearSessionGoal(params);
  }

  /** Closes the session's conversation; the service stays for the others. */
  async closeSession(params: CloseSessionParams): Promise<void> {
    await this.#lifecycle.closeSession(params);
  }

  /** The selectable model catalog, read live from the default account's service. */
  async listModels(): Promise<ProviderModel[]> {
    return await this.#lifecycle.listModels();
  }

  /** The levels a Codex session can run at, each with the profile it selects. */
  async listModes(): Promise<ProviderMode[]> {
    return listCodexModes();
  }

  /** The capability declaration of the build the default account's service runs. */
  async getCapabilities(): Promise<GetCapabilitiesResult> {
    return await this.#lifecycle.getCapabilities();
  }

  /** Whether the default account is signed in; never throws. */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    return await this.#lifecycle.probeAuth();
  }

  /** Compacts the thread's context and settles on the provider's compaction frame. */
  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    return await this.#lifecycle.compactContext(params);
  }

  /** The provider's commands and skills for the session, held until the provider signals change. */
  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    return await this.#lifecycle.listProviderCommands(params);
  }

  /** Moves the session between Build and Plan from its next turn. */
  async updateSessionMode(params: UpdateSessionModeParams): Promise<void> {
    await this.#lifecycle.updateSessionMode(params);
  }

  /** Codex has no command the daemon answers for the session alone, so every text goes as typed. */
  async answerSessionCommand(_params: AnswerSessionCommandParams): Promise<SessionCommandAnswer> {
    return { answered: false };
  }

  /** Asks a side question on a read-only copy of the conversation. */
  async askSideQuestion(params: AskSideQuestionParams): Promise<void> {
    await this.#lifecycle.askSideQuestion(params);
  }

  /** Starts Codex's own review of a set of changes. */
  async startReview(params: StartReviewParams): Promise<void> {
    await this.#lifecycle.startReview(params);
  }

  /** Follows the session's live command list until the returned function is called. */
  subscribeProviderCommands(
    params: SubscribeProviderCommandsParams,
    listener: ProviderCommandsListener,
  ): () => void {
    return this.#lifecycle.subscribeProviderCommands(params, listener);
  }

  /** Stops every service the daemon started and the hook socket; the person's own stays. */
  async shutdown(): Promise<void> {
    await this.#lifecycle.shutdown();
  }

  /** The tier the session's thread declared; see the lifecycle's reader. */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    return this.#lifecycle.observedOutputSpeedFor(sessionId);
  }
}
