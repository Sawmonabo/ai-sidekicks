// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Syntax color spans: the daemon colors code once and every client paints what it is handed.

import { type SchemaCheck, ucs2length, wireByteLength } from "../schema-check.js";

/** How many numbers one span takes in a reply: offset, length, class. */
export const HIGHLIGHT_SPAN_WIDTH = 3 as const;

/**
 * The largest source the daemon colors, in UTF-8 bytes of its JSON as it travels. A larger
 * block is left plain: coloring it would cost more than the span cache holds for everything
 * else.
 */
export const HIGHLIGHT_SOURCE_MAX_BYTES = 262144 as const;

/**
 * The largest span list a reply carries, in UTF-8 bytes of its JSON as it travels: its own
 * figure, which the reply with its envelope keeps well inside the message limit.
 */
export const HIGHLIGHT_SPANS_MAX_BYTES = 998976 as const;

/** The longest block id a `highlight.read` carries. */
export const HIGHLIGHT_BLOCK_ID_MAX_LENGTH = 128 as const;

/** Every language the daemon can color. */
export const HIGHLIGHT_LANGUAGES = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "rust",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;

/** The classes a span paints as, in wire order. */
export const HIGHLIGHT_SPAN_CLASSES = [
  "keyword",
  "name",
  "string",
  "number",
  "comment",
  "inserted",
  "deleted",
  "hunk",
  "heading",
  "emphasis",
  "inlineCode",
] as const;

/**
 * One language the daemon can color.
 */
export type HighlightLanguage =
  | "bash"
  | "css"
  | "diff"
  | "go"
  | "html"
  | "javascript"
  | "json"
  | "jsx"
  | "markdown"
  | "python"
  | "rust"
  | "sql"
  | "tsx"
  | "typescript"
  | "yaml";
/**
 * One class a span paints as; plain text has no span. The first five mark code; the rest mark a
 * diff's lines and Markdown's own syntax. A span names its class by its index in `VARIANTS`.
 */
export type HighlightSpanClass =
  | "keyword"
  | "name"
  | "string"
  | "number"
  | "comment"
  | "inserted"
  | "deleted"
  | "hunk"
  | "heading"
  | "emphasis"
  | "inlineCode";
/**
 * A source's color spans: `[offset, length, class, …]` in source order.
 */
export type HighlightSpans = number[];

/**
 * The code a client wants colored.
 */
export interface HighlightReadRequest {
  /**
   * The language.
   */
  language: HighlightLanguage;
  /**
   * The source, at most [`HIGHLIGHT_SOURCE_MAX_BYTES`] as its JSON travels.
   */
  source: string;
  /**
   * The code block on screen this read is for, unique among the client's blocks; a newer read
   * with the same block id on the same connection replaces this one while it waits.
   */
  blockId?: string;
}
/**
 * A source's color spans, in source order, never overlapping.
 */
export interface HighlightReadResponse {
  /**
   * The spans.
   */
  spans: HighlightSpans;
}

