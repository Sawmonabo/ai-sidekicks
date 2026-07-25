// Plan-003 Phase 4 T4.1 + Phase 5 T5.0d: typed `runtimeNodeClient` SDK surface
// — the V1 runtime-node-attach consumer wrapping `JsonRpcClient` (daemon
// transport, Plan-007 Phase 3) and the tRPC v11 control-plane transport
// (Plan-003 Phase 3 `runtimeNodeRouter`, T3.8; Phase 5 roster query, T5.0c)
// under a shared `RuntimeNodeClient` mutation interface. The control-plane
// factory returns the widened `ControlPlaneRuntimeNodeClient`, which adds the
// control-plane-only `roster` query (T5.0d).
//
// Spec coverage:
//   * `Spec-003 §Interfaces And Contracts` — `RuntimeNodeAttach` fields (sessionId, participantId,
//     nodeId, clientVersion, capabilities, healthState). `attach()` below
//     threads `RuntimeNodeAttachRequestSchema` / `RuntimeNodeAttachResponse-
//     Schema`; the server-derived `readOnly` PERMISSION verdict and the
//     `state` LIVENESS axis ride the response through unchanged (the SDK does
//     NOT compute `readOnly`; the Phase-3 attach service does — runtime-node.ts
//     §Design note).
//   * `Spec-003 §Interfaces And Contracts` — `RuntimeNodeHeartbeat` updates presence and health.
//     `heartbeat()` carries the daemon's 2-value `healthState` and unwraps the
//     no-content `z.null()` response (`RuntimeNodeHeartbeatResponseSchema`).
//   * `Spec-003 §Interfaces And Contracts` — `RuntimeNodeCapabilityUpdate` add/remove/health
//     variants. `capabilityUpdate()` threads the FULL-REPLACEMENT `capabilities`
//     map (removals by omission, additions by presence) plus the optional
//     `healthChanges` 2-value-health transition, and unwraps the
//     `{nodeId, state, updatedAt}` content response.
//   * `Spec-003 §Interfaces And Contracts` — `RuntimeNodeDetach` retires a node. `detach()` carries
//     the `nodeId` (+ optional audit `reason`) and unwraps the no-content
//     `z.null()` response (`RuntimeNodeDetachResponseSchema`).
//   * `Spec-003 §Interfaces And Contracts` (incl. the roster-read amendment)
//     — `RuntimeNodeRoster` returns the session's full node roster via the
//     control-plane-only `runtimenode.roster` query. `roster()` below (the
//     control-plane factory ONLY) threads `RuntimeNodeRosterRequestSchema` /
//     `RuntimeNodeRosterResponseSchema`; each entry rides through with BOTH
//     health axes verbatim plus the per-row read-time `readOnly` verdict —
//     the SDK derives no staleness and collapses no axis (the read-side
//     never-mask stance).
//
// Shape choice — TWO factories sharing one mutation interface (mirrors
// `sessionClient.ts`):
//   `createDaemonRuntimeNodeClient(client)` wraps the local daemon JSON-RPC
//   transport; `createControlPlaneRuntimeNodeClient(opts)` wraps the
//   control-plane tRPC HTTP transport. Both satisfy the SAME four-mutation
//   `RuntimeNodeClient`, so callers can swap transports for the mutation
//   surface without restructuring. The four mutations — attach / heartbeat /
//   capabilityupdate / detach — are every one a tRPC `.mutation` (runtime-
//   node-router.factory.ts:181-266) riding a POST JSON body. The
//   control-plane factory ADDITIONALLY exposes the namespace's one query —
//   `roster`, a GET `?input=` (runtime-node-router.factory.ts:268-287) — on
//   its widened `ControlPlaneRuntimeNodeClient` return type; the daemon
//   factory deliberately does not (see that interface's JSDoc for the
//   transport-ownership rationale). Neither factory carries a subscribe (SSE)
//   path, so this surface stays simpler than sessionClient's (which adds an
//   SSE subscribe) even with the query on board.
//
// What this file does NOT do:
//   * Redefine any request/response schema. Every schema is imported from
//     `@ai-sidekicks/contracts` (runtime-node.ts) — the wire contract is
//     single-sourced there.
//   * Compute `readOnly`. The PERMISSION verdict is server-derived — at attach
//     time by the Phase-3 attach service (comparing `clientVersion` against
//     the session `min_client_version` floor) and per roster row at read time
//     by `readRoster` (identical comparator semantics); the SDK passes both
//     through.
//   * Implement byte-level framing or HTTP transport. The daemon factory
//     consumes a fully-constructed `JsonRpcClient`; the control-plane factory
//     consumes a `fetcher` callable (caller supplies `globalThis.fetch` or an
//     in-process test handler).

