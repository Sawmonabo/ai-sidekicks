// A human phase's form: the controls its schema declares, or the raw editor beside the
// reason it has none.
//
// TWO ARMS AND NO THIRD. The arm reaches this component already decided, from a hook that
// read both the mapper and the compiled validator, and it is total over every input — so
// this branch is exhaustive by construction: there is no "could not read the schema" and
// no "drew controls nothing can check" state to render, because both ARE the raw arm,
// each carrying its own reason.
//
// A FINDING IS ADDRESSED TO WHAT IT IS ABOUT, AND A GROUP IS SOMETHING. A schema requiring
// a nested object reports the missing member at the group's own path, not at any of its
// children's — so a form that asked only for leaf paths drew a fieldset of optional
// controls with nothing wrong with any of them, over a report that was invalid. Every
// path this component asks about is asked for the same way, through the one reader.
//
// THE LEAF RENDERER IS COMPOSED ONCE AND HANDED DOWN, which is what keeps a control inside
// a group identical to a control at the root. Written twice — once here and once in the
// group — the two would drift the first time an issue, a disabled state, or a description
// changed shape, and the drift would only show inside groups.
//
// A LIST IS ADDRESSED TWICE, BECAUSE THE VALIDATOR ADDRESSES IT TWICE. What the schema
// says about the collection arrives at the array's own path; what it says about one entry
// arrives at that path plus the index. Both readings are composed here, where the report
// and the member path are both in hand, and each is handed to the surface it is about —
// asking only for the unindexed path is what left an entry's finding drawn nowhere.
//
// NOTHING IS SUBMITTED FROM HERE. This component composes an answer and renders the
// schema's verdict on it; the act that sends one is the workflow plan's, arriving with
// the revision it was composed against. That is the console's "absent, not disabled"
// rule rather than a gap: a submit control with no producer is a control that cannot work.

import { SchemaFieldGroup } from "./SchemaFieldGroup.js";
import { SchemaFieldList } from "./SchemaFieldList.js";
import { SchemaFormField } from "./SchemaFormField.js";
import { SchemaJsonEditor } from "./SchemaJsonEditor.js";
import { issuesForListEntry, issuesForMember } from "./schema-field-control.js";
import type { SchemaFormEntry, SchemaLeafEntry } from "./schema-fields.js";
import { encodeMemberPointer, type SchemaMemberPath } from "../../bridge/index.js";
import type { SchemaFormState } from "./use-schema-form.js";

export interface SchemaFormProps {
  /** The whole of the form's state, held by the caller so it outlives a re-render. */
  readonly form: SchemaFormState;
}

/** The path a leaf entry addresses, whichever of the two forms it takes. */
function leafPath(entry: SchemaLeafEntry): SchemaMemberPath {
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
          issuesForEntry={(index) => issuesForListEntry(form.report, memberPath, index)}
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
      <SchemaFieldGroup
        group={entry.group}
        renderLeaf={renderLeaf}
        issues={issuesForMember(form.report, entry.group.memberPath)}
      />
    ) : (
      renderLeaf(entry)
    );

  return (
    <div className="meridian-schema-form">
      {form.plan.entries.map((entry) => (
        <div
          className="meridian-schema-form__entry"
          key={encodeMemberPointer(
            entry.form === "group" ? entry.group.memberPath : leafPath(entry),
          )}
        >
          {renderEntry(entry)}
        </div>
      ))}
    </div>
  );
}
