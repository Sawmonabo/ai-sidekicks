// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Where a run stands, the state it starts in and the states it ends in.

import type { CompiledSchemaCheck } from "../../schema-check.js";

/**
 * The state a run is created in. No state change enters it, so the event entering it creates
 * a run.
 */
export const RUN_INITIAL_STATE = "queued" as const;

/** The states a run ends in; the event entering one is the terminal record of its run version. */
export const RUN_TERMINAL_STATES = ["completed", "interrupted", "stopped", "failed"] as const;

/**
 * Where a run stands. `pausing` is the step in flight finishing after a pause was asked for; the
 * run reads `paused` once nothing runs. `stopped` is a child ended for good by a stop that reached
 * several agents; a provider whose stop leaves a child resumable reads `interrupted` instead.
 */
export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waitingForApproval"
  | "waitingForInput"
  | "pausing"
  | "paused"
  | "completed"
  | "interrupted"
  | "stopped"
  | "failed";

// prettier-ignore
const schema577: any = {"description":"Where a run stands. `pausing` is the step in flight finishing after a pause was asked for; the\nrun reads `paused` once nothing runs. `stopped` is a child ended for good by a stop that reached\nseveral agents; a provider whose stop leaves a child resumable reads `interrupted` instead.","type":"string","enum":["queued","starting","running","waitingForApproval","waitingForInput","pausing","paused","completed","interrupted","stopped","failed"]};
/** Checks that a value is a {@link RunState}. */
// prettier-ignore
export const validateRunState: CompiledSchemaCheck<RunState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRunState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((((((data === "queued") || (data === "starting")) || (data === "running")) || (data === "waitingForApproval")) || (data === "waitingForInput")) || (data === "pausing")) || (data === "paused")) || (data === "completed")) || (data === "interrupted")) || (data === "stopped")) || (data === "failed"))){validateRunState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema577.enum}}];return false;}validateRunState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