import type {
  RuntimeNodeAttachRequest,
  RuntimeNodeAttachResponse,
  RuntimeNodeCapabilityUpdateRequest,
  RuntimeNodeCapabilityUpdateResponse,
  RuntimeNodeDetachRequest,
  RuntimeNodeHeartbeatRequest,
  RuntimeNodeRosterRequest,
  RuntimeNodeRosterResponse,
} from "@ai-sidekicks/contracts";
import {
  RuntimeNodeAttachRequestSchema,
  RuntimeNodeAttachResponseSchema,
  RuntimeNodeCapabilityUpdateRequestSchema,
  RuntimeNodeCapabilityUpdateResponseSchema,
  RuntimeNodeDetachRequestSchema,
  RuntimeNodeDetachResponseSchema,
  RuntimeNodeHeartbeatRequestSchema,
  RuntimeNodeHeartbeatResponseSchema,
  RuntimeNodeRosterRequestSchema,
  RuntimeNodeRosterResponseSchema,
} from "@ai-sidekicks/contracts";

import type { JsonRpcClient } from "./transport/jsonRpcClient.js";

// --------------------------------------------------------------------------
// Method names
// --------------------------------------------------------------------------

/**
 * Canonical runtime-node operation names. The four MUTATION names are shared
 * by both transports: on the daemon path they route to the JSON-RPC `method`
 * field; on the control-plane path the SAME strings route to the
 * per-procedure tRPC URL segment (`${endpoint}/${name}`), exactly as
 * `sessionClient.ts`'s `SESSION_METHOD_*` consts serve both factories. The
 * ROSTER name routes on the control-plane tRPC transport ONLY — the daemon
 * registers no `runtimenode.roster` JSON-RPC method (the registry pins the
 * roster row "control-plane tRPC ONLY" — api-payload-contracts.md
 * §Runtime-Node Method-Name Registry; see `ControlPlaneRuntimeNodeClient`).
 *
 * LOWERCASE one-word operation segments (`capabilityupdate`, NOT
 * `capabilityUpdate`) — these match the `runtimenode.*` procedure namespace the
 * control-plane router mounts (`runtime-node-router.factory.ts:180` —
 * `t.router({ runtimenode: t.router({ attach, heartbeat, capabilityupdate,
 * detach, roster }) })`) and the canonical error codes
 * `runtimenode.attach_conflict` / `runtimenode.capabilityupdate_conflict`
 * (`@ai-sidekicks/contracts` error.ts:111-127). These are wire strings authored
 * locally (NOT imported symbols); centralizing them here so a future name
 * evolution edits one location.
 */
const RUNTIME_NODE_METHOD_ATTACH = "runtimenode.attach";
const RUNTIME_NODE_METHOD_HEARTBEAT = "runtimenode.heartbeat";
const RUNTIME_NODE_METHOD_CAPABILITY_UPDATE = "runtimenode.capabilityupdate";
const RUNTIME_NODE_METHOD_DETACH = "runtimenode.detach";
const RUNTIME_NODE_METHOD_ROSTER = "runtimenode.roster";

