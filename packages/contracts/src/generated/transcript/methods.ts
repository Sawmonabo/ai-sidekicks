// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `transcript.*` methods, each bound to its request and response.

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

/** The methods of {@link TRANSCRIPT_METHOD_DESCRIPTORS}, each with its kind. */
export interface TranscriptMethodDescriptors {
  readonly "transcript.read": {
    readonly method: "transcript.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "transcript.reasoning.read": {
    readonly method: "transcript.reasoning.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "transcript.childRun.expand": {
    readonly method: "transcript.childRun.expand";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "transcript.body.read": {
    readonly method: "transcript.body.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "transcript.patch.list": {
    readonly method: "transcript.patch.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "transcript.search": {
    readonly method: "transcript.search";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link TRANSCRIPT_METHOD_DESCRIPTORS}. */
export interface TranscriptMethodTypes {
  readonly "transcript.read": {
    readonly params: TranscriptReadRequest;
    readonly result: TranscriptReadResponse;
  };
  readonly "transcript.reasoning.read": {
    readonly params: TranscriptReasoningReadRequest;
    readonly result: TranscriptReasoningReadResponse;
  };
  readonly "transcript.childRun.expand": {
    readonly params: TranscriptChildRunExpandRequest;
    readonly result: TranscriptChildRunExpandResponse;
  };
  readonly "transcript.body.read": {
    readonly params: TranscriptBodyReadRequest;
    readonly result: TranscriptBodyReadResponse;
  };
  readonly "transcript.patch.list": {
    readonly params: TranscriptPatchListRequest;
    readonly result: TranscriptPatchListResponse;
  };
  readonly "transcript.search": {
    readonly params: TranscriptSearchRequest;
    readonly result: TranscriptSearchResponse;
  };
}
/** The `transcript.*` methods' wire contract: name, procedure type and types. */
export const TRANSCRIPT_METHOD_DESCRIPTORS: TranscriptMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "transcript.read": /* @__PURE__ */ Object.freeze({
      method: "transcript.read",
      procedureType: "query",
      mutating: false,
    }),
    "transcript.reasoning.read": /* @__PURE__ */ Object.freeze({
      method: "transcript.reasoning.read",
      procedureType: "query",
      mutating: false,
    }),
    "transcript.childRun.expand": /* @__PURE__ */ Object.freeze({
      method: "transcript.childRun.expand",
      procedureType: "query",
      mutating: false,
    }),
    "transcript.body.read": /* @__PURE__ */ Object.freeze({
      method: "transcript.body.read",
      procedureType: "query",
      mutating: false,
    }),
    "transcript.patch.list": /* @__PURE__ */ Object.freeze({
      method: "transcript.patch.list",
      procedureType: "query",
      mutating: false,
    }),
    "transcript.search": /* @__PURE__ */ Object.freeze({
      method: "transcript.search",
      procedureType: "query",
      mutating: false,
    }),
  });
