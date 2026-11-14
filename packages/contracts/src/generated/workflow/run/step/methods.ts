// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `workflow.*` methods on one step: reading its input, output or log, storing what one of its panel's tabs holds as an artifact, the agent and human steps' saved outputs, answering an approval step or a chain's question, loading, saving and submitting a waiting form, and opening a fix session on a failed step, with their refusals and their method table.

import type { SchemaCheck } from "../../../../schema-check.js";
import type { ApprovalDecision } from "../../../approval.js";
import type { ArtifactId } from "../../../artifacts/id.js";
import {
  validateWorkflowFixSessionCreateResponse,
  validateWorkflowGateResolveRequest,
  validateWorkflowGateResolveResponse,
  validateWorkflowHumanFormDraftUpdateRequest,
  validateWorkflowHumanFormDraftUpdateResponse,
  validateWorkflowHumanFormReadResponse,
  validateWorkflowHumanFormSubmitRequest,
  validateWorkflowHumanFormSubmitResponse,
  validateWorkflowStepOutputListRequest,
  validateWorkflowStepOutputListResponse,
  validateWorkflowStepReadRequest,
  validateWorkflowStepReadResponse,
  validateWorkflowStepTabArtifactCreateRequest,
  validateWorkflowStepTabArtifactCreateResponse,
} from "../../../checks/workflow/run/step/methods.js";
import { validateWorkflowStepKey } from "../../../checks/workflow/run/step/record.js";
import type { WireInstant } from "../../../internal/wire-scalars.js";
import type { SessionId } from "../../../session/id.js";
import type { WorkflowNodeId } from "../../definition/document.js";
import type { WorkflowParamSpec } from "../../kind.js";
import type { WorkflowGateResolutionId } from "../gate-resolution.js";
import type { WorkflowRunId } from "../id.js";
import type { WorkflowPayloadRef, WorkflowStepKey } from "./record.js";

/**
 * A step panel's tabs, in the order the panel shows them: its three payloads, then its cost
 * and its error.
 */
export const WORKFLOW_STEP_TABS = ["input", "output", "log", "cost", "error"] as const;

/**
 * An approval answered, a form read or a form submitted on a step that is no longer waiting,
 * an answer after the step's `Timeout` passed included, even before its timer has run; also a
 * chain's question answered once it is no longer open.
 */
export const WORKFLOW_STEP_NOT_WAITING_CODE = "workflow.step.notWaiting" as const;

/** A form draft save or a form submit carrying a revision that is no longer current. */
export const WORKFLOW_HUMAN_FORM_REVISION_STALE_CODE = "workflow.humanForm.revisionStale" as const;

/**
 * One tab of a step's panel: its input, output or log, its cost or its error.
 */
export type WorkflowStepTab = "input" | "output" | "log" | "cost" | "error";
/**
 * Which of a step's three payloads a read returns: the tabs that hold items.
 */
export type WorkflowStepPayloadKind = "input" | "output" | "log";
/**
 * Where the next page of a step's payload starts. The daemon writes it and owns its format; a
 * client passes it back unchanged with the same step and payload.
 */
export type WorkflowStepReadCursor = string & { readonly __brand: "WorkflowStepReadCursor" };
/**
 * One saved output of a finished step: its summary and, for an artifact, the artifact's id. An
 * `artifactRef` output points at a stored artifact and never carries its bytes; an `inline`
 * output carries no artifact.
 */
export type WorkflowStepOutput =
  | {
      valueKind: "inline";
      /**
       * What it holds.
       */
      summary: string;
      /**
       * When the step produced it.
       */
      producedAt: WireInstant;
    }
  | {
      valueKind: "artifactRef";
      /**
       * The artifact.
       */
      artifactId: ArtifactId;
      /**
       * What it holds.
       */
      summary: string;
      /**
       * When the step produced it.
       */
      producedAt: WireInstant;
    };
/**
 * The status of a step whose outputs are listed: it finished, succeeded or failed.
 */
