// Plan-001 Phase 5 Lane A T5.1: typed `sessionClient` SDK surface — the
// V1 vertical-slice consumer wrapping `JsonRpcClient` (daemon transport,
// Plan-007 Phase 3) and the tRPC v11 SSE substrate (control-plane transport,
// Plan-008 Phase 1) under a single `SessionClient` interface.
//
// Spec coverage:
//   * Spec-001 §AC1 — `SessionCreate` returns a sessionId; `SessionRead`
//     against the same id round-trips identical state. `create()` + `read()`
//     below.
//   * Spec-001 §AC3 — Replay-from-cursor: events arrive in monotonically
//     increasing sequence; reconnect resumes after the consumer-tracked
//     cursor. `subscribe()` accepts `afterCursor` on both transports.
//   * Spec-001 §AC4 — A second client `SessionJoin` against an existing
//     session sees the existing event history (no fork). `join()` +
//     subsequent `subscribe()` below.
//   * Spec-001 §AC6 — Recovery from snapshot — a reconnect after a lost
//     stream restores from the daemon/control-plane authoritative
//     projection (NOT from the client's local cache). `subscribe()` issues
//     a fresh wire request on every call; the SDK holds no event cache.
//
// What this file does NOT do:
//   * Implement byte-level framing or HTTP transport. The daemon factory
//     consumes a fully-constructed `JsonRpcClient` (caller wires the
//     `ClientTransport`); the control-plane factory consumes a fetcher
//     callable (caller supplies `globalThis.fetch` or a wrangler/miniflare
//     test handler).
//   * Cache events client-side (per Spec-001 §AC6 — snapshot authority is
//     server-side; the SDK MUST NOT shadow it).
//   * Expose the dual-cursor wire schema. Internally `afterCursor` routes
//     to `params.afterCursor` on the daemon path and the `Last-Event-ID`
//     HTTP header on the control-plane path; the consumer surface unifies
//     both into a single `afterCursor?: EventCursor` field. (See
//     `SessionSubscribeRequest` JSDoc in contracts/session.ts for why the
//     wire schema carries both.)
//
// Shape choice — TWO factories sharing one interface — vs. a single
// union-typed constructor: `JsonRpcClient.subscribe()` returns a
// `LocalSubscription<T>` with synchronous handle + post-init mutation,
// whereas the control-plane SSE path returns an async generator built on
// the raw fetch + SSE frame parser. A union constructor would force
// runtime branching at every call site; per-transport factories let each
// surface keep its native primitive shape and still satisfy the same
// `SessionClient` interface without leaking transport details.

import type {
  EventCursor,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionEvent,
  SessionId,
  SessionJoinRequest,
  SessionJoinResponse,
  SessionReadRequest,
  SessionReadResponse,
} from "@ai-sidekicks/contracts";
import {
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionEventSchema,
  SessionJoinRequestSchema,
  SessionJoinResponseSchema,
  SessionReadRequestSchema,
  SessionReadResponseSchema,
} from "@ai-sidekicks/contracts";

import type { JsonRpcClient } from "./transport/jsonRpcClient.js";

// --------------------------------------------------------------------------
// Common consumer surface
// --------------------------------------------------------------------------

/**
 * Per-event envelope yielded by `subscribe()`. Carries both the opaque
 * `eventId` (the cursor the consumer should retain for `afterCursor`-based
 * reconnect) and the validated `SessionEvent` payload. Mirrors the shape
 * `sessionClientSubscribeStub` in
 * `client-sdk/test/transport/sse-roundtrip.test.ts:252-256` consumes — that
 * test was written ahead of this file specifically to PIN the consumer
 * surface for Plan-001 Phase 5 (per F-008b-1-09 unblock contract).
 */
export interface SessionEventEnvelope {
  readonly eventId: EventCursor;
  readonly event: SessionEvent;
}

/**
 * Subscribe options accepted by both transport factories. `afterCursor` is
 * optional; when omitted, the server replays from the start of the session
 * (subject to its retention window). When supplied, the server replays from
 * the row strictly after the given cursor.
 *
 * `signal` lets the caller cancel the subscription early — wired through to
 * the underlying transport so both `LocalSubscription.cancel()` (daemon) and
 * the SSE producer's abort path (control-plane) drain cleanly.
 */
