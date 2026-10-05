// What a run's header says in words: the two lines it opens with — what happened, then what it
// needs — and, while the run is going, the live line at its foot. Both are composed from the
// run's status and its blocking or failing step, named by its node's kind, so every kind of stop
// is written the same way and none is kept by hand. A waiting run's cause is read in the first
// line and nowhere else.

import {
  WORKFLOW_STEP_TIMED_OUT_CODE,
  type WorkflowStep,
  type WorkflowWaitCause,
} from "@ai-sidekicks/contracts/workflow/run/run";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { formatCount, formatDayClock } from "@renderer/lib/wire-figures.js";
import { costFigure } from "../run-cost.js";
import { AWAITING_RESUME_WORDS, WAIT_CAUSE_WORDS } from "../workflow-words.js";
import { isGoing } from "../run-controls.js";
import { isPersonWaitCause, latestStepWith } from "../run-steps.js";

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

/** A waiting step's next move, in the header's second line. */
const WAIT_NEEDS: Readonly<Record<Exclude<WorkflowWaitCause, "account">, string>> = {
  approval: "Approve or reject it in the step panel",
  form: "Answer its form in the step panel",
  reply: "Reply in the step panel or in its session",
  chain: "Keep the chain going or stop the runs it started",
};

/**
 * The two lines a run's header opens with. `nodeKind` reads a step's node kind from the pinned
 * version, which names the step (`The approval step timed out`); `undefined` until it is read.
 * `nowMs` is the instant a resume time's day is counted from.
 */
export function runHeaderLines(
  run: WorkflowRunReadResponse,
  nodeKind: (nodeId: string) => string | undefined,
  nowMs: number,
): RunHeaderLines {
  switch (run.state) {
    case "new":
      return { happened: "This run is starting", needs: "Nothing is needed" };
    case "running":
      return { happened: "This run is running", needs: "Nothing is needed" };
    case "waiting":
      return waitingLines(latestStepWith(run.steps, "waiting"), nodeKind, nowMs);
    case "failed":
      return failedLines(run, latestStepWith(run.steps, "failed"), nodeKind);
    case "succeeded":
      return { happened: "This run succeeded", needs: "Nothing is needed" };
    case "canceled":
      return { happened: "This run was canceled", needs: "Nothing is needed" };
    case "crashed":
      return { happened: "This run crashed", needs: "Re-run it to start again" };
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
    parts.push(plain("waiting for memory"));
  } else if (run.liveStep !== undefined) {
    parts.push(plain(run.liveStep.nodeName));
  }
  parts.push(plain(`${costFigure(run.cost)} so far`));
  return parts;
}

function waitingLines(
  step: WorkflowStep | undefined,
  nodeKind: (nodeId: string) => string | undefined,
  nowMs: number,
): RunHeaderLines {
  if (step?.waitCause === undefined) {
    return { happened: "This run is waiting", needs: "Nothing is needed until it resumes" };
  }
  const subject = stepSubject(nodeKind(step.nodeId));
  if (step.waitCause === "account") {
    return {
      happened: `${subject} is waiting on a spent account`,
      needs:
        step.resumeAt === undefined
          ? AWAITING_RESUME_WORDS
          : `It resumes itself at ${formatDayClock(step.resumeAt, nowMs)}, or press Resume`,
    };
  }
  return {
    happened: `${subject} is waiting on ${WAIT_CAUSE_WORDS[step.waitCause]}`,
    needs: WAIT_NEEDS[step.waitCause],
  };
}

function failedLines(
  run: WorkflowRunReadResponse,
  step: WorkflowStep | undefined,
  nodeKind: (nodeId: string) => string | undefined,
): RunHeaderLines {
  const needs = "Fix it and press Resume, or cancel the run";
  if (step === undefined) {
    return { happened: run.failureReason ?? "This run failed", needs };
  }
  const subject = stepSubject(nodeKind(step.nodeId));
  if (step.error?.code === WORKFLOW_STEP_TIMED_OUT_CODE) {
    return { happened: `${subject} timed out`, needs };
  }
  return { happened: `${subject} ${failedTimes(step.attempt)}`, needs };
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

/** `failed`, `failed twice`, `failed three times`, then the count in figures. */
function failedTimes(attempt: number): string {
  switch (attempt) {
    case 1:
      return "failed";
    case 2:
      return "failed twice";
    case 3:
      return "failed three times";
    default:
      return `failed ${formatCount(attempt)} times`;
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
