// The diagnostics plane's values: this machine's health, one run's failure, one
// run's stall, the recovery a request performed, and the redaction policy in force.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.
//
// EVERY VOCABULARY HERE IS CLOSED, AND EVERY ONE OF THEM IS THE CORPUS'S. The three
// health states, the four redaction buckets, the three recovery actions and the two
// health signals are enumerated in `api-payload-contracts.md §Plan-020`, so this
// module transcribes rather than invents. A widened arm here would teach the
// diagnostics page a state the daemon cannot send, and the page's own tables are
// total over these sets — which is what makes a sixth arm a compile error at the
// page rather than a blank region on screen.

/** The three status categories, shared by the overall verdict and each component. */
export const GROWTH_HEALTH_STATES = ["healthy", "degraded", "blocked"] as const;

/** One such state. Derived, so the set is declared exactly once. */
export type GrowthHealthState = (typeof GROWTH_HEALTH_STATES)[number];

/** One named component of this machine's health, with its own reading. */
export interface GrowthHealthComponent {
  readonly name: string;
  readonly state: GrowthHealthState;
  readonly lastChecked: string;
  /**
   * The component's own structured detail, where it sent any.
   *
   * `unknown`-valued rather than string-valued, because the registered shape is
   * `Record<string, unknown>` and narrowing it here would be this console deciding
   * what a component may say about itself.
   */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * This machine's health: one verdict over its components, and the components.
 *
 * The verdict is the DAEMON's and is carried rather than recomputed — the page's
 * governing section forbids deriving a health verdict of its own, and a renderer
 * folding the component states into a banner would be doing exactly that.
 */
export interface GrowthHealthStatus {
  readonly overall: GrowthHealthState;
  readonly components: readonly GrowthHealthComponent[];
}

/** What actually failed on one run, told apart by class rather than by message. */
export interface GrowthFailureDetail {
  readonly runId: string;
  readonly failureCategory: string;
  readonly recoveryCondition?: string;
  readonly recoverySpanClassification?: string;
  readonly humanSummary: string;
  readonly technicalDetails: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/** Whether the daemon suspects a run has stopped moving. Closed at two. */
export const GROWTH_STUCK_RUN_SIGNALS = ["stuck-suspected", "healthy"] as const;

/** One such signal. Derived, so the set is declared exactly once. */
export type GrowthStuckRunSignal = (typeof GROWTH_STUCK_RUN_SIGNALS)[number];

/**
 * The three ways out of a stuck run, in the registered order.
 *
 * `escalate` is in this set and is NOT one of the three the recovery request takes —
 * the mutation's own vocabulary is `retry | interrupt | abandon`. That asymmetry is
 * the registered contract's and is preserved rather than smoothed: the daemon may
 * SUGGEST escalating and there is no wire to escalate on, so the page renders that
 * suggestion as guidance and offers no control for it.
 */
export const GROWTH_RECOVERY_SUGGESTIONS = ["interrupt", "retry", "escalate"] as const;

/** One such suggestion. Derived, so the set is declared exactly once. */
export type GrowthRecoverySuggestion = (typeof GROWTH_RECOVERY_SUGGESTIONS)[number];

/** The three the recovery request actually takes. A subset, and deliberately not one. */
export const GROWTH_RECOVERY_ACTIONS = ["retry", "interrupt", "abandon"] as const;

/** One such action. Derived, so the set is declared exactly once. */
export type GrowthRecoveryAction = (typeof GROWTH_RECOVERY_ACTIONS)[number];

/** One run's stall reading, as the daemon last computed it. */
export interface GrowthStuckRunInspection {
  readonly runId: string;
  readonly currentState: string;
  readonly lastProgressAt: string;
  readonly lastEventTime: string;
  readonly blockingReason?: string;
  readonly healthSignal: GrowthStuckRunSignal;
  readonly suggestedAction?: GrowthRecoverySuggestion;
}

/**
 * What a recovery request did, in the daemon's own words.
 *
 * Both states are carried because the pair is the receipt: "interrupted" alone does
 * not say whether anything moved, and a surface that re-read the run to find out
 * would be asking a second question to answer the first one's reply.
 */
export interface GrowthRecoveryReceipt {
  readonly runId: string;
  readonly previousState: string;
  readonly newState: string;
  readonly actionTaken: string;
}

/** The four diagnostic buckets, in the registered order. */
export const GROWTH_REDACTION_BUCKETS = [
  "driver_raw_events",
  "command_output",
  "tool_traces",
  "reasoning_detail",
] as const;

/** One such bucket. Derived, so the set is declared exactly once. */
export type GrowthRedactionBucket = (typeof GROWTH_REDACTION_BUCKETS)[number];

/** One bucket's effective retention, and whether raw content was opted into. */
export interface GrowthRedactionBucketPolicy {
  readonly bucket: GrowthRedactionBucket;
  readonly ttlDays: number;
  readonly rawContentOptIn: boolean;
}

/**
 * The redaction policy in force, as policy STATE and never as the rule set.
 *
 * `outboundDefault` is a literal rather than a union, which is the registered shape:
 * default-deny outbound is not representable as anything else over this read, so a
 * widened member here would make a state the daemon cannot report look reachable.
 */
export interface GrowthRedactionPolicy {
  readonly buckets: readonly GrowthRedactionBucketPolicy[];
  readonly outboundDefault: "deny";
  readonly retentionPolicyOverrideActive: boolean;
}