// --------------------------------------------------------------------------
// Common consumer surface
// --------------------------------------------------------------------------

/**
 * Common consumer-side surface for the four DUAL-TRANSPORT runtime-node
 * mutations. Both `createDaemonRuntimeNodeClient` and
 * `createControlPlaneRuntimeNodeClient` return an object satisfying this
 * interface; the control-plane factory's declared return type is the widened
 * `ControlPlaneRuntimeNodeClient`, which adds the control-plane-only `roster`
 * query. `roster` is deliberately NOT a member here: this shared interface
 * must stay implementable by the daemon factory, and no daemon roster
 * handler exists (see `ControlPlaneRuntimeNodeClient` for the ownership
 * rationale).
 *
 * `heartbeat` and `detach` resolve `null` on success — their wire responses are
 * the no-content `z.null()` schemas (`RuntimeNodeHeartbeatResponseSchema` /
 * `RuntimeNodeDetachResponseSchema` in runtime-node.ts). The `null` is a
 * genuine success value, NOT a not-found sentinel: a below-floor or otherwise
 * refused write REJECTS with `RuntimeNodeControlPlaneError` (control-plane) or
 * `JsonRpcRemoteError` (daemon), never a `null` result.
 */
export interface RuntimeNodeClient {
  attach(request: RuntimeNodeAttachRequest): Promise<RuntimeNodeAttachResponse>;
  heartbeat(request: RuntimeNodeHeartbeatRequest): Promise<null>;
  capabilityUpdate(
    request: RuntimeNodeCapabilityUpdateRequest,
  ): Promise<RuntimeNodeCapabilityUpdateResponse>;
  detach(request: RuntimeNodeDetachRequest): Promise<null>;
}

// --------------------------------------------------------------------------
// Daemon transport factory
// --------------------------------------------------------------------------

/**
 * Build a `RuntimeNodeClient` over a daemon transport. The caller is
 * responsible for wiring the underlying `ClientTransport` (Unix socket, Windows
 * named pipe, in-memory test double) and instantiating the `JsonRpcClient` —
 * including completing the `daemon.hello` handshake before the first mutating
 * call (exactly as `createDaemonSessionClient` does).
 *
 * Each method threads its request schema + response schema through
 * `client.call(method, request, RequestSchema, ResponseSchema)`, which owns the
 * bidirectional Zod fail-fast (request validated before the wire write; response
 * validated before resolve). `JsonRpcClient.call<P, R>` REQUIRES a result schema
 * (there is no void overload — jsonRpcClient.ts:515-522), so the no-content
 * `heartbeat` / `detach` pass their `z.null()` response schemas
 * (`RuntimeNodeHeartbeatResponseSchema` / `RuntimeNodeDetachResponseSchema`),
 * while `attach` / `capabilityUpdate` pass their content response schemas. A
 * wire-level daemon error surfaces as `JsonRpcRemoteError` (jsonRpcClient.ts:96)
 * — the daemon path does NOT carry the control-plane's typed-aisError parsing
 * (that envelope is HTTP/tRPC-specific; the daemon transport has its own typed
 * error surface).
 *
 * This factory carries the four shared mutations ONLY — `roster` never rides
 * the daemon transport (see `ControlPlaneRuntimeNodeClient`).
 */
export function createDaemonRuntimeNodeClient(client: JsonRpcClient): RuntimeNodeClient {
  return {
    attach: (request) =>
      client.call(
        RUNTIME_NODE_METHOD_ATTACH,
        request,
        RuntimeNodeAttachRequestSchema,
        RuntimeNodeAttachResponseSchema,
      ),
    heartbeat: (request) =>
      client.call(
        RUNTIME_NODE_METHOD_HEARTBEAT,
        request,
        RuntimeNodeHeartbeatRequestSchema,
        RuntimeNodeHeartbeatResponseSchema,
      ),
    capabilityUpdate: (request) =>
      client.call(
        RUNTIME_NODE_METHOD_CAPABILITY_UPDATE,
        request,
        RuntimeNodeCapabilityUpdateRequestSchema,
        RuntimeNodeCapabilityUpdateResponseSchema,
      ),
    detach: (request) =>
      client.call(
        RUNTIME_NODE_METHOD_DETACH,
        request,
        RuntimeNodeDetachRequestSchema,
        RuntimeNodeDetachResponseSchema,
      ),
  };
}

