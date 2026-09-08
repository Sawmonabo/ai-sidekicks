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
// AND A FINDING CAN BE ABOUT THE ANSWER ITSELF, WHICH IS A MEMBER NOTHING HERE DRAWS. A
// root constraint — `oneOf`, `not`, `minProperties` — is checked against the whole object
// and reports at the empty path, so a form asking only for its entries' paths drew every
// control clean over a report that was invalid and said so nowhere on the screen. The
// block is drawn ABOVE the entries and describes the form's own container, which is the
// same move the group makes with its fieldset one level down: the finding is rendered on
// the thing it is about, and the thing it is about here is the form.
//
// NOTHING IS SUBMITTED FROM HERE. This component composes an answer and renders the
// schema's verdict on it; the act that sends one is the workflow plan's, arriving with
// the revision it was composed against. That is the console's "absent, not disabled"
// rule rather than a gap: a submit control with no producer is a control that cannot work.
// So the root findings describe the CONTAINER rather than a submit control: the container
// is what exists, and it is what a reader lands in.

import { useId } from "react";

import { SchemaFieldGroup } from "./SchemaFieldGroup.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaFieldList } from "./SchemaFieldList.js";
import { SchemaFormField } from "./SchemaFormField.js";
import { SchemaJsonEditor } from "./SchemaJsonEditor.js";
import { describedByOf, issuesForMember, ROOT_MEMBER_PATH } from "./schema-field-control.js";
import { leafPathOf, type SchemaFormEntry, type SchemaLeafEntry } from "./schema-fields.js";
import { encodeMemberPointer } from "../../bridge/index.js";
import type { SchemaFormState } from "./use-schema-form.js";

export interface SchemaFormProps {
  /** The whole of the form's state, held by the caller so it outlives a re-render. */
  readonly form: SchemaFormState;
}

/** The schema-derived form, drawn or raw. */
export function SchemaForm(props: SchemaFormProps): React.JSX.Element {
  const { form } = props;
  // Minted above the arm rather than inside the one that uses it: the raw arm returns
  // before the fields arm's body is reached, so an id minted down there would be a hook
  // this component calls on one render and not the next.
  const rootIssuesId = useId();

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
    const memberPath = leafPathOf(entry);
    const issues = issuesForMember(form.report, memberPath);
    if (entry.form === "list") {
      return (
        <SchemaFieldList
          list={entry.list}
          entries={form.listEntries(memberPath)}
          onChangeEntry={(index, draft) => {
            form.setListEntryDraft(memberPath, index, draft);
          }}
          onAppend={() => {
            form.appendListEntry(memberPath);
          }}
          onRemove={(index) => {
            form.removeListEntry(memberPath, index);
          }}
          issues={issues}
          // Asked of the form rather than of the report, because a drawn row and a
          // projected array position are not the same number once an unanswered row is
          // dropped — and the sentence about a row with nothing in it is the draft's own.
          issuesForEntry={(index) => form.listEntryIssues(memberPath, index)}
          isActive={form.listIsActive(memberPath)}
          onChangeActive={(isActive) => {
            form.setListActive(memberPath, isActive);
          }}
        />
      );
    }
    return (
      <SchemaFormField
        field={entry.field}
        view={form.memberView(memberPath)}
        onChange={(draft) => {
          form.setMemberDraft(memberPath, draft);
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
        isActive={form.groupIsActive(entry.group.memberPath)}
        onChangeActive={(isActive) => {
          form.setGroupActive(entry.group.memberPath, isActive);
        }}
      />
    ) : (
      renderLeaf(entry)
    );

  const rootIssues = issuesForMember(form.report, ROOT_MEMBER_PATH);
  return (
    <div
      className="meridian-schema-form"
      aria-describedby={describedByOf([rootIssues.length === 0 ? undefined : rootIssuesId])}
    >
      <SchemaFieldIssues issues={rootIssues} issuesId={rootIssuesId} />
      {form.plan.entries.map((entry) => (
        <div
          className="meridian-schema-form__entry"
          key={encodeMemberPointer(
            entry.form === "group" ? entry.group.memberPath : leafPathOf(entry),
          )}
        >
          {renderEntry(entry)}
        </div>
      ))}
    </div>
  );
}
