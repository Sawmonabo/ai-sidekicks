// What the run pane owes the body that answers a phase parked on a person.
//
// A MODULE OF ITS OWN BECAUSE FOUR MODULES NEED IT AND ONE OF THEM IS A BODY. The slot
// wrapper declares the phase it is handed, the submit channel composes the mount, the
// console's own fixture shell is handed one, and the submit dispatch reads every member
// of the request off it — so leaving the type in the wrapper would have made the shell
// import the wrapper that renders it, and a type-only edge is still an edge:
// `no-circular` reads the pre-compilation graph. The contract is what all four share, so
// the contract is what moves.
//
// TWO TYPES BECAUSE TWO PARTIES SUPPLY THEM. `HumanFormPhase` is what the mounting PANE
// resolves out of the run read; `HumanFormMount` is what the body is finally rendered
// with, which is that phase plus the one thing the pane cannot resolve — the act of
// sending an answer. They are declared as a base and an extension rather than as one
// type with an optional member, because a body handed a mount whose `submit` might be
// absent would have to decide what to do about a form it cannot send, and the answer is
// that there is no such state: a body is mounted only where the seat has a submit for it.
//
// WHAT THE MOUNT OWES, AS A TYPE. Four things the mounting pane knows and the body must
// not re-derive, and the first three are exactly what the registered submit is addressed
// by — the seat composes `workflowHumanFormSubmit` out of them so the body never has to:
//
//   • **The run**, verbatim as the pane was addressed by it. The registered request
//     takes `workflowRunId` beside the phase, and `phaseRunId` is opaque and
//     non-reversible, so a mount without the run could not compose the request at all.
//   • **The phase reference**, so the submission is addressed at one phase.
//   • **The optimistic-concurrency token**, passed through verbatim. It is `0` while an
//     attempt has no accepted submission and `1` after one, and a retry mints a new
//     attempt that reads `0` again — which is exactly why the value the form was
//     COMPOSED against is what travels, rather than whatever the newest run read says.
//   • **What the phase asks** — its prompt and its input schema, as the run read carried
//     them. Handed over rather than re-read for the reason the run snapshot is handed to
//     the detail body: the pane has the answer already, and a body that fetched the
//     definition to draw its own would put one question twice and hold two answers to it
//     on one screen. It could not put it at all, in fact — the definition's version read
//     is addressed by a version NUMBER and a run carries one opaque version id.
//
// AND ONE THING THE MOUNT REFUSES TO OWE: whether the form may be submitted. That is the
// daemon's adjudication, reaching the SEAT as a typed refusal, and a mount that predicted
// it would be a second authority on a question the daemon owns. A stale-revision submit
// is one of the uncoded refusal points, so the daemon's own message is the primary text
// there.
//
// THE DRAFT IS NOT THIS MOUNT'S. Autosave is renderer-local and window-scoped; the
// family's separate draft slot carries it, and a draft that reached the durable store
// would be user content in a durable home.

/** The phase whose form is open, as the mounting pane resolved it out of the run read. */
export interface HumanFormPhase {
  /**
   * The run this phase belongs to, wire-verbatim, as the submit is addressed by it.
   *
   * Read off the SNAPSHOT the phases came from rather than off the pane's address, so
   * the run and the phases in one mount are always the same answer: a pane retargeted
   * mid-read would otherwise pair the new run's id with the old run's phases, and the
   * submit composed from it would carry a phase that run never had.
   */
  readonly workflowRunId: string;
  /** The phase run whose form this is. Opaque and wire-verbatim. */
  readonly phaseRunId: string;
  /** The phase the form belongs to, for the deep link a park banner offers. */
  readonly phaseId: string;
  /**
   * The revision this attempt's form is composed against, as the run read reported it.
   *
   * Never compared here: the pane carries the number and the daemon decides whether it
   * is still current. What the seat sends is the value CAPTURED when the attempt opened
   * rather than this member re-read at press time — a run read that refreshes under a
   * live form moves this number without moving the answer somebody typed, and sending
   * the newer one would defeat the very comparison it exists for.
   */
  readonly formRevision: number;
  /**
   * What this phase asks, where the run read carried it.
   *
   * Optional because the wire member is: a daemon below the contract revision reports
   * the park and not the question. Absent is therefore "this build was not told", never
   * "the phase asks nothing".
   */
  readonly prompt?: string;
  /**
   * The schema the answer is shaped by, untyped and optional on the same reading.
   *
   * `unknown` rather than a JSON Schema type, because deciding what a schema IS belongs
   * to the one mapper that draws it and its fallback covers everything it is not.
   */
  readonly inputSchema?: unknown;
}

/** The resolved phase, plus the one act the seat keeps and the body may not author. */
export interface HumanFormMount extends HumanFormPhase {
  /**
   * Send this answer, whatever input mode composed it.
   *
   * THE CHANNEL IS THE SEAT'S AND NOT THE BODY'S, which is the whole reason it is on
   * the mount. The registered `workflowHumanFormSubmit`, the single-flight guard, the
   * revision this attempt was composed against, the re-armed run read and the rendering
   * of whatever came back are all the run pane's, so a body that dispatched for itself
   * would be a second implementation of every one of them — and the seat's own rule is
   * that this console ships the chrome and the typed hole, never the owner's body.
   *
   * Bound to the attempt on screen: a body may call it with the answer alone, and the
   * run, the phase and the revision it travels with are the seat's own reading of which
   * wait this is.
   */
  readonly submit: (answer: unknown) => void;
}

/**
 * The body the workflow plan authors: a COMPONENT the slot renders, never a function it
 * calls.
 *
 * The distinction is React's, not a preference. `owner-slots.ts` states it once for all
 * five slots; the short of it is that a called body's hooks join the WRAPPER's hook
 * list, and a wrapper that calls conditionally changes that list between renders. A
 * supplied body must therefore be a stable reference — a component composed inline on
 * each render is a different type each time, and React remounts it.
 */
export type HumanFormBody = (mount: HumanFormMount) => React.ReactNode;
