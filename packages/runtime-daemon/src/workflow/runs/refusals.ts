// The refusal a run or step read or write answers when the run or step it names is not stored.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { WORKFLOW_NOT_FOUND_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type { WorkflowStepKey } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/** `workflow.not_found` for a run that is not stored. */
export function workflowRunNotFound(workflowRunId: WorkflowRunId): DaemonDomainError {
  return new DaemonDomainError(`No workflow run ${workflowRunId}.`, {
    code: WORKFLOW_NOT_FOUND_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { workflowRunId },
  });
}

/** `workflow.not_found` for a step that is not stored. */
export function workflowStepNotFound(stepKey: WorkflowStepKey): DaemonDomainError {
  return new DaemonDomainError(
    `No step ${String(stepKey.executionIndex)} of node ${stepKey.nodeId} in workflow run ` +
      `${stepKey.workflowRunId}.`,
    {
      code: WORKFLOW_NOT_FOUND_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { ...stepKey },
    },
  );
}
