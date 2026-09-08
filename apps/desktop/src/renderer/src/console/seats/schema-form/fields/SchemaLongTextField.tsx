// A long-form answer.
//
// Reached by the schema declaring the corpus's own `long_text` field type in draft-07's
// one string extension point, `format`. It is a different CONTROL and not a different
// value: what travels is the same string a one-line answer would carry, which is why
// this is a sibling of the text field rather than a mode inside it.
//
// THE ROW COUNT IS A LAYOUT DEFAULT AND NOT A BOUND. Nothing here truncates, refuses, or
// counts characters — a length the schema cares about is the schema's to state, and the
// compiled validator is what reports it.
//
// AND IT CLEARS THE WAY THE ONE-LINE CONTROL CLEARS, through the same rule: an emptied
// control reports an unanswered node rather than an answered `""`. The same node in both
// places, so the two text controls cannot come to disagree about what an empty box means.

import { textValueOf, type SchemaFieldControlProps } from "../schema-field-control.js";
import { answeredScalar, UNANSWERED_SCALAR } from "../schema-draft.js";

/** How tall a long-form control opens. Layout only; the answer is never bounded here. */
const LONG_TEXT_ROWS = 4;

/** Several lines of text. */
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
