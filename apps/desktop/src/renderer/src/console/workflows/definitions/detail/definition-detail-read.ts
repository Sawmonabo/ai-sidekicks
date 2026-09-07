// One definition, as the pane that opened it can honestly know it.
//
// The builder pane's whole subject is a definition, and until this read it had no way
// to ask for one: the definition read, the version read and the chain read were on no
// growth-port row at all, so the addressed pane rendered "this definition has not been
// read in this window" in every build including the fixture — a true sentence about a
// question nothing could put. Three operations now exist, and this is what composes
// them into the one answer a detail surface renders.
//
// THREE READS AND NOT ONE, BECAUSE THE WIRE IS THREE READS. `workflow.definitionRead`
// answers the definition's identity and its latest version NUMBER; the body a person
// actually reads — the content hash, the schema marker, the entry record, the phase
// sequence — is `workflow.versionRead`, addressed by `(definitionId, versionNumber)`,
// which is why it cannot be put until the first has answered. The chain is a third
// question again, addressed by the opaque version id, and the registry resolves no
// version id at all — so it rides its own slate row and is asked last.
//
// AND THE THREE SETTLE INDEPENDENTLY, WHICH IS THE WHOLE SHAPE OF THIS MODULE. The
// definition read is the subject: without it there is nothing to render and the state
// is `unavailable`. The other two QUALIFY that subject, so a refused version body
// leaves the identity on screen with the body's own refusal beside it, and a refused
// chain leaves both. Folding all three into one refusal would withdraw facts the
// daemon answered, which is the mistake the definitions browser's own continuation
// arm exists to avoid one surface up.
//
// THE CHAIN HAS A THIRD ARM AND IT IS NOT A REFUSAL. `workflowVersionId` is
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

import {
  settleGrowthRead,
  useSettledGrowthRead,
  type GrowthPort,
  type SettledReadRefusal,
  type WorkflowDefinitionReadResult,
  type WorkflowVersionBody,
  type WorkflowVersionChainEntry,
} from "../../../bridge/index.js";
import { subjectReadStart, type SubjectRead } from "../../../store/index.js";

/**
 * The version body, or the refusal that stands in its place.
 *
 * Its own reading rather than an optional member on the detail, because "the body was
 * refused" and "the body is not here" are different things to draw and only one of
 * them carries a daemon sentence.
 */
export type WorkflowVersionBodyReading =
  | { readonly status: "served"; readonly body: WorkflowVersionBody }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * The version chain, the refusal that stands in its place, or no question at all.
 *
 * THREE ARMS BECAUSE THERE ARE THREE FACTS. Served is the chain. Unavailable is a
 * question that was put and refused, and carries the daemon's own sentence.
 * `unaddressable` is a question that could not be put: the chain read is addressed by
 * the opaque version id and the definition read did not carry one, and a console that
 * synthesized one would be inventing an encoding the wire does not have.
 */
export type WorkflowVersionChainReading =
  | { readonly status: "served"; readonly versions: readonly WorkflowVersionChainEntry[] }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal }
  | { readonly status: "unaddressable" };

/** Everything one definition's detail surface renders, from one composed read. */
export interface WorkflowDefinitionDetail {
  readonly definition: WorkflowDefinitionReadResult;
  readonly version: WorkflowVersionBodyReading;
  readonly chain: WorkflowVersionChainReading;
}

/** What this read looks like once its subject has an answer, either kind. */
type SettledDefinitionDetail =
  | { readonly status: "served"; readonly detail: WorkflowDefinitionDetail }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * What the pane knows about its definition at one moment.
 *
 * Four states and no others; the two unsettled ones come from the shared shape in
 * `store/subject-read-start.ts`, which is the rule every growth read on this seam
 * holds to.
 */
export type WorkflowDefinitionDetailState = SubjectRead<SettledDefinitionDetail>;

