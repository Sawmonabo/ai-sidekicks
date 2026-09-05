import { DerivedFigure } from "../../primitives/index.js";
import { type DiffFileListEntry } from "./diff-file-entries.js";

/** One row's control: the reset at row zero, or one changed file. */
export function DiffFileEntryButton(props: {
  readonly entry: DiffFileListEntry;
  readonly isSelected: boolean;
  readonly isTabbable: boolean;
  readonly onSelectFilePath: (path: string | undefined) => void;
}): React.JSX.Element {
  const { entry } = props;
  const selectedPath = entry.kind === "all-files" ? undefined : entry.path;
  return (
    <button
      type="button"
      className="meridian-diff-files__entry"
      aria-current={props.isSelected}
      // ONE TAB STOP FOR THE WHOLE LIST, which is what makes the arrows necessary and
      // what stops a windowed list from putting a moving number of stops in the page's
      // tab order.
      tabIndex={props.isTabbable ? 0 : -1}
      onClick={() => {
        props.onSelectFilePath(selectedPath);
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
