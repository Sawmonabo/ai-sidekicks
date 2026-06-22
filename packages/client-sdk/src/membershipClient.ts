// Plan-002 Phase 5 T5.1: typed `membershipClient` SDK surface — the local
// client's single gateway for the invite / membership / channel / presence
// operations owed to the desktop renderer + CLI consumers.
//
// Spec coverage:
//   * Spec-002 §AC1 (line 178) — an invited participant joins an active
//     session without resetting active runs. At the SDK transport boundary
//     (this file), the load-bearing surface is that `acceptInvite` is a PURE
//     membership operation: it issues exactly the `invite.accept` call and
//     returns the schema-validated `InviteAcceptResponse`, with NO
//     run-state-mutating side call. Substrate non-disruption (the actual
//     "active runs survive" guarantee) is verified at the services layer per
//     Plan-002 Phase 2 / Phase 3 — the SDK layer cannot reset a run because
//     it never issues a run-touching method.
//   * Spec-002 line 87 + §AC1 — `ChannelList` returns the bootstrap `main`
//     channel for an existing session. `listChannels()` below; the bootstrap
//     channel id is the deterministic `deriveMainChannelId(sessionId)`
//     (CP-002-7 shared derivation), NOT a stored/event-sourced id.
//   * Spec-002 §Interfaces — invite (`invite.create` / `invite.accept` /
//     `invite.revoke`), membership (`membership.update`), channel
//     (`channel.list`), and presence (`presence.read` / `presence.subscribe`)
//     wire surfaces, all unified under the `MembershipClient` interface.
//
// Transport-shape choice — DAEMON-AS-GATEWAY (single transport) vs. the
// dual-factory shape `sessionClient.ts` uses:
//
//   `createDaemonMembershipClient(jsonRpcClient)` is SINGLE-TRANSPORT: every
//   operation is a JSON-RPC call to the LOCAL daemon. This is the deliberate
//   Option A resolution (the plan under-specified the SDK↔control-plane
//   boundary; resolved via ADR-008 "stronger local boundary" + the
//   sessionClient precedent + a ratifying user directive). The daemon is the
//   local client's ONE gateway:
//     * `presence.read` / `presence.subscribe` hit REAL daemon handlers
//       directly — presence is in-memory daemon state (Plan-002 I-002-3), so
//       the daemon is the authoritative source and no control-plane hop is
//       involved.
//     * `invite.*` / `membership.*` / `channel.*` are method-names the SDK
//       DECLARES; the daemon proxies each to the control-plane tRPC server
//       SERVER-SIDE (the "invite/membership tRPC adapter" named in the plan
//       title is the DAEMON's job, not the SDK's). From the SDK's vantage
//       these are indistinguishable from native daemon methods — same
//       `JsonRpcClient.call` envelope, same bidirectional Zod fail-fast.
//
//   Contrast `sessionClient.ts`, which ships TWO factories (daemon + direct
//   control-plane HTTP/SSE) because the session vertical slice needs a client
//   that can talk to the control-plane WITHOUT a daemon. The membership
//   surface deliberately does not: the daemon-as-gateway boundary keeps a
//   single trust/transport seam for the local client (ADR-008), so there is
//   no `createControlPlaneMembershipClient` HTTP path here. A throwing
//   control-plane factory placeholder (`createControlPlaneMembershipClient`)
//   is owned by a sibling task (T5.2) and returns this SAME interface.
//
// Bidirectional Zod fail-fast: every unary method threads its request schema
// AND response schema through `JsonRpcClient.call(method, request,
// RequestSchema, ResponseSchema)` (jsonRpcClient.ts:515-522). `call` validates
// the request via the paramsSchema BEFORE the wire write (a malformed request
// fails fast with `JsonRpcSchemaError(phase: "params")` and never reaches the
// daemon) and validates the response via the resultSchema BEFORE resolving
// (server corruption surfaces as `JsonRpcSchemaError(phase: "result")`). We do
// NOT hand-roll `.parse()` — the wrapper owns both directions.
//
// What this file does NOT do:
//   * Implement the daemon-side bridge handlers that proxy `invite.*` /
//     `membership.*` / `channel.*` to the control-plane. Those live in
//     `runtime-daemon` and are out of this task's scope (T5.1 = the
//     client-sdk transport boundary).
//   * Implement byte-level framing or the `daemon.hello` handshake. The
//     factory consumes a fully-constructed `JsonRpcClient` (the caller wires
//     the `ClientTransport` and completes the handshake before the first
//     mutating call), exactly as `createDaemonSessionClient` does.
//   * Synthesize a cursor envelope around presence updates. Unlike
//     `SessionEventEnvelope` (which synthesizes `eventId` from `event.id` to
//     unify the daemon + control-plane subscribe surfaces), `PresenceUpdate`
//     carries no id/cursor field and presence is single-transport, so
//     `subscribePresence` yields the validated `PresenceUpdate` directly.

