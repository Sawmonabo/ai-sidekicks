// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A child's own controls: steer, interrupt and pause one provider helper inside a run, and stop every agent a session dispatched.

import type { CompiledSchemaCheck } from "../../../schema-check.js";
import type { ChildStoppedState } from "../../run/children.js";

// prettier-ignore
const schema114: any = {"description":"The run state a stop leaves a child in: `stopped` where the provider's stop is final,\n`interrupted` where a send can continue it.","type":"string","enum":["stopped","interrupted"]};
/** Checks that a value is a {@link ChildStoppedState}. */
// prettier-ignore
export const validateChildStoppedState: CompiledSchemaCheck<ChildStoppedState> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ChildStoppedState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateChildStoppedState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateChildStoppedState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "stopped") || (data === "interrupted"))){validateChildStoppedState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema114.enum}}];return false;}validateChildStoppedState.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