export interface SessionSubscribeOptions {
  readonly sessionId: SessionId;
  readonly afterCursor?: EventCursor | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Canonical session-operation names shared by both transports. On the daemon
 * path these route to `JSON-RPC` `method` field (per
 * docs/architecture/contracts/api-payload-contracts.md §JSON-RPC Method-Name
 * Registry, Tier 1 Ratified). On the control-plane path the same names
 * route to the per-procedure tRPC URL segment (the control-plane router
 * mounts `session.create` / `session.read` / `session.join` / `session.subscribe`
 * at `${endpoint}/${name}`). Centralizing here so a future name evolution
 * (namespace move, BL-issued rename, or transport divergence) edits one
 * location rather than scattered string literals.
 *
 * If the two transports ever diverge on these names, fork into per-transport
 * tables rather than reusing a name from the other side.
 */
const SESSION_METHOD_CREATE = "session.create";
const SESSION_METHOD_READ = "session.read";
const SESSION_METHOD_JOIN = "session.join";
const SESSION_METHOD_SUBSCRIBE = "session.subscribe";

/**
 * Common consumer-side surface for the four V1 session methods. Both
 * `createDaemonSessionClient` and `createControlPlaneSessionClient` return
 * an object satisfying this interface.
 */
export interface SessionClient {
  create(request: SessionCreateRequest): Promise<SessionCreateResponse>;
  read(request: SessionReadRequest): Promise<SessionReadResponse>;
  join(request: SessionJoinRequest): Promise<SessionJoinResponse>;
  subscribe(options: SessionSubscribeOptions): AsyncIterable<SessionEventEnvelope>;
}

// --------------------------------------------------------------------------
// Daemon transport factory
// --------------------------------------------------------------------------

/**
 * Build a `SessionClient` over a daemon transport. The caller is responsible
 * for wiring the underlying `ClientTransport` (Unix socket, Windows named
 * pipe, in-memory test double) and instantiating the `JsonRpcClient` —
 * including completing the `daemon.hello` handshake before the first
 * mutating call.
 *
 * Daemon-side `$/subscription/notify` frames carry `SessionEvent` directly
 * (no cursor envelope — the wire schema documents this in
 * `runtime-daemon/src/ipc/handlers/session-subscribe.ts`). To unify with the
 * control-plane consumer surface, we synthesize the `eventId` from
 * `event.id` — UUIDs satisfy `EventCursorSchema.min(1).max(256)`, and
 * Plan-006's structured cursor format is not yet on the wire. If/when
 * Plan-006 ratifies a structural `EventCursor` format, the daemon's
 * subscribe wire schema gains a cursor field and this synthesis is
 * removed (Spec-001 contract is shape-stable; the server-side change
 * widens the streaming envelope additively per ADR-018).
 */
export function createDaemonSessionClient(client: JsonRpcClient): SessionClient {
  return {
    create: (request) =>
      client.call(
        SESSION_METHOD_CREATE,
        request,
        SessionCreateRequestSchema,
        SessionCreateResponseSchema,
      ),
    read: (request) =>
      client.call(
        SESSION_METHOD_READ,
        request,
        SessionReadRequestSchema,
        SessionReadResponseSchema,
      ),
    join: (request) =>
      client.call(
        SESSION_METHOD_JOIN,
        request,
        SessionJoinRequestSchema,
        SessionJoinResponseSchema,
      ),
    subscribe: (options) => daemonSubscribe(client, options),
  };
}

/**
 * Daemon-side subscribe — wraps `JsonRpcClient.subscribe` and adapts its
 * `LocalSubscription<SessionEvent>` consumer handle into the unified
 * `AsyncIterable<SessionEventEnvelope>` shape. The async generator owns
 * cursor synthesis from `event.id` and signal-driven cancel (so
 * `for await ... break` releases the daemon's `StreamingPrimitive` entry
 * via `LocalSubscription.cancel()`).
 */
async function* daemonSubscribe(
  client: JsonRpcClient,
  options: SessionSubscribeOptions,
): AsyncIterable<SessionEventEnvelope> {
  // Pre-abort fast-exit: if the caller's signal is ALREADY aborted, do not
  // touch the wire. Returning from an async generator yields zero items, so
  // the caller's `for await` exits immediately. This keeps timeout / circuit-
  // breaker paths from spending a daemon round-trip on a subscription they
  // intend to cancel before any data flows. Must precede `client.subscribe`
  // because that call synchronously sends the `session.subscribe` envelope
  // and reserves a server-side `StreamingPrimitive` entry.
  if (options.signal?.aborted === true) {
    return;
  }

  // Build the wire payload. The daemon's `SessionSubscribeRequestSchema`
  // accepts both `afterCursor` and `lastEventId`; we use `afterCursor`
  // because the daemon transport is a JSON-RPC body (not an HTTP header).
  // Conditional spread keeps `afterCursor` off the envelope under
  // `exactOptionalPropertyTypes: true` when omitted.
  const params = {
    sessionId: options.sessionId,
    ...(options.afterCursor !== undefined ? { afterCursor: options.afterCursor } : {}),
  };

  const subscription = client.subscribe<SessionEvent>(
    SESSION_METHOD_SUBSCRIBE,
    params,
    SessionEventSchema,
  );

  // Wire the caller's AbortSignal through to the subscription's cancel.
  // We use `addEventListener("abort", ...)` rather than checking
  // `signal.aborted` mid-loop because the underlying `LocalSubscription`
  // parks on `next()` between value arrivals — a polling check inside
  // `for await` would only fire AFTER the next value lands. (The
  // pre-aborted case is handled above before `client.subscribe` runs.)
  let abortListener: (() => void) | undefined;
  if (options.signal !== undefined) {
    const sig = options.signal;
    abortListener = (): void => {
      void subscription.cancel().catch(() => undefined);
    };
    sig.addEventListener("abort", abortListener, { once: true });
  }

  try {
    for await (const event of subscription) {
      // Synthesize the cursor from the event's authoritative id. UUIDs
      // satisfy `EventCursorSchema.min(1).max(256)`; we cast through the
      // brand because the bare `event.id: string` does not carry it. This
      // synthesis disappears when Plan-006 widens the daemon's streaming
      // envelope with a structural cursor field.
      yield { eventId: event.id as EventCursor, event };
    }
  } finally {
    if (abortListener !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener("abort", abortListener);
    }
    // `for await ... return` already invoked the iterator's `return()`,
    // which calls `subscription.cancel()`. The post-loop cancel here is
    // idempotent (per `LocalSubscription.cancel()`'s documented contract)
    // and covers the early-throw case.
    await subscription.cancel().catch(() => undefined);
  }
}

// --------------------------------------------------------------------------
// Control-plane transport factory
// --------------------------------------------------------------------------

/**
 * Default tRPC procedure path under the control-plane fetch handler.
 * `buildControlPlaneFetchHandler` (in `@ai-sidekicks/control-plane`)
 * mounts at `/trpc` by default; the consumer can override via the
 * `endpoint` option. Plan-008 Phase 1 ratifies this path
 * (api-payload-contracts.md §HTTP Endpoints).
 */
const DEFAULT_TRPC_ENDPOINT = "/trpc";

/**
 * SSE frame separator — an empty line terminated by either LF or CRLF.
 * WHATWG HTML §9.2.6 (Server-sent events §interpretation) allows lines to
 * end with U+000D U+000A (CRLF), U+000A (LF), or U+000D (CR); a frame
 * boundary is two consecutive line terminators. tRPC v11.17.0's
 * `sseStreamProducer` emits LF-only today, but proxies and Node's HTTP
 * server can re-encode the stream to CRLF in transit, so the consumer must
 * accept both forms (and the mixed case where one terminator is CRLF and
 * the other LF) to remain interoperable. Compiled at module scope so the
 * RegExp is not rebuilt per-frame in the read loop. Lone-CR separators
 * (legal per the spec but not surfaced by tRPC's producer or by the proxies
 * cited in the bug report) are out of scope for this fix; surfaced as a
 * future-work concern in the PR notes rather than silently expanding the
 * scope of this round-trip.
 */
const SSE_FRAME_BOUNDARY = /\r?\n\r?\n/;

/**
 * SSE intra-frame line separator — the same LF / CRLF tolerance as
 * `SSE_FRAME_BOUNDARY`, applied to split a single frame into its `field:`
 * lines. WHATWG HTML §9.2.6 allows the two forms; using a shared regex
 * keeps the frame-boundary tolerance and the line-split tolerance aligned
 * (mismatched tolerance would parse the frame envelope but mis-split lines
 * inside the frame, surfacing as silently-dropped fields).
 */
const SSE_LINE_SEPARATOR = /\r?\n/;

/**
 * Constructor options for the control-plane factory.
 *
 * `fetcher`: an HTTP-like callable. Accepts a standard `Request` and returns
 * a standard `Response`. In production this is `globalThis.fetch.bind(globalThis)`
 * pointed at a deployed control-plane URL; in tests it's the in-process
 * fetch handler returned by `buildControlPlaneFetchHandler` (see
 * `client-sdk/test/transport/sse-roundtrip.test.ts:404` for the pattern).
 *
 * `baseUrl`: the absolute URL prefix (no trailing slash) of the control-plane
 * deployment. The SDK appends `${endpoint}/${method}` to this prefix.
 *
 * `endpoint`: optional tRPC mount path. Defaults to `/trpc` (see
 * `DEFAULT_TRPC_ENDPOINT`). Only override when the deployment mounts the
 * tRPC handler at a non-default path.
 */
export interface ControlPlaneSessionClientOptions {
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly baseUrl: string;
  readonly endpoint?: string;
}

/**
 * Build a `SessionClient` over the control-plane HTTP transport. Uses the
 * raw `fetch` shape (vs. the `@trpc/client` package) because:
 *   1. `@trpc/client` is NOT a declared client-sdk dep (only `@trpc/server`
 *      is, as a devDependency for the control-plane test harness). Adding
 *      `@trpc/client` would expand the SDK's runtime footprint for browsers
 *      / Workers without need.
 *   2. The wire shape — query/mutation via `?input=<encoded JSON>`,
 *      subscription via SSE — is small enough to inline correctly.
 *   3. The existing `sse-roundtrip.test.ts` integration test already pins
 *      the SSE consumer pattern; the production code mirrors that test.
 */
export function createControlPlaneSessionClient(
  opts: ControlPlaneSessionClientOptions,
): SessionClient {
  const endpoint = opts.endpoint ?? DEFAULT_TRPC_ENDPOINT;
  const trpcUrl = (method: string): string => `${opts.baseUrl}${endpoint}/${method}`;

  return {
    create: async (request) => {
      // tRPC v11 mutation wire format with no transformer (the control-plane
      // router uses defaultTransformer — see packages/control-plane/src/
      // sessions/trpc.ts:35-42, no `transformer:` slot in `.create()`):
      // POST body is the raw input JSON. resolveResponse line 92 reads the
      // input via `await req.json()` and applies an identity deserialize
      // (defaultTransformer at tracked-DWInO6EQ.mjs:70-79). Validate AT the
      // SDK boundary (mirrors the daemon path's `JsonRpcClient.call`
      // fail-fast posture per I-007-3).
      const validated = SessionCreateRequestSchema.parse(request);
      const response = await opts.fetcher(
        new Request(trpcUrl(SESSION_METHOD_CREATE), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validated),
        }),
      );
      return parseTrpcResult(response, SessionCreateResponseSchema);
    },
    read: async (request) => {
      // Queries: GET with `?input=<JSON-encoded>`. tRPC v11 reads the query
      // string at resolveResponse line 90-91 (`searchParams.get("input")` →
      // JSON.parse) and applies the identity deserialize. Same precedent as
      // packages/control-plane/src/sessions/__tests__/session-subscribe-sse.
      // test.ts:81-84 (`buildSubscribeRequest` cites tRPC v11
      // contentType.ts:100-106).
      const validated = SessionReadRequestSchema.parse(request);
      const response = await opts.fetcher(
        new Request(
          `${trpcUrl(SESSION_METHOD_READ)}?input=${encodeURIComponent(JSON.stringify(validated))}`,
          { method: "GET" },
        ),
      );
      return parseTrpcResult(response, SessionReadResponseSchema);
    },
    join: async (request) => {
      const validated = SessionJoinRequestSchema.parse(request);
      const response = await opts.fetcher(
        new Request(trpcUrl(SESSION_METHOD_JOIN), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validated),
        }),
      );
      return parseTrpcResult(response, SessionJoinResponseSchema);
    },
    subscribe: (options) => controlPlaneSubscribe(opts.fetcher, trpcUrl, options),
  };
}

