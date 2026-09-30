// The six `timeline.*` method strings, each BOUND to the
// request/response schemas that carry it.
//
// Six methods, all `query`, riding the daemon JSON-RPC transport only (the timeline is a daemon-local projection over the
// session event log and no tRPC sibling exists). Method tails are camelCase.
//
// ----------------------------------------------------------------------------
// Why the strings are bound to schemas rather than just declared
// ----------------------------------------------------------------------------
//
// The defect was not that the timeline shapes were missing —
// they were in the canonical doc — but that nothing said WHICH WIRE METHOD
// carried each one, so an operation's schema name resolved while its method
// string did not. Declaring bare constants would close half of that: the
// names would exist, and a handler binder could still register
// `timeline.childRunExpand` against the reasoning-surface schemas and typecheck.
//
// `TIMELINE_METHOD_DESCRIPTORS` is the pairing. It is the single place the
// method string, its procedure type, its mutating flag, and its schema pair are
// stated together, and the daemon's binder
// (`packages/runtime-daemon/src/ipc/handlers/timeline-methods.ts`) takes a
// descriptor rather than loose arguments, so no handler can bind a name to the
// wrong schemas.
//
// ----------------------------------------------------------------------------
// Nothing here registers a handler
// ----------------------------------------------------------------------------
//
// This file holds contracts only. A method is registered by the daemon service
// that answers it, and none is registered without one: a placeholder handler
// would put a method on the wire that answers nothing, which is worse than a
// method that is not on the wire.
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

export const TIMELINE_READ_METHOD = "timeline.read" as const;
export const TIMELINE_REASONING_SURFACE_READ_METHOD = "timeline.reasoningSurfaceRead" as const;
export const TIMELINE_CHILD_RUN_EXPAND_METHOD = "timeline.childRunExpand" as const;
export const TIMELINE_BODY_READ_METHOD = "timeline.bodyRead" as const;
export const TIMELINE_PATCH_READ_METHOD = "timeline.patchRead" as const;
export const TIMELINE_SEARCH_METHOD = "timeline.search" as const;

/** The closed set of method strings this namespace registers. */
export type TimelineMethodName =
  | typeof TIMELINE_READ_METHOD
  | typeof TIMELINE_REASONING_SURFACE_READ_METHOD
  | typeof TIMELINE_CHILD_RUN_EXPAND_METHOD
  | typeof TIMELINE_BODY_READ_METHOD
  | typeof TIMELINE_PATCH_READ_METHOD
  | typeof TIMELINE_SEARCH_METHOD;

/**
 * Every `timeline.*` method string, in the canonical registry table's row
 * order. A census a consumer can walk rather than a list it re-types.
 */
export const TIMELINE_METHOD_NAMES: readonly TimelineMethodName[] = Object.freeze([
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_BODY_READ_METHOD,
  TIMELINE_PATCH_READ_METHOD,
  TIMELINE_SEARCH_METHOD,
] as const);

/**
 * What a registrar needs to bind a single timeline method: the name, the procedure
 * type, the version-gate `mutating` flag, and the schema pair the registry
 * validates params and result against.
 *
 * `mutating` is typed `false` rather than `boolean` on purpose. Every
 * operation is an idempotent `query` read, so the literal states a property of
 * this surface instead of leaving a per-descriptor decision that could be set
 * wrong. A later timeline MUTATION
 * would fail to typecheck against this interface, which is the point: it should
 * arrive with a deliberate widening, not by flipping a boolean.
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
 * The request and response TYPES each method string is bound to — the type-level
 * half of {@link TIMELINE_METHOD_DESCRIPTORS}, which carries the schemas.
 *
 * This exists so a registrar can be handed a method NAME and have its handler's
 * parameter and return types follow from it, with no schema argument to supply
 * and therefore none to supply wrongly. Keyed by the method string so
 * `TimelineMethodContract[M]` resolves for a generic `M`.
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
 * The canonical method-to-schema binding for the `timeline.*` namespace —
 * the code-side mirror of the Timeline Method-Name Registry table.
 *
 * Frozen because it is a registry, not a builder: a consumer that could
 * re-point `TIMELINE_METHOD_DESCRIPTORS["timeline.read"].requestSchema` at
 * process start would be able to change what the daemon accepts on a method
 * without touching the method's own module.
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
