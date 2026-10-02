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
  DriverCompactionResult,
  DriverInterventionResult,
  InterruptRunParams,
  ProviderCommandListResult,
  ProviderModel,
} from "@ai-sidekicks/contracts";

import { resolveCodexModelCatalog, type CodexModelCatalogExchange } from "./capabilities.js";
import { CodexInterventionDispatcher, type CodexCapabilitySnapshotReader } from "./intervention.js";
import { CodexDriverConfigError } from "./session-errors.js";
import { CodexLifecycleManager } from "./lifecycle.js";
import {
  resolveCodexTransportSelection,
  type CodexTransportSelection,
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
  DriverTransportConfig,
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
  CODEX_APP_SERVER_SHELL_ARGV0,
  CODEX_APP_SERVER_SHELL_PRELUDE,
  composeCodexTransportArgv,
  type CodexTransportSelection,
  type CodexWebsocketBearerCredential,
} from "./transport-selection.js";
export {
  CODEX_MAX_LINE_LENGTH,
  type CodexServerRequestDecision,
  type CodexSessionServerRequestResponder,
} from "./server-requests.js";
export {
  describeCodexPostureDivergence,
  parseCodexSessionConfig,
  type CodexSessionConfig,
} from "./session-config.js";
export { type CodexCredentialEnvPolicyResolver } from "./session-state.js";
export {
  type CodexPtySessionListeners,
  type CodexPtySessionSubscriber,
  type CodexScheduleTimeout,
  type CodexTransportDiagnostic,
} from "./transport-diagnostics.js";

// Only the model-catalog symbols: `listModels` is the one operation from `./capabilities.ts`.
export { type CodexModelCatalogExchange } from "./capabilities.js";

export { CodexInterventionDispatcher, CODEX_INTERVENTION_FALLBACK_ACTION } from "./intervention.js";

/** Construction inputs for the Codex driver. */
export interface CodexDriverOptions extends CodexLifecycleOptions {
  /** Read live at every intervention dispatch. */
  readonly readCapabilities: CodexCapabilitySnapshotReader;
  /**
   * The driver-registry transport config. Absent means `stdio`; a present config selects
   * `unix-socket` or `websocket`. Resolved once at construction, so every connection this driver
   * opens gets the same selection.
   */
  readonly transportConfig?: DriverTransportConfig | undefined;
  /** The live `model/list` read backing `listModels()`. */
  readonly modelCatalogExchange: CodexModelCatalogExchange;
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
> {
  readonly #lifecycle: CodexLifecycleManager;
  readonly #interventions: CodexInterventionDispatcher;
  readonly #modelCatalogExchange: CodexModelCatalogExchange;

  readonly #transportSelection: CodexTransportSelection;

  constructor(options: CodexDriverOptions) {
    this.#modelCatalogExchange = options.modelCatalogExchange;
    // Selection first: a misconfigured transport fails construction, not the first session.
    this.#transportSelection = resolveCodexTransportSelection(options.transportConfig);
    if (this.#transportSelection.transport === "websocket") {
      if (options.resolveBearerCredential === undefined) {
        throw new CodexDriverConfigError(
          "A websocket transport is configured but no bearer-credential resolver was injected; refusing to register a driver that would start an unauthenticated listener.",
          "DriverTransportConfig.bearerTokenRef",
        );
      }
      if (options.websocketConnector === undefined) {
        throw new CodexDriverConfigError(
          "A websocket transport is configured but no transport connector was injected; refusing to register a driver that would silently reach a different process.",
          "DriverTransportConfig.endpoint",
        );
      }
    }
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

  /** The transport this driver reaches its provider processes over. */
  get transportSelection(): CodexTransportSelection {
    return this.#transportSelection;
  }
}
