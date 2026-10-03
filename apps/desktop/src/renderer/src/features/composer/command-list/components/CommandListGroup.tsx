// One labeled group of the discovery list. Console acts and provider names this console will
// not send are grouped so the difference is stated before a press. `role="group"` rather than a
// second listbox, since the arrow keys walk both halves as one sequence; the label is
// `role="presentation"` (only option and group may be listbox children) and stays visible. The
// flat index is the caller's, so it matches `aria-activedescendant`.

import { CommandListRow } from "./CommandListRow.js";
import type { CommandListEntry } from "../command-list-entries.js";

/** One entry, carrying the position it holds in the popover's single key sequence. */
export interface CommandListGroupRow {
  readonly entry: CommandListEntry;
  /** The index in the popover's flat entry list, which is what the cursor counts. */
  readonly flatIndex: number;
}

/** Props for one group of rows under a label. */
export interface CommandListGroupProps {
  readonly rows: readonly CommandListGroupRow[];
  /** What the group is called, in the words the command list offers it under. */
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

/** A labeled group of command rows inside the discovery listbox. */
export function CommandListGroup(props: CommandListGroupProps): React.JSX.Element {
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
      {/* `role="none"` on the inner list: the rows are the outer listbox's options. */}
      <ul className="meridian-command-discovery__group-rows" role="none">
        {rows.map((row) => (
          <CommandListRow
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
