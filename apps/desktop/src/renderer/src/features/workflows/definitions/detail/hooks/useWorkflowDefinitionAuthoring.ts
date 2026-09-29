// The two acts a definition's detail offers, as CALLS: what the hook holds for them,
// and which module carries each one out. The act set itself, its refusal vocabulary,
// and the shape a control reads are `definition-authoring.ts` beside this.
//
// TWO ACTS AND TWO MODULES, split on the seam that decides everything about them:
// `definition-authoring-export.ts` reaches the HOST and submits nothing, while
// `definition-authoring-port-acts.ts` holds importing, which rides the one create the
// caller supplies. The two answer a second press differently, take different arms of
// the latch, and fail at different seams, and each module states its own reasons. What
// is shared — the runtime handed to an act and the one record they all publish into —
// is `definition-authoring-runtime.ts` below both of them.
//
// WHAT IS LEFT HERE IS THE COORDINATOR: the held state, the latch, and the two
// closures a control presses. Nothing in this file knows what an act does.

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import type { WorkflowVersionBody } from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { useGenerationLatch } from "@renderer/lib/reads/generation-latch.js";
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
 * Offer the two acts for one definition.
 *
 * Eligibility is never computed here: whether this caller may write at a scope is the
 * daemon's adjudication. The version body is the one the export serializes.
 *
 * Held against `(create call, definition)` exactly as the pane's own read is, so a new
 * call identity and a pane re-addressed at another definition each re-seed during the
 * render that brings them: no frame shows one definition's settlement under another's
 * name.
 *
 * EVERY ACT IS DISPATCHED WITH `void`. The export settles its own rejection into an
 * outcome a person reads; a rejected create is not caught and reaches the host.
 */
export function useWorkflowDefinitionAuthoring(
  bridge: ConsoleBridge,
  createDefinition: WorkflowDefinitionCreateCall,
  workflowDefinitionId: string | undefined,
  sessionId: string | undefined,
  body: WorkflowVersionBody,
): WorkflowDefinitionAuthoring {
  const latch = useGenerationLatch();
  const { value, publish } = useSubjectScopedState(
    createDefinition,
    workflowDefinitionId,
    () => IDLE_STATE,
  );
  const runtime: AuthoringRuntime = {
    latch,
    createDefinition,
    bridge,
    sessionId,
    body,
    workflowDefinitionId,
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
