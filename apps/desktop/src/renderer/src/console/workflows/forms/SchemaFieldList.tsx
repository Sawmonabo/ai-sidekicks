// An array of one repeated control.
//
// THE ENTRIES ARE POSITIONS AND THE POSITION IS THE NAME. An array member has no key of
// its own, so each entry is labelled by where it sits, and removing one renumbers the
// rest — which is what the answer does too, because the list is rebuilt rather than
// holed. Anything else would leave the third entry called "3" while the answer carried
// it second.
//
// THE KEY IS THE INDEX, WHICH IS RIGHT HERE AND WRONG ALMOST EVERYWHERE ELSE. These
// entries carry no identity: two identical strings in a list are the same value twice,
// and there is nothing else to key them by. The list is edited by the person looking at
// it, one entry at a time, so the reconciliation an identity key would buy is a
// reconciliation nothing here needs.
//
// AN EMPTY LIST IS AN ANSWER. It renders its heading, its add control, and no entries —
// never a wait and never an absence, because a person who has added nothing yet has an
// empty list and not an unread one.
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

import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaListEntry } from "./SchemaListEntry.js";
import { SchemaRequiredMark } from "./SchemaRequiredMark.js";
import { describedByOf } from "./schema-field-control.js";
import { listAppendLabel, listRemoveLabel } from "./schema-list-labels.js";
import type { SchemaListDescriptor } from "./schema-fields.js";

export interface SchemaFieldListProps {
  readonly list: SchemaListDescriptor;
  readonly items: readonly unknown[];
  readonly onChangeItem: (index: number, value: unknown) => void;
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
}

/** A repeated control, one per entry, with the two controls that change how many. */
export function SchemaFieldList(props: SchemaFieldListProps): React.JSX.Element {
  const { list, items } = props;
  const issuesId = useId();
  return (
    <fieldset
      className="meridian-schema-list"
      aria-describedby={describedByOf([props.issues.length === 0 ? undefined : issuesId])}
    >
      <legend className="meridian-schema-list__legend">
        {list.label}
        <SchemaRequiredMark isRequired={list.isRequired} />
      </legend>
      {list.description === undefined ? null : (
        <p className="meridian-schema-field__description">{list.description}</p>
      )}
      <ol className="meridian-schema-list__items">
        {items.map((item, index) => (
          <li className="meridian-schema-list__item" key={index}>
            <SchemaListEntry
              list={list}
              index={index}
              value={item}
              onChange={(value) => {
                props.onChangeItem(index, value);
              }}
              issues={props.issuesForEntry(index)}
            />
            <button
              type="button"
              className="meridian-workflow__action"
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
        className="meridian-workflow__action"
        aria-label={listAppendLabel(list)}
        onClick={props.onAppend}
      >
        Add an entry
      </button>
      <SchemaFieldIssues issues={props.issues} issuesId={issuesId} />
    </fieldset>
  );
}
