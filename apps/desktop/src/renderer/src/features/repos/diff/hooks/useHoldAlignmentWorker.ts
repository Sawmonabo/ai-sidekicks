import { useEffect, useState } from "react";

import { AlignmentWorker } from "../intraline/worker/handle.js";

/** One alignment worker held for as long as the caller is mounted, and ended when it unmounts. */
export function useHoldAlignmentWorker(): AlignmentWorker {
  const [alignmentWorker] = useState(() => new AlignmentWorker());
  useEffect(
    () => () => {
      alignmentWorker.terminate();
    },
    [alignmentWorker],
  );
  return alignmentWorker;
}
