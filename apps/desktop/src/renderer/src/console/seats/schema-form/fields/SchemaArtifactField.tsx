// A reference to an artifact that already exists.
//
// NOTHING IS UPLOADED FROM INSIDE A FORM. `Spec-017 §Default Behavior` puts ingestion out
// of band: a file reaches the session through the artifact pipeline and reaches this
// control as an identifier. So there is no file input here, and the absence is the rule
// rather than an unbuilt control — a picker drawn against an ingestion this form does not
// perform would offer a move that cannot be made.
//
// THE IDENTIFIER IS A WIRE VALUE, so it is typed and shown in mono like every other one,
// and the hint beside it says where a reference comes from rather than paraphrasing what
// it means.

import { textValueOf, type SchemaFieldControlProps } from "../schema-field-control.js";
import { answeredScalar, UNANSWERED_SCALAR } from "../schema-draft.js";

/** An identifier naming an artifact the session already holds. */
export function SchemaArtifactField(props: SchemaFieldControlProps): React.JSX.Element {
  return (
    <input
      id={props.controlId}
      className="meridian-schema-field__input meridian-schema-field__input--figure"
      type="text"
      value={textValueOf(props.value)}
      aria-describedby={props.describedById}
      placeholder="artifact id"
      onChange={(event) => {
        const typed = event.currentTarget.value;
        props.onChange(typed === "" ? UNANSWERED_SCALAR : answeredScalar(typed));
      }}
    />
  );
}
