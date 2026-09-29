// The seven `timeline.*` method strings, each BOUND to the
// request/response schemas that carry it.
//
// Seven methods, six `query` and one `subscription`, riding the daemon
// JSON-RPC transport only (the timeline is a daemon-local projection over the
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
import type { MethodDescriptor, SubscriptionMethodDescriptor } from "../method-descriptor.js";
import {
  ChildRunExpandRequestSchema,
  ChildRunExpandResponseSchema,
  ReasoningSurfaceReadRequestSchema,
  ReasoningSurfaceReadResponseSchema,
  TimelineReadRequestSchema,
  TimelineReadResponseSchema,
  TimelineSubscribeRequestSchema,
  TimelineSubscribeResponseSchema,
  type ChildRunExpandRequest,
  type ChildRunExpandResponse,
  type ReasoningSurfaceReadRequest,
  type ReasoningSurfaceReadResponse,
  type TimelineReadRequest,
  type TimelineReadResponse,
  type TimelineSubscribeRequest,
  type TimelineSubscribeResponse,
} from "./operations.js";
import { TimelineRowSchema, type TimelineRow } from "./row.js";
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
export const TIMELINE_SUBSCRIBE_METHOD = "timeline.subscribe" as const;
export const TIMELINE_REASONING_SURFACE_READ_METHOD = "timeline.reasoningSurfaceRead" as const;
export const TIMELINE_CHILD_RUN_EXPAND_METHOD = "timeline.childRunExpand" as const;
export const TIMELINE_BODY_READ_METHOD = "timeline.bodyRead" as const;
export const TIMELINE_PATCH_READ_METHOD = "timeline.patchRead" as const;
export const TIMELINE_SEARCH_METHOD = "timeline.search" as const;

/** The closed set of method strings this namespace registers. */
export type TimelineMethodName =
  | typeof TIMELINE_READ_METHOD
  | typeof TIMELINE_SUBSCRIBE_METHOD
  | typeof TIMELINE_REASONING_SURFACE_READ_METHOD
  | typeof TIMELINE_CHILD_RUN_EXPAND_METHOD
  | typeof TIMELINE_BODY_READ_METHOD
  | typeof TIMELINE_PATCH_READ_METHOD
  | typeof TIMELINE_SEARCH_METHOD;

/**
 * The `query` method strings — every timeline method EXCEPT the
 * subscription.
 *
 * The split is not decoration. A `query` is bound by supplying a handler whose
 * resolved value the registry validates against the response schema; a
 * subscription additionally has a PER-EMISSION schema
 * ({@link TimelineSubscriptionMethodBinding.emissionSchema}) that nothing in a
 * `query` binding has anywhere to consume. Deriving this set with `Exclude`
 * rather than re-listing it lets the daemon's query binder be typed so the
 * subscription cannot be passed to it at all — the emission schema is then
 * unskippable rather than merely available, because the only binder that
 * accepts `timeline.subscribe` is the one that fixes the producer's schema
 * from the descriptor.
 */
export type TimelineQueryMethodName = Exclude<TimelineMethodName, typeof TIMELINE_SUBSCRIBE_METHOD>;

/**
 * Every `timeline.*` method string, in the canonical registry table's row
 * order. A census a consumer can walk rather than a list it re-types.
 */
export const TIMELINE_METHOD_NAMES: readonly TimelineMethodName[] = Object.freeze([
  TIMELINE_READ_METHOD,
  TIMELINE_SUBSCRIBE_METHOD,
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
 * operation is a read — idempotent `query` rows and one `subscription` — so
 * the literal states a property of this surface instead of leaving a
 * per-descriptor decision that could be set wrong. A later timeline MUTATION
 * would fail to typecheck against this interface, which is the point: it should
 * arrive with a deliberate widening, not by flipping a boolean.
 */
export interface TimelineMethodBinding<
  MethodName extends TimelineMethodName,
  RequestType,
  ResponseType,
> extends MethodDescriptor<MethodName, RequestType, ResponseType> {
  readonly procedureType: "query" | "subscription";
  readonly mutating: false;
}

/**
 * A `subscription` binding additionally names its PER-EMISSION payload — the
 * `TimelineRow` union the canonical registry table's response column reports
 * for `timeline.subscribe`. For `timeline.subscribe` the response schema is the
 * init ack, not the stream payload.
 */
export interface TimelineSubscriptionMethodBinding<
  MethodName extends TimelineMethodName,
  RequestType,
  ResponseType,
  EmissionType,
> extends SubscriptionMethodDescriptor<MethodName, RequestType, ResponseType, EmissionType> {
  readonly mutating: false;
}

/** The descriptors, keyed by method string. */
export interface TimelineMethodDescriptorRegistry {
  readonly [TIMELINE_READ_METHOD]: TimelineMethodBinding<
    typeof TIMELINE_READ_METHOD,
    TimelineReadRequest,
    TimelineReadResponse
  >;
  readonly [TIMELINE_SUBSCRIBE_METHOD]: TimelineSubscriptionMethodBinding<
    typeof TIMELINE_SUBSCRIBE_METHOD,
    TimelineSubscribeRequest,
    TimelineSubscribeResponse,
    TimelineRow
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
  readonly [TIMELINE_SUBSCRIBE_METHOD]: {
    readonly request: TimelineSubscribeRequest;
    readonly response: TimelineSubscribeResponse;
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
  [TIMELINE_SUBSCRIBE_METHOD]: Object.freeze({
    method: TIMELINE_SUBSCRIBE_METHOD,
    procedureType: "subscription",
    mutating: false,
    requestSchema: TimelineSubscribeRequestSchema,
    responseSchema: TimelineSubscribeResponseSchema,
    emissionSchema: TimelineRowSchema,
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
