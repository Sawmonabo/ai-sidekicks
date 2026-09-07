// The three acts a definition's detail offers, as CALLS: what the hook holds for them,
// and which module carries each one out. The act set itself, its refusal vocabulary,
// and the shape a control reads are `definition-authoring.ts` beside this.
//
// THREE ACTS AND TWO MODULES, split on the seam that decides everything about them:
// `definition-authoring-export.ts` reaches the HOST and submits nothing, while
// `definition-authoring-port-acts.ts` holds importing and promoting, which both ride
// the one create on the growth port. The two answer a second press differently, take
// different arms of the latch, and fail at different seams, and each module states its
// own reasons. What is shared — the runtime handed to an act and the one record they
// all publish into — is `definition-authoring-runtime.ts` below both of them.
//
// WHAT IS LEFT HERE IS THE COORDINATOR: the held state, the latch, and the three
// closures a control presses. Nothing in this file knows what an act does.

import type { ConsoleBridge, WorkflowVersionBody } from "../../../bridge/index.js";
import { useGenerationLatch, useSubjectScopedState } from "../../../store/index.js";
import { exportDefinitionFile } from "./definition-authoring-export.js";
import { importDefinitionFile, promoteDefinition } from "./definition-authoring-port-acts.js";
import { IDLE_STATE, type AuthoringRuntime } from "./definition-authoring-runtime.js";
import type { WorkflowDefinitionAuthoring } from "./definition-authoring.js";

/**
 * Offer the three acts for one definition.
 *
 * ALL THREE ARE OFFERED WHENEVER THEIR SUBJECT EXISTS, and eligibility is never
 * computed here: whether this caller may write at a scope is the daemon's adjudication
 * and arrives as a typed refusal on the press. What this does check is whether there is
 * anything to act ON — a version body for export and promote — because that is a fact
 * about the reads this pane already holds and not a permission.
 *
 * Held against `(port, definition)` exactly as the pane's own read is, so a bridge
 * swapped underneath and a pane re-addressed at another definition each re-seed during
 * the render that brings them: no frame shows one definition's settlement under
 * another's name.
 *
 * EVERY ACT IS DISPATCHED WITH `void`, and the three act bodies are what makes that
 * safe: each of them settles its own rejection into an outcome a person reads, so
 * nothing reaches this file to be dropped.
 */
export function useWorkflowDefinitionAuthoring(
  bridge: ConsoleBridge,
  workflowDefinitionId: string | undefined,
  sessionId: string | undefined,
  body: WorkflowVersionBody | undefined,
): WorkflowDefinitionAuthoring {
  const latch = useGenerationLatch();
  const { value, publish } = useSubjectScopedState(
    bridge.growth,
    workflowDefinitionId,
    () => IDLE_STATE,
  );
  const runtime: AuthoringRuntime = {
    latch,
    growth: bridge.growth,
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
    promoteDefinition: () => {
      void promoteDefinition(runtime);
    },
  };
}
