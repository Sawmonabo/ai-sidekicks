// The `driver.*` client SDK surface — Plan-005 Phase 4, T4.3 (factory) + T4.4
// (the subscription leg).
//
// DAEMON-ONLY, AND THAT IS THE WHOLE DESIGN. There is exactly one factory here
// and there will not be a second: Plan-005 §Phase 4 ratified decision #1 fixes
// this surface at `createDaemonProviderClient(JsonRpcClient): DriverClient` with
// no control-plane variant, because `Spec-005 §Required Behavior` places driver
// authority in the local daemon (I-005-1). The two sibling clients in this
// package (`sessionClient.ts`, `runtimeNodeClient.ts`) each ship a daemon
// factory AND a control-plane factory; the asymmetry here is deliberate, and its
// absence is the enforcement. A control-plane factory would be a wire path by
// which a client executed a provider somewhere other than the node that owns the
// process, which is the exact thing I-005-1 forbids — so the invariant survives
// contact with this package by there being no such function to call.
//
// SEVEN METHODS, AND THE FOUR THAT ARE MISSING ARE THE CONTRACT. `ProviderDriver`
// carries eighteen operations. Four of them — `createSession`, `resumeSession`,
// `startRun`, `closeSession` — establish, restore, start, or tear down a
// session-or-run domain object, which is orchestration's job (Plan-005 §Phase 4
// decision #2). They are daemon-internal: no client-facing schema exists for
// them at the SDK seam, no daemon handler registers them, and this interface
// does not declare them. A renderer or CLI holding a `DriverClient` therefore
// cannot mint or destroy runtime state behind the orchestrator's back — it
// cannot even name the operation. That is also what makes the recovery contract
// (`Spec-005 §Fallback Behavior`, I-005-5) enforceable from this side: a failed
// resume has no client-reachable route to a replacement session, because no
// route to session creation exists here at all.
//
// T4.9's two console-parity verbs (`driver.compactContext`,
// `driver.listProviderCommands`) extend THIS interface and THIS factory when
// they land, taking the client-facing set from seven to nine. They are
// deliberately not a second client module.
//
// ZOD AT THE SEAM, IN BOTH DIRECTIONS. Every request/response verb routes
// through `JsonRpcClient.call`, which validates the request against its T4.2
// schema BEFORE the wire write and the daemon's reply against its result schema
// BEFORE resolving. That bidirectional guard is why `applyIntervention` can be
// trusted to hand back a degraded envelope unmutated:
// `DriverInterventionResultSchema` is `.strict()`, so a daemon answering
// `{ status: "degraded" }` with the `fallbackAction` dropped, or with an unknown
// key spliced in, fails the result parse and rejects rather than reaching a
// caller that would render a fallback hint it never received (I-005-4). The
// subscription path gets the same treatment on the values it streams: every
// delivered frame is parsed against `DriverEventSchema` — the contracts-owned
// narrowing to the seven driver-event categories — so a daemon that filtered
// wrongly ends the subscription loudly instead of handing a driver-typed
// consumer an approval or membership row.
//
// THE THREE READS TAKE NO ARGUMENT. `listCapabilities`, `listModels`, and
// `listModes` are written no-arg here, matching the `DriverClient` signature
// Plan-005 §Phase 4 T4.3 ratifies and the `DriverReadParams` empty-object shape
// T4.2 registers. Each answers with a GROUP LIST keyed by driver name rather
// than a flat merged array, because model ids collide across providers and
// carry no vendor marker — a flat reply would strip the provenance a caller
// needs to keep a Claude-published value from being offered through a
// Codex-bound agent.
//
// Refs: Plan-005 §Phase 4 / T4.3 + T4.4 (ratified decisions #1-#4),
// `Spec-005 §Required Behavior` (driver authority local; drivers emit
// normalized runtime events), `Spec-005 §Fallback Behavior`, invariants
// I-005-1 / I-005-4, CP-007-4 (the shared streaming primitive's
// producer/consumer split).

import type {
  ApplyInterventionParams,
  DriverAckResult,
  DriverEvent,
  DriverInterventionResult,
  DriverReadParams,
  DriverSubscribeEventsParams,
  InterruptRunParams,
  ListCapabilitiesResult,
  ListModelsResult,
  ListModesResult,
  RespondToRequestParams,
} from "@ai-sidekicks/contracts";
import {
  ApplyInterventionParamsSchema,
  DriverAckResultSchema,
  DriverEventSchema,
  DriverInterventionResultSchema,
  DriverReadParamsSchema,
  DriverSubscribeEventsParamsSchema,
  InterruptRunParamsSchema,
  ListCapabilitiesResultSchema,
  ListModelsResultSchema,
  ListModesResultSchema,
  RespondToRequestParamsSchema,
} from "@ai-sidekicks/contracts";

