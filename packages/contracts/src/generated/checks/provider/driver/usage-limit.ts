// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The usage-limit signal and the spent-retries signal a driver hands over with a turn's end, which a failed run's cause carries.

import type { CompiledSchemaCheck } from "../../../../schema-check.js";
import type { ProviderUsageLimitResetBoundary } from "../../../provider/driver/usage-limit.js";
import { validateWireInstant } from "../../internal/wire-scalars.js";

/** Checks that a value is a {@link ProviderUsageLimitResetBoundary}. */
// prettier-ignore
export const validateProviderUsageLimitResetBoundary: CompiledSchemaCheck<ProviderUsageLimitResetBoundary> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderUsageLimitResetBoundary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderUsageLimitResetBoundary.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.resetsAt === undefined) && (missing0 = "resetsAt")){validateProviderUsageLimitResetBoundary.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "resetsAt")){validateProviderUsageLimitResetBoundary.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.resetsAt !== undefined){if(!(validateWireInstant.call(this, data.resetsAt, {instancePath:instancePath+"/resetsAt",parentData:data,parentDataProperty:"resetsAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}}}}}else {validateProviderUsageLimitResetBoundary.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderUsageLimitResetBoundary.errors = vErrors;return errors === 0;}, { evaluated: {"props":true,"dynamicProps":false,"dynamicItems":false} as any });
