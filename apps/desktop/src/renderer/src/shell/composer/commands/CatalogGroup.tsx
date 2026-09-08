// One labelled group of the discovery list: a heading, and the rows under it.
//
// WHY THE LIST IS GROUPED AT ALL. The two halves are not two kinds of the same thing.
// A console entry is an act this window performs; a provider entry is a name the
// provider published and this console will not send. One flat list put them under one
// heading and left the difference to be inferred from which rows happen to carry a
// button — a reading a person only gets after they have already tried one. The group
// label states it before the press, which is where the claim belongs.
//
// `role="group"` AND NOT A SECOND LISTBOX. A listbox is a single selection surface
// with one active row, and the popover's arrow keys walk both halves as one sequence
// — so two listboxes would be two cursors over one gesture. `group` is the role a
// listbox's own children take when its options are sectioned, and the label reaches
// the group through `aria-labelledby` so a screen reader announces the section on
// entering it rather than repeating it on every row.
//
// THE LABEL ELEMENT IS `role="presentation"`. Only `option` and `group` may be a
// listbox's children, so the heading is stripped of its own semantics and survives as
// the group's accessible name — the pattern grouped listboxes are built on. It stays
// visible: the label is the surface's whole point, and a name only a screen reader
// hears would leave every sighted reader with the flat list this replaces.
//
// THE ROW'S FLAT INDEX IS THE CALLER'S AND IS NEVER RE-DERIVED HERE. The popover
// answers keys over one sequence spanning both groups, and an index counted inside a
// group would name a different row from the one `aria-activedescendant` points at.

import { CatalogRow } from "./CatalogRow.js";
import type { CommandCatalogEntry } from "./provider-command-catalog.js";

/** One entry, carrying the position it holds in the popover's single key sequence. */
export interface CatalogGroupRow {
  readonly entry: CommandCatalogEntry;
  /** The index in the popover's flat entry list, which is what the cursor counts. */
  readonly flatIndex: number;
}

export interface CatalogGroupProps {
  readonly rows: readonly CatalogGroupRow[];
  /** What the group is called, in the words the surface offers it under. */
  readonly labelText: string;
  /** The id the heading carries, spent by this group's `aria-labelledby`. */
  readonly labelElementId: string;
  /** The row the popover's cursor is on, in flat coordinates. `-1` while there is none. */
  readonly activeFlatIndex: number;
  /** The DOM id of one row, composed by the popover so both halves agree on it. */
  readonly rowElementId: (flatIndex: number) => string;
  readonly onSelect: (flatIndex: number) => void;
  readonly onRun: (commandId: string) => void;
}

export function CatalogGroup(props: CatalogGroupProps): React.JSX.Element {
  const { rows, activeFlatIndex, rowElementId, onSelect, onRun } = props;
  return (
    <li
      className="meridian-command-discovery__group"
      role="group"
      aria-labelledby={props.labelElementId}
    >
      <span
        className="meridian-command-discovery__group-label"
        id={props.labelElementId}
        role="presentation"
      >
        {props.labelText}
      </span>
      {/* `role="none"` on the inner list: the rows are the outer listbox's options
          through this group, and a second list role would insert a container the
          option's own ancestry may not have. */}
      <ul className="meridian-command-discovery__group-rows" role="none">
        {rows.map((row) => (
          <CatalogRow
            key={row.entry.key}
            entry={row.entry}
            rowElementId={rowElementId(row.flatIndex)}
            isActive={row.flatIndex === activeFlatIndex}
            onSelect={() => {
              onSelect(row.flatIndex);
            }}
            onRun={onRun}
          />
        ))}
      </ul>
    </li>
  );
}
