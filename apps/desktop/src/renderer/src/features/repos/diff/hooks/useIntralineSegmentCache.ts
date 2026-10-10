import { useContext, useEffect, useMemo } from "react";

import { type DiffModel } from "../model.js";
import { IntralineSegmentCache } from "../intraline/segment-cache.js";
import { AlignmentWorkerContext } from "../intraline/worker/context.js";

/**
 * The intraline register of one diff, for as long as a view draws it, aligning its long pairs on
 * the window's alignment worker. Keyed on the model, not a row index: gap expansion, narrowing and
 * view-mode changes rebuild the index without changing any line's text. The view's unmount drops
 * its pairs still on the worker. Throws outside an `AlignmentWorkerProvider`.
 */
export function useIntralineSegmentCache(model: DiffModel): IntralineSegmentCache {
  const alignmentWorker = useContext(AlignmentWorkerContext);
  if (alignmentWorker === undefined) {
    throw new Error("A diff is drawn outside an AlignmentWorkerProvider, so it has no worker.");
  }
  const cache = useMemo(
    () => new IntralineSegmentCache(model, alignmentWorker),
    [model, alignmentWorker],
  );
  useEffect(
    () => () => {
      cache.dispose();
    },
    [cache],
  );
  return cache;
}
