# ADR-014: tRPC Control Plane API

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Control Plane / API` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |
| **Reviewers** | `Accepted 2026-04-15` |

## Context

The control plane needs request-response APIs, streaming notifications, and bidirectional collaboration channels. tRPC v11 provides end-to-end TypeScript type safety with zero codegen, covering queries, mutations, and SSE-based subscriptions. However, SSE is unidirectional -- bidirectional presence and collaboration (cursor positions, typing indicators, shared editing) require WebSocket.

## Problem Statement

What API layer should the control plane expose given a need for typed request-response, streaming notifications, and bidirectional collaboration, all from a TypeScript-native stack deployable on Cloudflare Workers?

### Trigger

The control plane was about to gain multiple consumers (CLI, desktop app, browser clients, relay) and needed a single API contract before surface area fragmented into ad-hoc REST and WebSocket shapes. Collaboration features (presence, typing indicators) made a SSE-only answer insufficient.

## Decision

Use tRPC v11 for control plane request-response operations and SSE subscriptions (notifications, run streaming). Use WebSocket with JSON-RPC 2.0 payloads for bidirectional collaboration channels (presence, live event streaming, relay coordination).

## Alternatives Considered

### Option A: tRPC + WebSocket (JSON-RPC 2.0) (Chosen)

- **What:** tRPC for typed request-response and SSE streaming; WebSocket for bidirectional collaboration.
- **Steel man:** Full type safety for the majority of API surface. WebSocket handles only the collaboration subset that genuinely requires bidirectional communication. JSON-RPC 2.0 on the WebSocket aligns with ADR-009.

### Option B: Plain REST + WebSocket (Rejected)

- **What:** OpenAPI-defined REST endpoints plus WebSocket for all real-time features.
- **Why rejected:** No end-to-end type safety without codegen. Requires maintaining OpenAPI schemas separately from implementation. TypeScript clients lose inference.

### Option C: gRPC (Rejected)

- **What:** Protocol Buffers with gRPC for all control plane communication.
- **Why rejected:** Heavy toolchain (protoc, codegen, HTTP/2 proxy for browser). Not TypeScript-native. Adds build complexity disproportionate to the API surface.

### Option D: oRPC (Rejected)

- **What:** oRPC as a lighter tRPC alternative.
- **Why rejected:** Too immature (approximately 4 months old at time of evaluation). Insufficient production track record and ecosystem support for a foundational API layer.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | tRPC v11 end-to-end TypeScript inference works well on Cloudflare Workers with no codegen. | tRPC v11 documents Workers as a supported adapter target; published examples run on Workers without codegen steps. | We would need a REST+OpenAPI layer, losing inference and adding schema maintenance. |
| 2 | SSE is adequate for one-directional streaming (notifications, run events) in browser and CLI contexts. | SSE is a W3C standard, widely deployed, and supported by modern browsers and HTTP clients. | If intermediaries strip or buffer SSE, we would have to route streaming traffic through WebSocket too. |
| 3 | A separate WebSocket channel using JSON-RPC 2.0 (per ADR-009) is the right transport for bidirectional collaboration features. | ADR-009 commits to JSON-RPC 2.0 for daemon IPC, so reusing the same payload shape avoids a second serialization contract. | If collaboration needs a different protocol (e.g., CRDT-native), we would run a third transport on the control plane. |
| 4 | Non-TypeScript clients are a minority use case and can be served by a narrow REST facade. | First-party clients (CLI, desktop, browser) are all TypeScript; relay and integrations can target the WebSocket/JSON-RPC boundary. | If enterprise customers demand OpenAPI-first contracts, we would need to publish and maintain a generated REST surface from day one. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| tRPC type inference degrades at large router scales (build time, IDE lag) | Med | Med | Build-time metrics, developer experience feedback | Split routers by domain; lazy-load procedure modules |
| SSE connections drop through corporate proxies or Cloudflare edge intermediaries | Med | Med | Connection drop rate metrics and user support tickets | Fall back to WebSocket streaming for affected clients; provide a transport-preference flag |
| WebSocket transport drifts from JSON-RPC 2.0 framing used for daemon IPC | Med | Med | Conformance tests that share fixtures with ADR-009 daemon tests | Share the JSON-RPC adapter codebase between daemon and control-plane WebSocket |
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
- SSE covers streaming and notifications without WebSocket connection overhead
- WebSocket is scoped to collaboration channels, keeping the connection count minimal

### Negative (accepted trade-offs)

- Two transport mechanisms (tRPC/SSE + WebSocket) increase operational surface area
- tRPC coupling means non-TypeScript clients need a REST adapter or generated OpenAPI layer

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
|--------|--------|--------------------|------------|
| End-to-end type safety across CLI/desktop/browser without codegen | 100% of first-party client calls | TypeScript build checks and client CI | `2026-07-01` |
| Control plane round-trip latency (query/mutation) on Cloudflare Workers | < 150 ms at p95 globally | Control plane metrics | `2026-10-01` |
| Collaboration features (presence, typing) working over WebSocket/JSON-RPC with no fallback | 100% of sessions at desktop launch | Session telemetry | `2026-12-01` |

## References

- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md)
- [ADR-002: Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [tRPC v11 Documentation](https://trpc.io/docs)

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-15 | Proposed | Initial draft |
| 2026-04-15 | Accepted | ADR accepted |