import { JsonRpcSchemaError, type JsonRpcClient } from "./transport/jsonRpcClient.js";
import type { LocalSubscriptionConsumer } from "./transport/types.js";

// --------------------------------------------------------------------------
// Canonical method names
// --------------------------------------------------------------------------

/**
 * The seven client-facing `driver.*` JSON-RPC method names, in the canonical
 * dotted-camelCase long form ADR-009 + Plan-007 I-007-9 require.
 *
 * Authored as local string constants rather than imported symbols, matching
 * `sessionClient.ts`'s `SESSION_METHOD_*` and `runtimeNodeClient.ts`'s
 * `RUNTIME_NODE_METHOD_*` tables: the wire name is a protocol fact shared with
 * the daemon's `register()` calls, and centralizing it here means a future
 * namespace evolution edits one location per side rather than scattered
 * literals. The daemon's own copies live in `driver-handlers.ts` and
 * `driver-subscribe.ts`; the pair is kept honest by the round-trip tests, which
 * dispatch these exact strings against a registry the daemon bound.
 *
 * Unlike the runtime-node table, every name here routes on the daemon transport
 * — there is no control-plane-only row, because there is no control-plane
 * driver transport at all (see the file header).
 */
const DRIVER_METHOD_LIST_CAPABILITIES = "driver.listCapabilities";
const DRIVER_METHOD_LIST_MODELS = "driver.listModels";
const DRIVER_METHOD_LIST_MODES = "driver.listModes";
const DRIVER_METHOD_INTERRUPT_RUN = "driver.interruptRun";
const DRIVER_METHOD_APPLY_INTERVENTION = "driver.applyIntervention";
const DRIVER_METHOD_RESPOND_TO_REQUEST = "driver.respondToRequest";
const DRIVER_METHOD_SUBSCRIBE_EVENTS = "driver.subscribeEvents";

/**
 * The request value the three no-arg reads send.
 *
 * A single frozen module-level constant rather than a fresh empty object per
 * call: the value is immutable by contract (`DriverReadParams` is
 * `Record<string, never>`, so there is nothing to vary), and freezing it means a
 * caller that somehow reached it cannot mutate the object a later call sends.
 */
const EMPTY_READ_PARAMS: DriverReadParams = Object.freeze({});

// --------------------------------------------------------------------------
// Consumer surface
// --------------------------------------------------------------------------

/**
 * The client-facing driver surface: the six non-lifecycle verbs plus
 * `subscribeEvents` — the seven methods ratified at Plan-005 §Phase 4
 * decision #2.
 *
 * `interruptRun` and `respondToRequest` resolve `DriverAckResult` (the empty
 * object). That is a genuine success value and not a sentinel: their driver-side
 * operations return `Promise<void>`, and the daemon answers with the empty
 * object because the method registry `safeParse`s every result and a handler
 * returning `undefined` would fail its own result schema — surfacing a
 * successful interrupt to this client as an internal error. A refusal never
 * arrives as an empty object; it arrives as a `JsonRpcRemoteError` carrying the
 * registered `driver.unavailable` / `driver.capability_unsupported` /
 * `run.not_found` code.
 *
 * `applyIntervention` is the one verb whose UNSUPPORTED case is a resolved value
 * rather than a rejection. ADR-011 makes an unsupported intervention DATA: the
 * call reaches the driver so it can answer a `degraded` status naming the
 * daemon's fallback, and the daemon deliberately does not pre-gate it on the
 * capability flag, because a gate would replace a usable fallback hint with an
 * error. Callers MUST branch on `status` — treating a resolved promise as "the
 * intervention was applied natively" is the misreading this envelope exists to
 * prevent (I-005-4).
 *
 * `subscribeEvents` returns SYNCHRONOUSLY, unlike the `AsyncIterable` wrappers
 * `sessionClient.subscribe` and `membershipClient.subscribePresence` expose.
 * This is the shape Plan-005 §Phase 4 T4.3 ratifies, and it hands the caller the
 * raw consumer handle — `next()` polling, `for await` iteration, and an
 * idempotent `cancel()` — rather than choosing one consumption style for them.
 */
