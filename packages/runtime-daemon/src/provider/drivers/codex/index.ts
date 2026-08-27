// Codex driver — entry point (Plan-005 Phase 3, T3.1 + T3.2).
//
// Composes the two collaborators this chunk owns and exposes them behind the
// slice of `ProviderDriver` they implement:
//
//   * `CodexLifecycleManager` (T3.1) — `createSession`, `resumeSession`,
//     `startRun`, `interruptRun`, `closeSession`.
//   * `CodexInterventionDispatcher` (T3.2) — `applyIntervention`.
//
// `implements Pick<ProviderDriver, ...>` rather than a hand-written interface, so
// each signature is checked against the canonical contract and drifts with it. The
// remaining operations of the 14-op surface (`getCapabilities`, `listModels`,
// `listModes`, `probeAuth`, `rollbackTo`, `respondToRequest`, `setSessionGoal`,
// `clearSessionGoal`) are authored by the sibling Phase-3 tasks; this class is
// widened to the full `ProviderDriver` when they land, which the `Pick` makes a
// purely additive edit.
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
  CloseSessionParams,
  CreateSessionParams,
  DriverInterventionResult,
  DriverResumeResult,
  InterruptRunParams,
  ProviderDriver,
  ProviderSessionHandle,
  ResumeSessionParams,
  StartRunParams,
} from "@ai-sidekicks/contracts";

import { CodexInterventionDispatcher, type CodexCapabilitySnapshotReader } from "./intervention.js";
import { CodexLifecycleManager, type CodexLifecycleOptions } from "./lifecycle.js";

export {
  CodexAppServerConnection,
  CodexDriverConfigError,
  CodexLifecycleManager,
  CodexLineTooLongError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexTransportError,
  CODEX_APP_SERVER_BIN_ENV_VAR,
  CODEX_APP_SERVER_READY_SENTINEL,
  CODEX_APP_SERVER_SHELL_PRELUDE,
  CODEX_DEFAULT_EXECUTABLE_PATH,
  CODEX_MAX_LINE_LENGTH,
  normalizeProviderFailureDetail,
  parseCodexRunConfig,
  parseCodexSessionConfig,
  type CodexConnectionOptions,
  type CodexDiagnosticSink,
  type CodexLifecycleOptions,
  type CodexPtySessionListeners,
  type CodexPtySessionSubscriber,
  type CodexRunConfig,
  type CodexScheduleTimeout,
  type CodexServerNotificationSink,
  type CodexSessionConfig,
  type CodexTransportDiagnostic,
} from "./lifecycle.js";

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
> {
  readonly #lifecycle: CodexLifecycleManager;
  readonly #interventions: CodexInterventionDispatcher;

  constructor(options: CodexDriverOptions) {
    this.#lifecycle = new CodexLifecycleManager(options);
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
}
