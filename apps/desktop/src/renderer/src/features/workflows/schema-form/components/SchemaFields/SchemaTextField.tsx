// A one-line answer, the default for a string member. A cleared box reports an unanswered
// node rather than an answered `""`, so a schema that tells absence from `""` stays reachable.

import { textValueOf, type SchemaFieldControlProps } from "../field-control-props.js";
import { answeredScalar, UNANSWERED_SCALAR } from "../../answer/schema-draft.js";

/** A one-line text input bound to a string member. */
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
