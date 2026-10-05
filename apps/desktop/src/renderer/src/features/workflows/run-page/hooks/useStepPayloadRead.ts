import { useState } from "react";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow-definition";
import type { WorkflowPayloadRef, WorkflowStep } from "@ai-sidekicks/contracts/workflow-run";
import type { WorkflowStepPayloadKind } from "@ai-sidekicks/contracts/workflow-run-step";

import { useSubjectRead } from "@renderer/hooks/useSubjectRead.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/** Where one step payload's read stands. */
export type StepPayloadRead =
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly payload: WorkflowPayloadRef }
  | { readonly kind: "failed"; readonly refusal: Refusal };

/** One step payload's read, and the press that asks for it again. */
export interface StepPayloadReadHold {
  readonly read: StepPayloadRead;
  readonly readAgain: () => void;
}

/**
 * Read one of a step's three payloads through `workflow.stepRead`, page by page until the daemon
 * names no next page. An inline payload is capped in size, so its pages are bounded; one kept as
 * an artifact comes back as its reference in one page. The read starts over when the step moves
 * on, so a step that finishes while its panel is open shows what it finished with.
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
          return { kind: "read", payload };
        }
        items.push(...payload.items);
        cursor = nextCursor;
      } while (cursor !== undefined);
      return { kind: "read", payload: { kind: "inline", items } };
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
