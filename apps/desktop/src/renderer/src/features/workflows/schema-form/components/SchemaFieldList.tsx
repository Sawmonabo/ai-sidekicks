// An array of one repeated control. An entry is called by its position and removing one
// renumbers the rest, but the row keys on the draft's entry id so per-entry control state
// stays with its entry. An active empty list draws its heading and add control; an inactive
// optional one draws only the control that answers it. Add and remove buttons carry
// accessible names that include the collection (`schema-list-labels.ts`); the visible text is
// short because the fieldset already names the list. Findings about the collection draw on
// this fieldset; findings about one entry draw under that entry.

import { useId } from "react";

import { SchemaActivationControl } from "./SchemaActivationControl.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaListEntry } from "./SchemaListEntry.js";
import { SchemaRequiredMark } from "./SchemaRequiredMark.js";
import type { SchemaScalarDraft } from "../answer/schema-draft.js";
import { describedByOf } from "./field-control-props.js";
import { listAppendLabel, listRemoveLabel } from "./schema-list-labels.js";
import type { SchemaListDescriptor } from "../plan/schema-fields.js";
import type { SchemaListEntryView } from "../answer/schema-projection.js";

/** The props of a repeated-control fieldset. */
export interface SchemaFieldListProps {
  readonly list: SchemaListDescriptor;
  /** Every drawn row, each carrying what it displays and the identity it keys on. */
  readonly entries: readonly SchemaListEntryView[];
  readonly onChangeEntry: (index: number, draft: SchemaScalarDraft) => void;
  readonly onAppend: () => void;
  readonly onRemove: (index: number) => void;
  /** The schema's findings about the list itself, rather than about one entry. */
  readonly issues: readonly string[];
  /** The schema's findings about one entry, asked for by position. */
  readonly issuesForEntry: (index: number) => readonly string[];
  /** Whether somebody is answering this collection. A required one always is. */
  readonly isActive: boolean;
  /** Answer this collection, or leave it unanswered. */
  readonly onChangeActive: (isActive: boolean) => void;
}

/** A repeated control, one per entry, with the two controls that change how many. */
export function SchemaFieldList(props: SchemaFieldListProps): React.JSX.Element {
  const { list, entries } = props;
  const descriptionId = useId();
  const issuesId = useId();
  return (
    <fieldset
      className="meridian-schema-list"
      aria-describedby={describedByOf([
        list.description === undefined ? undefined : descriptionId,
        props.issues.length === 0 ? undefined : issuesId,
      ])}
    >
      <legend className="meridian-schema-list__legend">
        {list.label}
        <SchemaRequiredMark isRequired={list.isRequired} />
        {list.isRequired ? null : (
          <SchemaActivationControl
            isActive={props.isActive}
            onChangeActive={props.onChangeActive}
          />
        )}
      </legend>
      {list.description === undefined ? null : (
        <p className="meridian-schema-field__description" id={descriptionId}>
          {list.description}
        </p>
      )}
      {!props.isActive ? null : (
        <>
          <ol className="meridian-schema-list__items">
            {entries.map((entry, index) => (
              <li className="meridian-schema-list__item" key={entry.entryId}>
                <SchemaListEntry
                  list={list}
                  index={index}
                  view={entry}
                  onChange={(draft) => {
                    props.onChangeEntry(index, draft);
                  }}
                  issues={props.issuesForEntry(index)}
                />
                <button
                  type="button"
                  className="meridian-schema-list__action"
                  aria-label={listRemoveLabel(list, index)}
                  onClick={() => {
                    props.onRemove(index);
                  }}
                >
                  Remove entry {index + 1}
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="meridian-schema-list__action"
            aria-label={listAppendLabel(list)}
            onClick={props.onAppend}
          >
            Add an entry
          </button>
        </>
      )}
      <SchemaFieldIssues issues={props.issues} issuesId={issuesId} />
    </fieldset>
  );
}
