// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's own controls and the reads behind its composer chips. Every method names the session it acts on, and every setting it changes belongs to that session alone.

import { type CompiledSchemaCheck, ucs2length } from "../../../../schema-check.js";
import type {
  PermissionLevel,
  SessionMode,
  SessionReviewTarget,
  SideQuestionId,
  SideQuestionText,
} from "../../../session/controls/methods.js";

// prettier-ignore
const schema175: any = {"description":"The five permission levels, most careful first, the same five words on every provider. Only\nthe first three ever ask the person; at `sandboxed` and `yolo` the daemon answers every ask\nitself. Plan is not a level: it is the session's mode.","type":"string","enum":["readonly","ask","reviewed","sandboxed","yolo"]};
/** Checks that a value is a {@link PermissionLevel}. */
// prettier-ignore
export const validatePermissionLevel: CompiledSchemaCheck<PermissionLevel> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PermissionLevel {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePermissionLevel.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePermissionLevel.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "readonly") || (data === "ask")) || (data === "reviewed")) || (data === "sandboxed")) || (data === "yolo"))){validatePermissionLevel.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema175.enum}}];return false;}validatePermissionLevel.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
// prettier-ignore
const schema176: any = {"description":"Whether the session's next turns plan or build: the composer's mode control.","type":"string","enum":["build","plan"]};
/** Checks that a value is a {@link SessionMode}. */
// prettier-ignore
export const validateSessionMode: CompiledSchemaCheck<SessionMode> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMode {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMode.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionMode.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "build") || (data === "plan"))){validateSessionMode.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema176.enum}}];return false;}validateSessionMode.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link SideQuestionId}. */
// prettier-ignore
export const validateSideQuestionId: CompiledSchemaCheck<SideQuestionId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SideQuestionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSideQuestionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateSideQuestionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateSideQuestionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSideQuestionId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
// prettier-ignore
const func2 = ucs2length;
// prettier-ignore
const pattern7 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link SideQuestionText}. */
// prettier-ignore
export const validateSideQuestionText: CompiledSchemaCheck<SideQuestionText> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SideQuestionText {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSideQuestionText.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func2(data) < 1){validateSideQuestionText.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern7.test(data)){validateSideQuestionText.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateSideQuestionText.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSideQuestionText.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
// prettier-ignore
const schema173: any = {"description":"What a review covers: the working tree, the staged set, or the branch against its base.","type":"string","enum":["workingTree","staged","branch"]};
/** Checks that a value is a {@link SessionReviewTarget}. */
// prettier-ignore
export const validateSessionReviewTarget: CompiledSchemaCheck<SessionReviewTarget> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReviewTarget {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReviewTarget.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionReviewTarget.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "workingTree") || (data === "staged")) || (data === "branch"))){validateSessionReviewTarget.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema173.enum}}];return false;}validateSessionReviewTarget.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
