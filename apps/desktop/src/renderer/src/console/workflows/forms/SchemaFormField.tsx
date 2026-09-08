// One drawn field: what it is called, what it asks, what is wrong with the answer.
//
// THE CHROME IS HERE AND NOT IN THE SIX CONTROLS. A label a control drew for itself would
// be drawn six ways, and the six would each have to decide how a description is attached
// and how a verdict is announced. One module owns it, and each control owns its value.
//
// THE ISSUES ARE THE SCHEMA'S SENTENCES, VERBATIM. Nothing here paraphrases a validation
// message, ranks them, or shows only the first: a schema that says two things about one
// member said both of them, and a form that showed one would send a person round twice.
//
// THE REQUIRED MARK IS A READING OF THE SCHEMA AND NOT AN ENFORCEMENT. It says what the
// schema declared; whether an answer satisfies it is the compiled validator's verdict,
// arriving as an issue on this same member.

import { useId } from "react";

import { SchemaFieldControl } from "./SchemaFieldControl.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaRequiredMark } from "./SchemaRequiredMark.js";
import { describedByOf } from "./schema-field-control.js";
import type { SchemaFieldDescriptor } from "./schema-fields.js";

export interface SchemaFormFieldProps {
  readonly field: SchemaFieldDescriptor;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  /** The schema's findings about this member, in the order it reported them. */
  readonly issues: readonly string[];
}

/** One labelled control, with its description and the schema's verdict beneath it. */
export function SchemaFormField(props: SchemaFormFieldProps): React.JSX.Element {
  const { field, issues } = props;
  const controlId = useId();
  const descriptionId = useId();
  const issuesId = useId();
  // Both are attached through one attribute, which is the only way a control can carry a
  // description AND its findings. The composition itself is a leaf's, because one list
  // entry's chrome composes the same attribute from the same rule.
  const describedBy = describedByOf([
    field.description === undefined ? undefined : descriptionId,
    issues.length === 0 ? undefined : issuesId,
  ]);
  return (
    <div className="meridian-schema-field">
      <label className="meridian-schema-field__label" htmlFor={controlId}>
        {field.label}
        <SchemaRequiredMark isRequired={field.isRequired} />
      </label>
      <SchemaFieldControl
        field={field}
        value={props.value}
        onChange={props.onChange}
        controlId={controlId}
        describedById={describedBy}
      />
      {field.description === undefined ? null : (
        <p className="meridian-schema-field__description" id={descriptionId}>
          {field.description}
        </p>
      )}
      <SchemaFieldIssues issues={issues} issuesId={issuesId} />
    </div>
  );
}
