// The console's declaration of the workflow plane's read shapes.
//
// OWNER. `Spec-017 §Interfaces And Contracts` owns the definition, run, gate,
// phase-output, and human-form operations; `Spec-017 §Operator run control (SA-45)`
// owns the cancel and resume pair. The typed request and reply shapes are registered
// in `docs/architecture/contracts/api-payload-contracts.md` §Plan-017, and every
// vocabulary below is transcribed from that section rather than re-derived from the
// spec's prose — the spec states the rules and that section fixes the spellings.
//
// WHY THE CONSOLE DECLARES IT AT ALL. None of it is registered in any code package:
// there is no `workflow` root in the daemon method union, no `SidekicksBridge`
// namespace naming one, and no phase or run type anywhere under `packages/`. A run
// pane or a builder built against a shape that exists nowhere would have to invent
// it inside a view family, which is what the growth slate exists to prevent — so the
// shapes are declared here, on the substrate, behind the `workflow-run-control`
// slate row, and every call goes through the growth port.
//
// DELETION OBLIGATION. When `packages/contracts` registers these types, this module
// is DELETED and `growth-signatures/workflows.ts` imports them from the contracts
// instead. The slate row leaves `growth-slate.ts` and `Plan-023 §Console growth slate`
// in the same PR, and `failure-modes.test.ts` then fails on the port entries that still
// claim fixture-only — which is the reminder this file wants at that moment.
//
// WHY THE VOCABULARIES ARE TUPLES AND THE NARROWINGS ARE NOT. Four of the five
// operations that answer with a state answer with a SUBSET of one of these unions —
// a successful cancel is only ever `cancelled`, a start is only ever `pending` or
// `running`. Those subsets are derived in `growth-signatures/workflows.ts` with
// `Extract`, so the
// full vocabulary keeps exactly one home here and a narrowing cannot quietly become
// a second spelling of it.
//
// WHAT IS DELIBERATELY NOT HERE. The request shapes. They are stated inline in
// `growth-signatures/`'s table beside every other operation's, because a
// request is read once at its call site and a named type per request would be nine
// declarations with one reader each. A request shape comes here the day two surfaces
// share one.

/**
 * Every run status, in the owning contract's DDL order.
 *
 * Closed and declared once: the registered response comments bind this union in
 * lockstep with the `workflow_runs.status` CHECK, so a seventh status is an
 * amendment to the owning document and never a string a console module invents. A
 * `gated` run reads `suspended` on the wire as on disk.
 */
export const WORKFLOW_RUN_STATES = [
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
] as const;

/** One run status. Derived, so the vocabulary has exactly one home. */
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

/**
 * Every phase-run status, in the owning contract's order.
 *
 * Deliberately NOT widened with a `suspended` arm. The park surface below is what
 * separates a phase parked right now from one that has resumed past its park, and
 * the owning document keeps this union coarse on purpose — a reader switching on
 * five values stays correct while the park members carry the finer fact.
 */
export const WORKFLOW_PHASE_RUN_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;

/** One phase-run status. Derived, so the vocabulary has exactly one home. */
export type WorkflowPhaseRunState = (typeof WORKFLOW_PHASE_RUN_STATES)[number];

/** Every gate state a phase projection reports. */
export const WORKFLOW_GATE_STATES = ["closed", "open", "bypassed"] as const;

/** One gate state. Derived, so the vocabulary has exactly one home. */
export type WorkflowGateState = (typeof WORKFLOW_GATE_STATES)[number];

/**
 * Why a phase is parked. Two values, and the difference is what an operator does
 * next: a human-form park waits on a person, a usage-limit park waits on a provider
 * account and may carry a schedule.
 */
export const WORKFLOW_PARK_REASONS = ["waiting-human", "provider-usage-limited"] as const;

/** One park reason. Derived, so the vocabulary has exactly one home. */
export type WorkflowParkReason = (typeof WORKFLOW_PARK_REASONS)[number];

/**
 * The three definition scopes, most specific first — which is also the order the
 * registered enumeration resolves them in.
 */
export const WORKFLOW_DEFINITION_SCOPES = ["session", "project", "shared"] as const;

