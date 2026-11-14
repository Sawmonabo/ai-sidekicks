// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `transcript.*` methods, each bound to its request and response.

import type { SchemaCheck } from "../../schema-check.js";
import {
  validateTranscriptBodyReadRequest,
  validateTranscriptBodyReadResponse,
  validateTranscriptChildRunExpandRequest,
  validateTranscriptChildRunExpandResponse,
  validateTranscriptPatchListRequest,
  validateTranscriptPatchListResponse,
  validateTranscriptReadRequest,
  validateTranscriptReadResponse,
  validateTranscriptReasoningReadRequest,
  validateTranscriptReasoningReadResponse,
} from "../checks/transcript/operations.js";
import {
  validateTranscriptSearchRequest,
  validateTranscriptSearchResponse,
} from "../checks/transcript/search.js";
import type {
  TranscriptBodyReadRequest,
  TranscriptBodyReadResponse,
  TranscriptChildRunExpandRequest,
  TranscriptChildRunExpandResponse,
  TranscriptPatchListRequest,
  TranscriptPatchListResponse,
  TranscriptReadRequest,
  TranscriptReadResponse,
  TranscriptReasoningReadRequest,
  TranscriptReasoningReadResponse,
} from "./operations.js";
import type { TranscriptSearchRequest, TranscriptSearchResponse } from "./search.js";

/** The methods of {@link TRANSCRIPT_METHOD_DESCRIPTORS}, each with its checks. */
export interface TranscriptMethodDescriptors {
  readonly "transcript.read": {
    readonly method: "transcript.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<TranscriptReadRequest>;
    readonly responseCheck: SchemaCheck<TranscriptReadResponse>;
  };
  readonly "transcript.reasoning.read": {
    readonly method: "transcript.reasoning.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<TranscriptReasoningReadRequest>;
    readonly responseCheck: SchemaCheck<TranscriptReasoningReadResponse>;
  };
  readonly "transcript.childRun.expand": {
    readonly method: "transcript.childRun.expand";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<TranscriptChildRunExpandRequest>;
    readonly responseCheck: SchemaCheck<TranscriptChildRunExpandResponse>;
  };
  readonly "transcript.body.read": {
    readonly method: "transcript.body.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<TranscriptBodyReadRequest>;
    readonly responseCheck: SchemaCheck<TranscriptBodyReadResponse>;
  };
  readonly "transcript.patch.list": {
    readonly method: "transcript.patch.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<TranscriptPatchListRequest>;
    readonly responseCheck: SchemaCheck<TranscriptPatchListResponse>;
  };
  readonly "transcript.search": {
    readonly method: "transcript.search";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<TranscriptSearchRequest>;
    readonly responseCheck: SchemaCheck<TranscriptSearchResponse>;
  };
}
/** The `transcript.*` methods' wire contract: name, procedure type and types. */
export const TRANSCRIPT_METHOD_DESCRIPTORS: TranscriptMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "transcript.read": /* @__PURE__ */ Object.freeze({
      method: "transcript.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateTranscriptReadRequest,
      responseCheck: validateTranscriptReadResponse,
    }),
    "transcript.reasoning.read": /* @__PURE__ */ Object.freeze({
      method: "transcript.reasoning.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateTranscriptReasoningReadRequest,
      responseCheck: validateTranscriptReasoningReadResponse,
    }),
    "transcript.childRun.expand": /* @__PURE__ */ Object.freeze({
      method: "transcript.childRun.expand",
      procedureType: "query",
      mutating: false,
      requestCheck: validateTranscriptChildRunExpandRequest,
      responseCheck: validateTranscriptChildRunExpandResponse,
    }),
    "transcript.body.read": /* @__PURE__ */ Object.freeze({
      method: "transcript.body.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateTranscriptBodyReadRequest,
      responseCheck: validateTranscriptBodyReadResponse,
    }),
    "transcript.patch.list": /* @__PURE__ */ Object.freeze({
      method: "transcript.patch.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateTranscriptPatchListRequest,
      responseCheck: validateTranscriptPatchListResponse,
    }),
    "transcript.search": /* @__PURE__ */ Object.freeze({
      method: "transcript.search",
      procedureType: "query",
      mutating: false,
      requestCheck: validateTranscriptSearchRequest,
      responseCheck: validateTranscriptSearchResponse,
    }),
  });
