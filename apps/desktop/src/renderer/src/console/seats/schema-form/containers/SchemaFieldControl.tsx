// The one dispatch from a field's declared kind to the control that draws it.
//
// EXHAUSTIVE BY CONSTRUCTION. The switch covers the six the vocabulary declares and the
// compiler holds it to them: a seventh kind added to `schema-fields.ts` stops this module
// compiling rather than falling through to a control that draws nothing. That is why the
// dispatch is a component rather than a lookup table — a table keyed by kind would be
// assignable while missing an arm, and the missing arm renders as silence.
//
// SIX KINDS AND SIX CONTROLS, AND ONE KIND THAT REACHES TWO OF THEM. A yes-or-no the
// answer may leave out has three states and a box has two, so that arm branches to the
// choice control instead. The branch reads the rule off `schema-fields.ts` rather than
// re-deciding it here, so the control a member gets and the value it opens holding cannot
// disagree.
//
// ONE DISPATCH AND NOT TWO. A field standing on its own and one entry of a list are the
// same control with different chrome around it, so both mount this and neither re-decides
// which of the six a kind means.

import { SchemaArtifactField } from "../fields/SchemaArtifactField.js";
import { SchemaCheckboxField } from "../fields/SchemaCheckboxField.js";
import { SchemaChoiceField } from "../fields/SchemaChoiceField.js";
import { SchemaLongTextField } from "../fields/SchemaLongTextField.js";
import { SchemaNumberField } from "../fields/SchemaNumberField.js";
import { SchemaTextField } from "../fields/SchemaTextField.js";
import { fieldDrawsAsCheckbox } from "../plan/schema-fields.js";
import type { SchemaFieldControlProps } from "./schema-field-control.js";

/** Whichever of the six this field's kind names. */
export function SchemaFieldControl(props: SchemaFieldControlProps): React.JSX.Element {
  switch (props.field.kind) {
    case "long-text":
      return <SchemaLongTextField {...props} />;
    case "number":
      return <SchemaNumberField {...props} />;
    case "checkbox":
      // THE ONE KIND WITH TWO CONTROLS, and `schema-fields.ts` is where the rule lives: a
      // box says yes or no and nothing else, so a boolean the answer may leave out is
      // drawn through the choice control, which has the third state. Still one kind — the
      // schema asked for a yes-or-no either way.
      return fieldDrawsAsCheckbox(props.field) ? (
        <SchemaCheckboxField {...props} />
      ) : (
        <SchemaChoiceField {...props} />
      );
    case "choice":
      return <SchemaChoiceField {...props} />;
    case "artifact-reference":
      return <SchemaArtifactField {...props} />;
    case "text":
      return <SchemaTextField {...props} />;
  }
}