import type {
  ChannelListRequest,
  ChannelListResponse,
  InviteAccept,
  InviteAcceptResponse,
  InviteCreate,
  InviteCreateResponse,
  InviteRevoke,
  InviteRevokeResponse,
  MembershipUpdate,
  MembershipUpdateResponse,
  PresenceReadRequest,
  PresenceReadResponse,
  PresenceSubscribeRequest,
  PresenceUpdate,
  SessionId,
} from "@ai-sidekicks/contracts";
import {
  ChannelListRequestSchema,
  ChannelListResponseSchema,
  InviteAcceptResponseSchema,
  InviteAcceptSchema,
  InviteCreateResponseSchema,
  InviteCreateSchema,
  InviteRevokeResponseSchema,
  InviteRevokeSchema,
  MembershipUpdateResponseSchema,
  MembershipUpdateSchema,
  PresenceReadRequestSchema,
  PresenceReadResponseSchema,
  PresenceUpdateSchema,
} from "@ai-sidekicks/contracts";

import type { JsonRpcClient } from "./transport/jsonRpcClient.js";

// --------------------------------------------------------------------------
// Common consumer surface
// --------------------------------------------------------------------------

/**
 * Subscribe options accepted by `subscribePresence`. Carries the `sessionId`
 * to scope the live presence stream plus an optional `signal` to cancel the
 * subscription early (wired through to the underlying transport so a
 * `for await ... break` releases the daemon's streaming-primitive entry).
 *
 * Sibling to `SessionSubscribeOptions` in `sessionClient.ts`, MINUS the
 * `afterCursor` field: presence pushes live in-memory CRDT state (Plan-002
 * I-002-3 — presence is in-memory only), so there is no durable cursor to
 * replay from. The `presence.subscribe` request schema (`PresenceSubscribe-
 * RequestSchema`) likewise carries only `{sessionId}`.
 *
 * Note there is no `PresenceUpdateEnvelope` sibling type. `subscribePresence`
 * yields the validated `PresenceUpdate` directly rather than wrapping it the
 * way `sessionClient`'s `subscribe` wraps `SessionEvent` in a
 * `SessionEventEnvelope`: that envelope exists to SYNTHESIZE a cursor
 * (`eventId`) for reconnect, but `PresenceUpdate` carries no id/cursor field
 * and presence has no replay cursor, so there is nothing to synthesize.
 */
