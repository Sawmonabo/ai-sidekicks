import { useContext } from "react";

import { ServedRunActContext, type RecordServedRunAct } from "../served-run-act.js";

/** The re-arm of the run pane this component is rendered inside, or `undefined`. */
export function useRecordServedRunAct(): RecordServedRunAct | undefined {
  return useContext(ServedRunActContext);
}
