# Spec-007: Local IPC And Daemon Control

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `007` |
| **Slug** | `local-ipc-and-daemon-control` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md), [Runtime Node Model](../domain/runtime-node-model.md) |
| **Implementation Plan** | [Plan-007: Local IPC And Daemon Control](../plans/007-local-ipc-and-daemon-control.md) |

> **Amendment + restoration (2026-09-01, the request-id bound and the authenticated principal on the handler context — the substrate half of [cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-98; the header flips to `review` under the audit runbook's spec-amendment rule and is restored `approved` by the paired [Plan-007](../plans/007-local-ipc-and-daemon-control.md) targeted readiness-audit delta riding this same diff.)** Two legs, both surfaced by the [Plan-013](../plans/013-live-timeline-visibility-and-reasoning-surfaces.md) Phase-1 review while it was making every timeline reply frame-safe, and both belonging here rather than there because the substrate is what enforces them. **(1) The request `id` is bounded.** §Wire Format has capped the message body since this spec was written and said nothing about the one member of a response the CALLER chooses. Because the id is echoed verbatim, an id that fits an inbound frame can make every reply to it un-encodable — and an oversized reply is the one failure the substrate cannot report, since the reply that failed to encode is the very thing that would have carried the error, so the connection closes instead. A caller could therefore drop its own session with a request the substrate accepted, and no response contract anywhere in this corpus could prevent it. The bound is stated where the value arrives, and [Plan-007](../plans/007-local-ipc-and-daemon-control.md)'s new I-007-22 carries the guarantee it buys — a refusal that never echoes an unbounded id, on either of the two gate orders that can produce one. **(2) A handler is given the caller's identity.** §Required Behavior has always implied authorization — this spec's own §Pitfalls forbids "renderer code direct untyped native execution access" and [api-payload-contracts.md §Authenticated Principal And Authorization Model](../architecture/contracts/api-payload-contracts.md#authenticated-principal-and-authorization-model) already fixes **how** a local-socket caller's principal is resolved (the daemon's node-owner participant identity, daemon-resolved, never read from a body field, failing closed while the identity provider is unwired). What no document said is **who puts it in a handler's hands**: the per-dispatch context carries a transport id and nothing else, so a policy-aware handler had no principal to evaluate and every plan needing one would have had to resolve it independently — five resolutions of one rule, differing in their failure modes. The resolution is stated once, in the substrate that already holds the transport. Neither leg mints a wire method, an event type, an error code, a table, or a column: the id refusal reuses the registered `-32600` invalid-request path, and the principal never appears on the wire at all.

## Purpose

Define the typed local control surface used by the Desktop Shell and CLI to communicate with the local daemon. Renderer-originated traffic reaches the daemon through the Desktop Shell via the preload bridge per [Spec-023 §Trust Stance](./023-desktop-shell-and-renderer.md#trust-stance) — the renderer is not a direct daemon client.

## Scope

This spec covers transport choice, version negotiation, request and stream semantics, and daemon supervision controls.

## Non-Goals

- Remote relay transport
- Provider-driver internal protocols
- UI rendering behavior

## Domain Dependencies

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)

## Required Behavior

- The Desktop Shell and CLI must use one shared typed client SDK. Renderer-originated traffic is brokered by the Shell via the preload bridge per [Spec-023 §Trust Stance](./023-desktop-shell-and-renderer.md#trust-stance) and reaches the daemon as Shell-originated JSON-RPC traffic.
- The CLI must be treated as a first-class local client and the first delivery track for the typed daemon contract.
- The local daemon must expose a typed request-response and subscription contract for session, run, repo, artifact, settings, and daemon lifecycle operations.
- The default local IPC transport must be OS-local:
  - Unix domain socket on Unix-like platforms
  - named pipe on Windows
- The system may expose a loopback fallback transport only when OS-local transport is unavailable or a non-desktop client requires it.
- Local IPC must support protocol version negotiation before mutating operations are accepted.
- The desktop shell must be able to start, stop, supervise, and reconnect to the daemon.
- The daemon must resolve the calling principal from the transport and make it available to every handler it dispatches, so a handler that authorizes reads or writes evaluates one daemon-resolved identity rather than resolving its own. Resolution follows [api-payload-contracts.md §Authenticated Principal And Authorization Model](../architecture/contracts/api-payload-contracts.md#authenticated-principal-and-authorization-model) unchanged — on this local socket the principal is the daemon's node-owner participant identity, never read from a request body field — and it fails **closed**: while the identity provider is unwired the principal is absent, and a handler that requires one refuses rather than proceeding unauthenticated. The identity is a dispatch-context fact and never a wire field, so no request schema gains a principal member and a caller-supplied one stays refused rather than trusted.

## Wire Format

- The wire format is JSON-RPC 2.0 with LSP-style Content-Length framing (not newline-delimited). Each message is preceded by `Content-Length: <byte-count>\r\n\r\n`.
- Maximum message size: 1 MB.
- Maximum request `id` size: 256 bytes once JSON-encoded. The `id` is opaque to the substrate and echoed verbatim, which makes it the one member of a response the caller sizes; an id past the bound is refused as `-32600 Invalid Request` **before dispatch**, and the refusal — like every error frame for an envelope whose id could not be recovered — carries `id: null` rather than echoing the offending value, per JSON-RPC 2.0 §5. Refusing the request is the only place the rule can be enforced: an oversized **response** cannot carry its own error, so the alternative is a closed connection on a request the daemon accepted.
- Every request (except health checks) must include a `protocolVersion` field carrying an ISO 8601 date-string in `YYYY-MM-DD` form (per §Tier 1 (cont.): Plan-007 ratification in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md)).
- Serialization: JSON via `JSON.stringify`/`JSON.parse`. No binary serialization.
- The client SDK in `packages/client-sdk/` wraps JSON-RPC in a thin typed Zod layer (~500-1000 LOC), following the MCP TypeScript SDK pattern.

## Default Behavior

- Desktop app default is auto-connect to the local daemon through OS-local IPC.
- If the daemon is not running, the desktop shell may auto-start it before the renderer gives up.
- CLI default is connect to the same typed local daemon contract rather than reimplement daemon logic inline.
- The first implementation release of the local control surface is CLI-first, with the Desktop Shell consuming the same stabilized contract afterward. The renderer consumes the preload bridge API per [Spec-023 §Trust Stance](./023-desktop-shell-and-renderer.md#trust-stance), not this daemon contract directly.

## Fallback Behavior

- If OS-local transport is unavailable, the client SDK may fall back to loopback transport with explicit authentication and version checks.
- If version negotiation fails, read-only compatibility may continue, but mutating operations must be blocked until versions are compatible.
- If the daemon cannot be started automatically, the client must return actionable status instead of hanging.

## Interfaces And Contracts

- `DaemonHello` and `DaemonHelloAck` must perform version negotiation.
- `DaemonStatusRead`, `DaemonStop`, and `DaemonRestart` must exist as IPC methods for supervised environments. Daemon **start** is a supervisor capability realized by **process spawn** — the `sidekicks daemon start` CLI command (and the desktop shell's auto-start per § Default Behavior and § Example Flows) launches the daemon process and awaits `DaemonHelloAck` — NOT a JSON-RPC method on the daemon: a stopped daemon has no IPC server to receive a `daemon.start` call. See [Plan-007 Phase R1/R3](../plans/007-local-ipc-and-daemon-control.md) (`daemon.stop` / `daemon.restart` are R1 IPC handlers; `daemon start` is the R3 CLI process-spawn path, T-007r-3-4).
- `LocalSubscriptionConsumer<T>` must support replay-capable event streams where appropriate.
- The typed client SDK must expose the same semantic surface to Desktop Shell and CLI callers. The renderer consumes a narrower preload bridge API per [Spec-023 §Trust Stance](./023-desktop-shell-and-renderer.md#trust-stance), not this SDK directly.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

> **Clarifying amendment (approved spec, 2026-05-28, PR #124).** The prior wording listed `DaemonStart` alongside the IPC methods, which a conformance reader could mis-read as mandating a `daemon.start` JSON-RPC handler. Daemon start is a process-spawn capability (CLI / desktop shell), not an IPC method — clarified above to match § Default Behavior and § Example Flows (both already model start as the shell launching the daemon). No capability change; this records a defect-fix to an approved spec, not a routine editorial change.

## State And Data Implications

- Client cache must not become the daemon's state store.
- Daemon supervision state may be shell-local, but daemon runtime truth remains in daemon-owned persistence and projections.
- Version compatibility decisions must be visible to clients and logs.

## Example Flows

- `Example: The desktop renderer starts while the daemon is not running. The shell launches the daemon, negotiates protocol version via the typed client SDK, and then exposes renderer-accessible capabilities via the preload bridge per Spec-023 §Trust Stance; the renderer is not a direct daemon client.`
- `Example: The CLI requests a run-state subscription through the same client SDK and receives canonical updates without duplicating daemon logic.`

## Implementation Notes

- Keep IPC semantics typed and narrow. Avoid renderer-driven arbitrary shell escape hatches.
- Local IPC choice is a security boundary, not merely a performance choice.
- Loopback fallback must be visibly second-class compared with OS-local transport.
- Treat the CLI as the contract proving ground for daemon control behavior, not as a disposable wrapper around desktop-only logic.

## Pitfalls To Avoid

- Giving renderer code direct untyped native execution access
- Allowing silent version skew for mutating operations
- Reimplementing daemon state transitions in the CLI

## Acceptance Criteria

- [ ] Desktop Shell and CLI share one typed daemon client surface; the renderer consumes the preload bridge API per `Spec-023 §Trust Stance`, not this daemon contract directly.
- [ ] The daemon can be started, pinged, and subscribed to through local IPC.
- [ ] Version mismatch blocks unsafe mutation while keeping status visibility available.
- [ ] **AC-N1** (`session.create`) — handler accepts a valid request envelope and returns a `SessionRead`-shape result with a stable `sessionId` (per [Spec-001 §Interfaces And Contracts](./001-shared-session-core.md#interfaces-and-contracts)); a malformed payload rejects with `-32602 InvalidParams` and the handler closure is never invoked (per [I-007-7](../plans/007-local-ipc-and-daemon-control.md), schema-validates-before-dispatch). Verified directly by Plan-007 Phase 3 test IDs `I-007-3-T1` (round-trip identity) + `I-007-3-T2` (malformed-payload rejection + I-007-7 enforcement); both live in `packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts` and are grep-discoverable in [Plan-007 §Phase 3 test plan](../plans/007-local-ipc-and-daemon-control.md).
- [ ] **AC-N2** (`session.read`) — handler returns a `SessionRead`-shape result for a known session id (per [Spec-001 §Interfaces And Contracts](./001-shared-session-core.md#interfaces-and-contracts)). The unknown-id rejection wire-shape is `-32602 InvalidParams` + `data.type: "session.not_found"` per [error-contracts.md §JSON-RPC Wire Mapping](../architecture/contracts/error-contracts.md#json-rpc-wire-mapping) + [Plan-007 §Invariants I-007-8](../plans/007-local-ipc-and-daemon-control.md#invariants) (the registered dotted-namespace code rides as `data.type` in the two-layer envelope), implemented via `SessionNotFoundError` at `packages/runtime-daemon/src/ipc/session-errors.ts` and its `mapJsonRpcError` discriminator branch at `packages/runtime-daemon/src/ipc/jsonrpc-error-mapping.ts`. Wire shape inherits [Spec-001 §Required Behavior](./001-shared-session-core.md#required-behavior). Structural invariants (I-007-6 duplicate-registration rejection at register-time + I-007-7 schema-validates-before-dispatch) inherit via the shared `router.register` substrate, proven by Plan-007 Phase 3 test ID `I-007-3-T5` against `session.create`'s identical binding shape; the per-method binding lives at `packages/runtime-daemon/src/ipc/handlers/session-read.ts`. Verified directly by Plan-007 Phase 3 test ID `I-007-3-T8` (happy-path round-trip + unknown-id `SessionNotFoundError` → `-32602` + `data.type: "session.not_found"` wire shape); lives in `packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts`.
- [ ] **AC-N3** (`session.join`) — handler appends a `membership.created` event to the session's event log (the canonical V1 join-admission event per `SessionEventSchema`'s discriminated union at `packages/contracts/src/event.ts` — V1 variants are `session.created` / `membership.created` / `channel.created`; there is no `session.joined` variant; AC text corrected 2026-05-19 per Codex review of PR #76). A second-client `SessionJoin` returns the same session id, existing membership state, and full event history per [Spec-001 AC4](./001-shared-session-core.md#acceptance-criteria). Wire shape inherits [Spec-001 §Interfaces And Contracts](./001-shared-session-core.md#interfaces-and-contracts). Structural invariants inherit via Plan-007 Phase 3 test ID `I-007-3-T5`'s substrate-symmetry; the per-method binding lives at `packages/runtime-daemon/src/ipc/handlers/session-join.ts`. Verified directly by Plan-007 Phase 3 test ID `I-007-3-T9` (`membership.created` event emission to a same-session subscribe observer + Spec-001 AC4 second-client replay shape at the handler boundary using mocked deps); lives in `packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts`.
- [ ] **AC-N4** (`session.subscribe`) — handler returns the subscribe-init envelope (`{ subscriptionId }`) BEFORE the first replay-flush notification per [I-007-10](../plans/007-local-ipc-and-daemon-control.md) (subscribe-init response precedes the first notification frame); the SDK-side `LocalSubscriptionConsumer<EventEnvelope>` supports `[Symbol.asyncIterator]` per [CP-007-4](../plans/007-local-ipc-and-daemon-control.md) (typed JSON-RPC client transport cross-plan obligation); `onCancel` fires across externally-imposed cancel paths per [I-007-11](../plans/007-local-ipc-and-daemon-control.md). Verified directly by Plan-007 Phase 3 test IDs `I-007-3-T3` (subscribe round-trip + cancel idempotency + frame shape) + `I-007-3-T6` (daemon-side `setImmediate`-buffered response-before-notify wire-ordering invariant) + `I-007-3-T7` (SDK-side synchronous `#subscriptions` registration in `#handleResponse`; Codex P1 regression). T3 + T6 live in `packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts`; T7 lives in `packages/client-sdk/src/transport/__tests__/jsonRpcClient.test.ts`.
- [ ] A request whose `id` exceeds the §Wire Format bound is refused as `-32600 Invalid Request` before the handler runs, the refusal carries `id: null` rather than the offending value, and the connection stays open — the request fails, not the session. Stated as [I-007-22](../plans/007-local-ipc-and-daemon-control.md); verified by the oversized-id group of the gateway suite at `packages/runtime-daemon/src/ipc/__tests__/local-ipc-gateway.test.ts`, which covers both gate orders — the id gate's own refusal and an earlier envelope gate answering first — and carries an under-bound id as its negative control.
- [ ] A dispatched handler can read the daemon-resolved calling principal from its dispatch context, and a handler that requires one refuses rather than proceeding when the identity provider has not supplied it. Stated as [I-007-21](../plans/007-local-ipc-and-daemon-control.md); verified by [Plan-007](../plans/007-local-ipc-and-daemon-control.md) Phase 2B task `T-007p-2B-1`, whose tests include the fail-closed negative control (provider unwired ⇒ absent member ⇒ a requiring handler refuses rather than defaulting).

## ADR Triggers

- If the system chooses a different default local transport boundary, create or update `../decisions/008-default-transports-and-relay-boundaries.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: browser-only local clients are out of scope. Desktop and CLI are the only first-class local clients in the first release.

## References

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md)
