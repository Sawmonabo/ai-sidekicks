// What a run's header says in words: the two lines it opens with — what happened, then what it
// needs — and, while the run is going, the live line at its foot. Both are composed from the
// run's status and its blocking or failing step, so every kind of stop is written the same way
// and none is kept by hand. A waiting run's cause is read in the first line and nowhere else.

import { type WorkflowWaitCause } from "@ai-sidekicks/contracts/workflow/run/status";
import { WORKFLOW_STEP_TIMED_OUT_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";
import { type WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { formatCount, formatDayClock } from "#renderer/lib/wire/figures.js";
import { costFigure } from "../cost.js";
import { WAIT_CAUSE_WORDS } from "../../words.js";
import { isGoing } from "../controls.js";
import { isPersonWaitCause, latestStepWith } from "../steps.js";
import { isPersonWaitKind } from "./step/receipts.js";

/** The header's two opening lines. */
export interface RunHeaderLines {
  readonly happened: string;
  readonly needs: string;
}

/** One stretch of the live line; `isAttention` marks the one blocker that needs a person. */
export interface RunLiveLinePart {
  readonly text: string;
  readonly isAttention: boolean;
}

/** What the header's lines name a run's steps and the run itself by. */
export interface RunHeaderNames {
  /** A step's node kind in the pinned version, `undefined` until the version is read. */
  readonly nodeKind: (nodeId: string) => string | undefined;
  /** A step's node name in the pinned version. */
  readonly nodeName: (nodeId: string) => string;
  /** The workflow's name, once it has been read. */
  readonly workflowName: string | undefined;
}

/** What a failed run needs, unless the failure was a person's wait running out. */
const FIX_AND_RESUME = "Fix it and press Resume, or cancel the run.";

/** What a run that has nothing left to do needs. */
const NOTHING_FINISHED = "Nothing — this run is finished.";

/**
 * The two lines a run's header opens with, such as `The run tests step failed twice.` over
 * `Fix it and press Resume, or cancel the run.` A stopped step is named by its node's kind; the
 * run by its workflow's name.
 */
export function runHeaderLines(
  run: WorkflowRunReadResponse,
  names: RunHeaderNames,
): RunHeaderLines {
  // Until the workflow's name is read the run goes by "This run".
  const runName = names.workflowName ?? "This run";
  switch (run.state) {
    case "new":
      return {
        happened: `${runName} has not started yet.`,
        needs: "Nothing — it starts on its own.",
      };
    case "running":
      return { happened: `${runName} is running.`, needs: "Nothing — it is still going." };
    case "waiting":
      return waitingLines(run, latestStepWith(run.steps, "waiting"), names, runName);
    case "failed":
      return failedLines(run, latestStepWith(run.steps, "failed"), names);
    case "succeeded":
      return { happened: `${runName} finished every step.`, needs: NOTHING_FINISHED };
    case "canceled":
      return { happened: `${runName} was canceled.`, needs: NOTHING_FINISHED };
    case "crashed":
      return {
        happened: `${runName} stopped when the machine went down.`,
        needs: "Nothing — re-run it when you want it again.",
      };
  }
}

/**
 * The line at the foot of a going run's header: its live step's place, what it is doing or
 * waiting on, the instant it resumes itself or gives up, its day counted from `nowMs`, and what it
 * has spent so far. A run that has finished has no live line.
 */
export function runLiveLine(
  run: WorkflowRunReadResponse,
  nowMs: number,
): readonly RunLiveLinePart[] | undefined {
  if (!isGoing(run.state)) {
    return undefined;
  }
  const parts: RunLiveLinePart[] = [];
  if (run.liveStep !== undefined) {
    parts.push(
      plain(`Step ${formatCount(run.liveStep.index)} of ${formatCount(run.liveStep.total)}`),
    );
  }
  const waiting = latestStepWith(run.steps, "waiting");
  const holding = latestStepWith(run.steps, "waiting-memory");
  if (waiting?.waitCause !== undefined) {
    parts.push(...waitingParts(run, waiting, waiting.waitCause, nowMs));
  } else if (holding !== undefined) {
    parts.push(plain("waiting for memory"), plain("starts itself when memory frees up"));
  } else if (run.liveStep !== undefined) {
    parts.push(plain(run.liveStep.nodeName));
  }
  parts.push(plain(`${costFigure(run.cost)} so far`));
  return parts;
}

function waitingLines(
  run: WorkflowRunReadResponse,
  step: WorkflowStep | undefined,
  names: RunHeaderNames,
  runName: string,
): RunHeaderLines {
  switch (step?.waitCause) {
    case undefined:
      return { happened: `${runName} is waiting.`, needs: "Nothing until it resumes." };
    case "account":
      return {
        happened: `${stepSubject(names.nodeKind(step.nodeId))} is waiting on a spent account.`,
        needs: "Nothing until the account can run again.",
      };
    case "approval": {
      // The approval asks about what the step before it did, so that step is named.
      const feeder = step.source.find((source) => source !== null);
      const asker = feeder === undefined ? runName : names.nodeName(feeder.nodeId);
      return {
        happened: `${asker} finished and asked for your approval.`,
        needs: "Approve it or reject it in the step that is waiting.",
      };
    }
    case "chain":
      // The chain's question stands on its first run's page and nowhere else.
      return run.chainRoot.runId === run.workflowRunId
        ? {
            happened:
              `This run has started ${formatCount(run.chainRoot.runCount)} runs, itself ` +
              "included, and the next one is waiting.",
            needs: "Answer the question below: keep going, or stop them all.",
          }
        : {
            happened:
              `${names.nodeName(step.nodeId)} is holding its next run behind the chain's ` +
              "question.",
            needs: "Answer it on the first run's page.",
          };
    case "form":
    case "reply": {
      const subject = stepSubject(names.nodeKind(step.nodeId));
      return {
        happened: `${subject} is waiting on ${WAIT_CAUSE_WORDS[step.waitCause]}.`,
        needs:
          step.waitCause === "form"
            ? "Answer its form in the step panel."
            : "Reply in the step panel or in its session.",
      };
    }
  }
}

function failedLines(
  run: WorkflowRunReadResponse,
  step: WorkflowStep | undefined,
  names: RunHeaderNames,
): RunHeaderLines {
  if (step === undefined) {
    return { happened: run.failureReason ?? "This run failed.", needs: FIX_AND_RESUME };
  }
  const kind = names.nodeKind(step.nodeId);
  const subject = stepSubject(kind);
  if (step.error?.code === WORKFLOW_STEP_TIMED_OUT_CODE) {
    // A person's wait that ran out is waited on again from the same input.
    return {
      happened: `${subject} timed out.`,
      needs:
        kind !== undefined && isPersonWaitKind(kind)
          ? "Press Retry from this step to wait for your answer again."
          : FIX_AND_RESUME,
    };
  }
  if (step.resolution?.kind === "declined") {
    return { happened: `${subject} was declined.`, needs: FIX_AND_RESUME };
  }
  return { happened: `${subject} failed ${failedTimes(step.attempt)}.`, needs: FIX_AND_RESUME };
}

/**
 * A step named by its node's kind, the kind's own last word: `human.approval` reads `The approval
 * step` and `developer.run-tests` `The run tests step`. Until the pinned version is read, `A step`.
 */
function stepSubject(kind: string | undefined): string {
  if (kind === undefined) {
    return "A step";
  }
  const word = kind.slice(kind.lastIndexOf(".") + 1).replaceAll("-", " ");
  return `The ${word} step`;
}

/** `once`, `twice`, `three times`, `four times`, then the count in figures. */
function failedTimes(attempt: number): string {
  switch (attempt) {
    case 1:
      return "once";
    case 2:
      return "twice";
    case 3:
      return "three times";
    case 4:
      return "four times";
    default:
      return `${formatCount(attempt)} times`;
  }
}

function waitingParts(
  run: WorkflowRunReadResponse,
  step: WorkflowStep,
  cause: WorkflowWaitCause,
  nowMs: number,
): RunLiveLinePart[] {
  const deadline =
    step.waitDeadlineAt === undefined ? "" : ` until ${formatDayClock(step.waitDeadlineAt, nowMs)}`;
  const blocker: RunLiveLinePart = {
    text: `waiting on ${WAIT_CAUSE_WORDS[cause]}${deadline}`,
    isAttention: isPersonWaitCause(cause),
  };
  if (cause === "chain") {
    return [blocker, plain(`${formatCount(run.chainRoot.runCount)} runs from one start`)];
  }
  if (cause !== "account") {
    return [blocker];
  }
  return [
    blocker,
    plain(
      step.resumeAt === undefined
        ? "awaiting resume — no instant is armed"
        : `resumes itself at ${formatDayClock(step.resumeAt, nowMs)}`,
    ),
  ];
}

function plain(text: string): RunLiveLinePart {
  return { text, isAttention: false };
}
