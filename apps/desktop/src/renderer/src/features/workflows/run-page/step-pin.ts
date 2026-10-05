// Whether a step's output may be pinned onto its node as builder test data: only a node with one
// main output, and only items that carry no file. The run's pinned document names the node's
// outputs by the edges that leave it; the items are checked again once read, since an output kept
// as an artifact is read only when the pin is pressed.

import type {
  WorkflowDocument,
  WorkflowItem,
  WorkflowPinnedItem,
} from "@ai-sidekicks/contracts/workflow-definition";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow-run";

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import type { RunControlAvailability } from "../run-controls.js";

/** What a pin refuses with when the output it read carries a file. */
export const PIN_CARRIES_FILE_REFUSAL: Refusal = refuse(
  "workflows",
  "workflows.pin_carries_file",
  "Output that carries a file cannot be pinned as test data.",
);

/** Whether `Pin this output` may act on this step of a run pinned to `document`. */
export function pinAvailability(
  document: WorkflowDocument | undefined,
  step: WorkflowStep,
): RunControlAvailability {
  const mainOutputs = new Set(
    (document?.edges ?? [])
      .filter(
        (edge) => edge.source === step.nodeId && edge.sourceHandle.startsWith("outputs/main/"),
      )
      .map((edge) => edge.sourceHandle),
  );
  if (mainOutputs.size > 1) {
    return { kind: "refused", reason: "Only a step with one main output can be pinned." };
  }
  if (step.outputRef.kind === "inline" && pinnedItemsOf(step.outputRef.items) === undefined) {
    return { kind: "refused", reason: PIN_CARRIES_FILE_REFUSAL.detail };
  }
  return { kind: "allowed" };
}

/** The items as a pin sends them, or `undefined` when any of them carries a file. */
export function pinnedItemsOf(items: readonly WorkflowItem[]): WorkflowPinnedItem[] | undefined {
  if (items.some((item) => item.binary !== undefined && Object.keys(item.binary).length > 0)) {
    return undefined;
  }
  return items.map(({ binary: _binary, ...item }) => item);
}
