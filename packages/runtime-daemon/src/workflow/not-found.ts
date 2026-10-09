// The one `workflow.not_found` refusal every workflow store raises, whatever it was asked for.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { WORKFLOW_NOT_FOUND_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";
import type { WorkflowStepKey } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { DaemonDomainError } from "../ipc/domain-error.js";

/** What a missing workflow record was addressed by: a workflow, a version, a run or a step. */
export type WorkflowNotFoundSubject =
  | { readonly definitionId: string }
  | { readonly definitionId: string; readonly versionNumber: number }
  | { readonly workflowVersionId: string }
  | { readonly workflowRunId: string }
  | WorkflowStepKey;

/**
 * `workflow.not_found`: no workflow, version, run or step answers to the id given. A write to a
 * deleted workflow is refused this way too, since it is no longer in the library.
 */
export class WorkflowNotFoundError extends DaemonDomainError {
  constructor(subject: WorkflowNotFoundSubject) {
    super(`No workflow record answers to ${JSON.stringify(subject)}.`, {
      code: WORKFLOW_NOT_FOUND_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { ...subject },
    });
  }
}
