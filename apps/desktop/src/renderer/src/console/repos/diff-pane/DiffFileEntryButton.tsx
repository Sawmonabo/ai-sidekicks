import { DerivedFigure } from "../../primitives/index.js";
import { type WindowedRowTargetProps } from "../windowed-row-target.js";
import { type DiffFileListEntry } from "./diff-file-entries.js";

/** One row's control, and the row's own statement that this element holds its stop. */
export type DiffFileEntryButtonProps = {
  readonly entry: DiffFileListEntry;
  readonly isSelected: boolean;
  readonly onSelectFilePath: (path: string | undefined) => void;
} & WindowedRowTargetProps;

/**
 * One row's control: the reset at row zero, or one changed file.
 *
 * ONE TAB STOP FOR THE WHOLE LIST, and the row is what says so. The roving `tabIndex`
 * and the target marker arrive together from the row primitive's renderer form
 * (`primitives/windowed-row-markers.ts` declares the marker) and are spread onto this
 * button and onto nothing else — which is what makes the marked element and the
 * focusable element the same element. Computing the index here from an `isTabbable`
 * prop left the row marking ITSELF as the focus target while the stop sat on this
 * button, so the roving effect focused an `<li>` with no `tabindex`, which Chromium
 * ignores: the ring never moved and the next Tab left the list.
 *
 * The primitive is named by module rather than by symbol on purpose: the architecture
 * census that reports a hand-rolled window excuses a row component whose SOURCE TEXT
 * carries the primitive's name, prose included, so a mention here would switch off the
 * planted control that proves the census can still see one.
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
      className="meridian-diff-files__entry"
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
          {/* Wire-verbatim path, truncated at the measure with the full string
              recoverable through the title — the pane subject's own rule. */}
          <span className="meridian-diff-files__path" title={entry.path}>
            {entry.path}
          </span>
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
