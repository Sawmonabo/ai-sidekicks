// The diff pane body: the change set it was handed, or the absence copy for the subject the
// address names. `PaneFrame` draws the section, kind glyph, trail and body box, so none of
// those are set here.

import "./diff.css";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { DiffChangeSet } from "./DiffChangeSet.js";
import { type DiffModel } from "../diff-model.js";

/**
 * This body's address arm, narrowed by the pane registry's `PaneContextOf`, so `entity` is
 * required and limited to the kinds a diff opens over.
 */
type DiffPaneContext = PaneContextOf<"diff">;

/**
 * The entity kinds a diff can view, read off the address rather than listed: a kind added in
 * `routing/panes/pane-address.ts` fails to compile in the table below until its copy exists.
 */
type DiffSubjectKind = DiffPaneContext["entity"]["kind"];

/** What the pane says when no diff has been asked for, per subject kind; never blank. */
const ABSENT_DIFF_COPY: Readonly<
  Record<DiffSubjectKind, { readonly title: string; readonly detail: string }>
> = {
  workspace: {
    title: "No diff has been asked for.",
    detail:
      "None has been requested for this workspace, so the console is not reporting that nothing changed.",
  },
  worktree: {
    title: "No diff has been asked for.",
    detail:
      "None has been requested for this execution root, so the console is not reporting that nothing changed.",
  },
};

/** What the diff pane is drawn from. */
export interface DiffPaneProps {
  readonly context: DiffPaneContext;
  /** A change set to render, for a caller that already holds a model. */
  readonly diff?: DiffModel;
}

/** The diff pane body: the change set when one is held, otherwise the absence copy. */
export function DiffPane(props: DiffPaneProps): React.JSX.Element {
  const { context, diff } = props;
  const absence = ABSENT_DIFF_COPY[context.entity.kind];

  return (
    <PaneFrame
      kind="diff"
      sessionId={context.sessionStore?.sessionId}
      // The trail renders the id wire-verbatim and never shortened: ids that differ only in
      // their tail read identically once abbreviated.
      entity={context.entity}
    >
      {diff !== undefined ? (
        <DiffChangeSet diff={diff} />
      ) : (
        <div className="meridian-diff-pane__absence">
          <Nothing
            kind="not-checked"
            placement="block"
            title={absence.title}
            detail={absence.detail}
          />
        </div>
      )}
    </PaneFrame>
  );
}
