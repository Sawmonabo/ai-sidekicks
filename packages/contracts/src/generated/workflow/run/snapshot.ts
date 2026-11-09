// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The two numbers that name one of a workflow run's snapshots: which execution of the run it belongs to, and which of that execution's approval pauses took it.

import type { SchemaCheck } from "../../../schema-check.js";

/**
 * Which execution of a run a snapshot belongs to: 0 for the first, one more at each re-run.
 */
export type WorkflowRunEpoch = number;
/**
 * Which approval pause of one execution took a snapshot, counted from 1.
 */
export type WorkflowRunPauseNumber = number;

// prettier-ignore
function validate2751(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunEpoch {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2751.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validate2751.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validate2751.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 0 || isNaN(data)){validate2751.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}validate2751.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2751.errors = null as any[] | null;
// prettier-ignore
validate2751.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2752(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowRunPauseNumber {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2752.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validate2752.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validate2752.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 1 || isNaN(data)){validate2752.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}validate2752.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2752.errors = null as any[] | null;
// prettier-ignore
validate2752.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowRunEpoch}. */
export const validateWorkflowRunEpoch: SchemaCheck<WorkflowRunEpoch> = validate2751;
/** Checks that a value is a {@link WorkflowRunPauseNumber}. */
export const validateWorkflowRunPauseNumber: SchemaCheck<WorkflowRunPauseNumber> = validate2752;
