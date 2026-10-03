// The two authoring acts as calls: this hook holds the state, the latch and the two closures a
// control presses, and each act module carries out its own act. The act set and refusal
// vocabulary are in `definition-authoring.ts`; the shared runtime is in
// `definition-authoring-runtime.ts`.
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { WorkflowVersionBody } from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { exportDefinitionFile } from "../definition-authoring-export.js";
import { importDefinitionFile } from "../definition-authoring-port-acts.js";
import {
  IDLE_STATE,
  type AuthoringRuntime,
  type WorkflowDefinitionCreateCall,
} from "../definition-authoring-runtime.js";
import type { WorkflowDefinitionAuthoring } from "../definition-authoring.js";

/**
 * Offer the two acts for one definition. Eligibility is the daemon's call, never computed here.
 *
 * State is held against `(create call, definition)`, so a new call identity or another
 * definition re-seeds in the render that brings it and no frame shows one definition's
 * settlement under another's name. Acts run with `void`: an export settles its own rejection
 * into an outcome, and a rejected create reaches the host uncaught.
 */
export function useWorkflowDefinitionAuthoring(
  bridge: PlatformBridge,
  createDefinition: WorkflowDefinitionCreateCall,
  definitionId: string | undefined,
  sessionId: string | undefined,
  body: WorkflowVersionBody,
): WorkflowDefinitionAuthoring {
  const latch = useGenerationLatch();
  const { value, publish } = useSubjectScopedState(
    createDefinition,
    definitionId,
    () => IDLE_STATE,
  );
  const runtime: AuthoringRuntime = {
    latch,
    createDefinition,
    bridge,
    sessionId,
    body,
    definitionId,
    publish,
  };
  return {
    outcomes: value.outcomes,
    exportedFile: value.exportedFile,
    exportDefinition: () => {
      void exportDefinitionFile(runtime);
    },
    importDefinition: (text) => {
      void importDefinitionFile(runtime, text);
    },
  };
}
