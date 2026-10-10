import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { DIFF_FLOW_FILL_STEP_ROWS } from "../measures.js";

/**
 * How many of a block's `rowCount` rows are mounted while it is open whole, or `undefined` while
 * it is cut. Opening, or mounting already open, mounts the steps holding its first
 * `firstRowCount` rows in that same commit; after it each commit posts one more step of
 * `DIFF_FLOW_FILL_STEP_ROWS` rows as a task of its own (`scheduler.postTask`) and commits it there,
 * so the browser paints and takes input between steps, until every row is mounted. Rows not
 * mounted yet take no room, so the block only grows, at the end of its mounted rows, as each step
 * lands. An unmount drops the step in flight.
 */
export function useRowsMountedInSteps(
  rowCount: number,
  isOpen: boolean,
  firstRowCount: number,
): number | undefined {
  // The steps landed after the first ones, each in its own task.
  const [landedStepCount, setLandedStepCount] = useState(0);
  const firstStepCount = Math.ceil(firstRowCount / DIFF_FLOW_FILL_STEP_ROWS);
  const mountedRowCount = isOpen
    ? Math.min(rowCount, (firstStepCount + landedStepCount) * DIFF_FLOW_FILL_STEP_ROWS)
    : undefined;

  useEffect(() => {
    if (mountedRowCount === undefined || mountedRowCount >= rowCount) {
      return undefined;
    }
    let isDropped = false;
    void scheduler.postTask(() => {
      if (!isDropped) {
        // Committed inside the posted task, so each step's cost is that one task's and the
        // browser paints and takes input between steps.
        flushSync(() => {
          setLandedStepCount((count) => count + 1);
        });
      }
    });
    return () => {
      isDropped = true;
    };
  }, [mountedRowCount, rowCount]);

  return mountedRowCount;
}
