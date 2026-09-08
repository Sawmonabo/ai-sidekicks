// A one-line answer.
//
// The plainest of the six, and the default a string member lands on: a string with no
// `format` the mapper recognises is one line of text, because that is what the corpus's
// own `text` field type is.
//
// AND A CLEARED BOX REPORTS AN UNANSWERED NODE, which leaves what that is WORTH to the
// projection's one rule rather than to this control's reading of it. Writing `""` for
// an emptied box put an ANSWERED empty string where the person had taken their answer
// back: a schema that tells absence from `""` — an object under `maxProperties`, a
// `minLength` the empty string fails — then had a state the form could reach on the way in
// and never on the way out, with the control looking exactly as it had at the mount.

import { textValueOf, type SchemaFieldControlProps } from "../containers/schema-field-control.js";
import { answeredScalar, UNANSWERED_SCALAR } from "../answer/schema-draft.js";

/** One line of text. */
export function SchemaTextField(props: SchemaFieldControlProps): React.JSX.Element {
  return (
    <input
      id={props.controlId}
      className="meridian-schema-field__input"
      type="text"
      value={textValueOf(props.value)}
      aria-describedby={props.describedById}
      onChange={(event) => {
        const typed = event.currentTarget.value;
        props.onChange(typed === "" ? UNANSWERED_SCALAR : answeredScalar(typed));
      }}
    />
  );
}