// --------------------------------------------------------------------------
// Control-plane transport factory
// --------------------------------------------------------------------------

/**
 * Default tRPC procedure path under the control-plane fetch handler — mirrors
 * `sessionClient.ts`'s `DEFAULT_TRPC_ENDPOINT`. `buildControlPlaneFetchHandler`
 * mounts at `/trpc` by default; the consumer can override via the `endpoint`
 * option.
 */
const DEFAULT_TRPC_ENDPOINT = "/trpc";

/**
 * Constructor options for the control-plane factory. An EXACT structural mirror
 * of `ControlPlaneSessionClientOptions` (`sessionClient.ts`) so the two
 * control-plane factories stay options-shape-aligned.
 *
 * `fetcher`: an HTTP-like callable. Accepts a standard `Request` and returns a
 * standard `Response`. In production this is `globalThis.fetch.bind(globalThis)`
 * pointed at a deployed control-plane URL; in tests it's the in-process fetch
 * handler returned by `buildControlPlaneFetchHandler`.
 *
 * `baseUrl`: the absolute URL prefix (no trailing slash) of the control-plane
 * deployment. The SDK appends `${endpoint}/${method}` to this prefix.
 *
 * `endpoint`: optional tRPC mount path. Defaults to `/trpc` (see
 * `DEFAULT_TRPC_ENDPOINT`). Only override when the deployment mounts the tRPC
 * handler at a non-default path.
 */
export interface ControlPlaneRuntimeNodeClientOptions {
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly baseUrl: string;
  readonly endpoint?: string;
}

/**
 * Control-plane consumer surface: the four shared `RuntimeNodeClient`
 * mutations PLUS the control-plane-only `roster` query.
 * `createControlPlaneRuntimeNodeClient` returns this widened interface;
 * `createDaemonRuntimeNodeClient` returns the base `RuntimeNodeClient`.
 *
 * WHY the daemon factory has no `roster`: the roster is control-plane-owned
 * cross-node coordination state — a daemon knows only itself — so the read is
 * registered "control-plane tRPC ONLY" (api-payload-contracts.md
 * §Runtime-Node Method-Name Registry roster row; Spec-003 §Interfaces And
 * Contracts, 2026-06-09 amendment), and no daemon JSON-RPC handler exists for
 * it (`packages/runtime-daemon/src/ipc/handlers/` registers `session.*` /
 * `presence.*` handlers only). Widening the SHARED `RuntimeNodeClient`
 * instead would force the daemon factory to carry an unimplementable method —
 * a throw-only stub lying about its transport reach — so the query lives on
 * this NAMED extension, keeping the shared contract honest and giving
 * control-plane consumers a stable type to hold.
 *
 * `roster` resolves the faithful both-axes projection (`Spec-003 §Interfaces And Contracts`):
 * every `runtime_node_attachments` row for the session — slot `state`
 * verbatim, nullable liveness `healthState` / `lastHeartbeatAt` (NULL until
 * the node's first heartbeat lands), and the per-row read-time `readOnly`
 * verdict. The SDK derives nothing; reconciling the two axes is the caller's
 * render-time concern.
 */
export interface ControlPlaneRuntimeNodeClient extends RuntimeNodeClient {
  roster(request: RuntimeNodeRosterRequest): Promise<RuntimeNodeRosterResponse>;
}

