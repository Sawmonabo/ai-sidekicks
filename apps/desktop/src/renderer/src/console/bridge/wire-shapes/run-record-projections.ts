// The two durable run records the corpus registers as COLUMNS and no read returns:
// the intervention row's admission path, and the queue row's binding to a run.
//
// WHY THEY ARE WIRE SHAPES AND NOT CONSOLE VALUES. `growth-values/index.ts` draws the
// line at whether the corpus has already decided the shape. Both of these are decided:
// `interventions.origin` and `interventions.pii_payload` are durable columns, and
// `queue_items.target_run_id` is a durable column too. What is missing is a READ — no
// method, no event payload, no schema in any code package carries either one — so the
// shape is transcribed here at the wire's edge rather than invented inside a view
// family, which is exactly the defect the growth slate exists to prevent.
//
// THE ORIGIN IS A CLOSED PAIR OF LABELS AND CARRIES NOTHING ELSE. It says which
// admission path a row came in on — the identity-carrying transport, or the in-process
// orchestration entrypoint below the wire authorization boundary — and it names nobody,
// because there is one user on a session and an admission path is not a person.
//
// THE DIRECTIVE BODY IS A UNION. A user-authored directive
// rests encrypted under the authoring user's key, so a row whose key has been
// shredded carries the audit record and no text. `{text?: string}` would make "the
// key is gone" and "the directive said nothing" the same value; two arms make them
// two facts, and the body-unavailable arm is what the surface renders its own sentence
// from.

/**
 * Which admission path an intervention came in on.
 *
 * The daemon RESOLVES this at acceptance and the column carries no default, so an
 * unstamped row never exists. The console renders the label the daemon sent and
 * derives nothing.
 */
export type GrowthInterventionOrigin = "user" | "system";

/**
 * What a user-authored intervention said, where the console may still read it.
 *
 * `unavailable` is not an error: the audit record survives its body, and a row whose
 * user key has been shredded is a complete record of an intervention with an
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
