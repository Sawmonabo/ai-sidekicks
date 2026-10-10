import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { DIFF_FLOW_FILL_STEP_ROWS } from "../measures.js";

/** A run of a block's steps, `first` to `last` inclusive, counted in steps of rows. */
export interface RowStepRange {
  readonly first: number;
  readonly last: number;
}

/** Which of a block's steps of rows hold their rows, once the block is open whole. */
export interface RowSteps {
  /** One flag per step of `DIFF_FLOW_FILL_STEP_ROWS` rows: whether its rows are mounted. */
  readonly mounted: readonly boolean[];
  /** The steps at and around the screen, which lay out now rather than when the engine says. */
  readonly near: RowStepRange | undefined;
}

/** A block's steps of rows, and the two ways they are mounted. */
export interface RowsMountedInSteps {
  /** `undefined` while the block is cut; otherwise which of its steps are mounted. */
  readonly steps: RowSteps | undefined;
  /**
   * Open the block whole: mount the steps holding its first `firstRowCount` rows at once, near the
   * screen, so they lay out in the press's frame.
   */
  readonly mountAll: (firstRowCount: number) => void;
  /**
   * Mount the steps in `near` and lay them out, committed before this call returns, so a scroll
   * that brought them into view paints them in its own frame. Called from an event, never while
   * React renders.
   */
  readonly bringNear: (near: RowStepRange | undefined) => void;
}

/**
 * A block's rows mounted a step at a time once it opens whole, so no one task mounts thousands of
 * rows: each commit posts the step after the last mounted one as a task of its own
 * (`scheduler.postTask`) and commits it there, so the browser paints and takes input between
 * steps, until every step of `rowCount` rows is mounted. A step a scroll brings near is mounted
 * out of turn and at once. An unmount drops the step in flight.
 */
export function useRowsMountedInSteps(rowCount: number): RowsMountedInSteps {
  const [steps, setSteps] = useState<RowSteps | undefined>(undefined);
  // The steps as last committed, so a scroll that changes nothing commits nothing.
  const committedSteps = useRef<RowSteps | undefined>(undefined);
  useLayoutEffect(() => {
    committedSteps.current = steps;
  });
  const stepCount = Math.ceil(rowCount / DIFF_FLOW_FILL_STEP_ROWS);

  useEffect(() => {
    const nextStep = steps?.mounted.indexOf(false) ?? -1;
    if (steps === undefined || nextStep === -1) {
      return undefined;
    }
    let isDropped = false;
    void scheduler.postTask(() => {
      if (!isDropped) {
        // Committed inside the posted task, so each step's cost is that one task's and the
        // browser paints and takes input between steps.
        flushSync(() => {
          setSteps({ ...steps, mounted: steps.mounted.with(nextStep, true) });
        });
      }
    });
    return () => {
      isDropped = true;
    };
  }, [steps]);

  const mountAll = useCallback(
    (firstRowCount: number) => {
      const firstStepCount = Math.min(
        stepCount,
        Math.ceil(firstRowCount / DIFF_FLOW_FILL_STEP_ROWS),
      );
      // The steps the press mounts are the ones the screen shows, so they are near from the start.
      setSteps({
        mounted: Array.from({ length: stepCount }, (_unused, step) => step < firstStepCount),
        near: { first: 0, last: firstStepCount - 1 },
      });
    },
    [stepCount],
  );

  const bringNear = useCallback((near: RowStepRange | undefined) => {
    const current = committedSteps.current;
    if (current === undefined || isSameRange(current.near, near)) {
      return;
    }
    const mounted =
      near === undefined
        ? current.mounted
        : current.mounted.map(
            (isMounted, step) => isMounted || (step >= near.first && step <= near.last),
          );
    const next = { mounted, near };
    committedSteps.current = next;
    flushSync(() => {
      setSteps(next);
    });
  }, []);

  return { steps, mountAll, bringNear };
}

function isSameRange(left: RowStepRange | undefined, right: RowStepRange | undefined): boolean {
  return left?.first === right?.first && left?.last === right?.last;
}
