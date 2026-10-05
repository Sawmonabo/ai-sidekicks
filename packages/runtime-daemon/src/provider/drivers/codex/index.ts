/**
 * Codex driver entry point: composes `CodexLifecycleManager` (sessions, runs, fork, goals,
 * compaction, provider commands) and `CodexInterventionDispatcher` behind the slice of
 * `ProviderDriver` they implement.
 *
 * No operation is capability-gated here. The registry's `checkCapability` is the static refusal
 * and reads the snapshot captured at registration; a second gate in this class would read a live
 * snapshot and could disagree with the one that already admitted the call.
 *
 * `implements Pick<ProviderDriver, ...>` checks each signature against the canonical contract. The
 * operations the `Pick` omits (`respondToRequest`, `listModes`, `getCapabilities`) are not
 * implemented by this class.
 *
 * The capability snapshot is injected and read live at each dispatch, so a refreshed capability
 * record is honored. The process substrate (`PtyHost`), the per-session subscription, the timeout
 * scheduler and the binding-id minter are injected too: the composition root owns lifetimes and
 * identity, and tests drive the real code through fakes.
 */

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

import { resolveCodexModelCatalog, type CodexModelCatalogExchange } from "./capabilities.js";
import { CodexInterventionDispatcher, type CodexCapabilitySnapshotReader } from "./intervention.js";
import { CodexLifecycleManager } from "./lifecycle.js";
import {
  resolveCodexTransportSelection,
  type CodexTransportSelection,
  type DriverTransportConfig,
} from "./transport-selection.js";
import { type CodexLifecycleOptions } from "./session-state.js";
import type {
  ClearSessionGoalParams,
  CloseSessionParams,
  CompactContextParams,
  CreateSessionParams,
  DriverAuthProbeResult,
  DriverResumeResult,
  ForkConversationResult,
  ListProviderCommandsParams,
  ProviderDriver,
  ProviderSessionHandle,
  ResumeSessionParams,
  ForkConversationParams,
  SetSessionGoalParams,
  DriverGoalResult,
  StartRunParams,
} from "../../provider-driver.js";

export { CodexAppServerConnection } from "./app-server-connection.js";
export {
  CodexDriverConfigError,
  CodexLineTooLongError,
  CodexSessionAlreadyLiveError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexRewindBoundaryUnsupportedError,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "./session-errors.js";
export { CodexLifecycleManager } from "./lifecycle.js";
export {
  CODEX_APP_SERVER_READY_SENTINEL,
  type CodexTransportSelection,
} from "./transport-selection.js";
export {
  CODEX_MAX_LINE_LENGTH,
  type CodexServerRequestDecision,
  type CodexSessionServerRequestResponder,
} from "./server-requests.js";
export { parseCodexSessionConfig, type CodexSessionConfig } from "./session-config.js";
export { type CodexCredentialEnvPolicyResolver } from "./session-state.js";
export {
  type CodexPtySessionListeners,
  type CodexPtySessionSubscriber,
  type CodexTransportDiagnostic,
} from "./transport-diagnostics.js";

// Only the model-catalog symbols: `listModels` is the one operation from `./capabilities.ts`.
export { type CodexModelCatalogExchange } from "./capabilities.js";

export { CodexInterventionDispatcher } from "./intervention.js";

/** Construction inputs for the Codex driver. */
export interface CodexDriverOptions extends CodexLifecycleOptions {
  /** Read live at every intervention dispatch. */
  readonly readCapabilities: CodexCapabilitySnapshotReader;
  /**
   * The driver-registry transport config, `stdio` or `unix-socket`; absent means `stdio`. Resolved
   * once at construction, so every connection this driver opens gets the same selection.
   */
  readonly transportConfig?: DriverTransportConfig | undefined;
}

/** The Codex provider driver: lifecycle operations plus intervention dispatch. */
export class CodexDriver implements Pick<
  ProviderDriver,
  | "createSession"
  | "resumeSession"
  | "startRun"
  | "interruptRun"
  | "closeSession"
  | "applyIntervention"
  | "forkConversation"
  | "setSessionGoal"
  | "clearSessionGoal"
  | "probeAuth"
  | "listModels"
  | "compactContext"
  | "listProviderCommands"
  | "observedOutputSpeedFor"
> {
  readonly #lifecycle: CodexLifecycleManager;
  readonly #interventions: CodexInterventionDispatcher;
  readonly #modelCatalogExchange: CodexModelCatalogExchange;

  readonly #transportSelection: CodexTransportSelection;

  constructor(options: CodexDriverOptions) {
    this.#modelCatalogExchange = options.modelCatalogExchange;
    // Selection first: a misconfigured transport fails construction, not the first session.
    this.#transportSelection = resolveCodexTransportSelection(options.transportConfig);
    this.#lifecycle = new CodexLifecycleManager({
      ...options,
      transportSelection: this.#transportSelection,
    });
    this.#interventions = new CodexInterventionDispatcher({
      // The manager structurally satisfies `CodexInterventionRuntime`; composing them here avoids
      // a circular import.
      runtime: this.#lifecycle,
      readCapabilities: options.readCapabilities,
    });
  }

  /** Spawns a provider process and starts a fresh thread for the session. */
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return this.#lifecycle.createSession(params);
  }

  /** Relaunches the session's process on its thread; a failure is the typed `failed` result. */
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return this.#lifecycle.resumeSession(params);
  }

  /** Starts one provider turn for the run. */
  startRun(params: StartRunParams): Promise<void> {
    return this.#lifecycle.startRun(params);
  }

  /** Interrupts the run's live turn. */
  interruptRun(params: InterruptRunParams): Promise<void> {
    return this.#lifecycle.interruptRun(params);
  }

  /** Unsubscribes and tears down the session's process; closing an unknown session resolves. */
  closeSession(params: CloseSessionParams): Promise<void> {
    return this.#lifecycle.closeSession(params);
  }

  /** Routes a steer, interrupt or cancel onto the provider, or returns `degraded`. */
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return this.#interventions.applyIntervention(params);
  }

  /** Forks the thread at a recorded turn boundary and moves the session onto the fork. */
  forkConversation(params: ForkConversationParams): Promise<ForkConversationResult> {
    return this.#lifecycle.forkConversation(params);
  }

  /** Sets the thread's goal on the provider. */
  setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    return this.#lifecycle.setSessionGoal(params);
  }

  /** Clears the thread's goal on the provider. */
  clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return this.#lifecycle.clearSessionGoal(params);
  }

  /** Asks a throwaway process whether the credential is signed in; never throws. */
  probeAuth(): Promise<DriverAuthProbeResult> {
    return this.#lifecycle.probeAuth();
  }

  /** The selectable model catalog, read live; `./capabilities.ts` owns the parsing. */
  listModels(): Promise<ProviderModel[]> {
    return resolveCodexModelCatalog(this.#modelCatalogExchange);
  }

  /** Compacts the thread's context and settles on the provider's compaction frame. */
  compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    return this.#lifecycle.compactContext(params);
  }

  /** The provider's commands and skills for the session, held until the provider signals change. */
  listProviderCommands(params: ListProviderCommandsParams): Promise<ProviderCommandListResult> {
    return this.#lifecycle.listProviderCommands(params);
  }

  /**
   * The tier the session's thread declared; see
   * {@link CodexLifecycleManager.observedOutputSpeedFor}.
   */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    return this.#lifecycle.observedOutputSpeedFor(sessionId);
  }

  /** The transport this driver reaches its provider processes over. */
  get transportSelection(): CodexTransportSelection {
    return this.#transportSelection;
  }
}