export type WorkflowStepOutputStatus = "succeeded" | "failed";

/**
 * The `workflow.step.read` input: one step's input, output or log, paged. Every secret value
 * was redacted before the payload was written, so a read never returns one.
 */
export interface WorkflowStepReadRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
  /**
   * Which payload.
   */
  which: WorkflowStepPayloadKind;
  /**
   * The most items on one page.
   */
  limit?: number;
  /**
   * Continue from this cursor, the previous page's `nextCursor`.
   */
  cursor?: WorkflowStepReadCursor;
}
/**
 * The `workflow.step.read` result: the payload inline or as an artifact reference, with a cursor
 * while more remains.
 */
export interface WorkflowStepReadResponse {
  /**
   * The step's node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which execution of the node.
   */
  executionIndex: number;
  /**
   * Which payload.
   */
  which: WorkflowStepPayloadKind;
  /**
   * The payload's page.
   */
  payload: WorkflowPayloadRef;
  /**
   * Where the next page starts; absent on the last.
   */
  nextCursor?: WorkflowStepReadCursor;
}
/**
 * The `workflow.step.tabArtifact.create` input: the step-panel tab whose content is stored as
 * an artifact of the run's session, for the tab's `Open as artifact`.
 */
export interface WorkflowStepTabArtifactCreateRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
  /**
   * The tab.
   */
  which: WorkflowStepTab;
}
/**
 * The `workflow.step.tabArtifact.create` result: the stored artifact's id.
 */
export interface WorkflowStepTabArtifactCreateResponse {
  /**
   * The artifact.
   */
  artifactId: ArtifactId;
}
/**
 * The `workflow.step.output.list` input: the run whose agent and human steps' outputs are listed.
 */
export interface WorkflowStepOutputListRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
}
/**
 * One finished agent or human step and its saved outputs. `status` is the step's, not the run's;
 * a retry adds steps and never rewrites one.
 */
export interface WorkflowStepOutputs {
  /**
   * The step's node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which execution of the node.
   */
  executionIndex: number;
  /**
   * How the step finished.
   */
  status: WorkflowStepOutputStatus;
  /**
   * Its saved outputs.
   */
  outputs: WorkflowStepOutput[];
}
/**
 * The `workflow.step.output.list` result: summaries and artifact references only. One step's full
 * input, output or log comes from `workflow.step.read`.
 */
export interface WorkflowStepOutputListResponse {
  /**
   * The finished agent and human steps.
   */
  steps: WorkflowStepOutputs[];
}
/**
 * The `workflow.gate.resolve` input: the person's answer to an approval step, named by `nodeId`,
 * or to the question a chain raises on its first run, which names no node: `approved` keeps the
 * chain going and `rejected` stops every run of it. The answer goes through the approvals pipeline
 * and its policy check.
 */
export interface WorkflowGateResolveRequest {
  /**
   * The run; for a chain's question, the chain's first run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The approval step answered; absent for a chain's question.
   */
  nodeId?: WorkflowNodeId;
  /**
   * The answer.
   */
  decision: ApprovalDecision;
  /**
   * The person's words with it.
   */
  feedback?: string;
}
/**
 * The `workflow.gate.resolve` result: the answer's entry in the run's approval record.
 */
export interface WorkflowGateResolveResponse {
  /**
   * The answer's record, which the `workflow.gate.resolved` event names.
   */
  gateResolutionId: WorkflowGateResolutionId;
  /**
   * When the answer was recorded, which the step panel's receipt reads.
   */
  decidedAt: WireInstant;
}
/**
 * What the person has typed into a waiting form so far, held by the daemon so a reload keeps it.
 * `revision` counts draft saves and guards only them.
 */
