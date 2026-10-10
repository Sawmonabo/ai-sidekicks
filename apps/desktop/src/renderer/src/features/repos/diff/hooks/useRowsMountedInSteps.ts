import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { DIFF_FLOW_FILL_STEP_ROWS } from "../measures.js";

/** How many of a block's rows are mounted, and the press that opens the block whole. */
export interface RowsMountedInSteps {
  /** `undefined` while the block is cut; otherwise how many of its rows are mounted so far. */
  readonly mountedRowCount: number | undefined;
  /** Mount the first `firstRowCount` rows at once and the rest one step per task after. */
  readonly mountAll: (firstRowCount: number) => void;
}

/**
 * A block's rows mounted in steps once it opens whole, so no one task mounts thousands of rows:
 * each commit posts the next step as a task of its own (`scheduler.postTask`) and commits it there,
 * so the browser paints and takes input between steps, until every one of `rowCount` rows is
 * mounted. An unmount drops the step in flight.
 */
export function useRowsMountedInSteps(rowCount: number): RowsMountedInSteps {
  const [mountedRowCount, setMountedRowCount] = useState<number | undefined>(undefined);

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
          setMountedRowCount(Math.min(rowCount, mountedRowCount + DIFF_FLOW_FILL_STEP_ROWS));
        });
      }
    });
    return () => {
      isDropped = true;
    };
  }, [mountedRowCount, rowCount]);

  const mountAll = useCallback(
    (firstRowCount: number) => {
      setMountedRowCount(Math.min(rowCount, firstRowCount));
    },
    [rowCount],
  );

  return { mountedRowCount, mountAll };
}
