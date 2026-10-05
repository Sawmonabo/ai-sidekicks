import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { WorkflowNodeKindId } from "@ai-sidekicks/contracts/workflow/definition/definition";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/run";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { resolutionReceipt, timedOutReceipt } from "../step-receipts.js";
import { ApprovalAnswer } from "./ApprovalAnswer.js";
import { ReplyAnswer } from "./ReplyAnswer.js";
import { OpenInReview } from "./OpenInReview.js";
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
  /** The receipt this sitting's answer left on the step, before the run reads back answered. */
  readonly receipt: string | undefined;
  readonly bridge: PlatformBridge;
  /** Called with the answer's receipt once the daemon has taken it. */
  readonly onAnswered: (receipt: string) => void;
  readonly onOpenRun: (workflowRunId: string) => void;
  readonly onOpenReview: (from: WorkflowRunSnapshotPoint, to: WorkflowRunSnapshotPoint) => void;
}

/**
 * What stands above a step's data where it waits on a person: the way to answer it, or the
 * receipt an answer left, read from the daemon's record of the answer so it survives a reload,
 * which has no way back. A step that waits on nobody draws nothing here.
 */
export function StepBlocker(props: StepBlockerProps): React.JSX.Element | null {
  const { run, step } = props;
  const { reviewPause } = step;
  const receipt =
    step.resolution === undefined
      ? (props.receipt ?? timedOutReceipt(step, props.nodeKind, props.nowMs))
      : resolutionReceipt(step.resolution, props.nowMs);
  if (receipt !== undefined) {
    return <p className="meridian-workflow-step__receipt">{receipt}</p>;
  }
  if (step.status !== "waiting") {
    return null;
  }
  switch (step.waitCause) {
    case "approval":
      return (
        <div className="meridian-workflow-step__approval">
          <ApprovalAnswer
            workflowRunId={step.workflowRunId}
            nodeId={step.nodeId}
            bridge={props.bridge}
            onAnswered={props.onAnswered}
          />
          {reviewPause === undefined ? null : (
            <OpenInReview
              door={
                reviewPause.state === "pinned"
                  ? {
                      state: "pinned",
                      from: { epoch: reviewPause.epoch, point: "start" },
                      to: {
                        epoch: reviewPause.epoch,
                        point: "pause",
                        pauseNumber: reviewPause.pauseNumber,
                      },
                    }
                  : reviewPause
              }
              onOpenReview={props.onOpenReview}
            />
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
      return run.chainRoot.runId === run.workflowRunId ? (
        <p className="meridian-workflow-step__note">
          This step is holding the runs it started until the chain&apos;s question is answered.
        </p>
      ) : (
        <p className="meridian-workflow-step__note">
          This step is held behind its chain&apos;s question.{" "}
          <button
            type="button"
            className="meridian-workflow-run__link"
            onClick={() => {
              props.onOpenRun(run.chainRoot.runId);
            }}
          >
            Answer it on the chain&apos;s first run
          </button>
        </p>
      );
    case "account":
    case undefined:
      return null;
  }
}
