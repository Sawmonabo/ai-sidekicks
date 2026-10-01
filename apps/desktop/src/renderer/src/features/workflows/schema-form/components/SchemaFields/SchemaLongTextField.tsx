// A long-form answer, reached by the schema's `long_text` format. It carries the same string a
// one-line answer would; an emptied box reports an unanswered node, as the text field does.

import { textValueOf, type SchemaFieldControlProps } from "../field-control-props.js";
import { answeredScalar, UNANSWERED_SCALAR } from "../../answer/schema-draft.js";

/** How many rows a long-form control opens with; layout only, never a bound. */
const LONG_TEXT_ROWS = 4;

/** A textarea bound to a string member. */
export function SchemaLongTextField(props: SchemaFieldControlProps): React.JSX.Element {
  return (
    <textarea
      id={props.controlId}
      className="meridian-schema-field__textarea"
      rows={LONG_TEXT_ROWS}
      value={textValueOf(props.value)}
      aria-describedby={props.describedById}
      onChange={(event) => {
        const typed = event.currentTarget.value;
        props.onChange(typed === "" ? UNANSWERED_SCALAR : answeredScalar(typed));
      }}
    />
  );
}