/** One definition scope. Derived, so the vocabulary has exactly one home. */
export type WorkflowDefinitionScope = (typeof WORKFLOW_DEFINITION_SCOPES)[number];

/**
 * One phase of a run, as the run read and the start reply both project it.
 *
 * The optional members are optional on the wire for two different reasons and the
 * console must not collapse them. `phaseRunId`, `attemptNumber`, and `formRevision`
 * are additive-optional on an already-published shape, so their absence means an
 * older daemon. The four park members are LIVE-SCOPED: a daemon emits them for
 * exactly those phases parked at the moment the response is built and emits none of
 * them for a phase that is not — so `parkReason`'s presence is the wire's park
 * discriminator, and its absence means this phase is not parked NOW rather than that
 * it never was. A surface that read absence as "unknown" would show a resumed phase
 * as still waiting.
 */
export interface WorkflowPhaseState {
  readonly phaseId: string;
  /** The execution instance. Absent from daemons below the contract revision. */
  readonly phaseRunId?: string;
  readonly attemptNumber?: number;
  readonly state: WorkflowPhaseRunState;
  readonly gateState: WorkflowGateState;
  /**
   * The optimistic-concurrency token a human-form submit carries back: 0 while the
   * attempt has no accepted submission, 1 after one. Emitted for human phases only.
   */
  readonly formRevision?: number;
  /** Present exactly while this phase is parked; the park's wire discriminator. */
  readonly parkReason?: WorkflowParkReason;
  /** The bounded engine-authored cause. Present whenever `parkReason` is. */
  readonly parkCause?: string;
  /**
   * The armed resume instant, where the park armed one. Its absence narrows the park
   * to the unscheduled, operator-resumable kind rather than denying it.
   */
  readonly autoResumeAt?: string;
  /** The provider-account key concurrently parked phases group by. */
  readonly parkAttentionKey?: string;
}

/**
 * One run's header and its per-phase projection, as the run read answers.
 *
 * The park surface rides on the phases and nowhere else: branches park
 * independently against different provider accounts, so a run-level park member
 * could hold only one of them. The run's `suspended` state says that something is
 * parked and the phase states say what and why.
 */
export interface WorkflowRunSnapshot {
  readonly workflowRunId: string;
  readonly sessionId: string;
  readonly workflowVersionId: string;
  readonly state: WorkflowRunState;
  readonly phaseStates: readonly WorkflowPhaseState[];
  /** Preserved on any bound breach; also carries the cancellation reason. */
  readonly failureReason?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
}

/**
 * One entry of the definition enumeration.
 *
 * `latestWorkflowVersionId` is the opaque server-minted reference a run start
 * accepts verbatim; `latestVersionNumber` stays beside it because a version read
 * addresses by number instead. A client passes both through and synthesizes
 * neither — no delimiter or encoding over the pair exists on the wire.
 */
export interface WorkflowDefinitionSummary {
  readonly id: string;
  readonly name: string;
  readonly scope: WorkflowDefinitionScope;
  /**
   * Scope identity: the authoring session's id at `session`, the resolved repository
   * root at `project`, the empty string at `shared`, which is daemon-wide and refers
   * to nothing narrower.
   */
  readonly scopeRef: string;
  readonly latestVersionNumber: number;
  readonly latestWorkflowVersionId: string;
  readonly contentHash: string;
  /**
   * True for the one entry per name that most-specific-first resolution would
   * actually pick from the caller's context, so a picker can show which definition a
   * run would use rather than re-deriving the order itself.
   */
  readonly resolvesAtThisContext: boolean;
  readonly createdAt: string;
}

/**
 * One durable output of a completed or failed phase.
 *
 * `valueKind` is additive-optional: set means the output is an artifact reference,
 * unset on a daemon at this contract revision means inline, and absent from an older
 * daemon, where the presence of `artifactId` is the fallback reading.
 */
export interface WorkflowPhaseOutput {
  readonly valueKind?: "inline" | "artifact_ref";
  readonly artifactId?: string;
  readonly summary: string;
  readonly producedAt: string;
}
