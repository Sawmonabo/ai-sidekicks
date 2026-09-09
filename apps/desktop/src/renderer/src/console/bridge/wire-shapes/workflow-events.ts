// The workflow plane's event taxonomy, as the console declares it for itself.
//
// OWNER. `Spec-017`'s SA-19 event-type enumeration names twenty-four `workflow.*`
// types across five `Spec-006` categories, and `Spec-006 §Event Type Summary` — the
// owning registry — carries no `workflow` category at all. That registration is the
// `workflow-event-registration` row on `Plan-023 §Console growth slate`, and until it
// lands `packages/contracts` registers none of these strings: `SessionEventType` does
// not admit one, and the fixture's own wire-truth predicate refuses a beat carrying
// one, because a beat of a type no daemon emits is a lie about the wire.
//
// SO WHY DECLARE THEM. Because the run pane has to say WHEN its read goes stale, and
// the console's refresh policy answers that with "the terminal events the owning spec
// names" (`Spec-023 §Rules every console surface obeys`, under "No interval polling").
// A pane that could not name those events has two options and both are wrong: poll on
// a timer, which that rule forbids outright, or re-read only when the operator at THIS
// keyboard acts — which is what the run pane did, so a run moved by another window, by
// another participant, or by the engine itself sat unchanged on screen until somebody
// pressed something.
//
// A KIND SET IS SAFE TO ARM EARLY AND A PAYLOAD SHAPE IS NOT. What this module
// declares is a set of strings compared against the `kind` of frames the session store
// already holds — `store/read/refresh-triggers.ts` types the declared set as
// `ReadonlySet<string>` for exactly this reason, since a projected frame's kind is
// whatever the wire sent. A kind no daemon emits therefore never matches and the
// reading simply refreshes on its other triggers; the day the registration lands it
// starts matching with no edit here. That is the opposite posture from a payload
// SHAPE, which a surface would read members off and be wrong about — which is why
// `workflow-projection.ts` next door carries the shapes and this file carries none.
//
// DELETION OBLIGATION. When `packages/contracts` registers the taxonomy, this module
// is DELETED and its consumers derive the set from the registered `SessionEventType`
// union instead — at which point the set becomes checkable by the compiler rather than
// by the count below. The slate row leaves `growth-slate.ts` and
// `Plan-023 §Console growth slate` in the same PR.

/**
 * `workflow_lifecycle` — the run's own arc, seven types.
 *
 * `workflow.cancelled` is the newest and is the reason the taxonomy reads 24 rather
 * than 23: a cancel appends it in the same unit of work as the status write, so a
 * projection rebuild cannot replay the last suspension and resurrect a run somebody
 * cancelled.
 */
const WORKFLOW_LIFECYCLE_EVENT_TYPES = [
  "workflow.created",
  "workflow.started",
  "workflow.gated",
  "workflow.failed",
  "workflow.completed",
  "workflow.resumed",
  "workflow.cancelled",
] as const;

/**
 * `workflow_phase_lifecycle` — one phase's arc, twelve types.
 *
 * `workflow.phase_suspended` is the park's own event and the one whose payload
 * carries the four members the run read projects live; `workflow.phase_waiting_on_pool`
 * is the diagnostic a phase blocked on `pty_slots` or `agent_memory_mb` emits.
 */
const WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES = [
  "workflow.phase_admitted",
  "workflow.phase_waiting_on_pool",
  "workflow.phase_started",
  "workflow.phase_progressed",
  "workflow.phase_cancelling",
  "workflow.phase_failed",
  "workflow.phase_retried",
  "workflow.phase_suspended",
  "workflow.phase_resumed",
  "workflow.phase_completed",
  "workflow.human_phase_claimed",
  "workflow.human_phase_escalated",
] as const;

/** `workflow_parallel_coordination` — the sibling cancel a join policy drives, one type. */
const WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES = ["workflow.parallel_join_cancellation"] as const;

/** `workflow_channel_coordination` — a phase's own channel opening and closing, three types. */
const WORKFLOW_CHANNEL_COORDINATION_EVENT_TYPES = [
  "workflow.channel_created_for_phase",
  "workflow.channel_closed_with_records_preserved",
  "workflow.channel_terminated_forcibly",
] as const;

/** `workflow_gate_resolution` — the gate chain's own extension, one type. */
const WORKFLOW_GATE_RESOLUTION_EVENT_TYPES = ["workflow.gate_resolved"] as const;

/**
 * Every `workflow.*` event type, in the owning spec's own category order.
 *
 * COMPOSED FROM THE FIVE CATEGORY TUPLES rather than written out flat, because the
 * categories are the taxonomy's own structure and a flat list would lose which type
 * belongs to which — the split the owning spec made deliberately, against one
 * monolithic `workflow_lifecycle`, so a query can be scoped. The five tuples are
 * module-private: nothing outside this file has asked a question about one category,
 * and a door line per category would be five exports with no reader.
 */
export const WORKFLOW_EVENT_TYPES: readonly string[] = [
  ...WORKFLOW_LIFECYCLE_EVENT_TYPES,
  ...WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES,
  ...WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES,
  ...WORKFLOW_CHANNEL_COORDINATION_EVENT_TYPES,
  ...WORKFLOW_GATE_RESOLUTION_EVENT_TYPES,
];

/**
 * The member every workflow-plane shape names a run by, on this wire and every other.
 *
 * A STRING AND NOT A SHAPE, which is what keeps this module's own rule intact. Reading
 * one identifier out of a payload is not declaring what the payload IS: a frame that
 * does not carry this member answers `undefined` and a caller has an arm for that,
 * where a declared interface would have callers reading members off frames nothing
 * establishes the shape of.
 */
const WORKFLOW_RUN_ID_MEMBER = "workflowRunId";

/**
 * Which run a workflow frame's payload names, where it names one.
 *
 * WHY A READER AND NOT A DECLARATION. The run pane's live-round reading has to answer
 * "did the run I am showing move", and the kind alone cannot: every one of the
 * twenty-four types is emitted for whichever run the engine advanced, so a pane
 * matching on kind re-reads for every OTHER run in the session too. The one member it
 * needs is the run identifier, which the whole workflow plane spells the same way —
 * every request and every response in the plane's own contract names a run
 * `workflowRunId`, so this is the plane's vocabulary rather than a guess about it.
 *
 * `undefined` FOR ANYTHING THAT IS NOT A STRING, including a frame with no payload at
 * all, and the caller's rule is that an unnamed frame is one it cannot rule out rather
 * than one it can rule against. That matters here and not in theory: `packages/contracts`
 * registers none of these kinds, so nothing yet establishes that a daemon puts this
 * member on the wire — and a reading that refused every frame it could not attribute
 * would go quiet exactly where the taxonomy is not registered.
 */
export function workflowRunIdOfEventPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const named = payload?.[WORKFLOW_RUN_ID_MEMBER];
  return typeof named === "string" ? named : undefined;
}
