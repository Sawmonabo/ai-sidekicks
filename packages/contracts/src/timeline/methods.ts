// The `timeline.*` method strings, each bound to its request and response schemas. All are
// queries over the daemon JSON-RPC transport only: the timeline is a daemon-local projection of
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
  TimelineReadRequestSchema,
  TimelineReadResponseSchema,
  type ChildRunExpandRequest,
  type ChildRunExpandResponse,
  type ReasoningSurfaceReadRequest,
  type ReasoningSurfaceReadResponse,
  type TimelineReadRequest,
  type TimelineReadResponse,
} from "./operations.js";
import {
  TimelineBodyReadRequestSchema,
  TimelineBodyReadResponseSchema,
  TimelinePatchReadRequestSchema,
  TimelinePatchReadResponseSchema,
  type TimelineBodyReadRequest,
  type TimelineBodyReadResponse,
  type TimelinePatchReadRequest,
  type TimelinePatchReadResponse,
} from "./row-content.js";
import {
  TimelineSearchRequestSchema,
  TimelineSearchResponseSchema,
  type TimelineSearchRequest,
  type TimelineSearchResponse,
} from "./search.js";

/** The method string of the paged timeline window. */
export const TIMELINE_READ_METHOD = "timeline.read" as const;
/** The method string of the reasoning-surface read. */
export const TIMELINE_REASONING_SURFACE_READ_METHOD = "timeline.reasoningSurfaceRead" as const;
/** The method string of the child-run expansion. */
export const TIMELINE_CHILD_RUN_EXPAND_METHOD = "timeline.childRunExpand" as const;
/** The method string of the row-body read. */
export const TIMELINE_BODY_READ_METHOD = "timeline.bodyRead" as const;
/** The method string of the omitted-patch read. */
export const TIMELINE_PATCH_READ_METHOD = "timeline.patchRead" as const;
/** The method string of the session search. */
export const TIMELINE_SEARCH_METHOD = "timeline.search" as const;

/** The `timeline.*` methods, keyed by name. */
export interface TimelineMethodDescriptorRegistry {
  readonly [TIMELINE_READ_METHOD]: MethodDescriptor<
    typeof TIMELINE_READ_METHOD,
    TimelineReadRequest,
    TimelineReadResponse
  >;
  readonly [TIMELINE_REASONING_SURFACE_READ_METHOD]: MethodDescriptor<
    typeof TIMELINE_REASONING_SURFACE_READ_METHOD,
    ReasoningSurfaceReadRequest,
    ReasoningSurfaceReadResponse
  >;
  readonly [TIMELINE_CHILD_RUN_EXPAND_METHOD]: MethodDescriptor<
    typeof TIMELINE_CHILD_RUN_EXPAND_METHOD,
    ChildRunExpandRequest,
    ChildRunExpandResponse
  >;
  readonly [TIMELINE_BODY_READ_METHOD]: MethodDescriptor<
    typeof TIMELINE_BODY_READ_METHOD,
    TimelineBodyReadRequest,
    TimelineBodyReadResponse
  >;
  readonly [TIMELINE_PATCH_READ_METHOD]: MethodDescriptor<
    typeof TIMELINE_PATCH_READ_METHOD,
    TimelinePatchReadRequest,
    TimelinePatchReadResponse
  >;
  readonly [TIMELINE_SEARCH_METHOD]: MethodDescriptor<
    typeof TIMELINE_SEARCH_METHOD,
    TimelineSearchRequest,
    TimelineSearchResponse
  >;
}

/** One `timeline.*` method string. */
export type TimelineMethodName = keyof TimelineMethodDescriptorRegistry;

/** The request type bound to one `timeline.*` method string. */
export type TimelineMethodRequest<MethodName extends TimelineMethodName> = MethodRequestOf<
  TimelineMethodDescriptorRegistry[MethodName]
>;

/** The response type bound to one `timeline.*` method string. */
export type TimelineMethodResponse<MethodName extends TimelineMethodName> = MethodResponseOf<
  TimelineMethodDescriptorRegistry[MethodName]
>;

/** The `timeline.*` method table. */
export const TIMELINE_METHOD_DESCRIPTORS: TimelineMethodDescriptorRegistry =
  defineMethodDescriptors({
    [TIMELINE_READ_METHOD]: {
      method: TIMELINE_READ_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: TimelineReadRequestSchema,
      responseSchema: TimelineReadResponseSchema,
    },
    [TIMELINE_REASONING_SURFACE_READ_METHOD]: {
      method: TIMELINE_REASONING_SURFACE_READ_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: ReasoningSurfaceReadRequestSchema,
      responseSchema: ReasoningSurfaceReadResponseSchema,
    },
    [TIMELINE_CHILD_RUN_EXPAND_METHOD]: {
      method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: ChildRunExpandRequestSchema,
      responseSchema: ChildRunExpandResponseSchema,
    },
    [TIMELINE_BODY_READ_METHOD]: {
      method: TIMELINE_BODY_READ_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: TimelineBodyReadRequestSchema,
      responseSchema: TimelineBodyReadResponseSchema,
    },
    [TIMELINE_PATCH_READ_METHOD]: {
      method: TIMELINE_PATCH_READ_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: TimelinePatchReadRequestSchema,
      responseSchema: TimelinePatchReadResponseSchema,
    },
    [TIMELINE_SEARCH_METHOD]: {
      method: TIMELINE_SEARCH_METHOD,
      procedureType: "query",
      mutating: false,
      requestSchema: TimelineSearchRequestSchema,
      responseSchema: TimelineSearchResponseSchema,
    },
  });
