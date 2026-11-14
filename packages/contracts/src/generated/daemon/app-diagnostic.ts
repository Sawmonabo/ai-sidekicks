// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What the desktop app records about itself, which its main process hands the service to write in its diagnostic log.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";

/** The longest each text of an app diagnostic record may be. */
export const APP_DIAGNOSTIC_TEXT_BOUNDS = {
  name: 128,
  message: 1024,
  stack: 8192,
  address: 2048,
  reason: 64,
  label: 128,
} as const;

/** Every place an error can go unhandled, in order. */
export const APP_DIAGNOSTIC_ROLES = [
  "main",
  "consoleDocument",
  "consoleWindow",
  "paneWindow",
] as const;

/** Every severity of a captured line, worst first. */
export const APP_DIAGNOSTIC_SEVERITIES = ["error", "warning", "notice"] as const;

/**
 * Where in the app an error went unhandled: main; the hidden console document, which runs the
 * code of every window, so its errors read here; or a window of session views or a pane's own
 * window, for what that window's own objects raise.
 */
export type AppDiagnosticRole = "main" | "consoleDocument" | "consoleWindow" | "paneWindow";
/**
 * How bad a captured line is.
 */
export type AppDiagnosticSeverity = "error" | "warning" | "notice";
/**
 * Why records were not written.
 */
export type AppDiagnosticHeldBackCause =
  | "windowBufferFull"
  | "pastRate"
  | "serviceUnreachable"
  | "serviceRefused";
/**
 * One record of `daemon.appDiagnostic.record`, told apart by its `kind`.
 */
export type AppDiagnosticRecord =
  | {
      kind: "uncaughtError";
      /**
       * When it happened.
       */
      at: WireInstant;
      /**
       * Where in the app it went unhandled.
       */
      role: AppDiagnosticRole;
      /**
       * The error's name, or `null` for a thrown value that is no error.
       */
      name: string | null;
      /**
       * Its message, with every quoted run taken out.
       */
      message: string;
      /**
       * Its stack frames, one per line, or `null` where it has none.
       */
      stack: string | null;
      /**
       * Where it was thrown, or `null` where that is not known.
       */
      source: AppErrorSource | null;
    }
  | {
      kind: "unhandledRejection";
      /**
       * When it happened.
       */
      at: WireInstant;
      /**
       * Where in the app it went unhandled.
       */
      role: AppDiagnosticRole;
      /**
       * The error's name, or `null` for a thrown value that is no error.
       */
      name: string | null;
      /**
       * Its message, with every quoted run taken out.
       */
      message: string;
      /**
       * Its stack frames, one per line, or `null` where it has none.
       */
      stack: string | null;
      /**
       * Where it was thrown, or `null` where that is not known.
       */
      source: AppErrorSource | null;
    }
  | {
      kind: "captured";
      /**
       * When the window captured it.
       */
      at: WireInstant;
      /**
       * How bad it is.
       */
      severity: AppDiagnosticSeverity;
      /**
       * The module that captured it.
       */
      source: string;
      /**
       * What kind of line it is, in that module's own words.
       */
      capturedKind: string;
      /**
       * What happened, with every quoted run taken out.
       */
      detail: string;
    }
  | {
      kind: "rendererGone";
      /**
       * When it went.
       */
      at: WireInstant;
      /**
       * Why it went, in Electron's own word.
       */
      reason: string;
      /**
       * Its exit code.
       */
      exitCode: number;
    }
  | {
      kind: "heldBack";
      /**
       * When it was counted.
       */
      at: WireInstant;
      /**
       * How many records were not written.
       */
      count: number;
      /**
       * Why.
       */
      cause: AppDiagnosticHeldBackCause;
    };

/**
 * Where a script error was thrown: the script's address, and the line and column it names.
 */
export interface AppErrorSource {
  /**
   * The script's address, without its query or fragment.
   */
  address: string;
  /**
   * The line.
   */
  line: number;
  /**
   * The column.
   */
  column: number;
}

