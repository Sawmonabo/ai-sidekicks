# ADR-013: Control Plane API

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Control Plane / API`   |
| **Date**      | `2026-04-15`            |
| **Author(s)** | `Claude`                |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

The control plane needs request-response APIs for sign-in, the account's statement chain, device linking and machine registration, streams of its own, and a bidirectional path between each of the user's devices and each of their machines. It is the Rust crate `sidekicks-control-plane`: a Cloudflare Worker built on `worker`, and a native program for the self-hosted Compose relay built from the same handlers. Its wire types are the Rust types in `sidekicks-contracts`, the same source the daemon's wire comes from, and the TypeScript clients get their types and Ajv checks generated from them. Server-Sent Events are one-directional, and a device driving a live session on a machine needs a bidirectional, sealed path that the control plane cannot read, which requires WebSocket.

## Problem Statement

What API layer should the control plane expose, given a need for typed request-response, its own streams and a bidirectional device channel, served from Rust on Cloudflare Workers and from the Compose relay's native program?

### Trigger

The control plane serves several consumers (the daemon, the CLI, the desktop app, the web and phone clients, the relay) and needs a single API contract so its surface does not fragment into ad-hoc shapes. Remote Control (a device driving a session it does not execute) makes a one-directional answer insufficient.

## Decision

The control plane's request-response operations are HTTP routes served by `axum` 0.8.9 (`default-features = false`, `json`) on `worker` 0.8.7 (`http`, `axum`), entered through `tower-service` 0.3.3 (`router().call(request)` in `#[event(fetch)]`): one POST per procedure with a JSON body. A refusal is answered `{code, category, message}`, the category the one [Error Contracts §Categories](../architecture/contracts/error-contracts.md#categories) gives the code, as every refusal carries, with the code's own fields beside them: `request.envelopeInvalid` at 400 for a body that does not parse or carries no JSON content type, and at 413 for one over the size limit; `request.paramsInvalid` at 422 for one that parses and fails its route's contract check, its schema's shape, then serde, then its garde rules, as every server here checks a message it receives; `request.methodNotFound` at 404 from the router's fallback, and `request.methodNotAllowed` at 405 for a route called with a method it does not serve; a refused request at the one HTTP status its code registers in [Error Contracts](../architecture/contracts/error-contracts.md), set by what the code means (429 for `relay.rateLimited`). The control plane's own streams are Server-Sent Events, sent one event at a time. A stream writes a keepalive comment every 15 seconds, on a Worker timer, since `axum`'s `Sse::keep_alive` needs its `tokio` feature, which the Worker build leaves off, so a reader can tell a quiet stream from a dead one. A stream cannot take a fresh access token once it is open, so it ends at its token's expiry, and at once when the token's family is revoked; the end is an ordinary close, never a 204, which would tell the client to stop reconnecting, and the client dials again under a fresh token. Each route's request and response are `sidekicks-contracts`' Rust types, so the TypeScript a client calls them with is generated from the same source.

Use one WebSocket (WSS) connection to the relay for each device and each machine as the bidirectional device channel's standing carrier: it carries the sealed Noise channel frames [Spec-027](../specs/027-remote-control.md) defines, one channel per device and machine, and inside each channel the device calls the machine's own JSON-RPC 2.0 methods per [ADR-009](./009-json-rpc-ipc-wire-format.md). Wherever the device and the machine can reach each other the same channel moves onto a WebRTC data channel straight between them, set up inside the channel itself, while the WebSocket stays open for reachability, presence and the fallback, per [ADR-008](./008-default-transports-and-relay-boundaries.md). Session transcripts and run output ride those channels on whichever carrier holds them; the control plane carries no session stream.

## Alternatives Considered

### Option A: `axum` on `worker` + WebSocket (JSON-RPC 2.0) (Chosen)

