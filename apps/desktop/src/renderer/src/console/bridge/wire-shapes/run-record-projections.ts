// The two durable run records the corpus registers as COLUMNS and no read returns:
// the intervention row's origin and admitting principal, and the queue row's binding
// to a run.
//
// WHY THEY ARE WIRE SHAPES AND NOT CONSOLE VALUES. `growth-values/index.ts` draws the
// line at whether the corpus has already decided the shape. Both of these are decided:
// `interventions.origin`, `interventions.admitting_principal_id` and
// `interventions.pii_payload` are durable columns with a stated requiredness rule, and
// `queue_items.target_run_id` is a durable column too. What is missing is a READ — no
// method, no event payload, no schema in any code package carries either one — so the
// shape is transcribed here at the wire's edge rather than invented inside a view
// family, which is exactly the defect the growth slate exists to prevent.
//
// THE ORIGIN IS A DISCRIMINATED UNION AND NOT A STRING BESIDE AN OPTIONAL FIELD. The
// rule is that the admitting principal is required exactly on the participant arm and
// forbidden on the system arm, and a flat `{origin, admittingPrincipalId?}` cannot
// state that — it admits a participant row with no principal, which is the shape a
// renderer would then have to guess about. Encoded as a union, the guess is
// unrepresentable and the surface reads the arm rather than inferring one from an
// absent field.
//
// THE DIRECTIVE BODY IS A UNION FOR THE SAME REASON. A participant-authored directive
// rests encrypted under the authoring participant's key, so a row whose key has been
// shredded carries the audit record and no text. `{text?: string}` would make "the
// key is gone" and "the directive said nothing" the same value; two arms make them
// two facts, and the body-unavailable arm is what the surface renders its own sentence
// from.

/**
 * Who raised an intervention, with the admitting principal on the arm that has one.
 *
 * The daemon RESOLVES this at acceptance from the transport-authenticated identity —
 * it is never a client-supplied actor, and it is never inferred from an absent
 * `initiatorId`. The console renders the arm the daemon sent and derives nothing.
 */
export type GrowthInterventionOrigin =
  | { readonly kind: "participant"; readonly admittingPrincipalId: string }
  | { readonly kind: "system" };

/**
 * What a participant-authored intervention said, where the console may still read it.
 *
 * `unavailable` is not an error: the audit record survives its body, and a row whose
 * participant key has been shredded is a complete record of an intervention with an
 * unreadable directive. The console says so rather than rendering an empty string.
 */
export type GrowthInterventionDirective =
  | { readonly availability: "available"; readonly text: string }
  | { readonly availability: "unavailable" };

/**
 * The four V1 intervention types, as the durable row names them.
 *
 * Declared here rather than taken from `@ai-sidekicks/contracts`, which deliberately
 * ships no `InterventionType` union: the request payload is a discriminated union and
 * the type is read off its arm. A durable HISTORY row has no arm to read, so the
 * closed set is stated once, here, and a fifth member fails the build rather than
 * rendering under whichever label a fallback picked.
 */
export type GrowthInterventionKind = "steer" | "interrupt" | "cancel" | "rollback";

/**
 * One durable intervention, as the run's record holds it.
 *
 * NEWEST LAST is the list's rule and not this shape's: the read returns the daemon's
 * own order and the console renders it, matching the ledger's reading direction.
 */
export interface GrowthInterventionRecord {
  readonly interventionId: string;
  readonly runId: string;
  readonly interventionKind: GrowthInterventionKind;
  /** The six-member `InterventionState`, spelled by the shipped contract. */
  readonly state: string;
  readonly origin: GrowthInterventionOrigin;
  readonly directive: GrowthInterventionDirective;
  /**
   * The queue item this intervention admitted, where it admitted one.
   *
   * The row-anchored linkage, so a drained replacement resolves ONE admitting row
   * rather than a scan of the history. Absent where the intervention admitted no
   * queue item, which is every intervention that is not a send.
   */
  readonly admittedQueueItemId?: string;
  /** Verbatim on a `rejected` row, absent everywhere else. */
  readonly rejectionReason?: string;
  readonly requestedAt: string;
}

/**
 * One queue row's binding to a run.
 *
 * A row with no binding has NO ENTRY rather than an entry carrying a null: the durable
 * column is nullable, and an entry naming a queue item and no run would say the daemon
 * answered about that row and named nothing, which is a different claim from the row
 * being unbound.
 */
export interface GrowthQueueItemRunBinding {
  readonly queueItemId: string;
  readonly targetRunId: string;
}