/**
 * Thrown by the `ControlPlaneRuntimeNodeClient` when a runtime-node procedure
 * returns a non-2xx tRPC response carrying a typed `aisError` envelope. The
 * control-plane router maps every typed runtime-node refusal to HTTP 409 / tRPC
 * `CONFLICT` and the shared `errorFormatter` projects the typed exception's
 * `.code` onto `shape.data.aisError` (`sessions/trpc.ts:81-99` — the
 * `AisWireException` base `instanceof`). This class surfaces that wire `code` so
 * the consumer can branch on it.
 *
 * Code-AGNOSTIC by design — it carries WHATEVER `aisError.code` string the wire
 * delivered, NOT a hardcoded constant. The four runtime-node refusals all
 * surface through this one class:
 *   * `version.floor_exceeded` — a below-floor read-only node's capability
 *     WRITE refusal (the typed `VERSION_FLOOR_EXCEEDED`, I-003-1 / ADR-018
 *     §Decision #4 / `Spec-003 §Acceptance Criteria` (AC4)). A consumer (e.g. Plan-003 T4.4) asserts
 *     this branch via `error.code === VERSION_FLOOR_EXCEEDED_CODE` (imported
 *     from `@ai-sidekicks/contracts`) — this SDK deliberately does NOT import or
 *     hardcode that constant, so the surface stays decoupled from any single
 *     code.
 *   * `runtimenode.attach_conflict` / `runtimenode.attach_revoked` — the two
 *     attach refusals.
 *   * `runtimenode.capabilityupdate_conflict` — the capability-update refusal.
 *
 * The `roster` query contributes NO typed refusal to that set (its server arm
 * has no catch — runtime-node-router.factory.ts:268-287): a non-2xx roster
 * response surfaces through this same class via the fallback tRPC-code branch
 * in `buildControlPlaneError` (e.g. `INTERNAL_SERVER_ERROR` when a corrupted
 * stored row fails the server's read-boundary parse), so the consumer still
 * sees one error class across all five methods.
 *
 * Modeled on the daemon path's `JsonRpcRemoteError` (jsonRpcClient.ts:96) —
 * `code` (here a STRING, the dotted wire code) + `message` + the originating
 * `httpStatus` — so the two transports surface comparably-shaped typed errors.
 * The wire `message` is read defensively as a string; we do NOT Zod-validate the
 * `aisError` payload against `VersionFloorExceededErrorSchema` because that
 * schema is the TWO-sided HTTP `ErrorResponse` shape (`acceptedRange.{min,max}`)
 * — the runtime-node write-refusal surface is code+message-only (the one-sided
 * session floor cannot populate it; error-contracts.md §Version surface (3)),
 * so validating against the two-sided schema would reject the very payload we
 * are parsing.
 */
export class RuntimeNodeControlPlaneError extends Error {
  /** The typed `aisError.code` wire string (e.g. `version.floor_exceeded`). */
  public readonly code: string;
  /** The originating HTTP status (409 for the typed runtime-node refusals). */
  public readonly httpStatus: number;

