// ClaudeDriver: the Claude provider driver entry point.
//
// Composition root that owns no logic of its own: it binds the lifecycle (`lifecycle.ts`) and the
// intervention dispatcher (`intervention.ts`). They meet through one narrow port,
// `ClaudeRunProcessLookup`, so the dispatcher finds a run's process without reaching into session
// state it must not mutate.
//
// The class implements a `Pick<ProviderDriver, ...>` rather than the whole interface. Declaring
// the full interface would force throwing stubs for the operations this driver does not serve
// (`respondToRequest`, `listModes`, `getCapabilities`, the two goal operations), and a driver
// that throws for an operation looks like a provider that refused it. The `Pick` still binds every
// implemented signature to the contract at compile time.

import type {
  ApplyInterventionParams,
  DriverInterventionResult,
  InterruptRunParams,
  ProviderModel,
} from "@ai-sidekicks/contracts/provider/driver/driver";
import type {
  DriverCompactionResult,
  ProviderCommandListResult,
  ProviderOutputSpeedState,
} from "@ai-sidekicks/contracts/provider/driver/transcript";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";

import { resolveClaudeModelCatalog, type ClaudeModelCatalogExchange } from "./capabilities.js";
import { ClaudeInterventionDispatcher } from "./intervention.js";
import { ClaudeSessionLifecycle } from "./lifecycle.js";
import { type ClaudeSessionLifecycleDependencies } from "./session/state.js";
import type {
  CloseSessionParams,
  CompactContextParams,
  CreateSessionParams,
  DriverAuthProbeResult,
  ListProviderCommandsParams,
  DriverResumeResult,
  ForkConversationResult,
  ProviderDriver,
  ProviderSessionHandle,
  ResumeSessionParams,
  ForkConversationParams,
  StartRunParams,
} from "../../provider-driver.js";

// The public surface is listed by name, not `export *`, so a symbol added to a module does not
// become public by accident. From `capabilities.ts` only the model-catalog type is public, because
// only `listModels` serves it; `tools.ts` is not exported.
export { type ClaudeModelCatalogExchange } from "./capabilities.js";
export { ClaudeInterventionDispatcher } from "./intervention.js";
export { ClaudeSessionLifecycle } from "./lifecycle.js";

/** The contract operations this driver implements; the class declaration is checked against it. */
type ClaudeDriverOperations = Pick<
  ProviderDriver,
  | "createSession"
  | "resumeSession"
  | "startRun"
  | "interruptRun"
  | "applyIntervention"
  | "closeSession"
  | "forkConversation"
  | "probeAuth"
  | "listModels"
  | "compactContext"
  | "listProviderCommands"
  | "observedOutputSpeedFor"
>;

/** The composition root's dependencies: the lifecycle's plus the model-catalog exchange. */
export type ClaudeDriverDependencies = ClaudeSessionLifecycleDependencies & {
  /**
   * The live `list_models` read backing `listModels()`. It lives here, not on the lifecycle
   * dependencies, because only this class reads it.
   */
  readonly modelCatalogExchange: ClaudeModelCatalogExchange;
};

/** The Claude provider driver: routes each contract operation to the lifecycle or dispatcher. */
export class ClaudeDriver implements ClaudeDriverOperations {
  readonly #lifecycle: ClaudeSessionLifecycle;
  readonly #interventionDispatcher: ClaudeInterventionDispatcher;
  readonly #modelCatalogExchange: ClaudeModelCatalogExchange;

  constructor(dependencies: ClaudeDriverDependencies) {
    this.#modelCatalogExchange = dependencies.modelCatalogExchange;
    this.#lifecycle = new ClaudeSessionLifecycle(dependencies);
    this.#interventionDispatcher = new ClaudeInterventionDispatcher({
      channelLookup: this.#lifecycle,
    });
  }

  /** Spawns and registers a new session; see {@link ClaudeSessionLifecycle.createSession}. */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return await this.#lifecycle.createSession(params);
  }

  /** Resumes a session by its handle; see {@link ClaudeSessionLifecycle.resumeSession}. */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return await this.#lifecycle.resumeSession(params);
  }

  /** Writes a run's opening text; see {@link ClaudeSessionLifecycle.startRun}. */
  async startRun(params: StartRunParams): Promise<void> {
    await this.#lifecycle.startRun(params);
  }

  /** Interrupts a run's turn; see {@link ClaudeSessionLifecycle.interruptRun}. */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    await this.#lifecycle.interruptRun(params);
  }

  /** Applies a steer, interrupt or cancel; see {@link ClaudeInterventionDispatcher}. */
  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return await this.#interventionDispatcher.applyIntervention(params);
  }

  /** Closes a session's channel; see {@link ClaudeSessionLifecycle.closeSession}. */
  async closeSession(params: CloseSessionParams): Promise<void> {
    await this.#lifecycle.closeSession(params);
  }

  /** Forks the conversation at a message; see {@link ClaudeSessionLifecycle.forkConversation}. */
  async forkConversation(params: ForkConversationParams): Promise<ForkConversationResult> {
    return await this.#lifecycle.forkConversation(params);
  }

  /** Probes authentication without a turn; see {@link ClaudeSessionLifecycle.probeAuth}. */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    return await this.#lifecycle.probeAuth();
  }

  /** The selectable model catalog, read live from the provider. */
  async listModels(): Promise<ProviderModel[]> {
    return await resolveClaudeModelCatalog(this.#modelCatalogExchange);
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
}
