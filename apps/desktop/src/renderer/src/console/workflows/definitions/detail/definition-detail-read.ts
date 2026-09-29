// One definition, as the pane that opened it can honestly know it.
//
// The builder pane's whole subject is a definition, and this is what composes the
// definition read, the version read and the chain read into the one answer a detail
// surface renders. The three calls are the caller's, and a rejected call reaches
// whoever supplied it.
//
// THREE READS AND NOT ONE, BECAUSE THE WIRE IS THREE READS. `workflow.definitionRead`
// answers the definition's identity and its latest version NUMBER; the body a person
// actually reads — the content hash, the schema marker, the entry record, the phase
// sequence — is `workflow.versionRead`, addressed by `(definitionId, versionNumber)`,
// which is why it cannot be put until the first has answered. The chain is a third
// question again, addressed by the opaque version id.
//
// AND THE SECOND AND THIRD GO OUT TOGETHER. Each is addressed out of the FIRST read's
// answer and neither is addressed out of the other's, so the wire orders them against
// the definition read and against nothing else. Chaining them anyway made the chain
// request hostage to the version body's latency — and, against a daemon holding that
// body open, a chain question that was never put at all while the identity it belongs
// to had already arrived.
//
// THE DEFINITION READ IS THE SUBJECT, and the other two QUALIFY it: the detail is
// served once all three have answered.
//
// THE CHAIN HAS A SECOND ARM AND IT IS NOT A REFUSAL. `workflowVersionId` is
// additive-optional on the definition read — a daemon at this contract revision always
// sends it, an older one does not — and the chain read is addressed by nothing else.
// A console that composed an id from `(definitionId, versionNumber)` would be
// inventing a wire fact: no delimiter or encoding over that pair exists anywhere on
// this wire. So the absence is `unaddressable`, which says the question could not be
// put rather than that it was put and refused.
//
// ONE READ PER MOUNT, AND NO POLLING, for `definitions/definition-directory.ts`'s
// reason: a definition version is immutable by construction — the store carries no
// updated-at column and an edit mints a new version — so a re-read on a timer would be
// a second answer to a question whose answer cannot change. Navigating back to the
// pane remounts and re-reads, which is the moment a person expects a fresh look.

import type {
  WorkflowDefinitionReadResult,
  WorkflowVersionBody,
  WorkflowVersionChainEntry,
} from "../../../bridge/index.js";
import { subjectReadStart, useSubjectRead, type SubjectRead } from "../../../store/index.js";

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
 * The version chain, or no question at all.
 *
 * TWO ARMS BECAUSE THERE ARE TWO FACTS. Served is the chain. `unaddressable` is a
 * question that could not be put: the chain read is addressed by the opaque version id
 * and the definition read did not carry one, and a console that synthesized one would
 * be inventing an encoding the wire does not have.
 */
export type WorkflowVersionChainReading =
  | { readonly status: "served"; readonly versions: readonly WorkflowVersionChainEntry[] }
  | { readonly status: "unaddressable" };

/** Everything one definition's detail surface renders, from one composed read. */
export interface WorkflowDefinitionDetail {
  readonly definition: WorkflowDefinitionReadResult;
  readonly version: WorkflowVersionBody;
  readonly chain: WorkflowVersionChainReading;
}

/**
 * What the pane knows about its definition at one moment.
 *
 * Three states and no others; the two unsettled ones come from the shared shape in
 * `store/read/subject-read-start.ts`.
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
  workflowDefinitionId: string | undefined,
): WorkflowDefinitionDetailState {
  return useSubjectRead<WorkflowDefinitionDetail, WorkflowDefinitionDetailState>(
    calls,
    workflowDefinitionId,
    () =>
      workflowDefinitionId === undefined
        ? undefined
        : composeDefinitionDetail(calls, workflowDefinitionId),
    {
      unsettled: subjectReadStart,
      settled: (detail) => ({ status: "served", detail }),
    },
  ).value;
}

/**
 * The three reads, folded into one answer.
 *
 * ONE ORDERING EDGE AND NOT TWO. The version read and the chain read are both put after
 * the DEFINITION read, because each is addressed by something only that read answers —
 * the version number for one, the opaque version id for the other. Neither is addressed
 * by anything the OTHER answers, so there is no wire reason to put them in sequence, and
 * putting them in one made a slow version body hold back a question that was already
 * fully composed. They are started together and awaited together.
 */
async function composeDefinitionDetail(
  calls: WorkflowDefinitionDetailCalls,
  workflowDefinitionId: string,
): Promise<WorkflowDefinitionDetail> {
  const definition = await calls.readDefinition({ definitionId: workflowDefinitionId });
  const [version, chain] = await Promise.all([
    calls.readVersion({ definitionId: definition.id, versionNumber: definition.versionNumber }),
    readVersionChain(calls, definition),
  ]);
  return { definition, version, chain };
}

/**
 * The chain that version belongs to, where the definition read named a version id.
 *
 * The absent arm is checked BEFORE the call rather than after it, which is the whole
 * point of the second arm: there is no request to compose without the id, and composing
 * one from the number would put a well-formed question about a version that does not
 * exist under that name.
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