export interface WorkflowHumanFormDraft {
  /**
   * The form's values as typed.
   */
  formState: {
    [k: string]: unknown | undefined;
  };
  /**
   * The draft's revision, counted from 1.
   */
  revision: number;
  /**
   * When it was saved.
   */
  savedAt: WireInstant;
}
/**
 * The `workflow.humanForm.read` result: the node's prompt, its fields (the same parameter specs
 * the inspector's form draws), the draft saved so far, and `formRevision`, the token a submit
 * carries back: 0 while the step has no accepted answer.
 */
export interface WorkflowHumanFormReadResponse {
  /**
   * What the form asks.
   */
  prompt: string;
  /**
   * Its fields.
   */
  fields: WorkflowParamSpec[];
  /**
   * The revision a submit carries back.
   */
  formRevision: number;
  /**
   * The draft saved so far.
   */
  draft?: WorkflowHumanFormDraft;
}
/**
 * The `workflow.humanForm.draft.update` input: the form as it is typed. With
 * `expectedRevision`, a save over a newer draft is refused rather than overwriting it.
 */
export interface WorkflowHumanFormDraftUpdateRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
  /**
   * The form's values as typed.
   */
  formState: {
    [k: string]: unknown | undefined;
  };
  /**
   * The draft revision the save was typed over.
   */
  expectedRevision?: number;
}
/**
 * The `workflow.humanForm.draft.update` result: the draft's new revision and when it was saved.
 */
export interface WorkflowHumanFormDraftUpdateResponse {
  /**
   * The draft's new revision.
   */
  revision: number;
  /**
   * When it was saved.
   */
  savedAt: WireInstant;
}
/**
 * One `path` field's answer: the field, by its dotted place in the form (`parent.child`, or
 * `parent.0.child` inside a repeating collection), and the path picked with the platform's own
 * chooser. It sits beside `fields`, never in it, so the page's file token for the path is found at
 * one fixed member whatever the form holds; a `json` answer can hold any key.
 */
export interface WorkflowHumanFormPathAnswer {
  /**
   * The field's dotted place in the form.
   */
  field: string;
  /**
   * The path picked.
   */
  path: string;
}
/**
 * The `workflow.humanForm.submit` input: every answer is in `fields` but a `path` field's, in
 * `paths` at most once per field, and a form has no artifact field. `expectedRevision` is the
 * form's revision when read; a stale one is refused and never overwrites an accepted answer.
 */
export interface WorkflowHumanFormSubmitRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
  /**
   * The answers by field, a `path` field's aside.
   */
  fields: {
    [k: string]: unknown | undefined;
  };
  /**
   * The `path` fields' answers, one per field at most.
   */
  paths?: WorkflowHumanFormPathAnswer[];
  /**
   * The form's revision when it was read.
   */
  expectedRevision: number;
}
/**
 * The `workflow.humanForm.submit` result: when the answer was accepted.
 */
export interface WorkflowHumanFormSubmitResponse {
  /**
   * When the answer was accepted.
   */
  submittedAt: WireInstant;
}
/**
 * The `workflow.fixSession.create` result: the fix session, opened on the failed step's own
 * project and checkout and seeded with the step; the step's own record receives nothing, and the
 * run links the new session.
 */
export interface WorkflowFixSessionCreateResponse {
  /**
   * The new session.
   */
  sessionId: SessionId;
}

export {
  validateWorkflowFixSessionCreateResponse,
  validateWorkflowGateResolveRequest,
  validateWorkflowGateResolveResponse,
  validateWorkflowHumanFormDraft,
  validateWorkflowHumanFormDraftUpdateRequest,
  validateWorkflowHumanFormDraftUpdateResponse,
  validateWorkflowHumanFormPathAnswer,
  validateWorkflowHumanFormReadResponse,
  validateWorkflowHumanFormSubmitRequest,
  validateWorkflowHumanFormSubmitResponse,
  validateWorkflowStepOutput,
  validateWorkflowStepOutputListRequest,
  validateWorkflowStepOutputListResponse,
  validateWorkflowStepOutputStatus,
  validateWorkflowStepOutputs,
  validateWorkflowStepPayloadKind,
  validateWorkflowStepReadCursor,
  validateWorkflowStepReadRequest,
  validateWorkflowStepReadResponse,
  validateWorkflowStepTab,
  validateWorkflowStepTabArtifactCreateRequest,
  validateWorkflowStepTabArtifactCreateResponse,
} from "../../../checks/workflow/run/step/methods.js";

