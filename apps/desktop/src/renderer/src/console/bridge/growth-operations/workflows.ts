// The workflow plane's ledger rows: definitions, runs, phase outputs, gates, human
// forms, and the gate-chain verification that audits them.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads — and it is
// the claim `index.test.ts` beside it checks by counting this block's entries.

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
  // workflow — nine of the thirteen rows of the registered method registry, in that
  // registry's own order. The four it does not carry are named in the slate row's
  // own wire text: the two authoring writes and the version read no console surface
  // on this substrate calls, and the draft save, which is declared with no handler
  // to reach.
  workflowDefinitionList: op(
    "workflowDefinitionList",
    "workflow-run-control",
    "method",
    "enumerate the workflow definitions visible here, resolved most-specific-first, so the builder can name one it does not already hold an id for",
    "workflow.definitionList",
  ),
  workflowRunStart: op(
    "workflowRunStart",
    "workflow-run-control",
    "method",
    "start a run against a pinned definition version",
    "workflow.runStart",
  ),
  workflowRunRead: op(
    "workflowRunRead",
    "workflow-run-control",
    "method",
    "read one run's header and its per-phase projection, park surface included, so the pane renders a parked run from this one call",
    "workflow.runRead",
  ),
  workflowRunCancel: op(
    "workflowRunCancel",
    "workflow-run-control",
    "method",
    "cancel a run, the operator control that is the only named producer of the cancelled status",
    "workflow.runCancel",
  ),
  workflowRunResume: op(
    "workflowRunResume",
    "workflow-run-control",
    "method",
    "resume a parked run, carrying the explicit version re-pin as a request member rather than an operation of its own",
    "workflow.runResume",
  ),
  workflowPhaseOutputRead: op(
    "workflowPhaseOutputRead",
    "workflow-run-control",
    "method",
    "read one phase's durable outputs, which stay addressable after the run ends",
    "workflow.phaseOutputRead",
  ),
  workflowGateResolve: op(
    "workflowGateResolve",
    "workflow-run-control",
    "method",
    "resolve a phase-boundary gate and read back the appended chain row's anchor",
    "workflow.gateResolve",
  ),
  workflowHumanFormSubmit: op(
    "workflowHumanFormSubmit",
    "workflow-run-control",
    "method",
    "submit a human phase's form under optimistic concurrency, so a stale submission is refused rather than silently overwriting",
    "workflow.humanFormSubmit",
  ),
  workflowGateChainVerify: op(
    "workflowGateChainVerify",
    "workflow-run-control",
    "method",
    "verify a run's gate-resolution hash chain and report the first divergent sequence",
    "workflow.gateChainVerify",
  ),
};
