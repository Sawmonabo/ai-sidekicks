// One entry of a list with its chrome. Its name is spoken, not drawn: a visually hidden
// `<label>`, since the legend and list order already show it. Findings at the entry's
// indexed path draw under its control. Ids are minted per entry, not from the member path,
// because two forms over one schema can be mounted at once.

import { useId } from "react";

import { SchemaFieldControl } from "./SchemaFieldControl.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import type { SchemaScalarDraft } from "../answer/schema-draft.js";
import { describedByOf } from "./field-control-props.js";
import { listEntryLabel } from "./schema-list-labels.js";
import type { SchemaListDescriptor } from "../plan/schema-fields.js";
import type { SchemaControlView } from "../answer/schema-projection.js";

/** The props of one repeated control. */
export interface SchemaListEntryProps {
  /** The collection this entry belongs to, which is what names it and types it. */
  readonly list: SchemaListDescriptor;
  /** Where it sits. Zero-based; the spoken position is the label rule's. */
  readonly index: number;
  /** What this row's control displays, projected from the entry node it holds. */
  readonly view: SchemaControlView;
  readonly onChange: (draft: SchemaScalarDraft) => void;
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
        value={props.view.value}
        unreadableText={props.view.unreadableText}
        onChange={props.onChange}
        controlId={controlId}
        describedById={describedByOf([props.issues.length === 0 ? undefined : issuesId])}
      />
      <SchemaFieldIssues issues={props.issues} issuesId={issuesId} />
    </div>
  );
}
