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
  DriverCompactionResult,
  ProviderCommandListResult,
  DriverInterventionResult,
  InterruptRunParams,
  ProviderModel,
  ProviderOutputSpeedState,
  SessionId,
} from "@ai-sidekicks/contracts";

import { resolveClaudeModelCatalog, type ClaudeModelCatalogExchange } from "./capabilities.js";
import { ClaudeInterventionDispatcher } from "./intervention.js";
import { ClaudeSessionLifecycle } from "./lifecycle.js";
import { type ClaudeSessionLifecycleDependencies } from "./session-state.js";
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

  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return await this.#lifecycle.createSession(params);
  }

  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return await this.#lifecycle.resumeSession(params);
  }

  async startRun(params: StartRunParams): Promise<void> {
    await this.#lifecycle.startRun(params);
  }

  async interruptRun(params: InterruptRunParams): Promise<void> {
    await this.#lifecycle.interruptRun(params);
  }

  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return await this.#interventionDispatcher.applyIntervention(params);
  }

  async closeSession(params: CloseSessionParams): Promise<void> {
    await this.#lifecycle.closeSession(params);
  }

  async forkConversation(params: ForkConversationParams): Promise<ForkConversationResult> {
    return await this.#lifecycle.forkConversation(params);
  }

  async probeAuth(): Promise<DriverAuthProbeResult> {
    return await this.#lifecycle.probeAuth();
  }

  /** The selectable model catalog, read live from the provider. */
  async listModels(): Promise<ProviderModel[]> {
    return await resolveClaudeModelCatalog(this.#modelCatalogExchange);
  }

  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    return await this.#lifecycle.compactContext(params);
  }

  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    return await this.#lifecycle.listProviderCommands(params);
  }

  /**
   * The output-speed state this session's binding holds from the provider's handshake, or
   * `undefined` when it holds none.
   *
   * Deliberately not part of `ClaudeDriverOperations`: the other provider declares no such axis,
   * so a contract operation for it would force that driver to stub it. It is public because
   * `ProviderRegistry` hands callers this class, and the lifecycle that holds the state is private.
   * Delegation only; the lifecycle owns the parsing and the absent answer.
   */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    return this.#lifecycle.observedOutputSpeedFor(sessionId);
  }
}
