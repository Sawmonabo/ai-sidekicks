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

import { SchemaFieldControl } from "./SchemaFieldControl.js";
import type { SchemaListDescriptor } from "./schema-fields.js";

export interface SchemaFieldListProps {
  readonly list: SchemaListDescriptor;
  readonly items: readonly unknown[];
  readonly onChangeItem: (index: number, value: unknown) => void;
  readonly onAppend: () => void;
  readonly onRemove: (index: number) => void;
  /** The schema's findings about the list itself, rather than about one entry. */
  readonly issues: readonly string[];
}

/** A repeated control, one per entry, with the two controls that change how many. */
export function SchemaFieldList(props: SchemaFieldListProps): React.JSX.Element {
  const { list, items } = props;
  return (
    <fieldset className="meridian-schema-list">
      <legend className="meridian-schema-list__legend">
        {list.label}
        {list.isRequired ? (
          <span className="meridian-schema-field__required"> required</span>
        ) : null}
      </legend>
      {list.description === undefined ? null : (
        <p className="meridian-schema-field__description">{list.description}</p>
      )}
      <ol className="meridian-schema-list__items">
        {items.map((item, index) => (
          <li className="meridian-schema-list__item" key={index}>
            <SchemaFieldControl
              field={list.item}
              value={item}
              onChange={(value) => {
                props.onChangeItem(index, value);
              }}
              controlId={`${list.memberPath.join(".")}-${String(index)}`}
              describedById={undefined}
            />
            <button
              type="button"
              className="meridian-workflow__action"
              onClick={() => {
                props.onRemove(index);
              }}
            >
              Remove entry {index + 1}
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="meridian-workflow__action" onClick={props.onAppend}>
        Add an entry
      </button>
      {props.issues.length === 0 ? null : (
        <ul className="meridian-schema-field__issues">
          {props.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