  public constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "RuntimeNodeControlPlaneError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Build a `ControlPlaneRuntimeNodeClient` over the control-plane HTTP
 * transport. Uses the raw `fetch` shape (vs. the `@trpc/client` package) for
 * the same reasons `createControlPlaneSessionClient` does: `@trpc/client` is
 * not a declared client-sdk dep, and the five-procedure wire surface — four
 * mutations (POST JSON body) plus one query (GET `?input=`) — is small enough
 * to inline correctly.
 *
 * The four mutations POST the raw input JSON as the body (no transformer; the
 * control-plane router uses `defaultTransformer` — sessions/trpc.ts).
 * `roster` — the namespace's one query — is a GET with
 * `?input=<encodeURIComponent(JSON.stringify(validated))>`, the same tRPC v11
 * query wire format `sessionClient.ts`'s `session.read` ships (tRPC reads the
 * query string via `searchParams.get("input")` → JSON.parse). There is still
 * NO subscribe (SSE) path here.
 *
 * Each method validates its request at the SDK boundary (mirrors the daemon
 * path's `JsonRpcClient.call` fail-fast posture) BEFORE any wire touch, then
 * unwraps + Zod-validates the response via `parseRuntimeNodeResult`. The
 * no-content `heartbeat` / `detach` unwrap to `null` (validated against their
 * `z.null()` schemas); `attach` / `capabilityUpdate` / `roster` unwrap to
 * their content responses. A non-2xx response REJECTS with
 * `RuntimeNodeControlPlaneError` on every method: the four mutations carry
 * the typed `aisError.code` refusals; the roster query has no typed refusal
 * family, so its failures ride the same class's fallback tRPC-code branch
 * (see the class JSDoc).
 */
export function createControlPlaneRuntimeNodeClient(
  opts: ControlPlaneRuntimeNodeClientOptions,
): ControlPlaneRuntimeNodeClient {
  const endpoint = opts.endpoint ?? DEFAULT_TRPC_ENDPOINT;
  const trpcUrl = (method: string): string => `${opts.baseUrl}${endpoint}/${method}`;

  const postMutation = (method: string, body: unknown): Promise<Response> =>
    opts.fetcher(
      new Request(trpcUrl(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  // tRPC v11 query wire format with no transformer: GET with the validated
  // input JSON-encoded into the `?input=` query string — the shipped in-repo
  // query idiom (`sessionClient.ts` `session.read`).
  const getQuery = (method: string, input: unknown): Promise<Response> =>
    opts.fetcher(
      new Request(`${trpcUrl(method)}?input=${encodeURIComponent(JSON.stringify(input))}`, {
        method: "GET",
      }),
    );

  return {
    attach: async (request) => {
      // tRPC v11 mutation wire format with no transformer (the control-plane
      // router uses defaultTransformer): POST body is the raw input JSON.
      // Validate AT the SDK boundary (mirrors the daemon path's
      // `JsonRpcClient.call` fail-fast posture).
      const validated = RuntimeNodeAttachRequestSchema.parse(request);
      const response = await postMutation(RUNTIME_NODE_METHOD_ATTACH, validated);
      return parseRuntimeNodeResult(response, RuntimeNodeAttachResponseSchema);
    },
    heartbeat: async (request) => {
      const validated = RuntimeNodeHeartbeatRequestSchema.parse(request);
      const response = await postMutation(RUNTIME_NODE_METHOD_HEARTBEAT, validated);
      // No-content success unwraps to `null` (validated against `z.null()`).
      return parseRuntimeNodeResult(response, RuntimeNodeHeartbeatResponseSchema);
    },
    capabilityUpdate: async (request) => {
      const validated = RuntimeNodeCapabilityUpdateRequestSchema.parse(request);
      const response = await postMutation(RUNTIME_NODE_METHOD_CAPABILITY_UPDATE, validated);
      return parseRuntimeNodeResult(response, RuntimeNodeCapabilityUpdateResponseSchema);
    },
    detach: async (request) => {
      const validated = RuntimeNodeDetachRequestSchema.parse(request);
      const response = await postMutation(RUNTIME_NODE_METHOD_DETACH, validated);
      // No-content success unwraps to `null` (validated against `z.null()`).
      return parseRuntimeNodeResult(response, RuntimeNodeDetachResponseSchema);
    },
    roster: async (request) => {
      // Validate BEFORE building the URL — the same SDK-boundary fail-fast
      // the four mutations apply before their POST bodies; a malformed
      // request never reaches the wire.
      const validated = RuntimeNodeRosterRequestSchema.parse(request);
      const response = await getQuery(RUNTIME_NODE_METHOD_ROSTER, validated);
      return parseRuntimeNodeResult(response, RuntimeNodeRosterResponseSchema);
    },
  };
}

/**
 * Parse a tRPC v11 fetch-adapter response for a runtime-node procedure — the
 * four mutations and the `roster` query alike (tRPC's success envelope is
 * identical for both procedure types). On a non-2xx response, surface the
 * typed `aisError` envelope as a `RuntimeNodeControlPlaneError` (see below);
 * on a 2xx, walk the success envelope to the unwrapped `data` and
 * Zod-validate it against the caller's schema.
 *
 * Local to this file rather than shared with `sessionClient.ts`'s
 * `parseTrpcResult`: the success-envelope walk is identical (~8 lines), but the
 * ERROR paths diverge fundamentally — `sessionClient.parseTrpcResult` throws a
 * generic `Error` with the body text on any non-2xx, whereas the runtime-node
 * surface MUST parse the typed `aisError` code and surface it as a typed error
 * (so a consumer can branch on `version.floor_exceeded`). Sharing the success
 * walk while diverging the error walk would couple two surfaces with different
 * error contracts; the divergent error paths make "keep local" the right call.
 */
async function parseRuntimeNodeResult<T>(
  response: Response,
  schema: { parse: (input: unknown) => T },
): Promise<T> {
  if (!response.ok) {
    throw await buildControlPlaneError(response);
  }
  const envelope = (await response.json()) as unknown;
  // Defensive shape extraction — we don't Zod-validate the tRPC wrapper (its
  // shape is owned by tRPC v11; pinning it here would tightly couple to the
  // library version). Walk the path and surface a structured error on mismatch.
  const data = extractTrpcResponseData(envelope);
  return schema.parse(data);
}

/**
 * Build the typed error for a non-2xx control-plane runtime-node response.
 *
 * The tRPC v11 HTTP error envelope (no transformer, no batching) is
 * `{ error: { message, code, data: { code, httpStatus, path,
 * ...errorFormatter additions } } }`; the shared `errorFormatter` appends the
 * typed exception's projection at `error.data.aisError = { code, message }`
 * (host-runtime-node.test.ts:267-281 pins this path empirically). When that
 * `aisError` envelope is present we surface its `code` + `message` as a
 * `RuntimeNodeControlPlaneError`.
 *
 * NOT every non-2xx carries an `aisError`: the attach self-check throws a plain
 * `TRPCError({ code: "UNAUTHORIZED" })` with NO `aisError` envelope
 * (runtime-node-router.factory.ts:194-198), and the roster query throws
 * nothing typed at all — a corrupted stored row failing its read-boundary
 * parse surfaces as a bare `INTERNAL_SERVER_ERROR`. For those (and any other
 * untyped non-2xx) we fall back to the tRPC envelope's own `error.message` /
 * top-level `error.data.code`, still surfaced as a
 * `RuntimeNodeControlPlaneError` so the caller sees ONE typed error class
 * across both the typed-refusal and the untyped-failure cases (the `code` is
 * the tRPC `error.code` string, e.g. `UNAUTHORIZED`, when no `aisError` is
 * present). The originating HTTP status rides `httpStatus` either way.
 *
 * `code` / `message` are read DEFENSIVELY as strings — we do NOT Zod-validate
 * the `aisError` payload against `VersionFloorExceededErrorSchema` (the
 * two-sided HTTP `ErrorResponse` shape), because the runtime-node write-refusal
 * surface is code+message-only and that schema would reject it (see
 * `RuntimeNodeControlPlaneError` JSDoc + error-contracts.md §Version).
 */
async function buildControlPlaneError(response: Response): Promise<RuntimeNodeControlPlaneError> {
  const httpStatus = response.status;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Body was not JSON (proxy error page, truncated stream, etc.). Surface the
    // status + statusText so the failure mode is still legible.
    return new RuntimeNodeControlPlaneError(
      "control_plane.non_json_error",
      `Control-plane runtime-node request failed: HTTP ${String(httpStatus)} ${response.statusText}`,
      httpStatus,
    );
  }
  // Walk the envelope with inline named-property cast types (mirrors
  // `sessionClient.ts`'s `extractTrpcResponseData`) rather than an index-
  // signature `Record` — named properties sidestep
  // `noPropertyAccessFromIndexSignature` (tsconfig.base.json) and keep the walk
  // legible.
  const error = isObject(body) ? (body as { error?: unknown }).error : undefined;
  const data = isObject(error) ? (error as { data?: unknown }).data : undefined;

  // Preferred: the typed `aisError` envelope projected by the shared
  // errorFormatter (present for every `AisWireException` refusal — the four
  // runtime-node typed refusals).
  const aisError = isObject(data) ? (data as { aisError?: unknown }).aisError : undefined;
  if (isObject(aisError)) {
    const typed = aisError as { code?: unknown; message?: unknown };
    if (typeof typed.code === "string") {
      const message = typeof typed.message === "string" ? typed.message : "";
      return new RuntimeNodeControlPlaneError(typed.code, message, httpStatus);
    }
  }

  // Fallback: an untyped tRPC error (e.g. the attach self-check's
  // `UNAUTHORIZED`, which carries NO `aisError`). Use the tRPC envelope's own
  // `error.data.code` (string code like `UNAUTHORIZED`) + `error.message`.
  const dataCode = isObject(data) ? (data as { code?: unknown }).code : undefined;
  const fallbackCode = typeof dataCode === "string" ? dataCode : "control_plane.error";
  const errorMessage = isObject(error) ? (error as { message?: unknown }).message : undefined;
  const fallbackMessage =
    typeof errorMessage === "string"
      ? errorMessage
      : `Control-plane runtime-node request failed: HTTP ${String(httpStatus)} ${response.statusText}`;
  return new RuntimeNodeControlPlaneError(fallbackCode, fallbackMessage, httpStatus);
}

/**
 * Walk a tRPC v11 success envelope down to the unwrapped `data` value. Throws a
 * structured error on shape mismatch so a future tRPC envelope change surfaces
 * here rather than passing `undefined` to Zod.
 *
 * Today's control-plane router uses defaultTransformer (identity) — the envelope
 * is `{ result: { data: <output> } }` directly (no `data.json` hop). For the
 * no-content `heartbeat` / `detach` mutations the unwrapped `data` is literally
 * `null` (the resolver returns `null`, serialized as `{ result: { data: null } }`
 * — host-runtime-node.test.ts:316-321), which `RuntimeNodeHeartbeatResponse-
 * Schema` / `RuntimeNodeDetachResponseSchema` (`z.null()`) accept. `result` is
 * the object `{ data: null }`, so the `isObject(result)` guard below passes and
 * `result.data` correctly reads back `null`.
 *
 * Mirrors `sessionClient.ts`'s `extractTrpcResponseData` — kept local rather
 * than shared because the surrounding error contracts diverge (see
 * `parseRuntimeNodeResult` JSDoc).
 */
function extractTrpcResponseData(envelope: unknown): unknown {
  if (!isObject(envelope)) {
    throw new Error("Control-plane runtime-node response: top-level value is not an object");
  }
  const result = (envelope as { result?: unknown }).result;
  if (!isObject(result)) {
    throw new Error("Control-plane runtime-node response: missing 'result' object");
  }
  return (result as { data?: unknown }).data;
}

/**
 * Narrow an `unknown` to a non-null object. Centralizes the
 * `typeof === "object" && !== null` guard the envelope walkers share so the
 * non-null narrowing is single-sourced (a bare `typeof x === "object"` admits
 * `null`). Narrows to `object` (NOT `Record<string, unknown>`) so callers must
 * reach individual fields via inline named-property casts — that sidesteps
 * `noPropertyAccessFromIndexSignature` and mirrors `sessionClient.ts`'s
 * envelope-walk idiom.
 */
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