- **What:** `axum` routes on `worker`, one POST per procedure, a `{code, category, message}` refusal and Server-Sent Events for the control plane's own streams; WebSocket for the bidirectional device channel.
- **Steel man:** `worker` supports `axum` directly, so the router is the maintained Rust one, and the same handlers serve the Compose relay's native program. Every route is plain HTTP with a JSON body that any client can call. The types come from the Rust contracts the daemon's wire already uses, so the control plane adds no second schema source. WebSocket handles only the path that genuinely requires bidirectional communication through the relay, and JSON-RPC 2.0 inside the device's channel aligns with ADR-009 on either carrier.

### Option B: tRPC (Rejected)

- **What:** tRPC routers for request-response and subscriptions.
- **Why rejected:** tRPC is TypeScript only, so it cannot serve from a Rust Worker.

### Option C: OpenAPI-first surface through `utoipa` or `aide` (Rejected)

- **What:** Routes described by an OpenAPI document that `utoipa` or `aide` derives, with a typed client generated from it.
- **Why rejected:** The OpenAPI document is a second schema source beside the Rust contracts that already generate the TypeScript types, with a second attribute language on every type.

### Option D: ConnectRPC (Rejected)

- **What:** Protocol Buffers services over the Connect protocol (`connectrpc` with `buffa`).
- **Why rejected:** It is pre-1.0, and on `wasm32` only its core compiles, since its client and server features need platform networking, so a Workers server is unproven. Its Protocol Buffers schemas would also be a second schema source and would change the JSON wire.

### Option E: gRPC (Rejected)

