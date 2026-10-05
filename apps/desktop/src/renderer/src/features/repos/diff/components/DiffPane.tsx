// The diff pane body, Review: over a workflow run, what the run changed between two of its
// snapshot points; over a checkout, the change set it was handed or the empty state for that
// checkout. `PaneFrame` draws the section, kind glyph, trail and body box, so none of those are
// set here.

import "./diff.css";

import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/run";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { DiffChangeSet } from "./DiffChangeSet.js";
import { WorkflowRunReview } from "./WorkflowRunReview.js";
import { type DiffModel } from "../diff-model.js";

/**
 * This body's address arm, narrowed by the pane registry's `PaneContextOf`, so `entity` is
 * required and limited to the kinds a diff opens over.
 */
type DiffPaneContext = PaneContextOf<"diff">;

/**
 * The checkout kinds a diff can view, read off the address rather than listed: a kind added in
 * `routing/panes/pane-address.ts` fails to compile in the table below until its copy exists. A
 * workflow run is drawn by its own body and never reaches this copy.
 */
type DiffCheckoutKind = Exclude<DiffPaneContext["entity"]["kind"], "workflow-run">;

/** What the pane says when no diff has been asked for, per subject kind; never blank. */
const EMPTY_STATE_COPY: Readonly<
  Record<DiffCheckoutKind, { readonly title: string; readonly detail: string }>
> = {
  workspace: {
    title: "No diff has been asked for.",
    detail:
      "None has been requested for this workspace, so the app is not " +
      "reporting that nothing changed.",
  },
  worktree: {
    title: "No diff has been asked for.",
    detail:
      "None has been requested for this execution root, so the app is " +
      "not reporting that nothing changed.",
  },
};

/** What the diff pane is drawn from. */
export interface DiffPaneProps {
  readonly context: DiffPaneContext;
  /** A change set to render, for a caller that already holds a model. */
  readonly diff?: DiffModel;
}

/**
 * The diff pane body: a workflow run's comparison, read by the pane; otherwise the change set
 * when one is held, or the empty state.
 */
export function DiffPane(props: DiffPaneProps): React.JSX.Element {
  const { context, diff } = props;
  const { entity } = context;
  const sessionId = context.sessionStore?.sessionId;

  return (
    <PaneFrame
      kind="diff"
      sessionId={sessionId}
      // The trail renders the id wire-verbatim and never shortened: ids that differ only in
      // their tail read identically once abbreviated.
      entity={entity}
    >
      {entity.kind === "workflow-run" ? (
        sessionId === undefined ? (
          // The session's store is still opening; the read names the session it asks about.
          <div className="meridian-diff-pane__empty-state">
            <Nothing kind="not-loaded" placement="block" title="Loading what this run changed…" />
          </div>
        ) : (
          <WorkflowRunReview
            bridge={context.bridge}
            request={{
              sessionId: sessionId as SessionId,
              scope: "workflow_run",
              workflowRunId: entity.id as WorkflowRunId,
              from: entity.from,
              to: entity.to,
            }}
          />
        )
      ) : diff !== undefined ? (
        <DiffChangeSet diff={diff} />
      ) : (
        <div className="meridian-diff-pane__empty-state">
          <Nothing
            kind="not-checked"
            placement="block"
            title={EMPTY_STATE_COPY[entity.kind].title}
            detail={EMPTY_STATE_COPY[entity.kind].detail}
          />
        </div>
      )}
    </PaneFrame>
  );
}
