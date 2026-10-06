// The `transcript.*` method strings, each bound to its request and response schemas. All are
// queries over the daemon JSON-RPC transport only: the transcript is a daemon-local projection of
// the session event log.
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type MethodRequestOf,
  type MethodResponseOf,
} from "../method-descriptor.js";
import {
  ChildRunExpandRequestSchema,
  ChildRunExpandResponseSchema,
  ReasoningSurfaceReadRequestSchema,
  ReasoningSurfaceReadResponseSchema,
  TranscriptReadRequestSchema,
  TranscriptReadResponseSchema,
  type ChildRunExpandRequest,
  type ChildRunExpandResponse,
  type ReasoningSurfaceReadRequest,
  type ReasoningSurfaceReadResponse,
  type TranscriptReadRequest,
  type TranscriptReadResponse,
} from "./operations.js";
import {
  TranscriptBodyReadRequestSchema,
  TranscriptBodyReadResponseSchema,
  TranscriptPatchReadRequestSchema,
  TranscriptPatchReadResponseSchema,
  type TranscriptBodyReadRequest,
  type TranscriptBodyReadResponse,
  type TranscriptPatchReadRequest,
  type TranscriptPatchReadResponse,
} from "./content.js";
import {
  TranscriptSearchRequestSchema,
  TranscriptSearchResponseSchema,
  type TranscriptSearchRequest,
  type TranscriptSearchResponse,
} from "./search.js";

/** The method string of the paged transcript window. */
export const TRANSCRIPT_READ_METHOD = "transcript.read" as const;
/** The method string of the reasoning-surface read. */
export const TRANSCRIPT_REASONING_SURFACE_READ_METHOD = "transcript.reasoningSurfaceRead" as const;
/** The method string of the child-run expansion. */
export const TRANSCRIPT_CHILD_RUN_EXPAND_METHOD = "transcript.childRunExpand" as const;
/** The method string of the row-body read. */
export const TRANSCRIPT_BODY_READ_METHOD = "transcript.bodyRead" as const;
/** The method string of the omitted-patch read. */
export const TRANSCRIPT_PATCH_READ_METHOD = "transcript.patchRead" as const;
/** The method string of the session search. */
export const TRANSCRIPT_SEARCH_METHOD = "transcript.search" as const;

/** The `transcript.*` methods, keyed by name. */
export interface TranscriptMethodDescriptorRegistry {
  readonly [TRANSCRIPT_READ_METHOD]: MethodDescriptor<
    typeof TRANSCRIPT_READ_METHOD,
    TranscriptReadRequest,
    TranscriptReadResponse
  >;
  readonly [TRANSCRIPT_REASONING_SURFACE_READ_METHOD]: MethodDescriptor<
    typeof TRANSCRIPT_REASONING_SURFACE_READ_METHOD,
    ReasoningSurfaceReadRequest,
    ReasoningSurfaceReadResponse
  >;
  readonly [TRANSCRIPT_CHILD_RUN_EXPAND_METHOD]: MethodDescriptor<
    typeof TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
    ChildRunExpandRequest,
    ChildRunExpandResponse
  >;
  readonly [TRANSCRIPT_BODY_READ_METHOD]: MethodDescriptor<
    typeof TRANSCRIPT_BODY_READ_METHOD,
    TranscriptBodyReadRequest,
    TranscriptBodyReadResponse
  >;
  readonly [TRANSCRIPT_PATCH_READ_METHOD]: MethodDescriptor<
    typeof TRANSCRIPT_PATCH_READ_METHOD,
    TranscriptPatchReadRequest,
    TranscriptPatchReadResponse
  >;
  readonly [TRANSCRIPT_SEARCH_METHOD]: MethodDescriptor<
    typeof TRANSCRIPT_SEARCH_METHOD,
    TranscriptSearchRequest,
    TranscriptSearchResponse
  >;
}

/** One `transcript.*` method string. */
export type TranscriptMethodName = keyof TranscriptMethodDescriptorRegistry;

/** The request type bound to one `transcript.*` method string. */
export type TranscriptMethodRequest<MethodName extends TranscriptMethodName> = MethodRequestOf<
  TranscriptMethodDescriptorRegistry[MethodName]
>;

/** The response type bound to one `transcript.*` method string. */
export type TranscriptMethodResponse<MethodName extends TranscriptMethodName> = MethodResponseOf<
  TranscriptMethodDescriptorRegistry[MethodName]
>;

/** The `transcript.*` method table. */
export const TRANSCRIPT_METHOD_DESCRIPTORS: TranscriptMethodDescriptorRegistry =
  defineMethodDescriptors({
    [TRANSCRIPT_READ_METHOD]: {
      method: TRANSCRIPT_READ_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: TranscriptReadRequestSchema,
      responseSchema: TranscriptReadResponseSchema,
    },
    [TRANSCRIPT_REASONING_SURFACE_READ_METHOD]: {
      method: TRANSCRIPT_REASONING_SURFACE_READ_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: ReasoningSurfaceReadRequestSchema,
      responseSchema: ReasoningSurfaceReadResponseSchema,
    },
    [TRANSCRIPT_CHILD_RUN_EXPAND_METHOD]: {
      method: TRANSCRIPT_CHILD_RUN_EXPAND_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: ChildRunExpandRequestSchema,
      responseSchema: ChildRunExpandResponseSchema,
    },
    [TRANSCRIPT_BODY_READ_METHOD]: {
      method: TRANSCRIPT_BODY_READ_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: TranscriptBodyReadRequestSchema,
      responseSchema: TranscriptBodyReadResponseSchema,
    },
    [TRANSCRIPT_PATCH_READ_METHOD]: {
      method: TRANSCRIPT_PATCH_READ_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: TranscriptPatchReadRequestSchema,
      responseSchema: TranscriptPatchReadResponseSchema,
    },
    [TRANSCRIPT_SEARCH_METHOD]: {
      method: TRANSCRIPT_SEARCH_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: TranscriptSearchRequestSchema,
      responseSchema: TranscriptSearchResponseSchema,
    },
  });