- **What:** Protocol Buffers with gRPC for all control plane communication.
- **Why rejected:** Heavy toolchain (protoc, codegen, HTTP/2 proxy for the browser). Adds build complexity disproportionate to the API surface.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `axum` on `worker` serves POST JSON, a JSON refusal body and Server-Sent Events from a Worker. | Proven in workerd 1.20261001 (wrangler 4.147.0, compatibility date 2026-10-01, no flags): POST JSON, the 400 through `JsonRejection`, the 404 fallback, the 422 refusal, and an SSE stream sent one event at a time. | We would route on `worker`'s own router and lose the native program's shared handlers. |
| 2 | Server-Sent Events are adequate for the control plane's own one-directional streams in browser and CLI contexts. | SSE is a W3C standard, widely deployed, and supported by modern browsers and HTTP clients. | If intermediaries strip or buffer SSE, we would have to route streaming traffic through WebSocket too. |
| 3 | A WebSocket to the relay carrying each device's sealed channel, with JSON-RPC 2.0 payloads inside it (per ADR-009), is the right transport for the bidirectional device channel. | ADR-009 commits to JSON-RPC 2.0 for daemon IPC, so reusing the same payload shape inside the channel avoids a second serialization contract. | If that channel needs a different protocol (e.g., CRDT-native), we would run a third transport on the control plane. |
| 4 | The Worker fits Cloudflare's limits with room to grow. | A measured Worker build (axum, `pasetors`, `web-push-native` and the passkey check) came to 2.0 MB of wasm plus 0.38 MB of JavaScript after `wasm-opt` (3.6% of the 64 MiB limit), about 18 ms of startup (limit 1 s), and about 1.1 ms of CPU for a request that verifies one PASETO token or one passkey assertion, within [Cloudflare's CPU limit](https://developers.cloudflare.com/workers/platform/limits/#cpu-time). | We would split the Worker or raise its CPU limit. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A development build panics in `worker::Delay` (from compatibility date 2026-08-04, workerd's `setTimeout` returns a `Timeout` object, not a number) | High | Low | The first call that waits | The Worker is built by `worker-build` 0.8.7's default release profile, which runs fine in development and production; a development build needs the `no_nodejs_global_timers` flag. |
| A `package.json` with dependencies in the crate root breaks `worker-build` (`invalid type: map, expected a string`) | Med | Low | The build fails | The npm manifest stays out of the crate root. |
| A handler awaits a JavaScript promise or a `Delay` that is not `Send` | High | Low | The build fails, since axum needs `Send` handlers | Every such await is wrapped in `worker::send::SendFuture`. |
| A request path calls `std::time::SystemTime::now` or `Instant::now`, which panic at run time on `wasm32-unknown-unknown` | Med | High | The route answers 500 | Request paths read the time through `worker`, never through `std::time`. |
| A panic (stable, `panic = "abort"`) answers its own request with a 500, and `worker-build`'s shim re-creates the wasm instance on the next call, resetting every Rust static; every other request then in flight on the isolate never answers, and a panic inside one of the relay's Durable Objects, the account object or a machine's forwarding object, loses that object's in-memory state and leaves its caller waiting; the object's storage writes made with no await between them commit together or not at all | Low | High | 500 responses and requests that never answer | Request paths hold no panicking call, and every outbound wait has a timeout. |
| The relay's Durable Objects do not build (E0433 from `#[durable_object]`) | High | Low | The build fails | The crate depends on `wasm-bindgen` directly, which `worker` 0.8.7's `#[durable_object]` needs. |
| SSE connections drop through corporate proxies or Cloudflare edge intermediaries | Med | Med | Connection drop rate metrics and user support tickets | Fall back to WebSocket streaming for affected clients; provide a transport-preference flag |
| The methods a device calls over its channel drift from the daemon's local JSON-RPC methods | Med | Med | One suite run against the local transport and the channel arm, on each carrier | Serve both from the daemon's one set of methods |

## Reversibility Assessment

- **Reversal cost:** Medium. Every route is a plain HTTP POST with a JSON body whose types come from the Rust contracts, so replacing the router touches the control plane crate and leaves the request and response shapes as they are.
- **Blast radius:** The control plane crate, the Compose relay's native program, and every client that calls the control plane (the daemon, the CLI, the desktop app, the web and phone clients).
- **Migration path:** Serve the same routes from the new router, run the same route suite against it, and switch the Worker's entry in one release.
- **Point of no return:** Once self-hosted relays run the native program, a change of route shape needs those relays upgraded with the clients.

## Consequences

### Positive

- One schema source, the Rust contracts, for the daemon's wire and the control plane's routes
- Plain HTTP routes any client can call, with refusals in one `{code, category, message}` shape
- Server-Sent Events cover the control plane's own streams without WebSocket connection overhead
- WebSocket is scoped to the device channel, keeping the connection count minimal

### Negative (accepted trade-offs)

- The TypeScript clients depend on a generation step, which CI checks by regenerating
- The Worker's traps (release builds only, `SendFuture` around every JavaScript await, no `std::time` clock, a panic resetting the instance) are rules every handler follows
- Two transport mechanisms (HTTP with SSE, and WebSocket) increase operational surface area

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| End-to-end type safety from TypeScript generated from the Rust contracts, committed under the `@ai-sidekicks/*` paths the clients import and checked in CI by regenerating and `git diff --exit-code` | 100% of first-party client calls | CI regenerates the TypeScript and fails on any difference; the TypeScript build checks every call | When the first client of the control-plane routes lands |
| Control plane round-trip latency (request-response) on Cloudflare Workers | < 150 ms at p95 globally | Control plane metrics | When the Workers relay is first deployed |
| Every method the local transport serves is also served over a device's channel, on the relay and on the direct path | 100% of daemon methods | One suite run against the local transport and the channel on each carrier | When Remote Control's method proxy lands, and again when the direct path lands |

## References

- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md)
- [ADR-002: Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [`axum` 0.8 documentation](https://docs.rs/axum/0.8.9/axum/)
- [`workers-rs` (the `worker` crate)](https://github.com/cloudflare/workers-rs)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [cloudflare/workers-rs#1086](https://github.com/cloudflare/workers-rs/issues/1086) — a development build panics in `worker::Delay`.
- [cloudflare/workers-rs#1087](https://github.com/cloudflare/workers-rs/issues/1087) — an npm manifest in the crate root breaks `worker-build`.
