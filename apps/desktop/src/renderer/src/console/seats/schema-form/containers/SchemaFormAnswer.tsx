// The form a phase parked on a person is answered through: its prompt, its controls,
// and the one act that sends what they compose.
//
// THE RUN'S HALF, WHERE `SchemaFormPreview` BESIDE IT IS THE DEFINITION'S. The
// preview answers "does the schema I wrote draw the form I meant" out of bytes an
// author is already reading, and sends nothing anywhere. This one is the other
// question — a person has been asked something and is answering it — so it carries a
// submit control and the preview deliberately does not.
//
// AND IT LIVES IN THE SEAT RATHER THAN BESIDE ITS MOUNT, which is this seat's own rule.
// `useSchemaForm` and `planSchemaForm` do not leave the form stack, because a caller
// assembling them itself would be a second answer to what a schema draws — and the
// schema compiler they use does not leave the BRIDGE except through a loader, so a
// caller assembling its own would also be fetching a chunk the form already has. A
// composer therefore lives WITH them and leaves through the seats door, exactly as the
// preview does — and the sheet every control below draws against enters through that
// same door, so a surface that deep-imported the parts would have rendered the controls
// unstyled.
//
// WHICH IS THE BOUNDARY BETWEEN THIS AND THE BODY THAT MOUNTS IT. The seat owns what a
// schema draws and the one act that sends what the controls composed; the mounting body
// owns where that act goes, which run and revision it carries, and what the daemon said
// back. A body re-authoring the form would be a second drawing of one schema.
//
// WHAT IT DOES NOT DECIDE. Whether the answer may be sent. The schema's verdict is
// rendered — every issue, on every control, on every keystroke — and the control is
// still offered, because requiredness is the schema's reading of the answer and
// admissibility is the daemon's reading of the participant, the phase and the
// revision. A submit disabled on a validation report would be this form refusing on
// behalf of an authority it cannot see the inputs to, and an operator with no way to
// find out what the daemon would actually have said.
//
// WHICH IS WHY THE ONE STATE THAT DOES CLOSE THE ACT IS NOT A VERDICT AT ALL. The schema
// compiler arrives on its own chunk, and until it lands this form has no report — not a
// clean one, not a refusing one, none. Offering the act there would send an answer nothing
// has yet been able to look at, and rendering it as permitted would say a verdict had been
// reached. So while the validator reads `compiling` the control is DISABLED rather than
// absent — it is arriving, not missing, and the two read differently to somebody waiting —
// and the form carries `aria-busy`, which is the same fact stated where a reader who is
// not looking at the button can meet it, and what a tier waits on rather than racing.
//
// AND IT IS THE ONLY STATE THAT CLOSES IT, WHICH IS WHY A CHUNK THAT NEVER ARRIVES DOES
// NOT. `checker-unavailable` is a settlement rather than a wait: this window will not check
// the answer, and that is as final as a schema which would not compile. Read as "still
// arriving" it would hold the act shut for ever over a fetch nobody is going to retry, on
// a form whose whole purpose is that a parked run can be answered — so the act is offered
// there exactly as it is on the uncompilable arm, and what will not be checked is stated
// on the editor beside it.
//
// A SCHEMA THE WIRE DID NOT CARRY IS NOT A SCHEMA OUTSIDE THE RENDER SET. The raw
// editor exists for the second — it opens with the mapper's own sentence about which
// member forced it — and the first is a different fact: an older daemon reported the
// park without reporting what it asks for. Answered as JSON it would ask a person to
// guess the shape, and the fallback sentence would explain a schema nobody sent. So
// that arm says what happened and offers no control, which is this console's
// "absent, not disabled" rule at the one point where the absence is the wire's.
//
// AND A THIRD ARM, WHERE THE SCHEMA ARRIVED AND ASKS FOR SOMETHING NO SUBMISSION CAN
// CARRY. `schema-root-shape.ts` states the rule: an answer travels as a set of named
// values, so a root declaring a single string or number describes an answer the request
// has no member for. The mapper is right to hand that schema to the raw editor — it
// cannot DRAW it — but this surface is the one that offers the act, and an editor whose
// every schema-valid answer settles as `answer-not-composed` is a control that cannot
// work. So the refusal is rendered here, at the moment the form is composed, and no
// submit control is offered beside it. The plan itself is unchanged and still never
// carries a refusal; what the plan describes is the input mode, and what this decides is
// whether there is an act at all.

import { SchemaForm } from "./SchemaForm.js";
import { schemaRootRefusal } from "../plan/schema-root-shape.js";
import { useSchemaForm } from "./use-schema-form.js";
import { InlineRefusal, Nothing } from "../../../primitives/index.js";

export interface SchemaFormAnswerProps {
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
}

/** The label the one act carries. Written once, read by the control and by its tests. */
const SUBMIT_LABEL = "Submit answer";

/** One waiting phase's form, or the honest statement that its shape never arrived. */
export function SchemaFormAnswer(props: SchemaFormAnswerProps): React.JSX.Element {
  // Called unconditionally with whatever the wire carried, because a hook may not sit
  // behind a branch. Neither of the two arms below that offer no act renders what this
  // composed.
  const form = useSchemaForm(props.inputSchema);
  // Read on every render rather than memoised: it is three property reads over a value
  // the caller already holds, and a cache would be a second thing to keep in step with
  // the schema.
  const rootRefusal = schemaRootRefusal(props.inputSchema);
  // The one act is closed while the compiler is still arriving — the header's reason. Read
  // off the form's own validator rather than held beside it, so there is no second answer
  // to whether this form has a verdict yet.
  const isAwaitingVerdict = form.validator.status === "compiling";
  return (
    <form
      className="meridian-schema-answer"
      aria-busy={isAwaitingVerdict ? true : undefined}
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
      ) : rootRefusal !== undefined ? (
        // Inline, on the refusal grammar's own reading of blast radius: nothing changed,
        // the phase is still parked exactly as it was, and the next move is in the
        // definition rather than anywhere on this screen. It stands where the form and
        // its act would have, because there is no control here for it to sit beside.
        <InlineRefusal code={rootRefusal.code} detail={rootRefusal.detail} />
      ) : (
        <>
          <SchemaForm form={form} />
          <div className="meridian-schema-answer__act">
            <button
              type="submit"
              className="meridian-schema-answer__submit"
              disabled={isAwaitingVerdict}
            >
              {SUBMIT_LABEL}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
