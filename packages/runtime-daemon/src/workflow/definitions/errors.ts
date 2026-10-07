// The refusals the workflow definition store raises, each carrying its contract code.
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { WORKFLOW_VERSION_STALE_CODE } from "@ai-sidekicks/contracts/workflow/definition/methods";
import {
  WORKFLOW_DEFINITION_REFUSED_CODE,
  type WorkflowDefinitionFinding,
} from "@ai-sidekicks/contracts/workflow/definition/refusals";
import { WORKFLOW_NOT_FOUND_CODE } from "@ai-sidekicks/contracts/workflow/run/failures";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/** What a missing workflow was addressed by: its definition, one of its versions, or a version. */
export type WorkflowNotFoundSubject =
  | { readonly definitionId: string }
  | { readonly definitionId: string; readonly versionNumber: number }
  | { readonly workflowVersionId: string };

/**
 * `workflow.not_found`: no workflow, or no version, answers to the id given. A write to a
 * deleted workflow is refused this way too, since it is no longer in the library.
 */
export class WorkflowNotFoundError extends DaemonDomainError {
  constructor(subject: WorkflowNotFoundSubject) {
    super(`No workflow answers to ${JSON.stringify(subject)}.`, {
      code: WORKFLOW_NOT_FOUND_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { ...subject },
    });
  }
}

/** `workflow.definition_refused`: the document broke one or more rules, every finding listed. */
export class WorkflowDefinitionRefusedError extends DaemonDomainError {
  /** Every finding the check raised, in the order it raised them. */
  readonly findings: readonly WorkflowDefinitionFinding[];

  constructor(findings: readonly WorkflowDefinitionFinding[]) {
    super(`The workflow was refused with ${String(findings.length)} finding(s).`, {
      code: WORKFLOW_DEFINITION_REFUSED_CODE,
      detail: { findings: [...findings] },
    });
    this.findings = [...findings];
  }
}

/** `workflow.version_stale`: the version the save was based on is no longer the latest. */
export class WorkflowVersionStaleError extends DaemonDomainError {
  constructor(definitionId: string, expectedVersionNumber: number, latestVersionNumber: number) {
    super(
      `Workflow ${definitionId} is at version ${String(latestVersionNumber)}, not ` +
        `${String(expectedVersionNumber)}; nothing was saved.`,
      {
        code: WORKFLOW_VERSION_STALE_CODE,
        detail: { definitionId, expectedVersionNumber, latestVersionNumber },
      },
    );
  }
}
