// ClaudeDriver — the Claude provider driver entry point (Plan-005 Phase 3, T3.6).
//
// Composition root for the Claude leg: it owns no logic of its own, binding the
// lifecycle band (T3.6, `lifecycle.ts`) and the intervention band (T3.7,
// `intervention.ts`) into the shape the daemon's `ProviderRegistry` registers.
// The two bands are coupled through exactly one narrow port —
// `ClaudeRunChannelLookup` — so the dispatcher can find the channel a run is
// bound to without reaching into session state it must not mutate.
//
// WHY `Pick<ProviderDriver, ...>` AND NOT `implements ProviderDriver`. This class
// implements FOURTEEN of the contract's EIGHTEEN operations — both figures
// counted from `ClaudeDriverOperations` below and from the `ProviderDriver`
// members themselves rather than carried forward from an earlier revision, since
// each side of that subtraction has moved three times this phase. The four still
// absent — `respondToRequest`, `listModes`, `getCapabilities`,
// `exportTranscript` — are authored by sibling Phase-3 tasks
// (T3.8 capabilities / modes, T3.14 interactive requests, T3.19 the
// canonical-transcript export). `listModels` left that list
// with T3.12's currency duty (C-8), `compactContext` / `listProviderCommands`
// with T3.26's console-parity surfaces, and `replayTranscript` with T3.20's
// replay leg and post-replay assertion. The enumeration is re-derived from the
// type argument rather than restated, so it cannot drift from what this class
// implements. Declaring the full interface today would force
// throwing stubs into the driver, and a driver that answers a contract operation
// by throwing is indistinguishable from one whose provider refused — the exact
// conflation I-005-2 and I-005-4 exist to prevent. The `Pick` binds every
// signature this class DOES implement to the contract with zero drift, so
// widening to the full `ProviderDriver` when the sibling bands land is purely
// additive: change the type argument, add the methods, and any drift becomes a
// compile error rather than a runtime surprise.

import type {
  ApplyInterventionParams,
  ClearSessionGoalParams,
  CloseSessionParams,
  CompactContextParams,
  CreateSessionParams,
  DriverAuthProbeResult,
  DriverCompactionResult,
  DriverGoalResult,
  ListProviderCommandsParams,
  ProviderCommandListResult,
  DriverInterventionResult,
  DriverResumeResult,
  DriverRollbackResult,
  InterruptRunParams,
  DriverTranscriptReplayResult,
  ProviderDriver,
  ReplayTranscriptParams,
  ProviderModel,
  ProviderOutputSpeedState,
  ProviderSessionHandle,
  ResumeSessionParams,
  RollbackToParams,
  SessionId,
  SetSessionGoalParams,
  StartRunParams,
} from "@ai-sidekicks/contracts";

import { resolveClaudeModelCatalog, type ClaudeModelCatalogExchange } from "./capabilities.js";
import { ClaudeInterventionDispatcher } from "./intervention.js";
import { ClaudeSessionLifecycle, type ClaudeSessionLifecycleDependencies } from "./lifecycle.js";

// Curated rather than `export *`: this barrel is the driver's public surface, and
// a star re-export would enlist every future symbol added to either band
// automatically — the surface would grow by accident instead of by decision. The
// rule is that whoever widens `ClaudeDriverOperations` toward the full
// `ProviderDriver` surface adds their exports alongside the operations that
// consume them, so the barrel never advertises a capability the driver object
// cannot yet serve. `capabilities.ts` is therefore enlisted for its model-catalog
// symbols ONLY — they ride `listModels`, which this driver now serves — and the
// declaration, refresh, and probe symbols of that module stay unexported here
// because no operation on this class serves them. `tools.ts` stays fully absent.
export {
  CLAUDE_DECLARED_MODEL_CATALOG,
  ClaudeModelCatalogUnreadableError,
  normalizeClaudeModelCatalog,
  resolveClaudeModelCatalog,
  type ClaudeModelCatalogExchange,
} from "./capabilities.js";
export {
  ClaudeInterventionDispatcher,
  CLAUDE_STEER_FALLBACK_ACTION,
  type ClaudeInterventionDispatcherDependencies,
} from "./intervention.js";
export {
  ClaudeAuthenticationRequiredError,
  ClaudeControlRequestRefusedError,
  ClaudeSessionLifecycle,
  ClaudeSessionUnavailableError,
  ClaudeSubagentConcurrencyGate,
  CLAUDE_CALLBACK_MCP_SERVER_NAME,
  CLAUDE_COMPACTION_WAIT_MS,
  CLAUDE_SUBAGENT_MAX_DEPTH_CEILING,
  composeClaudeCallbackMcpServer,
  composeClaudeProviderToolName,
  composeClaudeSandboxSettings,
  realizeClaudeSubagentPolicy,
  type ClaudeCallbackMcpServerDescriptor,
  type ClaudeChannelDisposalReason,
  type ClaudeControlRequest,
  type ClaudeControlRequestRefusedFields,
  type ClaudeControlResponse,
  type ClaudeCompactionBoundaryObservation,
  type ClaudeHandshakeDeclaration,
  type ClaudeInboundFrameObservation,
  type ClaudeInterruptControlRequest,
  type ClaudeResumedSessionAttachment,
  type ClaudeRewoundSessionAttachment,
  type ClaudeSandboxSettings,
  type ClaudeRunChannelLookup,
  type ClaudeRunDispatch,
  type ClaudeRunDispatchResolver,
  type ClaudeSessionAttachment,
  type ClaudeSessionChannel,
  type ClaudeSessionLifecycleDependencies,
  type ClaudeSessionResumeRequest,
  type ClaudeSessionRewindRequest,
  type ClaudeSessionSpawnRequest,
  type ClaudeSessionTransport,
  type ClaudeSessionUnavailableContext,
  type ClaudeSessionUnavailableFields,
  type ClaudeSessionUnavailableReason,
  type ClaudeSpawnBoundLegs,
  type ClaudeSubagentAdmissionPort,
  type ClaudeSubagentPolicyRealization,
  type ClaudeSubagentSlotRelease,
  type ClaudeUserTextDelivery,
  type ClaudeUserTextFrame,
  type ClaudeUserTextWriteAttempt,
  type ClaudeWithheldSubagentDefinition,
} from "./lifecycle.js";

