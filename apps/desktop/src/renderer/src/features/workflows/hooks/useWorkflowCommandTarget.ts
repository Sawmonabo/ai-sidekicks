import { useEffect } from "react";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";

import type {
  WorkflowCommandOffer,
  WorkflowCommandRole,
  WorkflowCommandTarget,
} from "../command-target.js";

/**
 * Offers a keyed act while the component is mounted and `isOffered` holds, as a control or as the
 * fallback behind the controls; a control whose answer is not ready yet, such as a form still
 * being read, passes `false` until it is. The offer is read through a ref when the act is listed
 * or pressed, since a component rebuilds its callbacks every render and adopting them directly
 * would re-adopt each pass or keep the first render's.
 */
export function useWorkflowCommandTarget(
  act: WorkflowCommandTarget,
  offer: WorkflowCommandOffer,
  role: WorkflowCommandRole = "control",
  isOffered = true,
): void {
  const ownerDocument = useOwnerWindow().document;
  const offerRef = useLatestRef(offer);
  useEffect(
    () =>
      isOffered
        ? act.adopt(
            {
              unavailable: () => offerRef.current.unavailable(),
              take: () => {
                offerRef.current.take();
              },
            },
            ownerDocument,
            role,
          )
        : undefined,
    [act, ownerDocument, role, isOffered, offerRef],
  );
}
