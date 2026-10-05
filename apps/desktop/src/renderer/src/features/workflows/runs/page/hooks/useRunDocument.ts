import { useState } from "react";

import type {
  WorkflowDefinitionId,
  WorkflowDocument,
} from "@ai-sidekicks/contracts/workflow/definition/definition";

import { useSubjectRead } from "#renderer/hooks/useSubjectRead.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/refusal.js";
import { callDaemon } from "#renderer/services/daemon/daemon-reply.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";

/** Where the run's pinned version stands: being read, read, or refused. */
export type RunDocumentRead =
  | { readonly kind: "reading" }
  | {
      readonly kind: "read";
      readonly versionNumber: number;
      readonly document: WorkflowDocument;
    }
  | { readonly kind: "failed"; readonly refusal: Refusal };

/** The pinned version's read, and the press that asks for it again. */
export interface RunDocumentHold {
  readonly read: RunDocumentRead;
  readonly readAgain: () => void;
}

/**
 * The version a run pinned, read by its id: its number from the definition's version chain, then
 * the document saved under that number, which the run graph draws. A run whose definition was
 * deleted still reads, since the run pins its version.
 */
export function useRunDocument(
  bridge: PlatformBridge,
  definitionId: WorkflowDefinitionId | undefined,
  workflowVersionId: string | undefined,
): RunDocumentHold {
  const [readRevision, setReadRevision] = useState(0);
  const { value: read } = useSubjectRead<RunDocumentRead, RunDocumentRead>(
    bridge,
    workflowVersionId,
    (subject, signal) =>
      subject === undefined || definitionId === undefined
        ? undefined
        : readPinnedVersion(bridge, definitionId, subject, signal),
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

async function readPinnedVersion(
  bridge: PlatformBridge,
  definitionId: WorkflowDefinitionId,
  workflowVersionId: string,
  signal: AbortSignal,
): Promise<RunDocumentRead> {
  const chain = await callDaemon(
    bridge,
    "workflow.versionChainRead",
    { workflowVersionId },
    { signal },
  );
  if (chain.status === "refused") {
    return { kind: "failed", refusal: chain.refusal };
  }
  const pinned = chain.value.versions.find(
    (entry) => entry.workflowVersionId === workflowVersionId,
  );
  if (pinned === undefined) {
    return {
      kind: "failed",
      refusal: refuse(
        "workflows",
        "workflows.version_not_in_chain",
        "The version this run pinned is not in its workflow's version history.",
      ),
    };
  }
  const version = await callDaemon(
    bridge,
    "workflow.versionRead",
    { definitionId, versionNumber: pinned.versionNumber },
    { signal },
  );
  return version.status === "refused"
    ? { kind: "failed", refusal: version.refusal }
    : { kind: "read", versionNumber: pinned.versionNumber, document: version.value.document };
}
