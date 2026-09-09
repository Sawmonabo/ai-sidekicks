// The workflow plane's ledger rows: definitions, runs, phase outputs, gates, the
// gate-chain verification that audits them, the two reads the registry does not carry
// — the run enumeration and the version chain — and the definition plane's own three
// registry rows, each group on a slate row of its own.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. Each section
// comment below is that section's own, kept with the rows it heads — and the first is
// the claim `index.test.ts` beside it checks by counting the rows on that row's id.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type WorkflowOperationId = Extract<GrowthOperationId, `workflow${string}`>;

/** The workflow rows, in the order the single table carried them. */
export const WORKFLOW_GROWTH_OPERATIONS: Readonly<
  Record<WorkflowOperationId, GrowthOperationEntry>
> = {
  // workflow — the nine rows below are nine of the thirteen rows of the registered
  // method registry, in that registry's own order. The four it does not carry are
  // named in the slate row's own wire text: the definition read, the version read and
  // the authoring write, which serve a different surface and are filed under
  // `workflow-definition-authoring` at the foot of this table, and the draft save,
  // which is declared with no handler to reach and is on no row at all.
  workflowDefinitionList: op(
    "workflowDefinitionList",
    "workflow-run-control",
    "method",
    "workflow.definitionList",
  ),
  workflowRunStart: op("workflowRunStart", "workflow-run-control", "method", "workflow.runStart"),
  workflowRunRead: op("workflowRunRead", "workflow-run-control", "method", "workflow.runRead"),
  workflowRunCancel: op(
    "workflowRunCancel",
    "workflow-run-control",
    "method",
    "workflow.runCancel",
  ),
  workflowRunResume: op(
    "workflowRunResume",
    "workflow-run-control",
    "method",
    "workflow.runResume",
  ),
  workflowPhaseOutputRead: op(
    "workflowPhaseOutputRead",
    "workflow-run-control",
    "method",
    "workflow.phaseOutputRead",
  ),
  workflowGateResolve: op(
    "workflowGateResolve",
    "workflow-run-control",
    "method",
    "workflow.gateResolve",
  ),
  workflowHumanFormSubmit: op(
    "workflowHumanFormSubmit",
    "workflow-run-control",
    "method",
    "workflow.humanFormSubmit",
  ),
  workflowGateChainVerify: op(
    "workflowGateChainVerify",
    "workflow-run-control",
    "method",
    "workflow.gateChainVerify",
  ),
  // The run enumeration, on its own row and naming no wire method — the corpus
  // registers none, and an invented string here would be a wire fact traceable to
  // nothing. It is why the section comment above scopes its count to the nine rows
  // it heads rather than to this block.
  workflowRunList: op("workflowRunList", "workflow-run-enumeration", "method"),
  // The version chain, on the same footing as the enumeration above and for the
  // mirror-image reason. The registry HAS a version read and it is addressed by
  // `(definitionId, versionNumber)`, which a caller holding one opaque version id
  // holds neither half of — so this names no wire method either, and inventing
  // `workflow.versionChainRead` here would be a string traceable to nothing.
  workflowVersionChainRead: op("workflowVersionChainRead", "workflow-version-chain", "method"),
  // The definition plane's own three registry rows, on a slate row of their own. They
  // are registered method strings exactly as the nine above are, and they are NOT on
  // that row because its count — nine of thirteen — is the claim that the enumeration,
  // the run operations, the gate, the outputs and the form submit are what a run pane
  // needs and that opening a definition is a different surface's question. The fourth
  // row neither block carries is the draft save, which is declared with no V1 handler.
  workflowDefinitionRead: op(
    "workflowDefinitionRead",
    "workflow-definition-authoring",
    "method",
    "workflow.definitionRead",
  ),
  workflowVersionRead: op(
    "workflowVersionRead",
    "workflow-definition-authoring",
    "method",
    "workflow.versionRead",
  ),
  workflowDefinitionCreate: op(
    "workflowDefinitionCreate",
    "workflow-definition-authoring",
    "method",
    "workflow.definitionCreate",
  ),
};

/**
 * What each of this plane's operations is, in a sentence.
 *
 * A second declaration rather than a member of the row beside it — `index.ts` states
 * the rule, which is `growth-slate-consumers.ts`'s: the split is by CONSUMER, and no
 * running console reads a sentence. The `Record` is over this plane's own id set, so a
 * row with no sentence and a sentence under an unknown id are both compile errors.
 */
export const WORKFLOW_GROWTH_OPERATION_SUMMARIES: Readonly<Record<WorkflowOperationId, string>> = {
  workflowDefinitionList:
    "enumerate the workflow definitions visible here, resolved most-specific-first, so the builder can name one it does not already hold an id for",
  workflowRunStart: "start a run against a pinned definition version",
  workflowRunRead:
    "read one run's header and its per-phase projection, park surface included, so the pane renders a parked run from this one call",
  workflowRunCancel:
    "cancel a run, the operator control that is the only named producer of the cancelled status",
  workflowRunResume:
    "resume a parked run, carrying the explicit version re-pin as a request member rather than an operation of its own",
  workflowPhaseOutputRead:
    "read one phase's durable outputs, which stay addressable after the run ends",
  workflowGateResolve:
    "resolve a phase-boundary gate and read back the appended chain row's anchor",
  workflowHumanFormSubmit:
    "submit a human phase's form under optimistic concurrency, so a stale submission is refused rather than silently overwriting",
  workflowGateChainVerify:
    "verify a run's gate-resolution hash chain and report the first divergent sequence",
  workflowRunList:
    "enumerate the workflow runs a session holds, so a person can see what is running and what is parked without already holding a run id",
  workflowVersionChainRead:
    "resolve the version chain one run's pinned version belongs to, so a resume can offer a re-pin target the operator chose rather than a version nobody read",
  workflowDefinitionRead:
    "open one definition — its scope identity, its latest version, and the phase sequence that version holds — so a browser row leads somewhere rather than to a pane with nothing in it",
  workflowVersionRead:
    "read one immutable version body with its content hash and schema marker, which is both what a detail pane shows and what an export serializes into the canonical file form",
  workflowDefinitionCreate:
    "submit a definition body — the one write all five authoring acts ride, whose target scope and not whose gesture is what the daemon's operator-scope authorization keys on",
};
