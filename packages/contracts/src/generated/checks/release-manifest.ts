// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The release manifest: the JSON file a release publishes beside its artifacts, and the version a release carries.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import type { ReleaseVersion, Sha256Hex } from "../release-manifest.js";

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern131 = new RegExp("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$", "u");
/** Checks that a value is a {@link ReleaseVersion}. */
// prettier-ignore
export const validateReleaseVersion: CompiledSchemaCheck<ReleaseVersion> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ReleaseVersion {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateReleaseVersion.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 64){validateReleaseVersion.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}else {if(!pattern131.test(data)){validateReleaseVersion.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"}}];return false;}}}else {validateReleaseVersion.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateReleaseVersion.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
// prettier-ignore
const pattern87 = new RegExp("^[0-9a-f]{64}$", "u");
/** Checks that a value is a {@link Sha256Hex}. */
// prettier-ignore
export const validateSha256Hex: CompiledSchemaCheck<Sha256Hex> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is Sha256Hex {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSha256Hex.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern87.test(data)){validateSha256Hex.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validateSha256Hex.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSha256Hex.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
