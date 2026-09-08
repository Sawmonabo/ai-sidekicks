// A yes-or-no answer.
//
// AN UNTOUCHED BOX IS `false`, AND THE ANSWER SAYS SO BEFORE ANYBODY TOUCHES IT. A
// checkbox has no third state to render: unchecked is not "unanswered", it is NO. So the
// member is `false` in the composed answer from the mount, and stays there whatever a
// person does to the box — `schema-fields.ts` owns that rule, which is why this control
// alone writes no absence. Leaving it out until the first toggle displayed one thing and
// submitted another, and made `false` the one value a person could not send without
// checking the box and unchecking it again.
//
// WHICH IS STILL NOT THIS CONTROL DECIDING REQUIREDNESS. The compiled validator reads the
// answer; a member the schema demands and nobody set is its finding to report. What
// changed is what the answer holds, not who judges it.
//
// A VALUE THAT IS NOT A BOOLEAN RENDERS UNCHECKED. A restored draft or a hand-edited
// answer can put anything at this member, and `=== true` is the honest reading of it: the
// box shows the one thing it can show, and the schema reports what is actually there.

import { answeredScalar } from "../answer/schema-draft.js";
import { type SchemaFieldControlProps } from "../containers/schema-field-control.js";

/** True or false. */
export function SchemaCheckboxField(props: SchemaFieldControlProps): React.JSX.Element {
  return (
    <input
      id={props.controlId}
      className="meridian-schema-field__checkbox"
      type="checkbox"
      checked={props.value === true}
      aria-describedby={props.describedById}
      onChange={(event) => {
        props.onChange(answeredScalar(event.currentTarget.checked));
      }}
    />
  );
}