export interface PresenceSubscribeOptions {
  readonly sessionId: SessionId;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Canonical method names for the membership-surface operations. On the daemon
 * transport these route to the JSON-RPC `method` field (per
 * docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name
 * Registry, Tier 1 Ratified — dotted-camelCase `namespace.operation`, flat
 * top-level namespaces matching the existing `session.*` + `presence.*`).
 *
 * Two provenance classes, deliberately distinguished:
 *   * `presence.read` / `presence.subscribe` are EXISTING daemon handlers —
 *     the daemon owns the presence state in-memory and answers these natively.
 *   * `invite.*` / `membership.*` / `channel.*` are SDK-DECLARED names the
 *     daemon BRIDGES to the control-plane tRPC server server-side (Option A,
 *     daemon-as-gateway — see the file header). From the SDK's vantage they
 *     are ordinary `JsonRpcClient.call` envelopes; the daemon-side proxy is
 *     transparent at this layer.
 *
 * Centralizing the names here so a future name evolution (namespace move,
 * BL-issued rename) edits one location rather than scattered string literals.
 */
const INVITE_METHOD_CREATE = "invite.create";
const INVITE_METHOD_ACCEPT = "invite.accept";
const INVITE_METHOD_REVOKE = "invite.revoke";
const MEMBERSHIP_METHOD_UPDATE = "membership.update";
const CHANNEL_METHOD_LIST = "channel.list";
const PRESENCE_METHOD_READ = "presence.read";
const PRESENCE_METHOD_SUBSCRIBE = "presence.subscribe";

/**
 * Common consumer-side surface for the seven membership-domain methods.
 * `createDaemonMembershipClient` returns an object satisfying this interface;
 * the sibling throwing `createControlPlaneMembershipClient` (T5.2) returns the
 * SAME interface so callers can swap factories without restructuring.
 */
export interface MembershipClient {
  createInvite(request: InviteCreate): Promise<InviteCreateResponse>;
  acceptInvite(request: InviteAccept): Promise<InviteAcceptResponse>;
  /**
   * Resolves the post-revoke invite projection (`InviteRevokeResponse`) on
   * success. A not-found invite REJECTS with a typed `invite.not_found` wire
   * error (`error-contracts.md §Invite`), never a `null` result — the non-null
   * return is by design. The daemon translates the control-plane service's
   * internal `null` sentinel (invite-service.ts:828-829) to that typed error.
   */
  revokeInvite(request: InviteRevoke): Promise<InviteRevokeResponse>;
  /**
   * Resolves the post-update membership projection (`MembershipUpdateResponse`)
   * on success. A not-found membership REJECTS with a typed not-found wire
   * error (`error-contracts.md §Error Codes`), never a `null` result — the
   * non-null return is by design. The daemon translates the control-plane
   * service's internal `null` sentinel (membership-service.ts:227-229) to that
   * typed error.
   */
  updateMembership(request: MembershipUpdate): Promise<MembershipUpdateResponse>;
  listChannels(request: ChannelListRequest): Promise<ChannelListResponse>;
  readPresence(request: PresenceReadRequest): Promise<PresenceReadResponse>;
  subscribePresence(options: PresenceSubscribeOptions): AsyncIterable<PresenceUpdate>;
}

// --------------------------------------------------------------------------
// Daemon transport factory (Option A — single gateway)
// --------------------------------------------------------------------------

/**
 * Build a `MembershipClient` over a daemon transport. The caller is
 * responsible for wiring the underlying `ClientTransport` (Unix socket,
 * Windows named pipe, in-memory test double) and instantiating the
 * `JsonRpcClient` — including completing the `daemon.hello` handshake before
 * the first mutating call.
 *
 * Every operation is a JSON-RPC call to the LOCAL daemon (Option A,
 * daemon-as-gateway — see the file header). The daemon answers `presence.*`
 * natively and bridges `invite.*` / `membership.*` / `channel.*` to the
 * control-plane server-side; the SDK surface is transport-uniform.
 *
 * Each unary method threads its request schema + response schema through
 * `client.call`, which owns the bidirectional Zod fail-fast (request validated
 * before the wire write; response validated before resolve). `subscribePresence`
 * delegates to `daemonSubscribePresence`, mirroring `sessionClient`'s
 * `daemonSubscribe`.
 */
export function createDaemonMembershipClient(client: JsonRpcClient): MembershipClient {
  return {
    createInvite: (request) =>
      client.call(INVITE_METHOD_CREATE, request, InviteCreateSchema, InviteCreateResponseSchema),
    acceptInvite: (request) =>
      client.call(INVITE_METHOD_ACCEPT, request, InviteAcceptSchema, InviteAcceptResponseSchema),
    revokeInvite: (request) =>
      client.call(INVITE_METHOD_REVOKE, request, InviteRevokeSchema, InviteRevokeResponseSchema),
    updateMembership: (request) =>
      // `MembershipUpdate` is a discriminated union (memberships.ts:158); the
      // schema is `z.discriminatedUnion("action", ...)`, so passing the value
      // straight through `client.call` validates the active variant
      // (including the `change_role` variant's `newRole` payload field).
      client.call(
        MEMBERSHIP_METHOD_UPDATE,
        request,
        MembershipUpdateSchema,
        MembershipUpdateResponseSchema,
      ),
    listChannels: (request) =>
      client.call(
        CHANNEL_METHOD_LIST,
        request,
        ChannelListRequestSchema,
        ChannelListResponseSchema,
      ),
    readPresence: (request) =>
      client.call(
        PRESENCE_METHOD_READ,
        request,
        PresenceReadRequestSchema,
        PresenceReadResponseSchema,
      ),
    subscribePresence: (options) => daemonSubscribePresence(client, options),
  };
}

/**
 * Daemon-side presence subscribe — wraps `JsonRpcClient.subscribe` and adapts
 * its `LocalSubscriptionConsumer<PresenceUpdate>` consumer handle into the
 * `AsyncIterable<PresenceUpdate>` shape. Structurally mirrors
 * `sessionClient.ts`'s `daemonSubscribe` (pre-abort fast-exit, abort-listener
 * + race-close re-check, `finally` cleanup), MINUS the cursor-envelope
 * synthesis: `PresenceUpdate` is yielded directly (it carries no id/cursor
 * field, and presence has no replay cursor).
 *
 * The per-notification `value` is validated against `PresenceUpdateSchema` by
 * `JsonRpcClient.subscribe` (every `$/subscription/notify` frame is parsed
 * against the supplied `valueSchema` before reaching the consumer queue), so
 * this wrapper does not re-validate.
 */
async function* daemonSubscribePresence(
  client: JsonRpcClient,
  options: PresenceSubscribeOptions,
): AsyncIterable<PresenceUpdate> {
  // Pre-abort fast-exit: if the caller's signal is ALREADY aborted, do not
  // touch the wire. Returning from an async generator yields zero items, so
  // the caller's `for await` exits immediately. Must precede `client.subscribe`
  // because that call synchronously sends the `presence.subscribe` envelope and
  // reserves a server-side `StreamingPrimitive` entry. Match the explicit
  // `=== true` check sessionClient uses so a future change to the optional
  // `signal` typing doesn't silently regress this guard via truthy-coercion.
  if (options.signal?.aborted === true) {
    return;
  }

  // The `presence.subscribe` request carries only `{sessionId}` (no replay
  // cursor — presence is in-memory only per I-002-3). Annotate the params with
  // the `PresenceSubscribeRequest` type so the wire shape is compile-checked
  // against the contract. (Subscribe-init params are not Zod-validated at the
  // SDK boundary — `JsonRpcClient.subscribe` uses a passthrough params schema
  // and validates only the per-notification `value` via `valueSchema`; the
  // daemon owns the subscribe-param validation contract, mirroring how
  // `sessionClient`'s `daemonSubscribe` builds its params literal.)
  const params: PresenceSubscribeRequest = {
    sessionId: options.sessionId,
  };

  const subscription = client.subscribe<PresenceUpdate>(
    PRESENCE_METHOD_SUBSCRIBE,
    params,
    PresenceUpdateSchema,
  );

  // Wire the caller's AbortSignal through to the subscription's cancel. We use
  // `addEventListener("abort", ...)` rather than checking `signal.aborted`
  // mid-loop because the underlying `LocalSubscriptionConsumer` parks on
  // `next()` between value arrivals — a polling check inside `for await` would
  // only fire AFTER the next value lands. (The pre-aborted case is handled
  // above before `client.subscribe` runs.)
  let abortListener: (() => void) | undefined;
  if (options.signal !== undefined) {
    const sig = options.signal;
    abortListener = (): void => {
      void subscription.cancel().catch(() => undefined);
    };
    sig.addEventListener("abort", abortListener, { once: true });
    // Race-close: if the signal aborted between the pre-check above and this
    // addEventListener (e.g., during client.subscribe()'s synchronous envelope
    // dispatch + StreamingPrimitive reservation), the listener missed the abort
    // event. Re-check sig.aborted now and fire the same cancel path the
    // listener would have. Without this, the daemon's subscription stays live
    // and the for-await parks indefinitely on a caller-canceled stream. Use
    // truthy `sig.aborted` (NOT `=== true`) — `sig` is already narrowed to
    // `AbortSignal` by the `options.signal !== undefined` block, so TS knows
    // `sig.aborted` is `boolean`.
    if (sig.aborted) {
      sig.removeEventListener("abort", abortListener);
      void subscription.cancel().catch(() => undefined);
      return;
    }
  }

  try {
    for await (const update of subscription) {
      // `update` is already validated against `PresenceUpdateSchema` by the
      // subscribe primitive; yield it directly (no cursor synthesis — see the
      // function JSDoc for why presence has no envelope).
      yield update;
    }
  } finally {
    if (abortListener !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener("abort", abortListener);
    }
    // `for await ... return` already invoked the iterator's `return()`, which
    // calls `subscription.cancel()`. The post-loop cancel here is idempotent
    // (per `LocalSubscriptionConsumer.cancel()`'s documented contract) and
    // covers the early-throw case.
    await subscription.cancel().catch(() => undefined);
  }
}

// --------------------------------------------------------------------------
// Control-plane transport factory (deferred to Tier 5 — Plan-008-remainder /
// CP-002-1)
// --------------------------------------------------------------------------
//
// The real direct-to-control-plane membership transport consumes the
// Plan-008-remainder relay, which does not ship until Tier 5 (cross-plan
// dependency CP-002-1). It is therefore impossible to implement at Tier 2.
// This is a plan-sanctioned forward-compatibility scaffold (Plan-002 T5.2,
// `Spec coverage: none`): a signature-complete factory that fails fast via a
// typed sentinel until the relay lands. When Tier 5 arrives the body is a
// straight swap (mirror `createControlPlaneSessionClient`'s
// fetcher/baseUrl/endpoint HTTP shape) and the `: MembershipClient` annotation
// already holds — no caller-facing signature churn.

/**
 * Thrown by `createControlPlaneMembershipClient` at construction time. The
 * direct-control-plane membership transport is deferred to Tier 5 — it
 * consumes the Plan-008-remainder relay (cross-plan dependency CP-002-1),
 * which does not exist at Tier 2 — so the factory cannot return a working
 * client and refuses to hand back a half-built one. Until then the production
 * transport for the local client is `createDaemonMembershipClient`, the
 * Option A daemon-as-gateway path (ADR-008): the daemon proxies `invite.*` /
 * `membership.*` / `channel.*` to the control-plane server-side, so no V1
 * caller has a legitimate reason to construct a direct-control-plane client.
 *
 * This sentinel is SDK-thrown and never serialized to the wire (it is not a
 * JSON-RPC / tRPC error envelope), so it stays in `client-sdk` rather than
 * being hoisted into `@ai-sidekicks/contracts`. The message names the
 * deferral substrate (Plan-008-remainder, CP-002-1, Tier 5) so a future
 * `grep` for the relay surfaces this seam.
 */
export class NotImplementedAtTier2Error extends Error {
  public constructor() {
    super(
      "createControlPlaneMembershipClient is not implemented at Tier 2: the " +
        "direct-control-plane membership transport consumes the Plan-008-remainder " +
        "relay (CP-002-1), which does not ship until Tier 5. Use " +
        "createDaemonMembershipClient (the Option A daemon-as-gateway path) as the " +
        "production transport until then.",
    );
    this.name = "NotImplementedAtTier2Error";
  }
}

/**
 * Constructor options for the (Tier-5-deferred) control-plane factory. An
 * EXACT structural mirror of `ControlPlaneSessionClientOptions`
 * (`sessionClient.ts`) so the future Tier-5 real implementation is a body-swap
 * with no options-shape divergence between the two control-plane factories.
 *
 * `fetcher`: an HTTP-like callable. Accepts a standard `Request` and returns a
 * standard `Response`. In production this is
 * `globalThis.fetch.bind(globalThis)` pointed at a deployed control-plane URL.
 *
 * `baseUrl`: the absolute URL prefix (no trailing slash) of the control-plane
 * deployment. The SDK appends `${endpoint}/${method}` to this prefix.
 *
 * `endpoint`: optional tRPC mount path. Defaults to `/trpc` in the
 * sessionClient counterpart. Only override when the deployment mounts the
 * tRPC handler at a non-default path.
 */
export interface ControlPlaneMembershipClientOptions {
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly baseUrl: string;
  readonly endpoint?: string;
}

/**
 * Build a `MembershipClient` over the control-plane HTTP transport.
 *
 * DEFERRED TO TIER 5: this factory throws `NotImplementedAtTier2Error` at
 * construction. The real direct-control-plane transport consumes the
 * Plan-008-remainder relay (CP-002-1), unavailable at Tier 2. Throw-at-
 * construction (not return-a-stub) is the correct fail-fast signal because
 * under Option A (ADR-008, daemon-as-gateway) NO V1 caller has a legitimate
 * reason to construct a direct-control-plane membership client —
 * `createDaemonMembershipClient` is the only production path. A loud throw at
 * the call site beats a stub that defers the failure to first method call.
 *
 * Returns the SAME `MembershipClient` interface as
 * `createDaemonMembershipClient` so the Tier-5 implementation is a body-swap
 * with type-level factory-swappability preserved. The `: MembershipClient`
 * annotation holds today because a throw-only body has type `never`, which is
 * assignable to `MembershipClient`. `_opts` is intentionally unused at Tier 2
 * (the root ESLint `argsIgnorePattern: "^_"` exempts the leading-underscore
 * name); the Tier-5 body will consume it exactly as
 * `createControlPlaneSessionClient` consumes its `opts`.
 */
export function createControlPlaneMembershipClient(
  _opts: ControlPlaneMembershipClientOptions,
): MembershipClient {
  throw new NotImplementedAtTier2Error();
}
