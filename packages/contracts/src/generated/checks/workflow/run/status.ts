// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The statuses every workflow run method and event shares: the run's, each step's, and what a waiting step waits on.

import type { CompiledSchemaCheck } from "../../../../schema-check.js";
import type { WorkflowRunStatus } from "../../../workflow/run/status.js";

// prettier-ignore
const schema1468: any = {"description":"A run's status; no screen shows any other. `waiting` covers a run held by a person, a chain's\nquestion or a spent provider account; it is never swept to `crashed` when the daemon starts and\nnever pruned, so a waiting run survives a restart.","type":"string","enum":["new","running","waiting","succeeded","failed","canceled","crashed"]};
/** Checks that a value is a {@link WorkflowRunStatus}. */
// prettier-ignore
export const validateWorkflowRunStatus: CompiledSchemaCheck<WorkflowRunStatus> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowRunStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowRunStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((data === "new") || (data === "running")) || (data === "waiting")) || (data === "succeeded")) || (data === "failed")) || (data === "canceled")) || (data === "crashed"))){validateWorkflowRunStatus.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1468.enum}}];return false;}validateWorkflowRunStatus.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
