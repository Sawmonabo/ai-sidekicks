# ADR-013: tRPC Control Plane API

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Control Plane / API`   |
| **Date**      | `2026-04-15`            |
| **Author(s)** | `Claude`                |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

The control plane needs request-response APIs for sign-in, the account's statement chain, device linking and machine registration, and a bidirectional path between each of the user's devices and each of their machines. tRPC v11 provides end-to-end TypeScript type safety with zero codegen, covering queries, mutations, and SSE-based subscriptions. However, SSE is unidirectional, and a device driving a live session on a machine needs a bidirectional, sealed path that the control plane cannot read, which requires WebSocket.

## Problem Statement

What API layer should the control plane expose given a need for typed request-response, streaming notifications, and a bidirectional device channel, all from a TypeScript-native stack deployable on Cloudflare Workers?

### Trigger

The control plane serves several consumers (CLI, desktop app, browser clients, relay) and needs a single API contract so its surface does not fragment into ad-hoc REST and WebSocket shapes. Remote Control (a device driving a session it does not execute) makes an SSE-only answer insufficient.

## Decision

Use tRPC v11 for control plane request-response operations and SSE subscriptions. Use one WebSocket (WSS) connection to the relay for each device and each machine as the bidirectional device channel: it carries the sealed Noise channel frames [Spec-027](../specs/027-remote-control.md) defines, one channel per device and machine, and inside each channel the device calls the machine's own JSON-RPC 2.0 methods per [ADR-009](./009-json-rpc-ipc-wire-format.md). Session transcripts and run output ride those channels, per [ADR-008](./008-default-transports-and-relay-boundaries.md)'s transport assignment; the control plane carries no session stream.

## Alternatives Considered

### Option A: tRPC + WebSocket (JSON-RPC 2.0) (Chosen)

- **What:** tRPC for typed request-response and SSE streaming; WebSocket for the bidirectional device channel.
- **Steel man:** Full type safety for the majority of API surface. WebSocket handles only the path that genuinely requires bidirectional communication. JSON-RPC 2.0 inside the device's channel aligns with ADR-009.

### Option B: Plain REST + WebSocket (Rejected)

- **What:** OpenAPI-defined REST endpoints plus WebSocket for all real-time features.
- **Why rejected:** No end-to-end type safety without codegen. Requires maintaining OpenAPI schemas separately from implementation. TypeScript clients lose inference.

### Option C: gRPC (Rejected)

- **What:** Protocol Buffers with gRPC for all control plane communication.
- **Why rejected:** Heavy toolchain (protoc, codegen, HTTP/2 proxy for browser). Not TypeScript-native. Adds build complexity disproportionate to the API surface.

### Option D: oRPC (Rejected)

- **What:** oRPC as a lighter tRPC alternative.
- **Why rejected:** Too immature: an insufficient production track record and ecosystem support for a foundational API layer.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | tRPC v11 end-to-end TypeScript inference works well on Cloudflare Workers with no codegen. | tRPC v11 documents Workers as a supported adapter target; published examples run on Workers without codegen steps. | We would need a REST+OpenAPI layer, losing inference and adding schema maintenance. |
| 2 | SSE is adequate for the control plane's own one-directional subscriptions in browser and CLI contexts. | SSE is a W3C standard, widely deployed, and supported by modern browsers and HTTP clients. | If intermediaries strip or buffer SSE, we would have to route streaming traffic through WebSocket too. |
| 3 | A WebSocket to the relay carrying each device's sealed channel, with JSON-RPC 2.0 payloads inside it (per ADR-009), is the right transport for the bidirectional device channel. | ADR-009 commits to JSON-RPC 2.0 for daemon IPC, so reusing the same payload shape inside the channel avoids a second serialization contract. | If that channel needs a different protocol (e.g., CRDT-native), we would run a third transport on the control plane. |
| 4 | Non-TypeScript clients are a minority use case and can be served by a narrow REST facade. | First-party clients (CLI, desktop, browser, phone) are all TypeScript; the relay carries only the sealed channel frames [Spec-027](../specs/027-remote-control.md) defines, which it never reads, so none needs a REST facade. | If an integration demands an OpenAPI-first contract, we would need to publish and maintain a generated REST surface. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| tRPC type inference degrades at large router scales (build time, IDE lag) | Med | Med | Build-time metrics, developer experience feedback | Split routers by domain; lazy-load procedure modules |
| SSE connections drop through corporate proxies or Cloudflare edge intermediaries | Med | Med | Connection drop rate metrics and user support tickets | Fall back to WebSocket streaming for affected clients; provide a transport-preference flag |
| The methods a device calls over its channel drift from the daemon's local JSON-RPC methods | Med | Med | One suite run against the local transport and the relay arm | Serve both from the daemon's one set of methods |
| tRPC upstream breaking change forces a v12 migration mid-lifecycle | Low | Med | tRPC release tracker | Pin major versions, follow tRPC migration guides, schedule upgrade windows |
| A non-TypeScript integration partner cannot consume tRPC | Med | Low | Partner feedback and integration requirements | Publish a narrow REST facade generated from the tRPC router for external consumers |

## Reversibility Assessment

- **Reversal cost:** High. tRPC types ripple into every client repo; replacing it means regenerating schemas, migrating clients, and rewriting route wiring.
- **Blast radius:** Control plane server, CLI client, desktop client, browser client, any SDK consumers.
- **Migration path:** Introduce an OpenAPI or alternative RPC router alongside tRPC, dual-serve for a deprecation window, migrate clients one at a time, then retire tRPC.
- **Point of no return:** Once external integrations depend on tRPC router shapes or type exports, reversal requires a coordinated external migration.

## Consequences

### Positive

- End-to-end type safety from server to client with zero codegen for the majority of the API
- SSE covers the control plane's own subscriptions without WebSocket connection overhead
- WebSocket is scoped to the device channel, keeping the connection count minimal

### Negative (accepted trade-offs)

- Two transport mechanisms (tRPC/SSE + WebSocket) increase operational surface area
- tRPC coupling means non-TypeScript clients need a REST adapter or generated OpenAPI layer

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| End-to-end type safety across CLI/desktop/browser without codegen | 100% of first-party client calls | TypeScript build checks and client CI | When the first client of the control-plane routers lands |
| Control plane round-trip latency (query/mutation) on Cloudflare Workers | < 150 ms at p95 globally | Control plane metrics | When the Workers relay is first deployed |
| Every method the local transport serves is also served over a device's channel through the relay | 100% of daemon methods | One suite run against both transports | When Remote Control's method proxy lands |

## References

- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md)
- [ADR-002: Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [tRPC v11 Documentation](https://trpc.io/docs)