export interface DriverClient {
  /**
   * Read every loaded driver's client-facing capability report, served from the
   * daemon's T4.5 capability cache with no provider round-trip per call.
   *
   * A driver the cache cannot substantiate refuses the WHOLE read rather than
   * being silently omitted from the roster: an omitted driver is
   * indistinguishable from one that is not loaded, and reporting "no
   * capabilities" for a driver whose capabilities are merely unknown is the
   * fail-open reading I-005-2 exists to prevent.
   */
  listCapabilities(): Promise<ListCapabilitiesResult>;

  /** Interrupt the run's in-flight turn. Resolves the empty ack on success. */
  interruptRun(params: InterruptRunParams): Promise<DriverAckResult>;

  /**
   * Apply a `steer` / `interrupt` / `cancel` intervention to a run.
   *
   * `rollback` is deliberately NOT reachable here:
   * `ApplyInterventionParamsSchema` is a discriminated union over three arms, so
   * a `type: "rollback"` request fails the caller-side params parse at the
   * discriminator before any wire write. Rollback is Spec-004 content driven
   * through Plan-004's own intervention path against the driver-side
   * `rollbackTo` operation.
   */
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;

  /** Answer a provider-raised interactive request. Resolves the empty ack. */
  respondToRequest(params: RespondToRequestParams): Promise<DriverAckResult>;

  /** Read every loaded driver's published model catalog, grouped by driver. */
  listModels(): Promise<ListModelsResult>;

  /** Read every loaded driver's published mode catalog, grouped by driver. */
  listModes(): Promise<ListModesResult>;

  /**
   * Open a subscription to one run's driver event stream.
   *
   * Takes the run id despite T4.3's `Provides` line writing this method bare —
   * that line is shorthand for the return type it was ratified to pin, and
   * T4.4's own `Provides` line states the addressing verbatim
   * (`driver.subscribeEvents(runId)`). The shipped wire schema
   * (`DriverSubscribeEventsParamsSchema`, one `runId` member and `.strict()`)
   * settles it: a no-arg call would fail the daemon's own request parse.
   *
   * The value type is `DriverEvent`, not `SessionEvent` — the contracts-owned
   * union over the seven driver-event categories, which is the return type
   * `Plan-005 §Phase 4 — Client SDK exposure + degraded-fallback` T4.3
   * ratifies. A caller therefore branches over driver arms only and never has
   * to type-handle a membership, approval, or audit event on a driver stream.
   * Note that no `run.*` arm appears in that union today: `run_lifecycle` is on
   * decision #4's category list, but no `run.*` payload variant is registered
   * with `SessionEventSchema` yet, and `DriverEvent` covers registered arms
   * rather than census names. Those arms join this type on the day their
   * emitting plan registers them, with no edit here.
   */
  subscribeEvents(params: DriverSubscribeEventsParams): LocalSubscriptionConsumer<DriverEvent>;
}

// --------------------------------------------------------------------------
// Daemon transport factory
// --------------------------------------------------------------------------

/**
 * Build a `DriverClient` over a daemon transport.
 *
 * The caller owns the underlying `ClientTransport` (Unix socket, Windows named
 * pipe, in-memory test double) and the `JsonRpcClient` construction — including
 * completing the `daemon.hello` handshake before the first MUTATING call. That
 * last point has teeth on this namespace specifically: the daemon marks
 * `interruptRun`, `applyIntervention`, and `respondToRequest` as mutating and
 * the four reads (`listCapabilities` / `listModels` / `listModes` /
 * `subscribeEvents`) as not, so a version-mismatched connection keeps the reads
 * and loses exactly the three verbs that drive a live run.
 *
 * Each of the six request/response verbs threads its schema pair through
 * `client.call(method, params, ParamsSchema, ResultSchema)`, which owns the
 * bidirectional fail-fast. Nothing is unwrapped, re-shaped, or defaulted on the
 * way through: the daemon's reply IS the return value, so a `degraded`
 * intervention envelope reaches the caller with its `fallbackAction` intact
 * rather than being flattened into a boolean or laundered into a throw.
 *
 * A daemon-side refusal surfaces as `JsonRpcRemoteError` carrying the registered
 * dotted code — this path does NOT carry the control-plane clients' typed
 * `aisError` parsing, which is an HTTP/tRPC envelope concern.
 */