/**
 * Parse a tRPC v11 fetch-adapter response envelope. With the control-plane's
 * defaultTransformer (no `transformer:` configured at trpc.ts:35-42), the
 * success shape is `{ result: { data: <output> } }` — confirmed by reading
 * `transformTRPCResponseItem` at @trpc/server v11.17.0
 * `dist/tracked-DWInO6EQ.mjs:80-83` which writes `{ ...item, result: {
 * ...item.result, data: serialize(item.result.data) } }`, where `serialize`
 * is identity for defaultTransformer (`tracked-DWInO6EQ.mjs:70-79`).
 *
 * If a future control-plane router opts in to SuperJSON or another wrapping
 * transformer, the on-wire `data` becomes `{ json: <output> }` and the
 * unwrap below needs the additional hop. We surface that as a typed shape-
 * mismatch error rather than silently passing the wrapper to Zod.
 *
 * We Zod-validate the unwrapped data against the caller-supplied schema
 * (mirrors the daemon path's `resultSchema` discipline — server corruption
 * surfaces as a typed error, NOT silent acceptance).
 */
async function parseTrpcResult<T>(
  response: Response,
  schema: { parse: (input: unknown) => T },
): Promise<T> {
  if (!response.ok) {
    // Surface non-2xx with the response body for diagnostic continuity.
    // Procedure-level errors (TRPCError) come back with their own JSON
    // envelope plus a non-2xx status — we surface the body verbatim so the
    // caller can inspect the server's error message. We do NOT attempt to
    // parse and re-throw a typed `TRPCError` here because `@trpc/client` is
    // not a declared dep; pulling in just for error parsing would invert
    // the cost/benefit of the raw-fetch choice.
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Control-plane request failed: HTTP ${String(response.status)} ${response.statusText}${
        bodyText.length > 0 ? ` — ${bodyText}` : ""
      }`,
    );
  }
  const envelope = (await response.json()) as unknown;
  // Defensive shape extraction. We don't Zod-validate the wrapper because
  // the wrapper shape is owned by tRPC v11 — pinning it here would create
  // a tight coupling with library version. Instead we walk the path and
  // surface a structured error if the shape doesn't match.
  const data = extractTrpcResponseData(envelope);
  return schema.parse(data);
}

/**
 * Walk a tRPC v11 success envelope down to the unwrapped `data` value.
 * Throws a structured error on shape mismatch so a future tRPC envelope
 * change surfaces here rather than passing `undefined` to Zod.
 *
 * Today's control-plane router uses defaultTransformer (identity) — the
 * envelope is `{ result: { data: <output> } }` directly. We do NOT walk
 * a `data.json` hop because no transformer wraps the output. If a future
 * router enables SuperJSON, this function needs widening (and would
 * surface that change here as a Zod-parse failure on `<output>` shape,
 * forcing the visible fix).
 */
function extractTrpcResponseData(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("Control-plane response: top-level value is not an object");
  }
  const result = (envelope as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) {
    throw new Error("Control-plane response: missing 'result' object");
  }
  return (result as { data?: unknown }).data;
}

/**
 * Control-plane subscribe — uses the SSE wire frame ratified by
 * api-payload-contracts.md §SSE Wire Frame (Tier 1 Ratified). Mirrors the
 * `sessionClientSubscribeStub` in `client-sdk/test/transport/
 * sse-roundtrip.test.ts:279-389` — that stub was authored ahead of this
 * production surface specifically to PIN the consumer shape.
 *
 * The `Last-Event-ID` HTTP header drives reconnect-from-cursor; tRPC v11's
 * fetch adapter injects the header value into `input.lastEventId`
 * pre-Zod-validation, and the procedure's resolution
 * `input.lastEventId ?? input.afterCursor` feeds it to the provider.
 * Header-over-body is the SSE standard; this matches EventSource's native
 * resumption semantics.
 */
async function* controlPlaneSubscribe(
  fetcher: (request: Request) => Promise<Response>,
  trpcUrl: (method: string) => string,
  options: SessionSubscribeOptions,
): AsyncIterable<SessionEventEnvelope> {
  const headers = new Headers();
  // The control-plane procedure carries `lastEventId` derived from this
  // header. The client surface unifies under `afterCursor`; we route that
  // single SDK input to the header on this transport.
  if (options.afterCursor !== undefined) {
    headers.set("Last-Event-ID", options.afterCursor);
  }
  // RequestInit.signal is `AbortSignal | null` under
  // exactOptionalPropertyTypes — conditional spread keeps it off the init
  // when the caller didn't supply one.
  const init: RequestInit = {
    method: "GET",
    headers,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const url = `${trpcUrl(SESSION_METHOD_SUBSCRIBE)}?input=${encodeURIComponent(
    JSON.stringify({ sessionId: options.sessionId }),
  )}`;
  const response = await fetcher(new Request(url, init));
  if (response.status !== 200) {
    throw new Error(
      `Control-plane subscribe failed: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }
  if (response.body === null) {
    throw new Error("Control-plane subscribe: response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Match LF (`\n\n`), CRLF (`\r\n\r\n`), or mixed terminators (`\r\n\n`,
      // `\n\r\n`) — see SSE_FRAME_BOUNDARY JSDoc for the WHATWG citation.
      // `exec()` on a non-global regex restarts from index 0 each call, so
      // re-running it after `buffer = buffer.slice(...)` finds the next
      // boundary cleanly without `lastIndex` bookkeeping.
      let match = SSE_FRAME_BOUNDARY.exec(buffer);
      while (match !== null) {
        const frameText = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseSseFrame(frameText);
        match = SSE_FRAME_BOUNDARY.exec(buffer);

        // Sentinel handling — see `sse-roundtrip.test.ts:323-366` for the
        // four named sentinels emitted by tRPC v11.17.0's `sseStreamProducer`
        // (`connected` / `ping` / `return` / `serialized-error`). All four
        // citations point at `unstable-core-do-not-import/stream/sse.ts` so
        // a future tRPC patch that renames a sentinel surfaces as a
        // citation mismatch in the test, not a silent SDK consumption bug.
        if (frame.event === "connected") continue;
        if (frame.event === "ping") continue;
        if (frame.event === "return") continue;
        if (frame.event === "serialized-error") {
          throw new Error(
            `Control-plane subscribe: producer surfaced serialized-error frame: ${
              frame.data ?? "<no data>"
            }`,
          );
        }
        // Defensive: any other named event shouldn't appear at the wire
        // level for tracked envelopes (un-named-event default at
        // sse.ts:138-144).
        if (frame.event !== undefined) {
          throw new Error(`Control-plane subscribe: unexpected SSE event '${frame.event}'`);
        }
        // tRPC tracked envelope: NO `event:` field, with `id:` + `data:`.
        if (frame.id === undefined || frame.data === undefined) {
          throw new Error("Control-plane subscribe: tracked frame missing id or data field");
        }
        const validated = SessionEventSchema.parse(JSON.parse(frame.data));
        yield {
          eventId: frame.id as EventCursor,
          event: validated,
        };
      }
    }
  } finally {
    // Drain the reader on early exit (consumer break, throw, or natural
    // end-of-stream). `cancel()` releases the underlying network resource
    // so the control-plane closes its SSE producer.
    await reader.cancel().catch(() => undefined);
  }
}

