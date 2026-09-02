// The diff pane: what changed between two named states, and who is accountable
// for each line.
//
// `Spec-023 §Console Design (Meridian)` §10.6 gives the pane that job, and this
// file is the chrome around it — the header that names the compared states and
// the attribution, the toolbar of renderer-local view controls, the changed-file
// list, and the region the rows are read inside. The rows themselves are
// `DiffRenderer`'s, because the inline timeline card renders exactly the same
// ones and a second implementation would let a one-character edit read as one
// character in one surface and something else in the other.
//
// THE DIFF ARRIVES AS A PROP AND THERE IS NO CALLER THAT FILLS IT YET. Creating a
// diff is `gitflow.diffArtifactCreate`, a `Plan-023 §Console growth slate` row
// (`gitflow-actions`, owned by Spec-011): the contracts package exports no
// `gitflow` module and the growth port registers no operation for it, so there is
// nothing to call and nothing to refuse with. That is why the absent case renders
// `not-checked` rather than a refusal — a refusal names a call that was made, and
// no call was made.
//
// WHY THE ABSENCE IS `not-checked` AND NOT `empty`. `empty` asserts the read came
// back with nothing, which for a diff means asserting a workspace has no changes.
// Nothing has been read. Rendering `empty` here would have the console state, in
// its own voice, a fact it never established. (`DiffRenderer` DOES render `empty`
// — for a diff that WAS read and holds no changed line. Those are different facts
// and the two surfaces spend the two kinds correctly.)
//
// WHY THE VIEW CONTROLS ARE LOCAL STATE AND NOT PERSISTED HERE. Everything the
// toolbar toggles is a reading preference over one pane's content. The console's
// durable UI state goes through `persistence/` and its closed value-class
// enumeration; a preference this pane invents has no class, and minting one for a
// toggle before a person has asked for it to be remembered is a durable write
// nobody requested.
//
// WHY THE FOCUS HUE IS NOT READ. `ConsolePaneContext.focusHue` colours the ring
// drawn AROUND a focused pane, and the deck draws it: the deck knows which of its
// panes has focus and this body does not. A body that painted its own ring would
// be a second answer to a question the deck already owns.

import { useCallback, useId, useState } from "react";

import { Chip, Glyph, Nothing } from "../../primitives/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";
import { DiffFileList } from "./DiffFileList.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { DiffToolbar, useDiffViewControls } from "./DiffToolbar.js";
import {
  diffAttributionSubjectId,
  type ConsoleDiffModel,
  type DiffAttributionMode,
} from "./diff-model.js";
import { expandGap, type DiffGapExpansion } from "./hunk-virtualization.js";

export interface DiffPaneProps {
  readonly context: ConsolePaneContext;
  /**
   * The diff to render. Absent until a wire produces one — see the header. The
   * prop exists rather than being a fetch this body performs, because the fetch
   * belongs to the module that owns the wire and this pane owns the chrome.
   */
  readonly diff?: ConsoleDiffModel;
}

/** What the attribution badge says on each arm, and how the subject is labelled. */
const ATTRIBUTION_COPY: Readonly<
  Record<DiffAttributionMode, { readonly label: string; readonly subject: string }>
> = {
  run_attributed: { label: "Run-attributed", subject: "Run" },
  workspace_fallback: { label: "Workspace fallback", subject: "Workspace" },
};

export function DiffPane(props: DiffPaneProps): React.JSX.Element {
  const { context, diff } = props;
  const headingId = useId();
  const viewControls = useDiffViewControls({ showAttributionMarks: true });
  const [expansion, setExpansion] = useState<DiffGapExpansion>(() => new Map());
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>(undefined);

  // §10.6's density rule: the pane opens on the changed-file list with the first
  // file expanded. Selecting a file narrows the rows to it; selecting none reads
  // the whole change set, which is what "the first file expanded" degrades to
  // once a reader has scrolled past it.
  //
  // THE NARROWING IS THE RENDERER'S AND NOT A FILTERED MODEL, which is what makes
  // the handler below correct. A filtered model renumbers its files, so a gap in
  // the second file arrives here as file zero and this lookup would resolve the
  // FIRST file's context — expanding by the wrong count, or by nothing.
  const handleExpandGap = useCallback(
    (fileIndex: number, hunkIndex: number) => {
      const available = diff?.files[fileIndex]?.hunks[hunkIndex]?.precedingContext.length ?? 0;
      setExpansion((previous) => expandGap(previous, fileIndex, hunkIndex, available));
    },
    [diff],
  );

  return (
    <section
      className="meridian-repos-pane meridian-repos-pane--diff"
      aria-labelledby={headingId}
      data-pane-id={context.paneId}
    >
      <header className="meridian-repos-pane__header">
        <h2 className="meridian-repos-pane__heading" id={headingId}>
          <Glyph name="diff" />
          Diff
        </h2>
        {context.entity === undefined ? null : (
          // Wire-verbatim and never shortened: two workspaces whose ids differ in
          // their tail read identically once a renderer abbreviates them, and this
          // is the only place the pane says which one it is a view of. The full
          // string stays recoverable through the title even where the measure
          // truncates the display copy.
          <span
            className="meridian-repos-pane__subject"
            title={context.entity.id}
            aria-label={`Subject: ${context.entity.kind} ${context.entity.id}`}
          >
            {context.entity.id}
          </span>
        )}
      </header>
      {diff === undefined ? (
        <div className="meridian-repos-pane__body">
          <Nothing
            kind="not-checked"
            placement="surface"
            title="No diff has been asked for."
            detail="A diff names two states and the run or workspace it is attributed to. None has been requested for this pane, so the console is not reporting that nothing changed."
          />
        </div>
      ) : (
        <>
          <DiffSubjectBar diff={diff} />
          <DiffToolbar controls={viewControls} />
          <div className="meridian-diff-pane__content">
            <DiffFileList
              diff={diff}
              selectedFilePath={selectedFilePath}
              onSelectFilePath={setSelectedFilePath}
            />
            <DiffRenderer
              model={diff}
              shownFilePath={selectedFilePath}
              viewMode={viewControls.viewMode}
              showAttributionMarks={viewControls.showAttributionMarks}
              wrapLongLines={viewControls.wrapLongLines}
              showWhitespaceChanges={viewControls.showWhitespaceChanges}
              expansion={expansion}
              onExpandGap={handleExpandGap}
              label={`Diff, ${diff.baseRef} to ${diff.headRef}`}
            />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The attribution badge and the compared states.
 *
 * The badge is `neutral` on BOTH arms, and that is the two-hue rule rather than
 * an oversight: a workspace-fallback diff is a lower attribution quality, not a
 * failure and not something a person has to act on, so it earns neither red nor
 * amber. It is distinguished by its words and by which subject it names — and a
 * `workspace_fallback` diff renders its workspace and never a run, which the
 * union makes true by construction rather than by this component remembering to.
 */
function DiffSubjectBar(props: { readonly diff: ConsoleDiffModel }): React.JSX.Element {
  const copy = ATTRIBUTION_COPY[props.diff.attribution.mode];
  const subjectId = diffAttributionSubjectId(props.diff.attribution);
  return (
    <div className="meridian-diff-pane__subject-bar">
      <Chip label={copy.label} glyph="agent" />
      <span className="meridian-diff-pane__attribution-subject" title={subjectId}>
        {`${copy.subject}: `}
        <Chip label={subjectId} mono />
      </span>
      <span className="meridian-diff-pane__refs">
        <Chip label={props.diff.baseRef} mono />
        <Glyph name="diff" />
        <Chip label={props.diff.headRef} mono />
      </span>
    </div>
  );
}
