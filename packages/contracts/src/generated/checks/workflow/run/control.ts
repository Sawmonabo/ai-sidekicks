// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The acts on a workflow run: starting one, canceling and resuming it, retrying from a step, running one node from the builder and posting a finished run's results into a session, with their refusals and their method table.

import { type CompiledSchemaCheck, ucs2length, wireByteLength } from "../../../../schema-check.js";
import type { WorkflowCancelReason } from "../../../workflow/run/control.js";

// prettier-ignore
const func2 = ucs2length;
/** Checks that a value is a {@link WorkflowCancelReason}. */
// prettier-ignore
export const validateWorkflowCancelReason: CompiledSchemaCheck<WorkflowCancelReason> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowCancelReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowCancelReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(wireByteLength(data, this && this.attachments) > 8192){validateWorkflowCancelReason.errors = [{instancePath,schemaPath:"#/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === 0){if(typeof data === "string"){if(func2(data) > 8190){validateWorkflowCancelReason.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 8190}}];return false;}else {if(func2(data) < 1){validateWorkflowCancelReason.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateWorkflowCancelReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowCancelReason.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
