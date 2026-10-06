import { useState } from "react";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step";
import type { WorkflowStepPayloadKind } from "@ai-sidekicks/contracts/workflow/run/step";

import { useSubjectRead } from "#renderer/hooks/useSubjectRead.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { readWorkflowPayloadItems } from "#renderer/services/artifacts/workflow-payload-items.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** Where a payload's items were kept: inline on the step's row, or as an artifact of its size. */
export type StepPayloadStorage =
  | { readonly kind: "inline" }
  | { readonly kind: "artifact"; readonly sizeBytes: number };

/** Where one step payload's read stands: its items, and where they were kept, once read. */
export type StepPayloadRead =
  | { readonly kind: "reading" }
  | {
      readonly kind: "read";
      readonly items: readonly WorkflowItem[];
      readonly storage: StepPayloadStorage;
    }
  | { readonly kind: "failed"; readonly refusal: Refusal };

/** One step payload's read, and the press that asks for it again. */
export interface StepPayloadReadHold {
  readonly read: StepPayloadRead;
  readonly readAgain: () => void;
}

/**
 * Read one of a step's three payloads through `workflow.stepRead`, page by page until the daemon
 * names no next page. An inline payload is capped in size, so its pages are bounded; one kept as
 * an artifact comes back as its reference in one page, and its items are then read from the
 * artifact, so the tab draws both the same way and says which it was. The read starts over when
 * the step moves on, so a step that finishes while its panel is open shows what it finished with.
 */
export function useStepPayloadRead(
  bridge: PlatformBridge,
  step: WorkflowStep,
  which: WorkflowStepPayloadKind,
): StepPayloadReadHold {
  const [readRevision, setReadRevision] = useState(0);
  const { workflowRunId, nodeId, executionIndex } = step;
  const subject =
    `${workflowRunId}/${nodeId}/${String(executionIndex)}/${which}/` +
    `${step.status}/${step.finishedAt ?? ""}`;
  const { value: read } = useSubjectRead<StepPayloadRead, StepPayloadRead>(
    bridge,
    subject,
    async (_subject, signal) => {
      const items: WorkflowItem[] = [];
      let cursor: string | undefined;
      do {
        const reply = await callDaemon(
          bridge,
          "workflow.stepRead",
          {
            workflowRunId,
            nodeId,
            executionIndex,
            which,
            ...(cursor === undefined ? {} : { cursor }),
          },
          { signal },
        );
        if (reply.status === "refused") {
          return { kind: "failed", refusal: reply.refusal };
        }
        const { payload, nextCursor } = reply.value;
        if (payload.kind === "artifact") {
          const kept = await readWorkflowPayloadItems(bridge, payload.artifactId, signal);
          return kept.status === "served"
            ? {
                kind: "read",
                items: kept.value,
                storage: { kind: "artifact", sizeBytes: payload.sizeBytes },
              }
            : { kind: "failed", refusal: kept.refusal };
        }
        items.push(...payload.items);
        cursor = nextCursor;
      } while (cursor !== undefined);
      return { kind: "read", items, storage: { kind: "inline" } };
    },
    { unsettled: () => ({ kind: "reading" }), settled: (value) => value },
    readRevision,
  );
  return {
    read,
    readAgain: () => {
      setReadRevision((revision) => revision + 1);
    },
  };
}