/**
 * Read one definition, its pinned version body, and its version chain, once.
 *
 * Keyed on the port and the definition id: the port is minted once per bridge and is
 * stable for the life of a window, so a re-render never re-reads, while a bridge
 * swapped underneath — the fixture's scenario switch — and a pane re-addressed at a
 * different definition both do.
 */
export function useWorkflowDefinitionDetail(
  growth: GrowthPort,
  workflowDefinitionId: string | undefined,
): WorkflowDefinitionDetailState {
  return useSettledGrowthRead<DefinitionDetailOutcome, WorkflowDefinitionDetailState>(
    growth,
    workflowDefinitionId,
    () => readDefinitionDetail(growth, workflowDefinitionId),
    {
      unsettled: subjectReadStart,
      settled: (settlement) =>
        settlement.status === "served"
          ? { status: "served", detail: settlement.detail }
          : { status: "unavailable", refusal: settlement },
    },
  ).value;
}

/**
 * What the composed read answers with: the whole detail, or the SUBJECT read's refusal.
 *
 * Only the definition read can refuse the whole thing, which is what makes this a
 * two-armed outcome over three calls: the other two answer members of the served arm.
 */
type DefinitionDetailOutcome =
  | { readonly status: "served"; readonly detail: WorkflowDefinitionDetail }
  | SettledReadRefusal;

/**
 * The three reads, in the only order the wire admits, or no question at all.
 *
 * The request carries a required definition id, so a pane naming none has nothing to
 * ask — the `unasked` state — and the absence is answered here, where the request is
 * built.
 *
 * The version read is put after the definition read rather than beside it because it
 * is addressed by a number the first read answers; the chain is put after for the
 * same reason. Serial rather than parallel is therefore the wire's shape and not a
 * choice about concurrency.
 */
function readDefinitionDetail(
  growth: GrowthPort,
  workflowDefinitionId: string | undefined,
): Promise<DefinitionDetailOutcome> | undefined {
  return workflowDefinitionId === undefined
    ? undefined
    : composeDefinitionDetail(growth, workflowDefinitionId);
}

/** The three reads, settled and folded into one answer. */
async function composeDefinitionDetail(
  growth: GrowthPort,
  workflowDefinitionId: string,
): Promise<DefinitionDetailOutcome> {
  const definition = await settleGrowthRead(
    growth.workflowDefinitionRead({ definitionId: workflowDefinitionId }),
  );
  if (definition.status !== "served") {
    return definition;
  }
  const version = await readVersionBody(growth, definition.value);
  const chain = await readVersionChain(growth, definition.value);
  return { status: "served", detail: { definition: definition.value, version, chain } };
}

/** The body of the version the definition read answered with. */
async function readVersionBody(
  growth: GrowthPort,
  definition: WorkflowDefinitionReadResult,
): Promise<WorkflowVersionBodyReading> {
  const settlement = await settleGrowthRead(
    growth.workflowVersionRead({
      definitionId: definition.id,
      versionNumber: definition.versionNumber,
    }),
  );
  return settlement.status === "served"
    ? { status: "served", body: settlement.value }
    : { status: "unavailable", refusal: settlement };
}

/**
 * The chain that version belongs to, where the definition read named a version id.
 *
 * The absent arm is checked BEFORE the call rather than after it, which is the whole
 * point of the third arm: there is no request to compose without the id, and composing
 * one from the number would put a well-formed question about a version that does not
 * exist under that name.
 */
async function readVersionChain(
  growth: GrowthPort,
  definition: WorkflowDefinitionReadResult,
): Promise<WorkflowVersionChainReading> {
  const { workflowVersionId } = definition;
  if (workflowVersionId === undefined) {
    return { status: "unaddressable" };
  }
  const settlement = await settleGrowthRead(growth.workflowVersionChainRead({ workflowVersionId }));
  return settlement.status === "served"
    ? { status: "served", versions: settlement.value.versions }
    : { status: "unavailable", refusal: settlement };
}