// The operations this driver owns, named once so the class declaration, the
// header count, and any consumer assertion read from the same list.
export type ClaudeDriverOperations = Pick<
  ProviderDriver,
  | "createSession"
  | "resumeSession"
  | "startRun"
  | "interruptRun"
  | "applyIntervention"
  | "closeSession"
  | "rollbackTo"
  | "setSessionGoal"
  | "clearSessionGoal"
  | "probeAuth"
  | "listModels"
  | "compactContext"
  | "listProviderCommands"
  | "replayTranscript"
>;

export type ClaudeDriverDependencies = ClaudeSessionLifecycleDependencies & {
  /**
   * The live `list_models` read backing `listModels()` (T3.12 C-8), or an
   * EXPLICIT `null` for a composition that binds none — in which case the
   * driver answers the provenance-stamped declaration in `./capabilities.ts`.
   *
   * REQUIRED, on the reasoning that makes the capability probe a required
   * dependency of `ClaudeCapabilityReporter`: an optional arm would let a
   * construction site that simply never bound it reach the declaration by
   * accident rather than by decision, and a stale catalog served as though it
   * were a reading is exactly the confusion the detection-source doctrine
   * exists to prevent.
   *
   * Declared HERE rather than on `ClaudeSessionLifecycleDependencies` because
   * the lifecycle band neither reads nor needs it: `listModels` is served by
   * this composition root, so widening the lifecycle's dependency set would
   * hand a band a dependency it has no use for.
   *
   * NO PRODUCTION IMPLEMENTATION EXISTS YET, and that is a recorded residual
   * rather than an oversight: no composition root constructs this driver, so
   * there is no live control-request channel for the read to ride. The exchange
   * binds when the first composition root lands.
   */
  readonly modelCatalogExchange: ClaudeModelCatalogExchange | null;
};

export class ClaudeDriver implements ClaudeDriverOperations {
  readonly #lifecycle: ClaudeSessionLifecycle;
  readonly #interventionDispatcher: ClaudeInterventionDispatcher;
  readonly #modelCatalogExchange: ClaudeModelCatalogExchange | null;

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

  async rollbackTo(params: RollbackToParams): Promise<DriverRollbackResult> {
    return await this.#lifecycle.rollbackTo(params);
  }

  async setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#lifecycle.setSessionGoal(params);
  }

  async clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return await this.#lifecycle.clearSessionGoal(params);
  }

  async probeAuth(): Promise<DriverAuthProbeResult> {
    return await this.#lifecycle.probeAuth();
  }

  /**
   * The selectable model catalog (T3.12 C-8).
   *
   * Delegates rather than deciding: `./capabilities.ts` owns both the declared
   * catalog and the normalization of a live reply, so the wire shape and its
   * provenance stamp sit in one place and this class stays a composition root.
   */
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
   * Reconstitutes the canonical transcript into a fresh provider session (T3.20).
   *
   * Refuses on every build published at this pin, and that is the declared
   * answer rather than a stub: `Spec-005`'s Claude `transcript_replay` cell is
   * probe-valued, the probe finds no seeding surface, and reconstitution settles
   * on the memo floor reported `degraded`. See the lifecycle method for why the
   * whole leg ships behind that probe rather than as an unconditional throw.
   */
  async replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult> {
    return await this.#lifecycle.replayTranscript(params);
  }

  /**
   * The output-speed state this session's binding HELD from the provider's own
   * handshake, or `undefined` where the binding holds none (T3.26).
   *
   * BESIDE the contract operations, not among them: it is deliberately absent
   * from `ClaudeDriverOperations`, so the thirteen-of-eighteen count in this
   * file's header still reads from that `Pick` and does not move. Widening
   * `ProviderDriver` for it would mint an eighteenth-plus operation on a
   * censused surface for a read only one of the two drivers can answer — the
   * sibling provider publishes no speed axis at all — and a contract operation
   * the other driver must stub is exactly the throwing-stub conflation the
   * header rejects.
   *
   * It exists as a public method because the alternative is that the state has
   * NO reader: `#lifecycle` is private, this class is what `ProviderRegistry`
   * hands a caller, and a held observation reachable only from the band's own
   * tests is a read-back the driver promises and cannot serve. Delegation only
   * — the band owns the parse, the diagnostic, and the fail-closed absent
   * answer, and this composition root adds no second reading of any of them.
   */
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined {
    return this.#lifecycle.observedOutputSpeedFor(sessionId);
  }
}
