// Codex driver — entry point (Plan-005 Phase 3, T3.1 + T3.2).
//
// Composes the two collaborators this chunk owns and exposes them behind the
// slice of `ProviderDriver` they implement:
//
//   * `CodexLifecycleManager` (T3.1) — `createSession`, `resumeSession`,
//     `startRun`, `interruptRun`, `closeSession`.
//   * `CodexInterventionDispatcher` (T3.2) — `applyIntervention`.
//   * `CodexLifecycleManager` (T3.15) — `rollbackTo`, `setSessionGoal`,
//     `clearSessionGoal`, the three R8 parity operations whose Codex mechanism
//     is a request on the session's own connection (`thread/fork`,
//     `thread/goal/set`, `thread/goal/clear`).
//
// The three T3.15 operations are NOT capability-gated here, and that is
// deliberate rather than an omission: I-005-2's static refusal is the
// registry's `checkCapability`, which reads the snapshot captured at
// registration. A second gate in this class would read a DIFFERENT snapshot
// through `readCapabilities` — a live one — so the two could disagree about
// whether a call that already passed the gate may proceed, and the driver would
// be answering a question the registry has already answered.
//
// `implements Pick<ProviderDriver, ...>` rather than a hand-written interface, so
// each signature is checked against the canonical contract and drifts with it. The
// operations still absent from the `Pick` below (`getCapabilities`, `listModes`,
// `respondToRequest`, `exportTranscript`, `replayTranscript`) are authored by the
// sibling Phase-3 tasks; this class is widened to the full `ProviderDriver` when
// they land, which the `Pick` makes a purely additive edit. `listModels` joined
// the `Pick` with T3.12's currency duty (C-8) — the enumeration above is
// re-derived from the type argument rather than restated, so it cannot drift
// from what the class actually implements.
//
// ---------------------------------------------------------------------------
// Why every collaborator is injected
// ---------------------------------------------------------------------------
//
// The capability snapshot is read through an injected function rather than
// imported from `capabilities.ts` (T3.3). Two reasons, and the second is the real
// one: the sibling module is authored in a parallel task and importing it would
// couple two chunks at the file level, AND the snapshot must be read LIVE at each
// dispatch so a refreshed capability record is honoured — a value captured at
// construction would freeze the gate that I-005-4 depends on.
//
// The process substrate (`PtyHost`), the per-session subscription, the timeout
// scheduler, and the binding-id minter are injected for the same reason the rest
// of this package injects them (`runtime-binding-store.ts`): the composition root
// owns lifetimes and identity minting, and tests drive the real code paths through
// fakes instead of stubbing the code under test.
//
// Spec coverage: `Spec-005 §Required Behavior` (the normalized driver contract);
// `Spec-005 §Fallback Behavior` (resume-handle failure surfaces a recovery-needed
// condition).
//
// Refs: Plan-005 §Phase 3 / T3.1 + T3.2, `Spec-005 §Required Behavior`,
// `Spec-005 §Fallback Behavior`, invariants I-005-4 and I-005-5, ADR-011.

import type {
  ApplyInterventionParams,
  ClearSessionGoalParams,
  CloseSessionParams,
  CreateSessionParams,
  DriverAuthProbeResult,
  DriverGoalResult,
  DriverInterventionResult,
  DriverResumeResult,
  DriverRollbackResult,
  DriverTransportConfig,
  InterruptRunParams,
  ProviderDriver,
  ProviderModel,
  ProviderSessionHandle,
  ResumeSessionParams,
  RollbackToParams,
  SetSessionGoalParams,
  StartRunParams,
} from "@ai-sidekicks/contracts";

import { resolveCodexModelCatalog, type CodexModelCatalogExchange } from "./capabilities.js";
import { CodexInterventionDispatcher, type CodexCapabilitySnapshotReader } from "./intervention.js";
import {
  CodexDriverConfigError,
  CodexLifecycleManager,
  resolveCodexTransportSelection,
  type CodexLifecycleOptions,
  type CodexTransportSelection,
} from "./lifecycle.js";

export {
  CodexAppServerConnection,
  CodexDriverConfigError,
  CodexLifecycleManager,
  CodexLineTooLongError,
  CodexSessionAlreadyLiveError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexRewindBoundaryUnsupportedError,
  CodexTransportError,
  CODEX_APP_SERVER_BIN_ENV_VAR,
  CODEX_APP_SERVER_READY_SENTINEL,
  CODEX_APP_SERVER_SHELL_ARGV0,
  CODEX_APP_SERVER_SHELL_PRELUDE,
  CODEX_DEFAULT_EXECUTABLE_PATH,
  CODEX_MAX_LINE_LENGTH,
  CODEX_ROUTED_SERVER_REQUEST_METHODS,
  CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
  CODEX_SUPPRESSED_REALTIME_NOTIFICATION_METHODS,
  composeCodexSubagentConfigOverrides,
  composeCodexThreadPosture,
  composeCodexThreadPostureConfig,
  composeCodexTransportArgv,
  composeCodexTurnSandboxPolicy,
  describeCodexPostureDivergence,
  normalizeProviderFailureDetail,
  parseCodexRunConfig,
  parseCodexSessionConfig,
  resolveCodexTransportSelection,
  type CodexBearerCredentialResolver,
  type CodexConnectionOptions,
  type CodexCredentialEnvPolicyResolver,
  type CodexDiagnosticSink,
  type CodexLifecycleOptions,
  type CodexPtySessionListeners,
  type CodexPtySessionSubscriber,
  type CodexRequestAttempt,
  type CodexRequestDelivery,
  type CodexRewindBoundaryUnsupportedFields,
  type CodexRunConfig,
  type CodexScheduleTimeout,
  type CodexServerNotificationSink,
  type CodexServerRequestDecision,
  type CodexSessionServerRequest,
  type CodexSessionServerRequestResponder,
  type CodexSessionConfig,
  type CodexSessionSlotState,
  type CodexThreadPostureParams,
  type CodexTransportDiagnostic,
  type CodexTransportSelection,
  type CodexWebsocketBearerCredential,
  type CodexWebsocketTransportConnector,
} from "./lifecycle.js";

