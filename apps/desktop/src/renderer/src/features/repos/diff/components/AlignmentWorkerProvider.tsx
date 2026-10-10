import { type ReactNode } from "react";

import { useHoldAlignmentWorker } from "../hooks/useHoldAlignmentWorker.js";
import { AlignmentWorkerContext } from "../intraline/worker/context.js";

/** Gives every diff drawn below one alignment worker for the window, ended when it unmounts. */
export function AlignmentWorkerProvider(props: {
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <AlignmentWorkerContext value={useHoldAlignmentWorker()}>
      {props.children}
    </AlignmentWorkerContext>
  );
}
