// An array of one repeated control.
//
// THE ENTRIES ARE POSITIONS AND THE POSITION IS THE NAME. An array member has no key of
// its own, so each entry is labelled by where it sits, and removing one renumbers the
// rest — which is what the answer does too, because the list is rebuilt rather than
// holed. Anything else would leave the third entry called "3" while the answer carried
// it second.
//
// THE KEY IS THE ENTRY'S OWN IDENTITY AND NEVER ITS POSITION. An entry carries no value
// that distinguishes it — two identical strings in a list are the same value twice — so
// the draft mints an id when the entry is ADDED and the row keys on that
// (`schema-draft.ts`). Keyed by index, a row holding control state the draft now carries
// for it — an unreadable figure — was reused or unmounted under the wrong entry the
// moment an earlier entry was removed, so the invalid text moved to a neighbour or
// disappeared. The position is still what the entry is CALLED, because an array member
// has no name of its own; it is no longer what React thinks the entry is.
//
// AN ANSWERED EMPTY LIST IS AN ANSWER, AND AN UNANSWERED ONE IS NOT THE SAME THING. A
// collection somebody is answering renders its heading, its add control, and no entries —
// never a wait and never an absence, because a person who has added nothing yet has an
// empty list. An OPTIONAL collection nobody has answered renders neither the entries nor
// the add control and offers the one control that answers it, exactly as an optional
// section does: zero rows would otherwise be the display for both states, so `[]` — the
// only answer a root demanding one member and a `maxItems: 0` array accepts — was a state
// this form could not reach. A required collection is answered from the mount and is
// offered no such control, because there is no state for it to reach.
//
// AND THE COLLECTION'S DESCRIPTION IS PART OF WHAT THE FIELDSET SAYS. The schema's own
// instructions were drawn under the legend and named in nothing, so a person moving among
// the entry, add, and remove controls heard the collection's name and never the sentence
// explaining what the entries should contain. Both the description and the findings are
// attached through the one attribute, in that order, as a scalar field's chrome does.
//
// THE TWO CONTROLS THAT CHANGE HOW MANY ARE SPOKEN WITH THE COLLECTION AND DRAWN WITHOUT
// IT. The legend names the collection to a reader moving down the form and is no part of
// a button's accessible name, so a form with two lists offered two controls called "Add
// an entry" and two called "Remove entry 1" — identical to anybody moving between
// buttons, and each of them changing a collection that person had not chosen. Both names
// are composed in `schema-list-labels.ts` beside the entry label they are built from, and the
// visible text is unchanged: inside the fieldset the short one is already unambiguous.
//
// TWO KINDS OF FINDING AND TWO PLACES FOR THEM. What the schema says about the COLLECTION
// — how few entries, how many, whether two of them are the same — is about this fieldset
// and is drawn against it. What it says about one entry is about that entry, is addressed
// by an indexed path, and is drawn by `SchemaListEntry` under the control it is about. A
// list asking only for the unindexed path got the first and silently dropped the second.

import { useId } from "react";

import { SchemaActivationControl } from "./SchemaActivationControl.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaListEntry } from "./SchemaListEntry.js";
import { SchemaRequiredMark } from "./SchemaRequiredMark.js";
import type { SchemaScalarDraft } from "./schema-draft.js";
import { describedByOf } from "./schema-field-control.js";
import { listAppendLabel, listRemoveLabel } from "./schema-list-labels.js";
import type { SchemaListDescriptor } from "./schema-fields.js";
import type { SchemaListEntryView } from "./schema-projection.js";

export interface SchemaFieldListProps {
  readonly list: SchemaListDescriptor;
  /** Every drawn row, each carrying what it displays and the identity it keys on. */
  readonly entries: readonly SchemaListEntryView[];
  readonly onChangeEntry: (index: number, draft: SchemaScalarDraft) => void;
  readonly onAppend: () => void;
  readonly onRemove: (index: number) => void;
  /** The schema's findings about the list itself, rather than about one entry. */
  readonly issues: readonly string[];
  /**
   * The schema's findings about one entry, asked for by position.
   *
   * A function rather than an array aligned with `items`, so there is no second length to
   * keep true: an array one entry short would render a control's verdict under its
   * neighbour, which is worse than the silence this replaces.
   */
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