// The model-catalog symbols only — `listModels` is served by this class, so the
// barrel advertises exactly what the driver object can answer. The declaration,
// refresh, and probe symbols of `./capabilities.ts` stay unexported here because
// no operation on this class serves them.
export {
  CODEX_DECLARED_MODEL_CATALOG,
  CodexModelCatalogUnreadableError,
  normalizeCodexModelCatalog,
  resolveCodexModelCatalog,
  type CodexModelCatalogExchange,
} from "./capabilities.js";

export {
  CodexTerminalEmissionGate,
  type CodexTerminalEmissionDecision,
  type CodexTerminalRunFrame,
  type CodexTerminalSuppressionReason,
} from "./event-normalizer.js";

export {
  CodexInterventionDispatcher,
  CODEX_INTERVENTION_CAPABILITY_FLAGS,
  CODEX_INTERVENTION_FALLBACK_ACTION,
  type CodexCapabilitySnapshotReader,
  type CodexInterventionOptions,
  type CodexInterventionRuntime,
} from "./intervention.js";

/** Construction inputs for the Codex driver. */
export interface CodexDriverOptions extends CodexLifecycleOptions {
  /** Read live at every intervention dispatch — see the note above. */
  readonly readCapabilities: CodexCapabilitySnapshotReader;
  /**
   * The daemon driver-registry transport config (T3.15 leg 6). ABSENT is the
   * V1 default and means `stdio`; a present config selects `unix-socket` or
   * `websocket` per its discriminated shape.
   *
   * Consumed HERE, at construction, and nowhere else. Resolving it once at the
   * composition root is what makes it real configuration rather than a field
   * the registry fills in and no code path reads: every connection this driver
   * opens is handed the already-decided selection, so two connections of one
   * driver cannot disagree about which process they reach.
   */
  readonly transportConfig?: DriverTransportConfig | undefined;
  /**
   * The live `model/list` read backing `listModels()` (T3.12 C-8), or an
   * EXPLICIT `null` for a composition that binds none — in which case the
   * driver answers the provenance-stamped declaration in `./capabilities.ts`.
   *
   * REQUIRED, on the same reasoning as `resolveCredentialEnvPolicy`: an
   * optional arm would let a construction site that simply never bound it reach
   * the declaration by accident rather than by decision, and a stale catalog
   * served as though it were a reading is exactly the confusion the
   * detection-source doctrine exists to prevent.
   *
   * NO PRODUCTION IMPLEMENTATION EXISTS YET, and that is a recorded residual
   * rather than an oversight: no composition root constructs this driver, so
   * there is no live connection for the read to ride. The exchange binds when
   * the first composition root lands — beside the `resolveCredentialEnvPolicy`
   * binding, which is unimplemented for the same reason.
   */
  readonly modelCatalogExchange: CodexModelCatalogExchange | null;
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
  | "rollbackTo"
  | "setSessionGoal"
  | "clearSessionGoal"
  | "probeAuth"
  | "listModels"
> {
  readonly #lifecycle: CodexLifecycleManager;
  readonly #interventions: CodexInterventionDispatcher;
  readonly #modelCatalogExchange: CodexModelCatalogExchange | null;

  readonly #transportSelection: CodexTransportSelection;

  constructor(options: CodexDriverOptions) {
    // Selection first: a misconfigured transport fails the driver's
    // CONSTRUCTION, not its first session. A registry that accepted a
    // websocket arm with no resolver and only discovered it when a participant
    // started a run would have reported a healthy driver for the whole
    // interval in between.
    this.#modelCatalogExchange = options.modelCatalogExchange;
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
      // The manager structurally satisfies `CodexInterventionRuntime`; composing
      // them here is what keeps the two modules free of a circular import.
      runtime: this.#lifecycle,
      readCapabilities: options.readCapabilities,
    });
  }

  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return this.#lifecycle.createSession(params);
  }

  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    return this.#lifecycle.resumeSession(params);
  }

  startRun(params: StartRunParams): Promise<void> {
    return this.#lifecycle.startRun(params);
  }

  interruptRun(params: InterruptRunParams): Promise<void> {
    return this.#lifecycle.interruptRun(params);
  }

  closeSession(params: CloseSessionParams): Promise<void> {
    return this.#lifecycle.closeSession(params);
  }

  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return this.#interventions.applyIntervention(params);
  }

  rollbackTo(params: RollbackToParams): Promise<DriverRollbackResult> {
    return this.#lifecycle.rollbackTo(params);
  }

  setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    return this.#lifecycle.setSessionGoal(params);
  }

  clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return this.#lifecycle.clearSessionGoal(params);
  }

  probeAuth(): Promise<DriverAuthProbeResult> {
    return this.#lifecycle.probeAuth();
  }

  /**
   * The selectable model catalog (T3.12 C-8).
   *
   * Delegates rather than deciding: `./capabilities.ts` owns both the declared
   * catalog and the normalization of a live reply, so the wire shape and its
   * provenance stamp sit in one place and this class stays a composition root.
   */
  listModels(): Promise<ProviderModel[]> {
    return resolveCodexModelCatalog(this.#modelCatalogExchange);
  }

  /** The transport this driver reaches its provider processes over. */
  get transportSelection(): CodexTransportSelection {
    return this.#transportSelection;
  }
}
