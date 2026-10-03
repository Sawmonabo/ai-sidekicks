// One drawn field: label, control, description and the schema's findings. The chrome lives
// here so each control owns only its value. Findings are the schema's sentences, all of them.

import { useId } from "react";

import { SchemaFieldControl } from "./SchemaFieldControl.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaRequiredMark } from "./SchemaRequiredMark.js";
import type { SchemaScalarDraft } from "../answer/schema-draft.js";
import { describedByOf } from "./field-control-props.js";
import type { SchemaFieldDescriptor } from "../plan/schema-fields.js";
import type { SchemaControlView } from "../answer/schema-projection.js";

/** The props of one labeled field. */
export interface SchemaFormFieldProps {
  readonly field: SchemaFieldDescriptor;
  /** What this member's control displays, projected from the draft node it holds. */
  readonly view: SchemaControlView;
  readonly onChange: (draft: SchemaScalarDraft) => void;
  /** The schema's findings about this member, in the order it reported them. */
  readonly issues: readonly string[];
}

/** One labeled control, with its description and the schema's verdict beneath it. */
export function SchemaFormField(props: SchemaFormFieldProps): React.JSX.Element {
  const { field, issues } = props;
  const controlId = useId();
  const descriptionId = useId();
  const issuesId = useId();
  // Description and findings share the one `aria-describedby` attribute.
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
        value={props.view.value}
        unreadableText={props.view.unreadableText}
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
