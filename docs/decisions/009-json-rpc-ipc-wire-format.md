# ADR-009: JSON-RPC IPC Wire Format

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Domain** | `Transport / IPC` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |

## Context

MCP (Anthropic) and LSP (Microsoft) both standardize on JSON-RPC 2.0 for local IPC. All three reference apps (Claude Code, Cursor, Windsurf) use JSON over stdio or sockets. V8's native `JSON.parse`/`JSON.stringify` outperforms JS-level binary serializers for typical message sizes, so a binary wire format adds complexity without a measurable speed gain in this tier.

## Decision

Use JSON-RPC 2.0 with LSP-style `Content-Length` header framing over a Unix domain socket (named pipe on Windows) for local daemon IPC. Provide a WebSocket adapter for browser and remote clients that carries the same JSON-RPC payloads.

## Alternatives Considered

### Option A: JSON-RPC 2.0 + Content-Length Framing (Chosen)

- **What:** Standard JSON-RPC 2.0 messages framed by `Content-Length` headers, identical to LSP/MCP.
- **Steel man:** Battle-tested framing, human-readable payloads, native V8 performance, zero external dependencies.

### Option B: tRPC Over HTTP (Rejected)

- **What:** Use tRPC's HTTP transport for local IPC.
- **Why rejected:** tRPC has no Unix domain socket adapter; HTTP overhead is unnecessary for local daemon traffic.

### Option C: Protocol Buffers (Rejected)

- **What:** Binary serialization with proto schema.
- **Why rejected:** Adds a codegen step and schema compilation toolchain for no meaningful throughput gain at this message volume.

### Option D: MessagePack (Rejected)

- **What:** Binary JSON-compatible serialization.
- **Why rejected:** Removes human-readable debugging without compensating performance benefit in V8.

### Option E: Newline-Delimited JSON (Rejected)

- **What:** One JSON object per `\n`-terminated line.
- **Why rejected:** Breaks on embedded newlines in string payloads; Content-Length framing is strictly safer.

## Consequences

### Positive

- Wire format matches MCP and LSP tooling, so existing client libraries work unmodified
- Human-readable messages simplify debugging and logging

### Negative (accepted trade-offs)

- Content-Length framing requires a small parser; raw newline-delimited would be simpler
- JSON is larger on the wire than binary formats, though local socket latency makes this negligible

## References

- [ADR-008: Default Transports And Relay Boundaries](./008-default-transports-and-relay-boundaries.md)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [LSP Base Protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol)
