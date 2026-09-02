// The diff pane: what changed between two named states, and who is accountable
// for each line.
//
// THE PANE'S JOB IS THIS FAMILY'S TO STATE — `Spec-023 §Console Design (Meridian)`
// puts each surface's composition in the console's code — and this
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

import { useId } from "react";

import { Chip, Glyph, Nothing } from "../../primitives/index.js";
import { type ConsolePaneContext } from "../../seats/index.js";
import { DiffFileList } from "./DiffFileList.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { DiffToolbar, useDiffViewControls } from "./DiffToolbar.js";
import {
  diffAttributionSubjectId,
  type ConsoleDiffModel,
  type DiffAttributionMode,
} from "./diff-model.js";
import { useDiffModelViewState } from "./diff-view-state.js";

/**
 * This body's own address arm, narrowed off the union the deck hands every pane.
 *
 * `ConsolePaneContext` is a discriminated union over the pane kind, so a body typed
 * on the whole union can read an entity of a kind it cannot render — which is the
 * defect the union was minted to close. Narrowing here is what makes `entity`
 * required and its kind one of the five a diff is opened over, by the compiler
 * rather than by this file remembering.
 */
type DiffPaneContext = Extract<ConsolePaneContext, { readonly kind: "diff" }>;

/**
 * The entity kinds a diff can be a view of, READ OFF the address rather than listed.
 *
 * `Spec-023 §The surface set` gives the diff pane the sidebar card's own subject list
 * — a repo, workspace, worktree, invite, or member — and `seats/pane-address.ts` is
 * where that list is declared. Deriving it means a kind added there fails to compile
 * in the table below until this family has said what that subject's changes render.
 */
type DiffSubjectKind = DiffPaneContext["entity"]["kind"];

/**
 * What the pane says when no diff has been asked for, per subject kind.
 *
 * ONE ENTRY PER KIND, and the totality is the point: the diff wire is unregistered
 * (`Plan-023 §Console growth slate`'s `gitflow-actions` row, owned by `Spec-011`), so
 * every one of these subjects reaches this pane with nothing to render — and a single
 * sentence written for a working tree would tell a person looking at a REPOSITORY
 * that their checkout is unchanged, which is a claim about a workspace this pane was
 * never opened over. Each sentence says what that subject's changes would be and that
 * nothing was asked, and none of them renders blank.
 *
 * The two collaboration subjects are stated rather than omitted for the same reason.
 * What an invitation's or a member's changes MEAN is that family's question and not
 * this one's; what this pane owes either of them is an honest absence rather than an
 * empty region, and that is what these two say.
 */
const ABSENT_DIFF_COPY: Readonly<
  Record<DiffSubjectKind, { readonly title: string; readonly detail: string }>
> = {
  workspace: {
    title: "No diff has been asked for.",
    detail:
      "A diff names two states and the run or workspace it is attributed to. None has been requested for this workspace, so the console is not reporting that nothing changed.",
  },
  worktree: {
    title: "No diff has been asked for.",
    detail:
      "A diff names two states and the run or workspace it is attributed to. None has been requested for this execution root, so the console is not reporting that nothing changed.",
  },
  repo: {
    title: "A repository's changes are not read here yet.",
    detail:
      "Changes belong to a checkout, and a repository can hold several. Nothing resolves this repository to the workspace a diff would be taken over on this build, so none has been requested — and the console is not reporting that this repository is unchanged.",
  },
  invite: {
    title: "An invitation's changes are not read here yet.",
    detail:
      "An invitation has no working tree, and what its changes are is settled by the family that owns the card, not by this pane. Nothing has been requested, so nothing is being reported about it.",
  },
  participant: {
    title: "A member's changes are not read here yet.",
    detail:
      "A member's changes span every root they have worked in, and nothing on this build gathers them. Nothing has been requested, so the console is not reporting that this member has changed nothing.",
  },
};

export interface DiffPaneProps {
  readonly context: DiffPaneContext;
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
  // This pane's own density: it opens on the changed-file list with the first
  // file expanded. Selecting a file narrows the rows to it; selecting none reads
  // the whole change set, which is what "the first file expanded" degrades to
  // once a reader has scrolled past it.
  //
  // BOTH PIECES ARE THE MODEL'S AND NOT THE PANE'S, so they live in a hook that
  // drops them when the diff does — a selected path the next diff does not
  // contain would narrow the rows to nothing, and the renderer would report two
  // identical states over a change set that has changes. The toolbar's four
  // toggles are the pane's and are deliberately not reset with them.
  const modelViewState = useDiffModelViewState(diff);

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
        {/*
          Wire-verbatim and never shortened: two workspaces whose ids differ in their
          tail read identically once a renderer abbreviates them, and this is the only
          place the pane says which one it is a view of. The full string stays
          recoverable through the title even where the measure truncates the display
          copy. Unconditional now, because a diff address carries its entity: the arm
          this body is narrowed to has no shape in which the subject is absent.
        */}
        <span
          className="meridian-repos-pane__subject"
          title={context.entity.id}
          aria-label={`Subject: ${context.entity.kind} ${context.entity.id}`}
        >
          {context.entity.id}
        </span>
      </header>
      {diff === undefined ? (
        <div className="meridian-repos-pane__body">
          <Nothing
            kind="not-checked"
            placement="surface"
            title={ABSENT_DIFF_COPY[context.entity.kind].title}
            detail={ABSENT_DIFF_COPY[context.entity.kind].detail}
          />
        </div>
      ) : (
        <>
          <DiffSubjectBar diff={diff} />
          <DiffToolbar controls={viewControls} />
          <div className="meridian-diff-pane__content">
            <DiffFileList
              diff={diff}
              selectedFilePath={modelViewState.selectedFilePath}
              onSelectFilePath={modelViewState.selectFilePath}
            />
            <DiffRenderer
              model={diff}
              shownFilePath={modelViewState.selectedFilePath}
              viewMode={viewControls.viewMode}
              showAttributionMarks={viewControls.showAttributionMarks}
              wrapLongLines={viewControls.wrapLongLines}
              showWhitespaceChanges={viewControls.showWhitespaceChanges}
              expansion={modelViewState.expansion}
              onExpandGap={modelViewState.expandGapAt}
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
