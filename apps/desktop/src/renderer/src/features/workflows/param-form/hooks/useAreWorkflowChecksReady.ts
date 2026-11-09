// Whether the workflow checks hold their module, so a form drawn before it arrived is drawn again
// once it does.

import {
  isWorkflowCheckModuleProvided,
  subscribeToWorkflowCheckModule,
} from "@ai-sidekicks/contracts/workflow/definition/check";
import { useSyncExternalStore } from "react";

/** Whether the workflow checks answer yet; the component re-renders when they start to. */
export function useAreWorkflowChecksReady(): boolean {
  return useSyncExternalStore(subscribeToWorkflowCheckModule, isWorkflowCheckModuleProvided);
}
