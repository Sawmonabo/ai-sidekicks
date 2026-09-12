// The diff pane: a change set, the form that asks for one, or an honest absence.
//
// THE PANE'S FRAME IS NOT THIS MODULE'S. `seats/ConsolePaneChrome` draws the section,
// the kind glyph, the breadcrumb, the control strip, and the body box for every pane
// kind in the console; what this file returns is the BODY that goes inside it. The
// section, its tab stop, its accessible name, and the actor's hue all arrive from
// there, which is why none of them is set here and why the pane is named by its whole
// address trail rather than by the word "Diff".
//
// WHAT THIS FILE DECIDES IS WHICH OF THREE BODIES THE ADDRESS ADMITS, and nothing more.
// A diff is minted over a run or over a workspace — `create/diff-create-subject.ts` is
// where that mapping lives — so two of the five subjects a diff pane opens over can ask
// for one and three cannot. The pane resolves the subject, hands the create surface the
// absence copy for it, and draws that copy alone where no subject resolves.

import { Nothing } from "../../primitives/index.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../seats/index.js";
import { DiffChangeSet } from "./DiffChangeSet.js";
import { DiffCreateSurface, diffCreateSubjectFor } from "./create/index.js";
import { type ConsoleDiffModel } from "./diff-model.js";

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
 * — a repo, workspace, worktree, invite, or member — and `seats/pane/pane-address.ts` is
 * where that list is declared. Deriving it means a kind added there fails to compile
 * in the table below until this family has said what that subject's changes render.
 */
type DiffSubjectKind = DiffPaneContext["entity"]["kind"];

/**
 * What the pane says when no diff has been asked for, per subject kind.
 *
 * ONE ENTRY PER KIND, and the totality is the point: a single sentence written for a
 * working tree would tell a person looking at a REPOSITORY that their checkout is
 * unchanged, which is a claim about a workspace this pane was never opened over. Each
 * sentence says what that subject's changes would be and that nothing was asked, and
 * none of them renders blank.
 *
 * TWO OF THE FIVE CARRY A FORM UNDER THIS COPY and three do not, which is the mint's
 * own keying rather than a product choice: `DiffArtifactCreateRequest` is keyed by a
 * run or by a workspace, a worktree resolves to the run that provisioned it, and a
 * repository, an invitation and a member resolve to neither. For those three the copy
 * stands alone — what an invitation's or a member's changes MEAN is that family's
 * question and not this one's, and what this pane owes either of them is an honest
 * absence rather than an empty region.
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
  participant: {
    title: "A member's changes are not read here yet.",
    detail:
      "A member's changes span every root they have worked in, and nothing on this build gathers them. Nothing has been requested, so the console is not reporting that this member has changed nothing.",
  },
};

export interface DiffPaneProps {
  readonly context: DiffPaneContext;
  /**
   * A change set to render instead of asking for one.
   *
   * THE PROP SURVIVES THE CREATE SURFACE and is not replaced by it: a caller that
   * already holds a model — a layout composed around one, a tier measuring the renderer
   * — hands it over and the pane draws it, which is a different question from where a
   * pane that holds none gets one.
   */
  readonly diff?: ConsoleDiffModel;
}

export function DiffPane(props: DiffPaneProps): React.JSX.Element {
  const { context, diff } = props;
  const { sessionStore } = context;
  const absence = ABSENT_DIFF_COPY[context.entity.kind];
  const subject = diffCreateSubjectFor(context.entity, sessionStore?.sessionId);

  return (
    <ConsolePaneChrome
      kind="diff"
      sessionId={sessionStore?.sessionId}
      // Unconditional: a diff address carries its entity, so the arm this body is
      // narrowed to has no shape in which the subject is absent. The trail renders the
      // id wire-verbatim, which is what the pane's own subject line used to say — and
      // it is never shortened, because two workspaces whose ids differ in their tail
      // read identically once a renderer abbreviates them.
      entity={context.entity}
      focusHue={context.focusHue}
    >
      {diff !== undefined ? (
        <DiffChangeSet diff={diff} />
      ) : subject !== undefined && sessionStore !== undefined ? (
        // THE STORE IS PART OF THE GATE AND NOT ONLY THE SUBJECT. Resolving what a diff
        // is attributed to is a read that arms refresh triggers on a session store, so a
        // pane opened on a bare route has nowhere to arm them — and the subject
        // resolution above is about the WIRE's two keys, which is a different question
        // from whether this window has a session to ask through.
        <DiffCreateSurface
          bridge={context.bridge}
          subject={subject}
          sessionStore={sessionStore}
          absence={absence}
          renderChangeSet={(created) => <DiffChangeSet diff={created} />}
        />
      ) : (
        <div className="meridian-diff-pane__absence">
          <Nothing
            kind="not-checked"
            placement="surface"
            title={absence.title}
            detail={absence.detail}
          />
        </div>
      )}
    </ConsolePaneChrome>
  );
}
