// The changed-file list and its filter.
//
// A FILE LIST WITH A FILTER, and `DiffPane.tsx`'s density opens the pane on it. So
// the list is the pane's first surface rather than a sidebar bolted beside it,
// and selecting a file narrows the rows to that file — which is what makes a
// forty-file change set navigable without a second scroller to lose your place
// in.
//
// THE FILTER IS A SUBSTRING MATCH OVER THE WIRE-VERBATIM PATH, and deliberately
// nothing cleverer. A fuzzy matcher exists in the console already
// (`palette/subsequence-score.ts`) and belongs to the palette's ranked-result
// problem; a file list is a dozen to a hundred exact strings a person is scanning
// rather than recalling, and a subsequence match over them surfaces paths whose
// letters merely appear in order, which reads as the filter being broken.
//
// THE COUNTS ARE DERIVED FIGURES, NOT WIRE FIGURES. `+12 −3` is the console's own
// arithmetic over the model, so it renders through `DerivedFigure` and never
// through `WireFigure` — the provenance signature rule (`Spec-023` rule 4) is
// about where a number came from, and these came from here.
//
// AND THE COUNTS ARE NOT THE WHOLE CHANGE. A rename, a copy, a mode change, and a
// binary change all live in a git patch's extended headers, so a file whose change is
// only one of those has no hunks and counts `+0 −0` — which, alone, reads as nothing
// having happened to it. The note beside the counts is what the patch actually said,
// composed once by `diff-model.ts` so this list and the row renderer cannot disagree
// about it. The counts stay: they are true, and suppressing them would make an
// extended-header file the one row a reader cannot compare with its neighbours.

import { useId, useMemo, useState } from "react";

import { DerivedFigure, Glyph } from "../../primitives/index.js";
import { DIFF_FILE_LIST_SCROLL_THRESHOLD } from "./diff-bounds.js";
import { diffFileChangeCounts, diffFileChangeNotes, type ConsoleDiffModel } from "./diff-model.js";

export interface DiffFileListProps {
  readonly diff: ConsoleDiffModel;
  /** The path whose rows are shown, or `undefined` for the whole change set. */
  readonly selectedFilePath: string | undefined;
  readonly onSelectFilePath: (path: string | undefined) => void;
}

/** Glyph edge length in a file row, matching the primitives' own inline size. */
const DIFF_FILE_GLYPH_SIZE = 12;

export function DiffFileList(props: DiffFileListProps): React.JSX.Element {
  const filterId = useId();
  const [filterText, setFilterText] = useState("");

  const matchingFiles = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    const files = props.diff.files.map((file) => ({
      path: file.path,
      counts: diffFileChangeCounts(file),
      changeNotes: diffFileChangeNotes(file),
    }));
    return needle === "" ? files : files.filter((file) => file.path.toLowerCase().includes(needle));
  }, [props.diff, filterText]);

  const isScrolling = props.diff.files.length > DIFF_FILE_LIST_SCROLL_THRESHOLD;

  return (
    <div className={`meridian-diff-files${isScrolling ? " meridian-diff-files--scrolling" : ""}`}>
      <label className="meridian-diff-files__filter" htmlFor={filterId}>
        <Glyph name="search" size={DIFF_FILE_GLYPH_SIZE} />
        <span className="meridian-visually-hidden">Filter changed files</span>
        <input
          id={filterId}
          type="search"
          className="meridian-diff-files__filter-input"
          placeholder="Filter files"
          value={filterText}
          onChange={(changeEvent) => {
            setFilterText(changeEvent.target.value);
          }}
        />
      </label>
      <ul className="meridian-diff-files__list">
        <li>
          <button
            type="button"
            className="meridian-diff-files__entry"
            aria-current={props.selectedFilePath === undefined}
            onClick={() => {
              props.onSelectFilePath(undefined);
            }}
          >
            <span className="meridian-diff-files__path">All files</span>
            <DerivedFigure text={String(props.diff.files.length)} />
          </button>
        </li>
        {matchingFiles.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="meridian-diff-files__entry"
              aria-current={props.selectedFilePath === file.path}
              onClick={() => {
                props.onSelectFilePath(file.path);
              }}
            >
              {/* Wire-verbatim path, truncated at the measure with the full string
                  recoverable through the title — the pane subject's own rule. */}
              <span className="meridian-diff-files__path" title={file.path}>
                {file.path}
              </span>
              {file.changeNotes.length === 0 ? null : (
                <span className="meridian-diff-files__change" title={file.changeNotes.join(", ")}>
                  {file.changeNotes.join(", ")}
                </span>
              )}
              <span className="meridian-diff-files__counts">
                <DerivedFigure text={`+${String(file.counts.insertions)}`} />
                <DerivedFigure text={`−${String(file.counts.deletions)}`} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {matchingFiles.length === 0 ? (
        <p className="meridian-diff-files__no-match">No changed file matches that filter.</p>
      ) : null}
    </div>
  );
}
