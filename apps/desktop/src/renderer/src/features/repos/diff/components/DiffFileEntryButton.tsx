import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { type WindowedRowTargetProps } from "#renderer/components/WindowedListRow/WindowedListRow.js";
import { type DiffFileListEntry } from "../file-entries.js";
import { DiffStepMark } from "./DiffStepMark.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** What one file-list row's control is drawn from, plus the row's target props. */
export type DiffFileEntryButtonProps = {
  readonly entry: DiffFileListEntry;
  readonly isSelected: boolean;
  readonly onSelectFilePath: (path: string | undefined) => void;
} & WindowedRowTargetProps;

/**
 * One row's control: the reset at row zero, or one changed file. The list has one tab stop, so
 * the roving `tabIndex` and target marker (`lib/windowed-row-markers.ts`) arrive together from
 * the row's renderer form and go onto this button alone. Marking the `<li>` while the stop sat
 * on the button left `focus()` a no-op in Chromium, so the ring never moved.
 */
export function DiffFileEntryButton({
  entry,
  isSelected,
  onSelectFilePath,
  ...targetProps
}: DiffFileEntryButtonProps): React.JSX.Element {
  const selectedPath = entry.kind === "all-files" ? undefined : entry.path;
  // The path is the button's hover label, so the keyboard on the button shows a truncated path
  // whole, as the pointer anywhere on it does.
  return (
    <HoverLabel text={selectedPath} textIs="visible-text">
      <button
        type="button"
        className="meridian-diff-files__entry meridian-focus-inset"
        aria-current={isSelected}
        {...targetProps}
        onClick={() => {
          onSelectFilePath(selectedPath);
        }}
      >
        {entry.kind === "all-files" ? (
          <>
            <span className="meridian-diff-files__path">All files</span>
            <DerivedFigure text={formatCount(entry.fileCount)} />
          </>
        ) : (
          <>
            {/* Wire-verbatim path, truncated at the measure. */}
            <span className="meridian-diff-files__path">{entry.path}</span>
            {entry.stepName === undefined ? null : <DiffStepMark stepName={entry.stepName} />}
            {entry.changeNotes.length === 0 ? null : (
              <HoverLabel text={entry.changeNotes.join(", ")} textIs="visible-text">
                <span className="meridian-diff-files__change">{entry.changeNotes.join(", ")}</span>
              </HoverLabel>
            )}
            <span className="meridian-diff-files__counts">
              <DerivedFigure text={`+${formatCount(entry.counts.insertions)}`} />
              <DerivedFigure text={`−${formatCount(entry.counts.deletions)}`} />
            </span>
          </>
        )}
      </button>
    </HoverLabel>
  );
}
