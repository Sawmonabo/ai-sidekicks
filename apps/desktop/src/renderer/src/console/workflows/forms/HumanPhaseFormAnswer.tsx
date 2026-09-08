// The form a phase parked on a person is answered through: its prompt, its controls,
// and the one act that sends what they compose.
//
// THE RUN'S HALF, WHERE `HumanPhaseFormPreview` BESIDE IT IS THE DEFINITION'S. The
// preview answers "does the schema I wrote draw the form I meant" out of bytes an
// author is already reading, and sends nothing anywhere. This one is the other
// question — a person has been asked something and is answering it — so it carries a
// submit control and the preview deliberately does not.
//
// AND IT LIVES HERE RATHER THAN BESIDE ITS MOUNT, which is this directory's own rule.
// `useSchemaForm`, `planSchemaForm` and `compileSchemaValidator` do not leave the form
// stack, because a caller assembling those three itself would be a second answer to
// what a schema draws. A composer therefore lives WITH them and leaves through the
// door, exactly as the preview does — and the sheet every control below draws against
// enters through that same door, so a surface that deep-imported the parts would have
// rendered the controls unstyled.
//
// WHAT IT DOES NOT DECIDE. Whether the answer may be sent. The schema's verdict is
// rendered — every issue, on every control, on every keystroke — and the control is
// still offered, because requiredness is the schema's reading of the answer and
// admissibility is the daemon's reading of the participant, the phase and the
// revision. A submit disabled on a validation report would be this form refusing on
// behalf of an authority it cannot see the inputs to, and an operator with no way to
// find out what the daemon would actually have said.
//
// A SCHEMA THE WIRE DID NOT CARRY IS NOT A SCHEMA OUTSIDE THE RENDER SET. The raw
// editor exists for the second — it opens with the mapper's own sentence about which
// member forced it — and the first is a different fact: an older daemon reported the
// park without reporting what it asks for. Answered as JSON it would ask a person to
// guess the shape, and the fallback sentence would explain a schema nobody sent. So
// that arm says what happened and offers no control, which is this console's
// "absent, not disabled" rule at the one point where the absence is the wire's.

import { SchemaForm } from "./SchemaForm.js";
import { useSchemaForm } from "./use-schema-form.js";
import { Nothing } from "../../primitives/index.js";

export interface HumanPhaseFormAnswerProps {
  /** What the phase asks, as its author wrote it. Absent where the wire carried none. */
  readonly prompt: string | undefined;
  /**
   * The schema the answer is shaped by, untyped and possibly absent.
   *
   * `unknown` because the mapper is what decides what a schema is; carrying `undefined`
   * inside that rather than beside it, because the two are different facts and only one
   * of them is answerable — see the header.
   */
  readonly inputSchema: unknown;
  /** Send the composed answer. Called with whatever input mode composed it. */
  readonly onSubmit: (answer: unknown) => void;
  /**
   * Where the last press got to, rendered beside the control that made it.
   *
   * A node rather than a settlement type, because what a settlement MEANS is the
   * mounting surface's — this form owns what a schema draws and the act that sends it,
   * and the run pane owns what the daemon said back. Beside the button rather than
   * under the form, so nothing changed reads where the act was asked for.
   */
  readonly children?: React.ReactNode;
}

/** The label the one act carries. Written once, read by the control and by its tests. */
const SUBMIT_LABEL = "Submit answer";

/** One waiting phase's form, or the honest statement that its shape never arrived. */
export function HumanPhaseFormAnswer(props: HumanPhaseFormAnswerProps): React.JSX.Element {
  // Called unconditionally with whatever the wire carried, because a hook may not sit
  // behind a branch. The absent arm below never renders what this composed.
  const form = useSchemaForm(props.inputSchema);
  return (
    <form
      className="meridian-schema-answer"
      onSubmit={(event) => {
        // The page must not navigate: this is a console surface and the act is a growth
        // call. A button outside a form would lose the Enter key that submitting a form
        // gives every control inside it for free.
        event.preventDefault();
        props.onSubmit(form.answer);
      }}
    >
      {props.prompt === undefined ? null : (
        <p className="meridian-schema-answer__prompt">{props.prompt}</p>
      )}
      {props.inputSchema === undefined ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="This run did not report what this phase asks for."
          detail="The phase is waiting on a person and its question has not reached this window, so there is nothing to answer here yet."
        />
      ) : (
        <>
          <SchemaForm form={form} />
          <div className="meridian-schema-answer__act">
            <button type="submit" className="meridian-schema-answer__submit">
              {SUBMIT_LABEL}
            </button>
            {props.children}
          </div>
        </>
      )}
    </form>
  );
}
