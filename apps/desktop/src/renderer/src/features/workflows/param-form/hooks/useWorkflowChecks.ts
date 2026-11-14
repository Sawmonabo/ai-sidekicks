// The workflow checks as a form reads them: asked for once a form needs them, so their module is
// compiled only then, and drawn again as they load, fail or start to answer.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import type { PageModuleState } from "#renderer/components/Markdown/worker/page-module-load.js";

/** The workflow checks, asked for while `isNeeded`; the component re-renders as they move. */
export function useWorkflowChecks(isNeeded: boolean): WorkflowChecks {
  const { workflowChecks } = markdownWorker;
  const state = useSyncExternalStore(workflowChecks.subscribe, () => workflowChecks.state);
  useEffect(() => {
    if (isNeeded) {
      markdownWorker.wantWorkflowChecks();
    }
  }, [isNeeded]);
  const loadAgain = useCallback(() => {
    markdownWorker.wantWorkflowChecks();
  }, []);
  return { state, loadAgain };
}

/** Where the checks stand, and the ask that loads them again after a failure. */
interface WorkflowChecks {
  readonly state: PageModuleState;
  readonly loadAgain: () => void;
}
