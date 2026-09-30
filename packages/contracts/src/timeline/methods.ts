// The six `timeline.*` method strings, each bound to its request and response schemas. All are
// `query` reads over the daemon JSON-RPC transport only: the timeline is a daemon-local
// projection of the session event log. Binding the pair in `TIMELINE_METHOD_DESCRIPTORS`, which
// the daemon's binder (`packages/runtime-daemon/src/ipc/handlers/timeline-methods.ts`) takes, is
// what stops a handler being registered against the wrong schemas. This file registers no
// handler: a placeholder would put a method on the wire that answers nothing.
import type { MethodDescriptor } from "../method-descriptor.js";
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

/** The closed set of method strings this namespace registers. */
export type TimelineMethodName =
  | typeof TIMELINE_READ_METHOD
  | typeof TIMELINE_REASONING_SURFACE_READ_METHOD
  | typeof TIMELINE_CHILD_RUN_EXPAND_METHOD
  | typeof TIMELINE_BODY_READ_METHOD
  | typeof TIMELINE_PATCH_READ_METHOD
  | typeof TIMELINE_SEARCH_METHOD;

/** Every `timeline.*` method string, for a consumer to walk instead of re-typing the list. */
export const TIMELINE_METHOD_NAMES: readonly TimelineMethodName[] = Object.freeze([
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_BODY_READ_METHOD,
  TIMELINE_PATCH_READ_METHOD,
  TIMELINE_SEARCH_METHOD,
] as const);

/**
 * What a registrar needs to bind one timeline method: the name, procedure type, `mutating` flag
 * and the schema pair the registry validates against. Every timeline method is a read, so
 * `procedureType` is `"query"` and `mutating` is `false`; a timeline mutation must widen this
 * interface deliberately.
 */
export interface TimelineMethodBinding<
  MethodName extends TimelineMethodName,
  RequestType,
  ResponseType,
> extends MethodDescriptor<MethodName, RequestType, ResponseType> {
  readonly procedureType: "query";
  readonly mutating: false;
}

/** The descriptors, keyed by method string. */
export interface TimelineMethodDescriptorRegistry {
  readonly [TIMELINE_READ_METHOD]: TimelineMethodBinding<
    typeof TIMELINE_READ_METHOD,
    TimelineReadRequest,
    TimelineReadResponse
  >;
  readonly [TIMELINE_REASONING_SURFACE_READ_METHOD]: TimelineMethodBinding<
    typeof TIMELINE_REASONING_SURFACE_READ_METHOD,
    ReasoningSurfaceReadRequest,
    ReasoningSurfaceReadResponse
  >;
  readonly [TIMELINE_CHILD_RUN_EXPAND_METHOD]: TimelineMethodBinding<
    typeof TIMELINE_CHILD_RUN_EXPAND_METHOD,
    ChildRunExpandRequest,
    ChildRunExpandResponse
  >;
  readonly [TIMELINE_BODY_READ_METHOD]: TimelineMethodBinding<
    typeof TIMELINE_BODY_READ_METHOD,
    TimelineBodyReadRequest,
    TimelineBodyReadResponse
  >;
  readonly [TIMELINE_PATCH_READ_METHOD]: TimelineMethodBinding<
    typeof TIMELINE_PATCH_READ_METHOD,
    TimelinePatchReadRequest,
    TimelinePatchReadResponse
  >;
  readonly [TIMELINE_SEARCH_METHOD]: TimelineMethodBinding<
    typeof TIMELINE_SEARCH_METHOD,
    TimelineSearchRequest,
    TimelineSearchResponse
  >;
}

/**
 * The request and response types each method string is bound to: the type-level half of
 * {@link TIMELINE_METHOD_DESCRIPTORS}. A registrar handed a method name gets its handler's
 * parameter and return types from it.
 */
export interface TimelineMethodContract {
  readonly [TIMELINE_READ_METHOD]: {
    readonly request: TimelineReadRequest;
    readonly response: TimelineReadResponse;
  };
  readonly [TIMELINE_REASONING_SURFACE_READ_METHOD]: {
    readonly request: ReasoningSurfaceReadRequest;
    readonly response: ReasoningSurfaceReadResponse;
  };
  readonly [TIMELINE_CHILD_RUN_EXPAND_METHOD]: {
    readonly request: ChildRunExpandRequest;
    readonly response: ChildRunExpandResponse;
  };
  readonly [TIMELINE_BODY_READ_METHOD]: {
    readonly request: TimelineBodyReadRequest;
    readonly response: TimelineBodyReadResponse;
  };
  readonly [TIMELINE_PATCH_READ_METHOD]: {
    readonly request: TimelinePatchReadRequest;
    readonly response: TimelinePatchReadResponse;
  };
  readonly [TIMELINE_SEARCH_METHOD]: {
    readonly request: TimelineSearchRequest;
    readonly response: TimelineSearchResponse;
  };
}

/** The request type bound to one `timeline.*` method string. */
export type TimelineMethodRequest<MethodName extends TimelineMethodName> =
  TimelineMethodContract[MethodName]["request"];

/** The response type bound to one `timeline.*` method string. */
export type TimelineMethodResponse<MethodName extends TimelineMethodName> =
  TimelineMethodContract[MethodName]["response"];

/**
 * The method-to-schema binding for the `timeline.*` namespace. Frozen so no consumer can
 * re-point a method's schema and change what the daemon accepts.
 */
export const TIMELINE_METHOD_DESCRIPTORS: TimelineMethodDescriptorRegistry = Object.freeze({
  [TIMELINE_READ_METHOD]: Object.freeze({
    method: TIMELINE_READ_METHOD,
    procedureType: "query",
    mutating: false,
    requestSchema: TimelineReadRequestSchema,
    responseSchema: TimelineReadResponseSchema,
  }),
  [TIMELINE_REASONING_SURFACE_READ_METHOD]: Object.freeze({
    method: TIMELINE_REASONING_SURFACE_READ_METHOD,
    procedureType: "query",
    mutating: false,
    requestSchema: ReasoningSurfaceReadRequestSchema,
    responseSchema: ReasoningSurfaceReadResponseSchema,
  }),
  [TIMELINE_CHILD_RUN_EXPAND_METHOD]: Object.freeze({
    method: TIMELINE_CHILD_RUN_EXPAND_METHOD,
    procedureType: "query",
    mutating: false,
    requestSchema: ChildRunExpandRequestSchema,
    responseSchema: ChildRunExpandResponseSchema,
  }),
  [TIMELINE_BODY_READ_METHOD]: Object.freeze({
    method: TIMELINE_BODY_READ_METHOD,
    procedureType: "query",
    mutating: false,
    requestSchema: TimelineBodyReadRequestSchema,
    responseSchema: TimelineBodyReadResponseSchema,
  }),
  [TIMELINE_PATCH_READ_METHOD]: Object.freeze({
    method: TIMELINE_PATCH_READ_METHOD,
    procedureType: "query",
    mutating: false,
    requestSchema: TimelinePatchReadRequestSchema,
    responseSchema: TimelinePatchReadResponseSchema,
  }),
  [TIMELINE_SEARCH_METHOD]: Object.freeze({
    method: TIMELINE_SEARCH_METHOD,
    procedureType: "query",
    mutating: false,
    requestSchema: TimelineSearchRequestSchema,
    responseSchema: TimelineSearchResponseSchema,
  }),
});
