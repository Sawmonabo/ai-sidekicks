// A human phase's form: the controls its schema declares, or the raw editor beside the
// reason it has none.
//
// TWO ARMS AND NO THIRD. `planSchemaForm` is total over every input, so this component's
// branch is exhaustive by construction: there is no "could not read the schema" state to
// render, because that state IS the raw arm carrying its own reason.
//
// THE LEAF RENDERER IS COMPOSED ONCE AND HANDED DOWN, which is what keeps a control inside
// a group identical to a control at the root. Written twice — once here and once in the
// group — the two would drift the first time an issue, a disabled state, or a description
// changed shape, and the drift would only show inside groups.
//
// NOTHING IS SUBMITTED FROM HERE. This component composes an answer and renders the
// schema's verdict on it; the act that sends one is the workflow plan's, arriving with
// the revision it was composed against. That is the console's "absent, not disabled"
// rule rather than a gap: a submit control with no producer is a control that cannot work.

import { SchemaFieldGroup } from "./SchemaFieldGroup.js";
import { SchemaFieldList } from "./SchemaFieldList.js";
import { SchemaFormField } from "./SchemaFormField.js";
import { SchemaJsonEditor } from "./SchemaJsonEditor.js";
import { issuesForMember } from "./schema-field-control.js";
import type { SchemaFormEntry, SchemaLeafEntry } from "./schema-fields.js";
import type { SchemaFormState } from "./use-schema-form.js";

export interface SchemaFormProps {
  /** The whole of the form's state, held by the caller so it outlives a re-render. */
  readonly form: SchemaFormState;
}

/** The path a leaf entry addresses, whichever of the two forms it takes. */
function leafPath(entry: SchemaLeafEntry): readonly string[] {
  return (entry.form === "field" ? entry.field : entry.list).memberPath;
}

/** The schema-derived form, drawn or raw. */
export function SchemaForm(props: SchemaFormProps): React.JSX.Element {
  const { form } = props;

  if (form.plan.shape === "raw") {
    return (
      <SchemaJsonEditor
        fallback={form.plan.fallback}
        rawText={form.rawText}
        onChangeRawText={form.setRawText}
        rawReading={form.rawReading}
        validator={form.validator}
        report={form.report}
      />
    );
  }

  const renderLeaf = (entry: SchemaLeafEntry): React.ReactNode => {
    const memberPath = leafPath(entry);
    const issues = issuesForMember(form.report, memberPath);
    if (entry.form === "list") {
      return (
        <SchemaFieldList
          list={entry.list}
          items={form.listItems(memberPath)}
          onChangeItem={(index, value) => {
            form.setListItem(memberPath, index, value);
          }}
          onAppend={() => {
            form.appendListItem(memberPath);
          }}
          onRemove={(index) => {
            form.removeListItem(memberPath, index);
          }}
          issues={issues}
        />
      );
    }
    return (
      <SchemaFormField
        field={entry.field}
        value={form.memberValue(memberPath)}
        onChange={(value) => {
          form.setMemberValue(memberPath, value);
        }}
        issues={issues}
      />
    );
  };

  const renderEntry = (entry: SchemaFormEntry): React.ReactNode =>
    entry.form === "group" ? (
      <SchemaFieldGroup group={entry.group} renderLeaf={renderLeaf} />
    ) : (
      renderLeaf(entry)
    );

  return (
    <div className="meridian-schema-form">
      {form.plan.entries.map((entry) => (
        <div
          className="meridian-schema-form__entry"
          key={(entry.form === "group" ? entry.group.memberPath : leafPath(entry)).join(".")}
        >
          {renderEntry(entry)}
        </div>
      ))}
    </div>
  );
}