export function createDaemonProviderClient(client: JsonRpcClient): DriverClient {
  return {
    listCapabilities: () =>
      client.call(
        DRIVER_METHOD_LIST_CAPABILITIES,
        EMPTY_READ_PARAMS,
        DriverReadParamsSchema,
        ListCapabilitiesResultSchema,
      ),
    interruptRun: (params) =>
      client.call(
        DRIVER_METHOD_INTERRUPT_RUN,
        params,
        InterruptRunParamsSchema,
        DriverAckResultSchema,
      ),
    applyIntervention: (params) =>
      client.call(
        DRIVER_METHOD_APPLY_INTERVENTION,
        params,
        ApplyInterventionParamsSchema,
        DriverInterventionResultSchema,
      ),
    respondToRequest: (params) =>
      client.call(
        DRIVER_METHOD_RESPOND_TO_REQUEST,
        params,
        RespondToRequestParamsSchema,
        DriverAckResultSchema,
      ),
    listModels: () =>
      client.call(
        DRIVER_METHOD_LIST_MODELS,
        EMPTY_READ_PARAMS,
        DriverReadParamsSchema,
        ListModelsResultSchema,
      ),
    listModes: () =>
      client.call(
        DRIVER_METHOD_LIST_MODES,
        EMPTY_READ_PARAMS,
        DriverReadParamsSchema,
        ListModesResultSchema,
      ),
    subscribeEvents: (params) => daemonSubscribeEvents(client, params),
  };
}

/**
 * Open the `driver.subscribeEvents` subscription — T4.4's SDK half of the
 * Plan-007 CP-007-4 producer/consumer split.
 *
 * THE PER-VALUE SCHEMA IS `DriverEventSchema`, AND VALIDATING IT HERE TOO IS
 * DEFENSE IN DEPTH, NOT A SECOND DEFINITION. Plan-005 §Phase 4 decision #4
 * defines `DriverEvent` as the union of seven EXISTING Plan-006-owned event
 * categories. That derived view is authored once, in Plan-005's own
 * `packages/contracts/src/driver-event.ts`, so this side imports the schema
 * rather than deriving anything. That is what dissolves the objection that kept
 * this seam on the full `SessionEvent` union: with one home there is no second
 * derivation to drift, and the drift risk was the only argument for validating
 * wide here.
 *
 * The daemon already filters non-driver events out before they reach the wire,
 * so in a correct pairing this schema never refuses anything. It earns its
 * place against an INCORRECT one: a daemon whose filter regressed, or a peer
 * running a version that widened the stream, otherwise hands this client an
 * approval or membership row that parses cleanly and reaches a consumer typed
 * to expect neither. With the narrow schema that value fails per-value
 * validation and the subscription ends in a typed `JsonRpcSchemaError` on the
 * `value` phase, which is the loud failure the SDK boundary exists to give.
 *
 * PARAMS ARE VALIDATED HERE, WHICH DIVERGES FROM THE TWO SIBLING SUBSCRIBE
 * WRAPPERS, ON PURPOSE. `sessionClient`'s `daemonSubscribe` and
 * `membershipClient`'s `daemonSubscribePresence` both note that subscribe-init
 * params go unvalidated at the SDK boundary — `JsonRpcClient.subscribe` erases
 * them through a passthrough schema — and lean on the daemon's I-007-7 parse.
 * Two things make that trade wrong for this method. First, both siblings are
 * async generators, so a malformed request surfaces to the caller on the first
 * iteration; this one hands back a consumer handle SYNCHRONOUSLY, so an
 * unvalidated bad `runId` would leave the caller holding a live-looking handle
 * whose failure only appears at an eventual `next()`, detached from the call
 * that caused it. Second, `DriverSubscribeEventsParamsSchema` is a T4.2 SDK-seam
 * schema whose stated job is guarding client input crossing into the daemon;
 * skipping it here would leave the daemon's registry as its only reader.
 *
 * The refusal is `JsonRpcSchemaError` on the `params` phase — the SAME typed
 * error `client.call` raises for a caller-side params failure — so a consumer
 * catches one error class across all seven methods rather than a
 * subscription-specific twin. It throws synchronously, before any wire write and
 * before the server-side streaming entry is reserved, which is what keeps a
 * rejected request from orphaning daemon state.
 */
function daemonSubscribeEvents(
  client: JsonRpcClient,
  params: DriverSubscribeEventsParams,
): LocalSubscriptionConsumer<DriverEvent> {
  const parsed = DriverSubscribeEventsParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcSchemaError(
      "params",
      `Request params for ${DRIVER_METHOD_SUBSCRIBE_EVENTS} failed schema validation`,
      parsed.error.issues,
    );
  }

  return client.subscribe<DriverEvent>(
    DRIVER_METHOD_SUBSCRIBE_EVENTS,
    parsed.data,
    DriverEventSchema,
  );
}
