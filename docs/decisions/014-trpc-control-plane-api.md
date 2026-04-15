# ADR-014: tRPC Control Plane API

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Domain** | `Control Plane / API` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |

## Context

The control plane needs request-response APIs, streaming notifications, and bidirectional collaboration channels. tRPC v11 provides end-to-end TypeScript type safety with zero codegen, covering queries, mutations, and SSE-based subscriptions. However, SSE is unidirectional -- bidirectional presence and collaboration (cursor positions, typing indicators, shared editing) require WebSocket.

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

## Consequences

### Positive

- End-to-end type safety from server to client with zero codegen for the majority of the API
- SSE covers streaming and notifications without WebSocket connection overhead
- WebSocket is scoped to collaboration channels, keeping the connection count minimal

### Negative (accepted trade-offs)

- Two transport mechanisms (tRPC/SSE + WebSocket) increase operational surface area
- tRPC coupling means non-TypeScript clients need a REST adapter or generated OpenAPI layer

## References

- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md)
- [ADR-002: Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [tRPC v11 Documentation](https://trpc.io/docs)
