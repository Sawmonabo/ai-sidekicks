// One entry of a list, with the chrome that makes it a control a person can use.
//
// AN ENTRY IS NAMED BY WHERE IT SITS, AND THE NAME IS SPOKEN RATHER THAN DRAWN. The
// legend names the collection and the ordered list draws the position, so a visible
// "Reviewers, entry 2" above every row would say twice what the layout already says once.
// It is still a `<label>` and not an `aria-label`, because that is the primitive the
// scalar fields use and the association it makes is a real one — a click on it reaches
// the control — while `meridian-visually-hidden` takes it out of the picture and leaves
// it in the tree.
//
// AND THE ENTRY'S FINDINGS ARE ITS OWN. The validator addresses an array member by index,
// so a length, a range, or an enum failure belongs under the control that holds the value
// it is about. A list of four entries with one bad one would otherwise report one
// unattributed sentence beneath all four — or, as it did, report nothing anywhere.
//
// THE IDS ARE MINTED PER ENTRY rather than composed from the member path, because two
// forms over one schema can be mounted at once — a definition's preview beside a run's
// answer — and a path-derived id would be the same id in both documents.

import { useId } from "react";

import { SchemaFieldControl } from "./SchemaFieldControl.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { describedByOf } from "./schema-field-control.js";
import { listEntryLabel, type SchemaListDescriptor } from "./schema-fields.js";

export interface SchemaListEntryProps {
  /** The collection this entry belongs to, which is what names it and types it. */
  readonly list: SchemaListDescriptor;
  /** Where it sits. Zero-based; the spoken position is the label rule's. */
  readonly index: number;
  /** Whatever the answer holds at this position. Not yet proved to be anything. */
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  /** The schema's findings about this entry, addressed by its own indexed path. */
  readonly issues: readonly string[];
}

/** One repeated control, named for where it sits and carrying its own verdict. */
export function SchemaListEntry(props: SchemaListEntryProps): React.JSX.Element {
  const controlId = useId();
  const issuesId = useId();
  return (
    <div className="meridian-schema-list__entry">
      <label className="meridian-visually-hidden" htmlFor={controlId}>
        {listEntryLabel(props.list, props.index)}
      </label>
      <SchemaFieldControl
        field={props.list.item}
        value={props.value}
        onChange={props.onChange}
        controlId={controlId}
        describedById={describedByOf([props.issues.length === 0 ? undefined : issuesId])}
      />
      <SchemaFieldIssues issues={props.issues} issuesId={issuesId} />
    </div>
  );
}