/** The methods of {@link WORKFLOW_STEP_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowStepMethodDescriptors {
  readonly "workflow.step.read": {
    readonly method: "workflow.step.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowStepReadRequest>;
    readonly responseCheck: SchemaCheck<WorkflowStepReadResponse>;
  };
  readonly "workflow.step.tabArtifact.create": {
    readonly method: "workflow.step.tabArtifact.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowStepTabArtifactCreateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowStepTabArtifactCreateResponse>;
  };
  readonly "workflow.step.output.list": {
    readonly method: "workflow.step.output.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowStepOutputListRequest>;
    readonly responseCheck: SchemaCheck<WorkflowStepOutputListResponse>;
  };
  readonly "workflow.gate.resolve": {
    readonly method: "workflow.gate.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowGateResolveRequest>;
    readonly responseCheck: SchemaCheck<WorkflowGateResolveResponse>;
  };
  readonly "workflow.humanForm.read": {
    readonly method: "workflow.humanForm.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowStepKey>;
    readonly responseCheck: SchemaCheck<WorkflowHumanFormReadResponse>;
  };
  readonly "workflow.humanForm.draft.update": {
    readonly method: "workflow.humanForm.draft.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowHumanFormDraftUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowHumanFormDraftUpdateResponse>;
  };
  readonly "workflow.humanForm.submit": {
    readonly method: "workflow.humanForm.submit";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowHumanFormSubmitRequest>;
    readonly responseCheck: SchemaCheck<WorkflowHumanFormSubmitResponse>;
  };
  readonly "workflow.fixSession.create": {
    readonly method: "workflow.fixSession.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowStepKey>;
    readonly responseCheck: SchemaCheck<WorkflowFixSessionCreateResponse>;
  };
}
/** The `workflow.*` methods on one step. */
export const WORKFLOW_STEP_METHOD_DESCRIPTORS: WorkflowStepMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "workflow.step.read": /* @__PURE__ */ Object.freeze({
      method: "workflow.step.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowStepReadRequest,
      responseCheck: validateWorkflowStepReadResponse,
    }),
    "workflow.step.tabArtifact.create": /* @__PURE__ */ Object.freeze({
      method: "workflow.step.tabArtifact.create",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowStepTabArtifactCreateRequest,
      responseCheck: validateWorkflowStepTabArtifactCreateResponse,
    }),
    "workflow.step.output.list": /* @__PURE__ */ Object.freeze({
      method: "workflow.step.output.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowStepOutputListRequest,
      responseCheck: validateWorkflowStepOutputListResponse,
    }),
    "workflow.gate.resolve": /* @__PURE__ */ Object.freeze({
      method: "workflow.gate.resolve",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowGateResolveRequest,
      responseCheck: validateWorkflowGateResolveResponse,
    }),
    "workflow.humanForm.read": /* @__PURE__ */ Object.freeze({
      method: "workflow.humanForm.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowStepKey,
      responseCheck: validateWorkflowHumanFormReadResponse,
    }),
    "workflow.humanForm.draft.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.humanForm.draft.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowHumanFormDraftUpdateRequest,
      responseCheck: validateWorkflowHumanFormDraftUpdateResponse,
    }),
    "workflow.humanForm.submit": /* @__PURE__ */ Object.freeze({
      method: "workflow.humanForm.submit",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowHumanFormSubmitRequest,
      responseCheck: validateWorkflowHumanFormSubmitResponse,
    }),
    "workflow.fixSession.create": /* @__PURE__ */ Object.freeze({
      method: "workflow.fixSession.create",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowStepKey,
      responseCheck: validateWorkflowFixSessionCreateResponse,
    }),
  });
