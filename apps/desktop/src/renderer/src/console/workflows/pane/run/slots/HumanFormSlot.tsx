// The human phase's form slot — the prompt, the fields derived from its input
// schema, and the submission that carries the revision it was composed against.
//
// OWNED BY PLAN-017. The form is a schema walk over a `JSONSchema7` with a
// JSON-editor fallback for anything outside the render set, and the console does
// not author one. THE SHELL DIES IN THE PLAN-017 TASK THAT MOUNTS THE BODY, in the
// same PR as the mount.
//
// WHAT THE MOUNT OWES, AS A TYPE. Three things the mounting pane knows and the body
// must not re-derive, and together they are exactly what the registered submit is
// addressed by — a mount the body cannot compose `workflowHumanFormSubmit` out of is
// a seat that hands over a form nobody can send:
//
//   • **The run**, verbatim as the pane was addressed by it. The registered request
//     takes `workflowRunId` beside the phase, and `phaseRunId` is opaque and
//     non-reversible, so a body handed only the phase run would have to go looking
//     for the run through a read the console does not have.
//   • **The phase reference**, so the body reads its own prompt and schema rather
//     than being handed a rendered form.
//   • **The optimistic-concurrency token**, passed through verbatim. It is `0`
//     while an attempt has no accepted submission and `1` after one, and a retry
//     mints a new attempt that reads `0` again — which is exactly why the body must
//     carry the value it composed against into the submit rather than re-reading it
//     at the moment of pressing.
//
// AND ONE THING THE MOUNT REFUSES TO OWE: whether the form may be submitted. That
// is the daemon's adjudication, reaching the body as a typed refusal, and a mount
// that predicted it would be a second authority on a question the daemon owns. A
// stale-revision submit is one of the uncoded refusal points, so the daemon's own
// message is the primary text there.
//
// WHY THE PHASE IS A WHOLE VALUE THAT MAY BE ABSENT, RATHER THAN THREE OPTIONALS.
// A pane mounts this region before it knows which phase is waiting — no run read is
// reachable from this build, so today it never knows — and the two states are "a
// phase is open" and "none is". Spread across three optional members, every
// consumer would have to re-decide which of them discriminates, and the wrong
// answer (`formRevision`, which is legitimately `0`) is the one that reads as
// falsy. One member, present or absent, and the question is asked once here.
//
// THE DRAFT IS NOT THIS SLOT'S. Autosave is renderer-local and window-scoped; the
// family's separate draft slot carries it, and a draft that reached the durable
// store would be participant content in a durable home.

import { WorkflowSlotMount } from "../../../WorkflowSlotMount.js";
import { WORKFLOW_HUMAN_FORM_SLOT } from "../../../owner-slots.js";

/** The phase whose form is open, as the mounting pane resolved it. */
export interface HumanFormMount {
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
   * The revision the form is composed against, passed through into the submit.
   *
   * Never re-read at press time and never compared here: the pane carries the
   * number and the daemon decides whether it is still current.
   */
  readonly formRevision: number;
}

/**
 * The body Plan-017 authors: a COMPONENT this pane renders, never a function it
 * calls.
 *
 * The distinction is React's, not a preference. `owner-slots.ts` states it once for
 * all five slots; the short of it is that a called body's hooks join the WRAPPER's
 * hook list, and a wrapper that calls conditionally changes that list between
 * renders. A supplied body must therefore be a stable reference — a component
 * composed inline on each render is a different type each time, and React remounts
 * it.
 */
export type HumanFormBody = (mount: HumanFormMount) => React.ReactNode;

export interface HumanFormSlotProps {
  /**
   * The open phase, or `undefined` while none is.
   *
   * Required-carrying-undefined rather than optional: a pane that has not resolved
   * a phase has to say so, and an absent key would read identically to one that
   * simply forgot to look.
   */
  readonly phase: HumanFormMount | undefined;
  /** The body, once there is one. Absent everywhere here, so the shell stands. */
  readonly body?: HumanFormBody;
}

/** The human phase's form, or the honest statement that it is reserved and unbuilt. */
export function HumanFormSlot(props: HumanFormSlotProps): React.JSX.Element {
  const { phase, body: HumanFormBodyComponent } = props;
  return (
    <WorkflowSlotMount
      slot={{
        contract: WORKFLOW_HUMAN_FORM_SLOT.contract,
        // No phase means no body, and never a body rendered against a placeholder: a
        // form composed against a phase nobody resolved would be answerable in
        // appearance and unsubmittable in fact. The element is CONSTRUCTED here and
        // rendered by the mount, so the body keeps its own hook boundary across this
        // conditional.
        body:
          phase === undefined || HumanFormBodyComponent === undefined ? undefined : (
            <HumanFormBodyComponent {...phase} />
          ),
      }}
      title="The form a waiting phase needs is not built yet."
      detail="A phase waiting on a person opens its prompt and fields here; until then the phase is readable and not answerable."
    />
  );
}