interface SseFrame {
  readonly event?: string;
  readonly data?: string;
  readonly id?: string;
}

/**
 * Parse a single SSE frame's text into its named fields. SSE spec § 9.2.6:
 * field name is everything before the first colon; value is everything after,
 * with a single leading space stripped if present. Lines beginning with `:`
 * are comments; empty lines are field separators (handled by the caller's
 * outer split on `\n\n`).
 *
 * Multiple `data:` lines on the same frame are joined with `\n` per the
 * spec (each line appends to the data buffer; the dispatcher strips the
 * trailing `\n` once at frame boundary). tRPC v11.17.0's `sseStreamProducer`
 * emits single-line `JSON.stringify` payloads today, so the join is
 * defense-in-depth against a future producer change (custom transformer,
 * pretty-print) that emits multi-line `data:` values.
 */
function parseSseFrame(frameText: string): SseFrame {
  const fields: { event?: string; data?: string; id?: string } = {};
  // Split on LF or CRLF (SSE_LINE_SEPARATOR) to mirror the frame-boundary
  // tolerance — see the regex's JSDoc for the spec citation. The accumulated
  // multi-line `data:` join below uses literal `\n` per WHATWG §9.2.6 (the
  // spec's data buffer is LF-only regardless of input separator).
  for (const line of frameText.split(SSE_LINE_SEPARATOR)) {
    if (line === "" || line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1).replace(/^ /, "");
    if (key === "event") fields.event = value;
    else if (key === "data")
      fields.data = fields.data === undefined ? value : `${fields.data}\n${value}`;
    else if (key === "id") fields.id = value;
  }
  return fields;
}
