// What a human phase will ask, drawn from the definition an author is reading.
//
// THE INSPECTOR'S HALF AND NOT THE RUN'S. A parked phase is answered in the run pane,
// through the workflow plan's own form body and the submit that carries the revision it
// was composed against. This is the other question, and it is a definition question: does
// the schema I wrote draw the form I meant? It is answered from bytes the definition read
// already returned, so it costs no read and reaches no run.
//
// WHICH IS WHY THERE IS NO SUBMIT CONTROL. "Absent, not disabled" — the console offers a
// control when its caller supplies the act and never before, and nothing here can send an
// answer anywhere: this phase has no run, so there is no attempt to submit against and no
// revision to carry. A greyed Submit would be a control that could never work.
//
// AND WHY IT IS STILL LIVE. The fields are real controls over a real schema, so an author
// typing into them learns exactly what a participant will meet — including the raw editor,
// which is what a schema outside the drawn set actually opens as. A picture of a form
// would answer the same question worse and would go stale against the mapper.
//
// ONE READ, ONE HOOK, NO EFFECT. The schema comes off the phase the caller already holds
// and the hook memoises the plan and the compiled validator on it, so a keystroke re-walks
// nothing.

import { SchemaForm } from "./SchemaForm.js";
import { humanPhaseFormConfigOf } from "./human-phase-config.js";
import { useSchemaForm } from "./use-schema-form.js";
import type { WorkflowPhaseDefinition } from "../../bridge/index.js";

export interface HumanPhaseFormPreviewProps {
  readonly phase: WorkflowPhaseDefinition;
}

/** The form this phase will ask, or nothing at all where it asks for none. */
export function HumanPhaseFormPreview(props: HumanPhaseFormPreviewProps): React.ReactNode {
  const config = humanPhaseFormConfigOf(props.phase);
  // Called unconditionally with whatever the config carried, because a hook may not be
  // called behind a branch: a phase with no form hands `undefined` to the mapper, which
  // resolves it to the raw arm like any other unreadable schema — and the element that
  // would render it is never returned.
  const form = useSchemaForm(config?.inputSchema);
  if (config === undefined) {
    return null;
  }
  return (
    <div className="meridian-schema-preview">
      <p className="meridian-schema-preview__caption">
        What this phase asks. Answering it here changes nothing — the phase is answered from its
        run.
      </p>
      {config.prompt === undefined ? null : (
        <p className="meridian-schema-preview__prompt">{config.prompt}</p>
      )}
      <SchemaForm form={form} />
    </div>
  );
}
