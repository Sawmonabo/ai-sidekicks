import { useEffect, useMemo } from "react";

import { type DiffModel } from "../model.js";
import { IntralineSegmentCache } from "../intraline/segment-cache.js";

/**
 * The intraline register of one diff, for as long as a view draws it. Keyed on the model, not a
 * row index: gap expansion, narrowing and view-mode changes rebuild the index without changing any
 * line's text. The view's unmount ends the register's alignment worker.
 */
export function useIntralineSegmentCache(model: DiffModel): IntralineSegmentCache {
  const cache = useMemo(() => new IntralineSegmentCache(model), [model]);
  useEffect(
    () => () => {
      cache.dispose();
    },
    [cache],
  );
  return cache;
}
