// A human phase's form: the controls its schema declares, or the raw editor beside the
// reason it has none. The arm arrives already decided, so this branch is exhaustive. Nothing
// is submitted here: `SchemaFormAnswer` owns the act. Findings are asked for by the path the
// validator reports them at: a group's own path, an array's path and its indexed entries, and
// the empty path for root constraints, which draw above the entries on the form's container.

import { useId } from "react";

import { SchemaFieldGroup } from "./SchemaFieldGroup.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaFieldList } from "./SchemaFieldList.js";
import { SchemaFormField } from "./SchemaFormField.js";
import { SchemaJsonEditor } from "./SchemaJsonEditor.js";
import { describedByOf, issuesForMember, ROOT_MEMBER_PATH } from "./field-control-props.js";
import { leafPathOf, type SchemaFormEntry, type SchemaLeafEntry } from "../plan/schema-fields.js";
import { encodeMemberPointer } from "../schema-member-path.js";
import type { SchemaFormState } from "../hooks/useSchemaForm.js";

/** The props of the schema-derived form. */
export interface SchemaFormProps {
  /** The whole of the form's state, held by the caller so it outlives a re-render. */
  readonly form: SchemaFormState;
}

/** The schema-derived form, drawn or raw. */
export function SchemaForm(props: SchemaFormProps): React.JSX.Element {
  const { form } = props;
  // Minted above the arms: the raw arm returns early, so a hook called below would run on
  // one render and not the next.
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
          // Asked of the form because a drawn row and a projected array position differ once
          // an unanswered row is dropped.
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
