// A yes-or-no answer.
//
// AN UNTOUCHED BOX IS `false` AND THE SCHEMA DECIDES WHETHER THAT COUNTS AS ANSWERED. A
// checkbox has no third state to render, so a required boolean that has never been
// touched reads as `false` here — which is exactly why this control never decides
// requiredness. The compiled validator reads the answer; a member the schema demands and
// nobody set is its finding to report.

import { type SchemaFieldControlProps } from "../schema-field-control.js";

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
        props.onChange(event.currentTarget.checked);
      }}
    />
  );
}
