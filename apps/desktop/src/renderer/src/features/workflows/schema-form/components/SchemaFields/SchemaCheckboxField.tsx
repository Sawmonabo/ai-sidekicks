// A yes-or-no answer. An untouched box is `false` in the composed answer from the mount
// (`schema-fields.ts` owns the rule): a checkbox has no unanswered state. A value that is not
// a boolean renders unchecked, and the schema reports what is actually there.

import { answeredScalar } from "../../answer/schema-draft.js";
import { type SchemaFieldControlProps } from "../field-control-props.js";

/** A checkbox bound to a boolean member. */
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
