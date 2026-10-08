import { useMemo } from "react";

import type { WorkflowNodeKindId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type {
  WorkflowStep,
  WorkflowStepResolution,
} from "@ai-sidekicks/contracts/workflow/run/step/record";

import type { HeldStepAnswer } from "../held-answer.js";
import { resolutionReceipt, timedOutReceipt, type StepReceipt } from "../receipts.js";

/** A step's answer as its blocker draws it, and how an answer the daemon took is held. */
export interface StepAnswer {
  /** The receipt the answer or a timeout left; `undefined` while the step still waits. */
  readonly receipt: StepReceipt | undefined;
  /** True where the receipt's instant is the window's clock standing in for the daemon's. */
  readonly isWindowClock: boolean;
  /** Holds an approval's or a form's answer, which carries the daemon's own instant. */
  readonly holdDaemonAnswer: (answered: WorkflowStepResolution) => void;
}

/**
 * Reads a step's answer from the daemon's record, or from the answer this sitting held until
 * the run reads it back.
 */
export function useStepAnswer(
  step: WorkflowStep,
  nodeKind: WorkflowNodeKindId | undefined,
  answer: HeldStepAnswer | undefined,
  onAnswered: (answer: HeldStepAnswer) => void,
): StepAnswer {
  const holdDaemonAnswer = (answered: WorkflowStepResolution): void => {
    onAnswered({ resolution: answered, isWindowClock: false });
  };
  const receipt = useMemo(() => {
    const resolution = step.resolution ?? answer?.resolution;
    return resolution === undefined
      ? timedOutReceipt(step, nodeKind)
      : resolutionReceipt(resolution);
  }, [answer, nodeKind, step]);
  return {
    receipt,
    isWindowClock: step.resolution === undefined && answer?.isWindowClock === true,
    holdDaemonAnswer,
  };
}
