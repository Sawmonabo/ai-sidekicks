// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The daemon-assigned id of the one machine a daemon runs on.

import { type CompiledSchemaCheck, ucs2length } from "../../../schema-check.js";
import type { MachineId } from "../../machine/id.js";

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link MachineId}. */
// prettier-ignore
export const validateMachineId: CompiledSchemaCheck<MachineId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MachineId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMachineId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateMachineId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateMachineId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateMachineId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateMachineId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
