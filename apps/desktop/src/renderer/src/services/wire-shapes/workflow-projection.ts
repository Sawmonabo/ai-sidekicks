// The phase-model run shapes that today's Workflows screens read: run and phase states,
// gates and parks.
//
// NO CONTRACT COUNTERPART. The workflow contract in `packages/contracts` describes a run
// as the steps of a node document, not as phases, and the screens that read these shapes
// still draw phases. What the two models share (the scope, the definition summary, the
// version chain) is imported from the contract, never declared here.
//
// WHY THE VOCABULARIES ARE TUPLES AND THE NARROWINGS ARE NOT. An operation that
// answers with a state can answer with a SUBSET of one of these unions — a successful
// cancel is only ever `canceled`, a start is only ever `pending` or `running`. Such a
// subset is derived with `Extract`, so the full vocabulary keeps exactly one home here
// and a narrowing cannot quietly become a second spelling of it.
//
// WHAT IS DELIBERATELY NOT HERE. The request shapes. A request is read once at its
// call site, and a named type per request would be a declaration with one reader. A
// request shape comes here the day two views share one.

/**
 * Every run status these screens draw.
 *
 * Closed and declared once, so a seventh status is one edit here and never a string a
 * console module invents. A `gated` run reads `suspended`.
 */
export const WORKFLOW_RUN_STATES = [
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "canceled",
] as const;

/** One run status. Derived, so the vocabulary has exactly one home. */
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

/**
 * Every phase-run status these screens draw.
 *
 * Deliberately NOT widened with a `suspended` arm. The park members below are what
 * separate a phase parked right now from one that has resumed past its park, so the
 * union stays coarse — a reader switching on five values stays correct while the park
 * members carry the finer fact.
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
 * One phase of a run, as the run read and the start reply both project it.
 *
 * The optional members are optional for different reasons and the console must not
 * collapse them. `phaseRunId`, `attemptNumber` and `formRevision` may be absent from a
 * run read. The four park members are LIVE-SCOPED: a daemon emits them for
 * exactly those phases parked at the moment the response is built and emits none of
 * them for a phase that is not — so `parkReason`'s presence is the wire's park
 * discriminator, and its absence means this phase is not parked NOW rather than that
 * it never was. A view that read absence as "unknown" would show a resumed phase
 * as still waiting.
 *
 * `prompt` and `inputSchema` are live-scoped to the human park, because what a phase
 * asks is a question only while somebody is being asked it. They ride the park
 * discriminator rather than a presence rule of their own: emitted for exactly those phases
 * whose `parkReason` is `waiting-human` when the response is built, and for no other
 * phase, so a phase that has answered its form carries neither. They sit on the run
 * read because the definition body that holds a human phase's prompt and schema is addressed
 * by `(definitionId, versionNumber)`, which a run holding one opaque version id has
 * neither half of.
 */
export interface WorkflowPhaseState {
  readonly phaseId: string;
  /** The execution instance, where the run read carries it. */
  readonly phaseRunId?: string;
  readonly attemptNumber?: number;
  readonly state: WorkflowPhaseRunState;
  readonly gateState: WorkflowGateState;
  /**
   * The optimistic-concurrency token a human-form submit carries back: 0 while the
   * attempt has no accepted submission, 1 after one. Emitted for human phases only.
   */
  readonly formRevision?: number;
  /**
   * What this phase asks, as its definition's author wrote it.
   *
   * Present exactly while the phase is parked on a person. Carried on the run read
   * rather than resolved from the definition, because the park is renderable from ONE
   * response and a prompt fetched separately would be the second call that rule exists
   * to remove.
   */
  readonly prompt?: string;
  /**
   * The schema the answer is shaped by, untyped on purpose.
   *
   * `unknown` rather than a JSON Schema type, for the reason the definition-side reader
   * gives: deciding what a schema IS belongs to the one mapper that draws it, and its
   * fallback is what covers everything it is not. A narrowing here would be that
   * decision made twice, with only one of the two able to say why it went the way it
   * did. Present on the same rule as `prompt`.
   */
  readonly inputSchema?: unknown;
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
 * The park members ride on the phases and nowhere else: branches park
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
 * One run as the run ENUMERATION carries it: the run read's shape, plus the two
 * facts about the definition it was started from.
 *
 * WHY THE ENUMERATION CARRIES THEM AND THE RUN READ DOES NOT. `workflow.runRead`
 * addresses one run by an id the caller already holds — a caller that got that id
 * from a definition already knows which definition it came from. An enumeration has
 * no such caller: it answers with runs nobody named, each pinned to an opaque
 * version id, and no read maps a version id back to its definition
 * (`workflow.versionRead` addresses by `(definitionId, versionNumber)`, and the
 * definition enumeration carries only each definition's LATEST version). So a run
 * list built on the read's shape alone can name no run and can never tell that a
 * pin has fallen behind — which is the one condition an operator repairs.
 */
export interface WorkflowRunListEntry extends WorkflowRunSnapshot {
  /** The definition this run was started from, so a row reads as more than an id. */
  readonly definitionName: string;
  /**
   * That definition's newest version id at the moment the enumeration answered.
   *
   * Optional: a daemon that does not send it leaves the
   * frozen-pin state UNKNOWN, and unknown is reported as not-stale rather than
   * guessed — claiming a run is current is a smaller error than claiming it is stale
   * and inviting a repair the daemon would refuse.
   */
  readonly definitionLatestWorkflowVersionId?: string;
}
