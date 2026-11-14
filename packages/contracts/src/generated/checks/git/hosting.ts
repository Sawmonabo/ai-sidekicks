// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What the hosting service answers: the self-hosted git hosts, the change requests on a branch, the reviewer and label candidates, posting a review, answering a thread and reading a failing check's log.

import type { CompiledSchemaCheck } from "../../../schema-check.js";
import type { ReviewSubmitVerdict } from "../../git/hosting.js";

// prettier-ignore
const schema186: any = {"description":"The verdict the person posts a review under.","type":"string","enum":["comment","approve","requestChanges"]};
/** Checks that a value is a {@link ReviewSubmitVerdict}. */
// prettier-ignore
export const validateReviewSubmitVerdict: CompiledSchemaCheck<ReviewSubmitVerdict> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReviewSubmitVerdict {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReviewSubmitVerdict.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateReviewSubmitVerdict.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "comment") || (data === "approve")) || (data === "requestChanges"))){validateReviewSubmitVerdict.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema186.enum}}];return false;}validateReviewSubmitVerdict.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