// prettier-ignore
const schema1929: any = {"description":"One language the daemon can color.","type":"string","enum":["bash","css","diff","go","html","javascript","json","jsx","markdown","python","rust","sql","tsx","typescript","yaml"]};
// prettier-ignore
function validate1008(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HighlightLanguage {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1008.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1008.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((((((((((data === "bash") || (data === "css")) || (data === "diff")) || (data === "go")) || (data === "html")) || (data === "javascript")) || (data === "json")) || (data === "jsx")) || (data === "markdown")) || (data === "python")) || (data === "rust")) || (data === "sql")) || (data === "tsx")) || (data === "typescript")) || (data === "yaml"))){validate1008.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1929.enum}}];return false;}validate1008.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1008.errors = null as any[] | null;
// prettier-ignore
validate1008.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1009(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HighlightReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1009.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.language === undefined) && (missing0 = "language")) || ((data.source === undefined) && (missing0 = "source"))){validate1009.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "language") || (key0 === "source")) || (key0 === "blockId"))){validate1009.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.language !== undefined){let data0: any = data.language;const _errs2: any = errors;if(typeof data0 !== "string"){validate1009.errors = [{instancePath:instancePath+"/language",schemaPath:"#/$defs/HighlightLanguage/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((((((((((data0 === "bash") || (data0 === "css")) || (data0 === "diff")) || (data0 === "go")) || (data0 === "html")) || (data0 === "javascript")) || (data0 === "json")) || (data0 === "jsx")) || (data0 === "markdown")) || (data0 === "python")) || (data0 === "rust")) || (data0 === "sql")) || (data0 === "tsx")) || (data0 === "typescript")) || (data0 === "yaml"))){validate1009.errors = [{instancePath:instancePath+"/language",schemaPath:"#/$defs/HighlightLanguage/enum",keyword:"enum",params:{allowedValues: schema1929.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.source !== undefined){let data1: any = data.source;const _errs5: any = errors;if(wireByteLength(data1, this && this.attachments) > 262144){validate1009.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate1009.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1009.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.blockId !== undefined){let data2: any = data.blockId;const _errs7: any = errors;if(errors === _errs7){if(typeof data2 === "string"){if(func1(data2) > 128){validate1009.errors = [{instancePath:instancePath+"/blockId",schemaPath:"#/properties/blockId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1009.errors = [{instancePath:instancePath+"/blockId",schemaPath:"#/properties/blockId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1009.errors = [{instancePath:instancePath+"/blockId",schemaPath:"#/properties/blockId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validate1009.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1009.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1009.errors = null as any[] | null;
// prettier-ignore
validate1009.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1010(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HighlightReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1010.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.spans === undefined) && (missing0 = "spans")){validate1010.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "spans")){validate1010.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.spans !== undefined){let data0: any = data.spans;const _errs3: any = errors;if(wireByteLength(data0, this && this.attachments) > 998976){validate1010.errors = [{instancePath:instancePath+"/spans",schemaPath:"#/$defs/HighlightSpans/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === _errs3){if(Array.isArray(data0)){var valid2: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs5: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1010.errors = [{instancePath:instancePath+"/spans/" + i0,schemaPath:"#/$defs/HighlightSpans/items/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1010.errors = [{instancePath:instancePath+"/spans/" + i0,schemaPath:"#/$defs/HighlightSpans/items/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1010.errors = [{instancePath:instancePath+"/spans/" + i0,schemaPath:"#/$defs/HighlightSpans/items/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs5 === errors;if(!valid2){break;}}}else {validate1010.errors = [{instancePath:instancePath+"/spans",schemaPath:"#/$defs/HighlightSpans/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1010.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1010.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1010.errors = null as any[] | null;
// prettier-ignore
validate1010.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link HighlightLanguage}. */
export const validateHighlightLanguage: SchemaCheck<HighlightLanguage> = validate1008;
/** Checks that a value is a {@link HighlightReadRequest}. */
export const validateHighlightReadRequest: SchemaCheck<HighlightReadRequest> = validate1009;
/** Checks that a value is a {@link HighlightReadResponse}. */
export const validateHighlightReadResponse: SchemaCheck<HighlightReadResponse> = validate1010;

/** The methods of {@link HIGHLIGHT_METHOD_DESCRIPTORS}, each with its checks. */
export interface HighlightMethodDescriptors {
  readonly "highlight.read": {
    readonly method: "highlight.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<HighlightReadRequest>;
    readonly responseCheck: SchemaCheck<HighlightReadResponse>;
  };
}
/** The `highlight.*` methods: one read, answered by the daemon's colorer. */
export const HIGHLIGHT_METHOD_DESCRIPTORS: HighlightMethodDescriptors = Object.freeze({
  "highlight.read": Object.freeze({
    method: "highlight.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateHighlightReadRequest,
    responseCheck: validateHighlightReadResponse,
  }),
});
