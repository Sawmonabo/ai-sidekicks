// One run's page: a header, the run graph, and the step panel that opens beside the graph when a
// step is picked. Everything the run has to say is in one of the three, and picking a step
// replaces what the panel holds rather than making the page longer.

import "./RunPage.css";

import { useRef } from "react";

import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { EventCursor } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { isTextEntryTarget } from "#renderer/lib/editable-target.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useRunTimesNow } from "../../hooks/useRunTimesNow.js";
import type { WorkflowRunComparison } from "../comparison.js";
import type { WorkflowReadSources } from "../../reading.js";
import { ChainQuestion } from "./components/ChainQuestion.js";
import { RunHeader } from "./components/RunHeader.js";
import { StepPanel } from "./step/components/StepPanel.js";
import { useRunPage } from "./hooks/useRunPage.js";
import { findDocumentNode } from "./document-node.js";
import { RunGraph } from "./graph/RunGraph.js";
import type { PayerReading } from "../cost.js";

/** What one run's page is drawn from, and where its links lead. */
export interface RunPageProps {
  readonly sources: WorkflowReadSources;
  readonly workflowRunId: string;
  /** A saved workflow's current name, while the saved workflows are read and list it. */
  readonly definitionNameFor: (definitionId: string) => string | undefined;
  readonly payerOf: (providerAccountId: string) => PayerReading;
  readonly onOpenRun: (workflowRunId: string) => void;
  readonly onOpenSession: (sessionId: string) => void;
  /** Open a session with the message a cursor names in view, or at its foot without one. */
  readonly onOpenMessage: (sessionId: string, messageAnchorCursor: EventCursor | undefined) => void;
  /** Open the builder over the workflow a run came from, in the run's session. */
  readonly onOpenWorkflow: (sessionId: string, definitionId: string) => void;
  /** Open Review on what a run changed between two of its snapshots, in the run's session. */
  readonly onOpenReview: (comparison: WorkflowRunComparison) => void;
  /** The daemon has no run by this id. */
  readonly onRunMissing: () => void;
  /** Leave the run's page for the runs list. */
  readonly onBackToList: () => void;
  /** A person answered one of this run's waits. */
  readonly onAnswered: () => void;
}

/**
 * A run's page. While it is being read it reads `Loading this run…`; a read that fails reads
 * `Could not load this run` with `Try again`. Escape closes the step panel first and, with no
 * panel open, goes back to the runs list; a press inside a text field is the field's own.
 */
export function RunPage(props: RunPageProps): React.JSX.Element {
  const page = useRunPage({
    sources: props.sources,
    workflowRunId: props.workflowRunId,
    onRunMissing: props.onRunMissing,
    onAnswered: props.onAnswered,
  });
  const clock = useClock();
  const pageRef = useRef<HTMLDivElement>(null);
  const { runState } = page;
  // The day the graph, the step panel and the chain question count their instants from: it moves
  // at midnight, never each second, so a going run's ticking stays in its header.
  const dayNowMs = useRunTimesNow({
    drawn: [runState],
    isTicking: false,
    namesDays: true,
    isPartOfDayShown: false,
  });
  if (runState.kind === "not-loaded") {
    return <LoadingNotice clock={clock} placement="block" title="Loading this run…" />;
  }
  if (runState.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="block"
        title="Could not load this run"
        detail={runState.refusal.detail}
        action={<TryAgainButton onPress={page.readRunAgain} />}
      />
    );
  }
  const run = runState.value;
  const documentRead = page.document.read;
  const document = documentRead.kind === "read" ? documentRead.document : undefined;
  const nodeKind = (nodeId: string): string | undefined => findDocumentNode(document, nodeId)?.kind;
  // Until the document is read a step goes by its node id.
  const nodeName = (nodeId: string): string => findDocumentNode(document, nodeId)?.name ?? nodeId;
  const openReview = (from: WorkflowRunSnapshotPoint, to: WorkflowRunSnapshotPoint): void => {
    props.onOpenReview({ sessionId: run.sessionId, workflowRunId: run.workflowRunId, from, to });
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented || isTextEntryTarget(event.target)) {
      return;
    }
    event.preventDefault();
    if (page.selectedNodeId === undefined) {
      props.onBackToList();
      return;
    }
    page.selectNode(undefined);
    // The panel took focus with it; the page keeps it so the next Escape reaches the list.
    pageRef.current?.focus();
  };
  return (
    <div className="meridian-workflow-run" ref={pageRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <RunHeader
        run={run}
        workflowName={workflowNameOf(run, props.definitionNameFor(run.definitionId), document)}
        versionNumber={documentRead.kind === "read" ? documentRead.versionNumber : undefined}
        nodeKind={nodeKind}
        nodeName={nodeName}
        payerOf={props.payerOf}
        bridge={props.sources.bridge}
        onOpenRun={props.onOpenRun}
        onOpenSession={props.onOpenSession}
        onOpenMessage={props.onOpenMessage}
        onOpenWorkflow={(definitionId) => {
          props.onOpenWorkflow(run.sessionId, definitionId);
        }}
        onOpenReview={openReview}
      />
      {run.chainQuestion === undefined ? null : (
        <ChainQuestion
          question={run.chainQuestion}
          chainRoot={run.chainRoot}
          bridge={props.sources.bridge}
          nowMs={dayNowMs}
          onAnswered={props.onAnswered}
        />
      )}
      <div className="meridian-workflow-run__body">
        <div className="meridian-workflow-run__graph">
          {documentRead.kind === "reading" ? (
            <LoadingNotice clock={clock} placement="block" title="Loading this workflow…" />
          ) : documentRead.kind === "failed" ? (
            <Nothing
              kind="error"
              placement="block"
              title="Could not load this workflow"
              detail={documentRead.refusal.detail}
              action={<TryAgainButton onPress={page.document.readAgain} />}
            />
          ) : (
            <RunGraph
              document={documentRead.document}
              steps={run.steps}
              edgeItemCounts={run.edgeItemCounts}
              selectedNodeId={page.selectedNodeId}
              nowMs={dayNowMs}
              onSelectNode={page.selectNode}
            />
          )}
        </div>
        {page.selectedNodeId === undefined ? null : (
          <StepPanel
            run={run}
            document={document}
            nodeId={page.selectedNodeId}
            nodeKind={nodeKind}
            nodeName={nodeName}
            payerOf={props.payerOf}
            bridge={props.sources.bridge}
            nowMs={dayNowMs}
            receipts={page.receipts}
            onAnswered={page.holdAnswered}
            onOpenRun={props.onOpenRun}
            onOpenReview={openReview}
            onOpenSession={props.onOpenSession}
            onClose={() => {
              page.selectNode(undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The workflow's current name where the saved workflows list it, else the name saved in the
 * version the run pinned, else the chain's first run where that is this workflow; nothing until
 * one of them has been read.
 */
function workflowNameOf(
  run: WorkflowRunReadResponse,
  currentName: string | undefined,
  document: WorkflowDocument | undefined,
): string | undefined {
  if (currentName !== undefined) {
    return currentName;
  }
  if (document !== undefined) {
    return document.name;
  }
  return run.chainRoot.definitionId === run.definitionId ? run.chainRoot.workflowName : undefined;
}
