// The diff pane: a change set, the files it touches, and the rows inside them.
//
// THE PANE'S FRAME IS NOT THIS MODULE'S. `seats/ConsolePaneChrome` draws the section,
// the kind glyph, the breadcrumb, the control strip, and the body box for every pane
// kind in the console; what this file returns is the BODY that goes inside it. The
// section, its tab stop, its accessible name, and the actor's hue all arrive from
// there, which is why none of them is set here and why the pane is named by its whole
// address trail rather than by the word "Diff".

import { Nothing } from "../../primitives/index.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../seats/index.js";
import { DiffFileList } from "./DiffFileList.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { DiffToolbar, useDiffViewControls } from "./DiffToolbar.js";
import { type ConsoleDiffModel } from "./diff-model.js";
import { useDiffModelViewState } from "./diff-view-state.js";
import { DiffSubjectBar } from "./DiffSubjectBar.js";

/**
 * This body's own address arm, narrowed off the union the deck hands every pane.
 *
 * `PaneContextOf` is the seat's own narrowing rather than a second `Extract` written
 * here: one registry holds every kind and a body does not, so the narrowing is stated
 * once where the chrome states it. It is what makes `entity` required and its kind one
 * of the five a diff is opened over, by the compiler rather than by this file
 * remembering.
 */
type DiffPaneContext = PaneContextOf<"diff">;

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

export function DiffPane(props: DiffPaneProps): React.JSX.Element {
  const { context, diff } = props;
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
    <ConsolePaneChrome
      kind="diff"
      sessionId={context.sessionStore?.sessionId}
      // Unconditional: a diff address carries its entity, so the arm this body is
      // narrowed to has no shape in which the subject is absent. The trail renders the
      // id wire-verbatim, which is what the pane's own subject line used to say — and
      // it is never shortened, because two workspaces whose ids differ in their tail
      // read identically once a renderer abbreviates them.
      entity={context.entity}
      focusHue={context.focusHue}
    >
      {diff === undefined ? (
        <div className="meridian-diff-pane__absence">
          <Nothing
            kind="not-checked"
            placement="surface"
            title={ABSENT_DIFF_COPY[context.entity.kind].title}
            detail={ABSENT_DIFF_COPY[context.entity.kind].detail}
          />
        </div>
      ) : (
        // A column of its own inside the chrome's body box, because the body scrolls
        // as one and this surface has three bands: the attribution strip, the
        // toolbar, and the list-and-rows pair that takes the rest of the height.
        <div className="meridian-diff-pane">
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
        </div>
      )}
    </ConsolePaneChrome>
  );
}
