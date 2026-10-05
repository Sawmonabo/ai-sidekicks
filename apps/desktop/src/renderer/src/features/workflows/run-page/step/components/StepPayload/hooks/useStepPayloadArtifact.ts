import { useState } from "react";

import type { ArtifactId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/definition";

import { useReadScope } from "@renderer/hooks/useReadScope.js";
import type { Refusal } from "@renderer/lib/refusal/refusal.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { readWorkflowPayloadItems } from "@renderer/services/artifacts/workflow-payload-items.js";

/** Where opening a payload's artifact stands: not asked, reading, read, or refused. */
export type StepPayloadArtifactState =
  | { readonly kind: "closed" }
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly items: readonly WorkflowItem[] }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** A payload artifact's state and the press that opens it. */
export interface StepPayloadArtifact {
  readonly state: StepPayloadArtifactState;
  /** Read the artifact; a press while it is being read is ignored. */
  readonly open: () => void;
}

/**
 * Open one step payload kept as an artifact, read only when the person asks, since it may be
 * large. A read whose view is gone settles nothing.
 */
export function useStepPayloadArtifact(artifactId: ArtifactId): StepPayloadArtifact {
  const bridge = usePlatformBridge();
  const readScope = useReadScope(bridge, artifactId);
  const [state, setState] = useState<StepPayloadArtifactState>({ kind: "closed" });
  const open = (): void => {
    if (state.kind === "reading") {
      return;
    }
    setState({ kind: "reading" });
    const round = readScope.openRound();
    void readWorkflowPayloadItems(bridge, artifactId, round.signal).then((reply) => {
      round.settle(() => {
        setState(
          reply.status === "served"
            ? { kind: "read", items: reply.value }
            : { kind: "refused", refusal: reply.refusal },
        );
      });
    });
  };
  return { state, open };
}
