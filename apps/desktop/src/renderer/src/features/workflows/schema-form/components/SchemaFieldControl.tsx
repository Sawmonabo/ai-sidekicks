// Dispatches a field's declared kind to the control that draws it. A component with an
// exhaustive switch, so a new kind stops compiling instead of rendering nothing.

import { SchemaCheckboxField } from "./fields/SchemaCheckboxField.js";
import { SchemaChoiceField } from "./fields/SchemaChoiceField.js";
import { SchemaLongTextField } from "./fields/SchemaLongTextField.js";
import { SchemaNumberField } from "./fields/SchemaNumberField.js";
import { SchemaTextField } from "./fields/SchemaTextField.js";
import { fieldDrawsAsCheckbox } from "../plan/schema-fields.js";
import type { SchemaFieldControlProps } from "./field-control-props.js";

/** Whichever of the five this field's kind names. */
export function SchemaFieldControl(props: SchemaFieldControlProps): React.JSX.Element {
  switch (props.field.kind) {
    case "long-text":
      return <SchemaLongTextField {...props} />;
    case "number":
      return <SchemaNumberField {...props} />;
    case "checkbox":
      // A boolean the answer may leave out has three states and a box has two, so it is
      // drawn through the choice control; `fieldDrawsAsCheckbox` owns that rule.
      return fieldDrawsAsCheckbox(props.field) ? (
        <SchemaCheckboxField {...props} />
      ) : (
        <SchemaChoiceField {...props} />
      );
    case "choice":
      return <SchemaChoiceField {...props} />;
    case "text":
      return <SchemaTextField {...props} />;
  }
}
