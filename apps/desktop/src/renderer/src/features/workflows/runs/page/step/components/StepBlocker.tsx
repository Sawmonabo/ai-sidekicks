import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { WorkflowNodeKindId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { formatCount, formatDayClock } from "#renderer/lib/wire/figures.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { DayClockFigure } from "#renderer/features/workflows/components/DayClockFigure.js";
import { resolutionReceipt, timedOutReceipt, type HeldStepAnswer } from "../receipts.js";
import { ApprovalAnswer } from "../../components/ApprovalAnswer.js";
import { ReplyAnswer } from "../../components/ReplyAnswer.js";
import { OpenInReview } from "../../components/OpenInReview.js";
import { StepForm } from "./StepForm.js";

/** What the blocker over a step's data is drawn from, and where an answer goes. */
export interface StepBlockerProps {
  readonly run: WorkflowRunReadResponse;
  readonly step: WorkflowStep;
  /**
   * The step's node's kind, once the run's version is read; it says whether the step waited on a
   * person.
   */
  readonly nodeKind: WorkflowNodeKindId | undefined;
  /** The instant a receipt's day is counted from. */
  readonly nowMs: number;
  /** The answer this sitting gave the step, held until the run reads back answered. */
  readonly answer: HeldStepAnswer | undefined;
  readonly bridge: PlatformBridge;
  /** Called with the answer once the daemon has taken it. */
  readonly onAnswered: (answer: HeldStepAnswer) => void;
  readonly onOpenReview: (from: WorkflowRunSnapshotPoint, to: WorkflowRunSnapshotPoint) => void;
}

/**
 * What stands above a step's data where it waits on a person: the way to answer it, or the
 * receipt an answer left, read from the daemon's record of the answer so it survives a reload,
 * which has no way back. A step that waits on nobody draws nothing here.
 */
export function StepBlocker(props: StepBlockerProps): React.JSX.Element | null {
  const { run, step } = props;
  const clockLocale = useClockLocale();
  const { reviewPause } = step;
  // The daemon's record wins over this sitting's answer, which wins over a timed-out wait.
  const isWindowClockStamp = step.resolution === undefined && props.answer?.isWindowClockStamp;
  const resolution = step.resolution ?? props.answer?.resolution;
  const receipt =
    resolution === undefined
      ? timedOutReceipt(step, props.nodeKind)
      : resolutionReceipt(resolution);
  if (receipt !== undefined) {
    return (
      <p className="meridian-workflow-step__receipt">
        {receipt.words}{" "}
        {isWindowClockStamp === true ? (
          <DerivedFigure text={formatDayClock(receipt.at, props.nowMs, clockLocale)} />
        ) : (
          <DayClockFigure at={receipt.at} nowMs={props.nowMs} locale={clockLocale} />
        )}
      </p>
    );
  }
  if (step.status !== "waiting") {
    return null;
  }
  switch (step.waitCause) {
    case "approval":
      return (
        <div className="meridian-workflow-step__approval">
          <WaitingEyebrow words="Waiting for you" />
          <ApprovalAnswer
            workflowRunId={step.workflowRunId}
            nodeId={step.nodeId}
            bridge={props.bridge}
            onAnswered={props.onAnswered}
          />
          {reviewPause === undefined ? null : (
            <OpenInReview snapshots={reviewPause} onOpenReview={props.onOpenReview} />
          )}
        </div>
      );
    case "form":
      return (
        <StepForm
          bridge={props.bridge}
          stepKey={{
            workflowRunId: step.workflowRunId,
            nodeId: step.nodeId,
            attempt: step.attempt,
            executionIndex: step.executionIndex,
          }}
          onAnswered={props.onAnswered}
        />
      );
    case "reply":
      return step.question === undefined ? null : (
        <ReplyAnswer question={step.question} bridge={props.bridge} onAnswered={props.onAnswered} />
      );
    case "chain":
      // The chain's question is answered on its first run's page; a held step only says so.
      return (
        <div>
          <WaitingEyebrow words="Waiting on you" />
          <p className="meridian-workflow-step__note">
            {`${formatCount(run.chainRoot.runCount)} runs from one start`}
          </p>
          <p className="meridian-workflow-step__note">
            Its next run waits for the chain&apos;s question on the first run&apos;s page.
          </p>
        </div>
      );
    case "account":
    case undefined:
      return null;
  }
}

function WaitingEyebrow(props: { readonly words: string }): React.JSX.Element {
  return (
    <span className="meridian-workflow-run__eyebrow meridian-workflow-run__eyebrow--attention">
      {props.words}
    </span>
  );
}
