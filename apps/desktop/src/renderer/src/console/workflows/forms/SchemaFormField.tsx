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
  // description AND its findings: the platform takes a space-separated id list here, and
  // an element id pointing at nothing is dropped, so a field with neither carries none.
  const describedBy = [
    field.description === undefined ? undefined : descriptionId,
    issues.length === 0 ? undefined : issuesId,
  ]
    .filter((id): id is string => id !== undefined)
    .join(" ");
  return (
    <div className="meridian-schema-field">
      <label className="meridian-schema-field__label" htmlFor={controlId}>
        {field.label}
        {field.isRequired ? (
          <span className="meridian-schema-field__required"> required</span>
        ) : null}
      </label>
      <SchemaFieldControl
        field={field}
        value={props.value}
        onChange={props.onChange}
        controlId={controlId}
        describedById={describedBy === "" ? undefined : describedBy}
      />
      {field.description === undefined ? null : (
        <p className="meridian-schema-field__description" id={descriptionId}>
          {field.description}
        </p>
      )}
      {issues.length === 0 ? null : (
        <ul className="meridian-schema-field__issues" id={issuesId}>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
