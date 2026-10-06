import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { type WindowedRowTargetProps } from "#renderer/components/WindowedListRow/WindowedListRow.js";
import { type DiffFileListEntry } from "../file-entries.js";

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
  return (
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
          <DerivedFigure text={String(entry.fileCount)} />
        </>
      ) : (
        <>
          {/* Wire-verbatim path, truncated at the measure; the full string stays in the title. */}
          <span className="meridian-diff-files__path" title={entry.path}>
            {entry.path}
          </span>
          {entry.stepName === undefined ? null : (
            <span className="meridian-diff-files__step" title={entry.stepName}>
              {entry.stepName}
            </span>
          )}
          {entry.changeNotes.length === 0 ? null : (
            <span className="meridian-diff-files__change" title={entry.changeNotes.join(", ")}>
              {entry.changeNotes.join(", ")}
            </span>
          )}
          <span className="meridian-diff-files__counts">
            <DerivedFigure text={`+${String(entry.counts.insertions)}`} />
            <DerivedFigure text={`−${String(entry.counts.deletions)}`} />
          </span>
        </>
      )}
    </button>
  );
}
