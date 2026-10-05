import { useEffect, useRef } from "react";

import { useOwnerWindow } from "@renderer/hooks/owner-window/useOwnerWindow.js";

import type {
  WorkflowCommandPress,
  WorkflowCommandRole,
  WorkflowCommandTarget,
} from "../workflow-command-target.js";

/**
 * Offers a keyed act while the component is mounted and `isOffered` holds, as a control or as the
 * fallback behind the controls; a control whose answer is not ready yet, such as a form still
 * being read, passes `false` until it is. The press is read through a ref at press time, since a
 * component rebuilds its callbacks every render and adopting the function itself would re-adopt
 * each pass or keep the first render's.
 */
export function useWorkflowCommandTarget(
  act: WorkflowCommandTarget,
  press: WorkflowCommandPress,
  role: WorkflowCommandRole = "control",
  isOffered = true,
): void {
  const ownerDocument = useOwnerWindow().document;
  const pressRef = useRef(press);
  useEffect(() => {
    pressRef.current = press;
  });
  useEffect(
    () => (isOffered ? act.adopt(() => pressRef.current(), ownerDocument, role) : undefined),
    [act, ownerDocument, role, isOffered],
  );
}