// prettier-ignore
const schema223: any = {"description":"Where in the app an error went unhandled: main; the hidden console document, which runs the\ncode of every window, so its errors read here; or a window of session views or a pane's own\nwindow, for what that window's own objects raise.","type":"string","enum":["main","consoleDocument","consoleWindow","paneWindow"]};
/** Checks that a value is a {@link AppDiagnosticRole}. */
// prettier-ignore
export const validateAppDiagnosticRole: CompiledSchemaCheck<AppDiagnosticRole> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AppDiagnosticRole {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAppDiagnosticRole.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAppDiagnosticRole.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "main") || (data === "consoleDocument")) || (data === "consoleWindow")) || (data === "paneWindow"))){validateAppDiagnosticRole.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema223.enum}}];return false;}validateAppDiagnosticRole.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAppDiagnosticRole.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema225: any = {"description":"How bad a captured line is.","type":"string","enum":["error","warning","notice"]};
/** Checks that a value is a {@link AppDiagnosticSeverity}. */
// prettier-ignore
export const validateAppDiagnosticSeverity: CompiledSchemaCheck<AppDiagnosticSeverity> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AppDiagnosticSeverity {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAppDiagnosticSeverity.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAppDiagnosticSeverity.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "error") || (data === "warning")) || (data === "notice"))){validateAppDiagnosticSeverity.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema225.enum}}];return false;}validateAppDiagnosticSeverity.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAppDiagnosticSeverity.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema226: any = {"description":"Why records were not written.","type":"string","enum":["windowBufferFull","pastRate","serviceUnreachable","serviceRefused"]};
/** Checks that a value is a {@link AppDiagnosticHeldBackCause}. */
// prettier-ignore
export const validateAppDiagnosticHeldBackCause: CompiledSchemaCheck<AppDiagnosticHeldBackCause> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AppDiagnosticHeldBackCause {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAppDiagnosticHeldBackCause.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAppDiagnosticHeldBackCause.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "windowBufferFull") || (data === "pastRate")) || (data === "serviceUnreachable")) || (data === "serviceRefused"))){validateAppDiagnosticHeldBackCause.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema226.enum}}];return false;}validateAppDiagnosticHeldBackCause.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAppDiagnosticHeldBackCause.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link AppErrorSource}. */
// prettier-ignore
export const validateAppErrorSource: CompiledSchemaCheck<AppErrorSource> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AppErrorSource {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAppErrorSource.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.address === undefined) && (missing0 = "address")) || ((data.line === undefined) && (missing0 = "line"))) || ((data.column === undefined) && (missing0 = "column"))){validateAppErrorSource.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "address") || (key0 === "line")) || (key0 === "column"))){validateAppErrorSource.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.address !== undefined){let data0: any = data.address;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 2048){validateAppErrorSource.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2048}}];return false;}}else {validateAppErrorSource.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.line !== undefined){let data1: any = data.line;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateAppErrorSource.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateAppErrorSource.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateAppErrorSource.errors = [{instancePath:instancePath+"/line",schemaPath:"#/properties/line/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.column !== undefined){let data2: any = data.column;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateAppErrorSource.errors = [{instancePath:instancePath+"/column",schemaPath:"#/properties/column/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateAppErrorSource.errors = [{instancePath:instancePath+"/column",schemaPath:"#/properties/column/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateAppErrorSource.errors = [{instancePath:instancePath+"/column",schemaPath:"#/properties/column/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateAppErrorSource.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAppErrorSource.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAppErrorSource.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema222: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"uncaughtError"},"at":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it happened."},"role":{"$ref":"#/$defs/AppDiagnosticRole","description":"Where in the app it went unhandled."},"name":{"type":["string","null"],"maxLength":128,"description":"The error's name, or `null` for a thrown value that is no error."},"message":{"type":"string","maxLength":1024,"description":"Its message, with every quoted run taken out."},"stack":{"type":["string","null"],"maxLength":8192,"description":"Its stack frames, one per line, or `null` where it has none."},"source":{"anyOf":[{"$ref":"#/$defs/AppErrorSource"},{"type":"null"}],"description":"Where it was thrown, or `null` where that is not known."}},"required":["kind","at","role","name","message","stack","source"],"description":"An exception nothing caught."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"unhandledRejection"},"at":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it happened."},"role":{"$ref":"#/$defs/AppDiagnosticRole","description":"Where in the app it went unhandled."},"name":{"type":["string","null"],"maxLength":128,"description":"The error's name, or `null` for a thrown value that is no error."},"message":{"type":"string","maxLength":1024,"description":"Its message, with every quoted run taken out."},"stack":{"type":["string","null"],"maxLength":8192,"description":"Its stack frames, one per line, or `null` where it has none."},"source":{"anyOf":[{"$ref":"#/$defs/AppErrorSource"},{"type":"null"}],"description":"Where it was thrown, or `null` where that is not known."}},"required":["kind","at","role","name","message","stack","source"],"description":"A promise rejected with nothing to handle it."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"captured"},"at":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the window captured it."},"severity":{"$ref":"#/$defs/AppDiagnosticSeverity","description":"How bad it is."},"source":{"type":"string","maxLength":128,"description":"The module that captured it."},"capturedKind":{"type":"string","maxLength":128,"description":"What kind of line it is, in that module's own words."},"detail":{"type":"string","maxLength":1024,"description":"What happened, with every quoted run taken out."}},"required":["kind","at","severity","source","capturedKind","detail"],"description":"A line a window's diagnostic capture took: something the app could not do or could\nnot read."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"rendererGone"},"at":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it went."},"reason":{"type":"string","maxLength":64,"description":"Why it went, in Electron's own word."},"exitCode":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Its exit code."}},"required":["kind","at","reason","exitCode"],"description":"The process drawing every window went away; main reloads it."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"heldBack"},"at":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was counted."},"count":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many records were not written."},"cause":{"$ref":"#/$defs/AppDiagnosticHeldBackCause","description":"Why."}},"required":["kind","at","count","cause"],"description":"How many records were not written, and why."}],"description":"One record of `daemon.appDiagnostic.record`, told apart by its `kind`.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
/** Checks that a value is a {@link AppDiagnosticRecord}. */
// prettier-ignore
export const validateAppDiagnosticRecord: CompiledSchemaCheck<AppDiagnosticRecord> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AppDiagnosticRecord {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAppDiagnosticRecord.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "uncaughtError"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.at === undefined) && (missing0 = "at"))) || ((data.role === undefined) && (missing0 = "role"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.message === undefined) && (missing0 = "message"))) || ((data.stack === undefined) && (missing0 = "stack"))) || ((data.source === undefined) && (missing0 = "source"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((((key0 === "kind") || (key0 === "at")) || (key0 === "role")) || (key0 === "name")) || (key0 === "message")) || (key0 === "stack")) || (key0 === "source"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("uncaughtError" !== data0){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "uncaughtError"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.at !== undefined){const _errs7: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.role !== undefined){const _errs8: any = errors;if(!(validateAppDiagnosticRole.call(this, data.role, {instancePath:instancePath+"/role",parentData:data,parentDataProperty:"role",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAppDiagnosticRole.errors : vErrors.concat(validateAppDiagnosticRole.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data3: any = data.name;const _errs9: any = errors;if((typeof data3 !== "string") && (data3 !== null)){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: schema222.oneOf[0].properties.name.type}}];return false;}if(errors === _errs9){if(typeof data3 === "string"){if(func1(data3) > 128){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.message !== undefined){let data4: any = data.message;const _errs11: any = errors;if(errors === _errs11){if(typeof data4 === "string"){if(func1(data4) > 1024){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/0/properties/message/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}}else {validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/0/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.stack !== undefined){let data5: any = data.stack;const _errs13: any = errors;if((typeof data5 !== "string") && (data5 !== null)){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/stack",schemaPath:"#/oneOf/0/properties/stack/type",keyword:"type",params:{type: schema222.oneOf[0].properties.stack.type}}];return false;}if(errors === _errs13){if(typeof data5 === "string"){if(func1(data5) > 8192){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/stack",schemaPath:"#/oneOf/0/properties/stack/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.source !== undefined){let data6: any = data.source;const _errs15: any = errors;const _errs16: any = errors;let valid3: any = false;const _errs17: any = errors;if(!(validateAppErrorSource.call(this, data6, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAppErrorSource.errors : vErrors.concat(validateAppErrorSource.errors);errors = vErrors.length;}var _valid0: any = _errs17 === errors;valid3 = valid3 || _valid0;const _errs18: any = errors;if(data6 !== null){const err0: any = {instancePath:instancePath+"/source",schemaPath:"#/oneOf/0/properties/source/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs18 === errors;valid3 = valid3 || _valid0;if(!valid3){const err1: any = {instancePath:instancePath+"/source",schemaPath:"#/oneOf/0/properties/source/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateAppDiagnosticRecord.errors = vErrors;return false;}else {errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}}}}}}}}}}else {validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props1: any = true;valid0 = valid1;}else if(tag0 === "unhandledRejection"){const _errs20: any = errors;if(errors === _errs20){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((((data.kind === undefined) && (missing1 = "kind")) || ((data.at === undefined) && (missing1 = "at"))) || ((data.role === undefined) && (missing1 = "role"))) || ((data.name === undefined) && (missing1 = "name"))) || ((data.message === undefined) && (missing1 = "message"))) || ((data.stack === undefined) && (missing1 = "stack"))) || ((data.source === undefined) && (missing1 = "source"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs22: any = errors;for(const key1 in data){if(!(((((((key1 === "kind") || (key1 === "at")) || (key1 === "role")) || (key1 === "name")) || (key1 === "message")) || (key1 === "stack")) || (key1 === "source"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs22 === errors){if(data.kind !== undefined){let data7: any = data.kind;const _errs23: any = errors;if(typeof data7 !== "string"){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("unhandledRejection" !== data7){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "unhandledRejection"}}];return false;}var valid5: any = _errs23 === errors;}else {var valid5: any = true;}if(valid5){if(data.at !== undefined){const _errs25: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid5: any = _errs25 === errors;}else {var valid5: any = true;}if(valid5){if(data.role !== undefined){const _errs26: any = errors;if(!(validateAppDiagnosticRole.call(this, data.role, {instancePath:instancePath+"/role",parentData:data,parentDataProperty:"role",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAppDiagnosticRole.errors : vErrors.concat(validateAppDiagnosticRole.errors);errors = vErrors.length;}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}if(valid5){if(data.name !== undefined){let data10: any = data.name;const _errs27: any = errors;if((typeof data10 !== "string") && (data10 !== null)){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: schema222.oneOf[1].properties.name.type}}];return false;}if(errors === _errs27){if(typeof data10 === "string"){if(func1(data10) > 128){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}}}var valid5: any = _errs27 === errors;}else {var valid5: any = true;}if(valid5){if(data.message !== undefined){let data11: any = data.message;const _errs29: any = errors;if(errors === _errs29){if(typeof data11 === "string"){if(func1(data11) > 1024){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}}else {validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/message",schemaPath:"#/oneOf/1/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs29 === errors;}else {var valid5: any = true;}if(valid5){if(data.stack !== undefined){let data12: any = data.stack;const _errs31: any = errors;if((typeof data12 !== "string") && (data12 !== null)){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/stack",schemaPath:"#/oneOf/1/properties/stack/type",keyword:"type",params:{type: schema222.oneOf[1].properties.stack.type}}];return false;}if(errors === _errs31){if(typeof data12 === "string"){if(func1(data12) > 8192){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/stack",schemaPath:"#/oneOf/1/properties/stack/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}}}var valid5: any = _errs31 === errors;}else {var valid5: any = true;}if(valid5){if(data.source !== undefined){let data13: any = data.source;const _errs33: any = errors;const _errs34: any = errors;let valid6: any = false;const _errs35: any = errors;if(!(validateAppErrorSource.call(this, data13, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAppErrorSource.errors : vErrors.concat(validateAppErrorSource.errors);errors = vErrors.length;}var _valid1: any = _errs35 === errors;valid6 = valid6 || _valid1;const _errs36: any = errors;if(data13 !== null){const err2: any = {instancePath:instancePath+"/source",schemaPath:"#/oneOf/1/properties/source/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid1: any = _errs36 === errors;valid6 = valid6 || _valid1;if(!valid6){const err3: any = {instancePath:instancePath+"/source",schemaPath:"#/oneOf/1/properties/source/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateAppDiagnosticRecord.errors = vErrors;return false;}else {errors = _errs34;if(vErrors !== null){if(_errs34){vErrors.length = _errs34;}else {vErrors = null;}}}var valid5: any = _errs33 === errors;}else {var valid5: any = true;}}}}}}}}}}else {validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs20 === errors;if(props1 !== true){props1 = true;}valid0 = valid4;}else if(tag0 === "captured"){const _errs38: any = errors;if(errors === _errs38){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((data.kind === undefined) && (missing2 = "kind")) || ((data.at === undefined) && (missing2 = "at"))) || ((data.severity === undefined) && (missing2 = "severity"))) || ((data.source === undefined) && (missing2 = "source"))) || ((data.capturedKind === undefined) && (missing2 = "capturedKind"))) || ((data.detail === undefined) && (missing2 = "detail"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs40: any = errors;for(const key2 in data){if(!((((((key2 === "kind") || (key2 === "at")) || (key2 === "severity")) || (key2 === "source")) || (key2 === "capturedKind")) || (key2 === "detail"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs40 === errors){if(data.kind !== undefined){let data14: any = data.kind;const _errs41: any = errors;if(typeof data14 !== "string"){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("captured" !== data14){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "captured"}}];return false;}var valid8: any = _errs41 === errors;}else {var valid8: any = true;}if(valid8){if(data.at !== undefined){const _errs43: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid8: any = _errs43 === errors;}else {var valid8: any = true;}if(valid8){if(data.severity !== undefined){const _errs44: any = errors;if(!(validateAppDiagnosticSeverity.call(this, data.severity, {instancePath:instancePath+"/severity",parentData:data,parentDataProperty:"severity",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAppDiagnosticSeverity.errors : vErrors.concat(validateAppDiagnosticSeverity.errors);errors = vErrors.length;}var valid8: any = _errs44 === errors;}else {var valid8: any = true;}if(valid8){if(data.source !== undefined){let data17: any = data.source;const _errs45: any = errors;if(errors === _errs45){if(typeof data17 === "string"){if(func1(data17) > 128){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/2/properties/source/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}}else {validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/2/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs45 === errors;}else {var valid8: any = true;}if(valid8){if(data.capturedKind !== undefined){let data18: any = data.capturedKind;const _errs47: any = errors;if(errors === _errs47){if(typeof data18 === "string"){if(func1(data18) > 128){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/capturedKind",schemaPath:"#/oneOf/2/properties/capturedKind/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}}else {validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/capturedKind",schemaPath:"#/oneOf/2/properties/capturedKind/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs47 === errors;}else {var valid8: any = true;}if(valid8){if(data.detail !== undefined){let data19: any = data.detail;const _errs49: any = errors;if(errors === _errs49){if(typeof data19 === "string"){if(func1(data19) > 1024){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/oneOf/2/properties/detail/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}}else {validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/oneOf/2/properties/detail/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs49 === errors;}else {var valid8: any = true;}}}}}}}}}else {validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs38 === errors;if(props1 !== true){props1 = true;}valid0 = valid7;}else if(tag0 === "rendererGone"){const _errs51: any = errors;if(errors === _errs51){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.kind === undefined) && (missing3 = "kind")) || ((data.at === undefined) && (missing3 = "at"))) || ((data.reason === undefined) && (missing3 = "reason"))) || ((data.exitCode === undefined) && (missing3 = "exitCode"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs53: any = errors;for(const key3 in data){if(!((((key3 === "kind") || (key3 === "at")) || (key3 === "reason")) || (key3 === "exitCode"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs53 === errors){if(data.kind !== undefined){let data20: any = data.kind;const _errs54: any = errors;if(typeof data20 !== "string"){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("rendererGone" !== data20){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "rendererGone"}}];return false;}var valid10: any = _errs54 === errors;}else {var valid10: any = true;}if(valid10){if(data.at !== undefined){const _errs56: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid10: any = _errs56 === errors;}else {var valid10: any = true;}if(valid10){if(data.reason !== undefined){let data22: any = data.reason;const _errs57: any = errors;if(errors === _errs57){if(typeof data22 === "string"){if(func1(data22) > 64){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/maxLength",keyword:"maxLength",params:{limit: 64}}];return false;}}else {validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs57 === errors;}else {var valid10: any = true;}if(valid10){if(data.exitCode !== undefined){let data23: any = data.exitCode;const _errs59: any = errors;if(!(((typeof data23 == "number") && (!(data23 % 1) && !isNaN(data23))) && (isFinite(data23)))){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs59){if((typeof data23 == "number") && (isFinite(data23))){if(data23 > 9007199254740991 || isNaN(data23)){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data23 < -9007199254740991 || isNaN(data23)){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid10: any = _errs59 === errors;}else {var valid10: any = true;}}}}}}}else {validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs51 === errors;if(props1 !== true){props1 = true;}valid0 = valid9;}else if(tag0 === "heldBack"){const _errs61: any = errors;if(errors === _errs61){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((data.kind === undefined) && (missing4 = "kind")) || ((data.at === undefined) && (missing4 = "at"))) || ((data.count === undefined) && (missing4 = "count"))) || ((data.cause === undefined) && (missing4 = "cause"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs63: any = errors;for(const key4 in data){if(!((((key4 === "kind") || (key4 === "at")) || (key4 === "count")) || (key4 === "cause"))){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs63 === errors){if(data.kind !== undefined){let data24: any = data.kind;const _errs64: any = errors;if(typeof data24 !== "string"){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("heldBack" !== data24){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "heldBack"}}];return false;}var valid12: any = _errs64 === errors;}else {var valid12: any = true;}if(valid12){if(data.at !== undefined){const _errs66: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid12: any = _errs66 === errors;}else {var valid12: any = true;}if(valid12){if(data.count !== undefined){let data26: any = data.count;const _errs67: any = errors;if(!(((typeof data26 == "number") && (!(data26 % 1) && !isNaN(data26))) && (isFinite(data26)))){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/count",schemaPath:"#/oneOf/4/properties/count/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs67){if((typeof data26 == "number") && (isFinite(data26))){if(data26 > 9007199254740991 || isNaN(data26)){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/count",schemaPath:"#/oneOf/4/properties/count/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data26 < 0 || isNaN(data26)){validateAppDiagnosticRecord.errors = [{instancePath:instancePath+"/count",schemaPath:"#/oneOf/4/properties/count/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid12: any = _errs67 === errors;}else {var valid12: any = true;}if(valid12){if(data.cause !== undefined){const _errs69: any = errors;if(!(validateAppDiagnosticHeldBackCause.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAppDiagnosticHeldBackCause.errors : vErrors.concat(validateAppDiagnosticHeldBackCause.errors);errors = vErrors.length;}var valid12: any = _errs69 === errors;}else {var valid12: any = true;}}}}}}}else {validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs61 === errors;if(props1 !== true){props1 = true;}valid0 = valid11;}else {validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props1 !== true){for(const key5 in data){if(!props1 || !props1[key5]){validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key5}}];return false;break;}}}}}else {validateAppDiagnosticRecord.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAppDiagnosticRecord.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAppDiagnosticRecord.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS}, each with its checks. */
export interface DaemonAppDiagnosticMethodDescriptors {
  readonly "daemon.appDiagnostic.record": {
    readonly method: "daemon.appDiagnostic.record";
    readonly procedureType: "mutation";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AppDiagnosticRecord>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The method main writes an app diagnostic with. */
export const DAEMON_APP_DIAGNOSTIC_METHOD_DESCRIPTORS: DaemonAppDiagnosticMethodDescriptors =
  Object.freeze({
    "daemon.appDiagnostic.record": Object.freeze({
      method: "daemon.appDiagnostic.record",
      procedureType: "mutation",
      mutating: false,
      requestCheck: validateAppDiagnosticRecord,
      responseCheck: validateEmptyPayload,
    }),
  });
