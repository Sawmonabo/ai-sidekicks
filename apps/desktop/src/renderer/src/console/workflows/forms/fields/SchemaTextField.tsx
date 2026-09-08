// A one-line answer.
//
// The plainest of the six, and the default a string member lands on: a string with no
// `format` the mapper recognises is one line of text, because that is what the corpus's
// own `text` field type is.

import { textValueOf, type SchemaFieldControlProps } from "../schema-field-control.js";

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
        props.onChange(event.currentTarget.value);
      }}
    />
  );
}
