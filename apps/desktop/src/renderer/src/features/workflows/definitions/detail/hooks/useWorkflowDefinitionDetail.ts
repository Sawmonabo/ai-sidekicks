// One definition, composed from the definition, version and chain reads; served once all three
// answer. The version read needs the definition's number and the chain read its opaque version
// id, so both go out together after the definition read. A version is immutable, so it is read
// once per mount with no polling. A rejected call reaches whoever supplied it.

import type {
  WorkflowDefinitionReadResult,
  WorkflowVersionBody,
} from "@renderer/services/wire-shapes/workflow-definition-body.js";
import type { WorkflowVersionChainEntry } from "@ai-sidekicks/contracts";
import { subjectReadStart, type SubjectRead } from "../../../subject-read-start.js";
import { useSubjectRead } from "@renderer/hooks/useSubjectRead.js";

/**
 * The three calls one definition's detail is composed from.
 *
 * Pass a stable object: a new identity re-reads the definition.
 */
export interface WorkflowDefinitionDetailCalls {
  readonly readDefinition: (request: {
    readonly definitionId: string;
  }) => Promise<WorkflowDefinitionReadResult>;
  readonly readVersion: (request: {
    readonly definitionId: string;
    readonly versionNumber: number;
  }) => Promise<WorkflowVersionBody>;
  readonly readChain: (request: {
    readonly workflowVersionId: string;
  }) => Promise<{ readonly versions: readonly WorkflowVersionChainEntry[] }>;
}

/**
 * The version chain, or no question at all: `unaddressable` means the definition read carried
 * no version id, and none can be composed from the version number because the wire has no
 * such encoding.
 */
export type WorkflowVersionChainReading =
  | { readonly status: "served"; readonly versions: readonly WorkflowVersionChainEntry[] }
  | { readonly status: "unaddressable" };

/** Everything one definition's detail renders, from one composed read. */
export interface WorkflowDefinitionDetail {
  readonly definition: WorkflowDefinitionReadResult;
  readonly version: WorkflowVersionBody;
  readonly chain: WorkflowVersionChainReading;
}

/**
 * What the pane knows about its definition at one moment. The two unsettled states come from
 * `features/workflows/subject-read-start.ts`.
 */
export type WorkflowDefinitionDetailState = SubjectRead<{
  readonly status: "served";
  readonly detail: WorkflowDefinitionDetail;
}>;

/**
 * Read one definition, its pinned version body, and its version chain, once.
 *
 * Keyed on the calls and the definition id: the calls are stable for the life of a
 * window, so a re-render never re-reads, while different calls and a pane re-addressed
 * at a different definition both do.
 */
export function useWorkflowDefinitionDetail(
  calls: WorkflowDefinitionDetailCalls,
  definitionId: string | undefined,
): WorkflowDefinitionDetailState {
  return useSubjectRead<WorkflowDefinitionDetail, WorkflowDefinitionDetailState>(
    calls,
    definitionId,
    () => (definitionId === undefined ? undefined : composeDefinitionDetail(calls, definitionId)),
    {
      unsettled: subjectReadStart,
      settled: (detail) => ({ status: "served", detail }),
    },
  ).value;
}

/**
 * The three reads, folded into one answer. The version and chain reads are both put after the
 * definition read (each is addressed by something only it answers) and neither waits on the
 * other.
 */
async function composeDefinitionDetail(
  calls: WorkflowDefinitionDetailCalls,
  definitionId: string,
): Promise<WorkflowDefinitionDetail> {
  const definition = await calls.readDefinition({ definitionId });
  const [version, chain] = await Promise.all([
    calls.readVersion({ definitionId: definition.id, versionNumber: definition.versionNumber }),
    readVersionChain(calls, definition),
  ]);
  return { definition, version, chain };
}

/**
 * The chain that version belongs to, where the definition read named a version id. The absent
 * arm returns before the call: without the id there is no request to compose.
 */
async function readVersionChain(
  calls: WorkflowDefinitionDetailCalls,
  definition: WorkflowDefinitionReadResult,
): Promise<WorkflowVersionChainReading> {
  const { workflowVersionId } = definition;
  if (workflowVersionId === undefined) {
    return { status: "unaddressable" };
  }
  const chain = await calls.readChain({ workflowVersionId });
  return { status: "served", versions: chain.versions };
}
