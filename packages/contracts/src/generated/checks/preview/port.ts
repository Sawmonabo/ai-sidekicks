// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The ports a machine shares with the person's other devices, and the `preview.port*` methods.

import { type CompiledSchemaCheck, SCHEMA_FORMATS } from "../../../schema-check.js";
import type { PreviewPortTicketIssueResponse } from "../../preview/port.js";

// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
// prettier-ignore
const pattern21 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link PreviewPortTicketIssueResponse}. */
// prettier-ignore
export const validatePreviewPortTicketIssueResponse: CompiledSchemaCheck<PreviewPortTicketIssueResponse> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPortTicketIssueResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPortTicketIssueResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.address === undefined) && (missing0 = "address")){validatePreviewPortTicketIssueResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "address")){validatePreviewPortTicketIssueResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.address !== undefined){let data0: any = data.address;const _errs2: any = errors;if(errors === _errs2){if(errors === _errs2){if(typeof data0 === "string"){if(!pattern21.test(data0)){validatePreviewPortTicketIssueResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}else {if(!(formats0(data0))){validatePreviewPortTicketIssueResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/format",keyword:"format",params:{format: "https-url"}}];return false;}}}else {validatePreviewPortTicketIssueResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}}else {validatePreviewPortTicketIssueResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPortTicketIssueResponse.errors = vErrors;return errors === 0;}, { evaluated: {"props":true,"dynamicProps":false,"dynamicItems":false} as any });
