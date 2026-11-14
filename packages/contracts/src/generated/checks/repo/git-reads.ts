// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The git reads the panes make: the branch list, reading a file's lines by path or by blob, and the signal that a session's working folder changed.

import type { CompiledSchemaCheck } from "../../../schema-check.js";
import type { GitObjectId } from "../../repo/git-reads.js";

// prettier-ignore
const pattern117 = new RegExp("^(?:[0-9a-f]{40}|[0-9a-f]{64})$", "u");
/** Checks that a value is a {@link GitObjectId}. */
// prettier-ignore
export const validateGitObjectId: CompiledSchemaCheck<GitObjectId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is GitObjectId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateGitObjectId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern117.test(data)){validateGitObjectId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"}}];return false;}}else {validateGitObjectId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateGitObjectId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
