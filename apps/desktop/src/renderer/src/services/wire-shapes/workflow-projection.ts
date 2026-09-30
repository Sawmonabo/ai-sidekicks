// The phase-model run shapes the Workflows screens read: run and phase states, gates and parks.
//
// The workflow contract describes a run as the steps of a node document, not as phases, so
// anything the two models share is imported from it rather than declared here. Consumers
// narrow a vocabulary to the subset an operation answers with (a cancel only ever answers
// `canceled`) using `Extract`, so each vocabulary keeps one home. Request shapes are not
// declared here; they move here when two views share one.

/**
 * Every run status these screens draw.
 *
 * A `gated` run reads `suspended`.
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
 * There is no `suspended` arm: the park members below separate a phase parked now from one
 * that has resumed, so the union stays coarse.
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
 * Why a phase is parked: a human-form park waits on a person, a usage-limit park waits on a
 * provider account and may carry a schedule.
 */
export const WORKFLOW_PARK_REASONS = ["waiting-human", "provider-usage-limited"] as const;

/** One park reason. Derived, so the vocabulary has exactly one home. */
export type WorkflowParkReason = (typeof WORKFLOW_PARK_REASONS)[number];

/**
 * One phase of a run, as the run read and the start reply both project it.
 *
 * `phaseRunId`, `attemptNumber` and `formRevision` may be absent from a run read. The park
 * members are live-scoped: the daemon emits them only for phases parked when the response is
 * built, so `parkReason` is the wire's park discriminator and its absence means not parked now,
 * never unknown. `prompt` and `inputSchema` ride the same rule for a `waiting-human` park; they
 * sit on the run read because a run holds one opaque version id, not the
 * `(definitionId, versionNumber)` that addresses the definition body.
 */
export interface WorkflowPhaseState {
  readonly phaseId: string;
  /** The execution instance, where the run read carries it. */
  readonly phaseRunId?: string;
  readonly attemptNumber?: number;
  readonly state: WorkflowPhaseRunState;
  readonly gateState: WorkflowGateState;
  /**
   * The optimistic-concurrency token a human-form submit carries back: 0 while the attempt has
   * no accepted submission, 1 after one. Emitted for human phases only.
   */
  readonly formRevision?: number;
  /**
   * What this phase asks, as its definition's author wrote it. Present exactly while the phase
   * is parked on a person, so the park renders from one response.
   */
  readonly prompt?: string;
  /**
   * The schema the answer is shaped by, untyped on purpose: deciding what a schema is belongs
   * to the one mapper that draws it. Present on the same rule as `prompt`.
   */
  readonly inputSchema?: unknown;
  /** Present exactly while this phase is parked; the park's wire discriminator. */
  readonly parkReason?: WorkflowParkReason;
  /** The bounded engine-authored cause. Present whenever `parkReason` is. */
  readonly parkCause?: string;
  /**
   * The armed resume instant, where the park armed one. Its absence marks the unscheduled,
   * operator-resumable kind.
   */
  readonly autoResumeAt?: string;
  /** The provider-account key concurrently parked phases group by. */
  readonly parkAttentionKey?: string;
}

/**
 * One run's header and its per-phase projection, as the run read answers.
 *
 * Park members ride on the phases only: branches park independently against different provider
 * accounts, so one run-level member could hold just one of them.
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
 * One run as the run enumeration carries it: the run read's shape plus two facts about its
 * definition.
 *
 * The enumeration answers with runs nobody named, each pinned to an opaque version id, and no
 * read maps a version id back to its definition. Without these a list can name no run and
 * cannot tell that a pin has fallen behind.
 */
export interface WorkflowRunListEntry extends WorkflowRunSnapshot {
  /** The definition this run was started from, so a row reads as more than an id. */
  readonly definitionName: string;
  /**
   * That definition's newest version id when the enumeration answered. Optional: when absent
   * the frozen-pin state is unknown and is reported as not stale, never guessed.
   */
  readonly definitionLatestWorkflowVersionId?: string;
}
