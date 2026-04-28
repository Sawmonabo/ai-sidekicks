# ADR-009: JSON-RPC IPC Wire Format

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Transport / IPC`       |
| **Date**      | `2026-04-15`            |
| **Author(s)** | `Claude`                |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

MCP (Anthropic) and LSP (Microsoft) both standardize on JSON-RPC 2.0 for local IPC. All three reference apps (Claude Code, Cursor, Windsurf) use JSON over stdio or sockets. V8's native `JSON.parse`/`JSON.stringify` outperforms JS-level binary serializers for typical message sizes, so a binary wire format adds complexity without a measurable speed gain in this tier.

## Problem Statement

What wire format should the daemon use for local IPC, and how should the same payloads reach browser and remote clients without introducing a second serialization surface?

### Trigger

The architecture program needs a stable IPC contract before CLI, desktop, and daemon components can be specified independently. Without a committed wire format, client libraries, framing, and transport adapters cannot be written without rework.

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

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | V8 native JSON parsing is fast enough for daemon message volume. | MCP, LSP, and reference apps (Claude Code, Cursor, Windsurf) ship on JSON/stdio at scale. | If tool-call payloads or streamed artifacts push per-message parse cost above the single-digit-ms budget, we would need a binary format. |
| 2 | Local IPC consumers can open a Unix domain socket on macOS/Linux and a named pipe on Windows. | Node.js `net` module supports both APIs transparently via path-style addresses. | If a supported runtime cannot speak either, we would need a TCP loopback fallback with its own auth story. |
| 3 | The same JSON-RPC payloads can be reused verbatim over a WebSocket adapter for browser and remote clients. | ADR-008 positions WebSocket as the browser/remote transport, and JSON-RPC 2.0 is transport-agnostic. | If browser clients need a different payload shape, we would carry two serialization schemas. |
| 4 | Content-Length framing is robust against embedded newlines and partial reads. | LSP has used this framing for years without corruption issues across large tooling ecosystems. | If framing proves ambiguous (e.g., mismatched header parsers), we would have to add explicit length-prefixed binary framing. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| JSON payloads become too large (streamed artifacts, large tool results) and parse latency spikes | Med | Med | Daemon IPC latency metrics and parse-time histograms | Add chunked streaming for large artifacts outside the JSON-RPC envelope; keep control messages JSON |
| A client mis-implements `Content-Length` framing and desyncs the stream | Med | High | Framing-error counters and dropped-connection logs | Publish a conformance test suite and reject malformed frames with a clear close code |
| JSON-RPC 2.0 evolves or a competing successor emerges before WebSocket adapter lands | Low | Low | Spec tracker and upstream MCP/LSP release notes | JSON-RPC 2.0 is effectively frozen; transport layer can wrap a successor without rewriting clients |
| Windows named pipe semantics diverge from Unix socket behavior (permissions, reconnection) | Med | Med | Platform-specific integration tests and daemon crash reports | Abstract transport in a thin adapter; document per-platform quirks |

## Reversibility Assessment

- **Reversal cost:** High. Replacing JSON-RPC with a binary format requires rewriting daemon, CLI, desktop, and WebSocket adapters plus all client SDKs.
- **Blast radius:** Every component that talks to the daemon: CLI, desktop app, WebSocket bridge, relay, tooling, and third-party integrations.
- **Migration path:** Introduce a new transport version flag, run dual-format servers during a deprecation window, and migrate clients one at a time. Retire the JSON transport only after all first-party and known third-party clients have cut over.
- **Point of no return:** Once third-party MCP/LSP clients and relay deployments depend on JSON-RPC payloads over the documented framing, reversal requires coordinated external upgrades.

## Consequences

### Positive

- Wire format matches MCP and LSP tooling, so existing client libraries work unmodified
- Human-readable messages simplify debugging and logging

### Negative (accepted trade-offs)

- Content-Length framing requires a small parser; raw newline-delimited would be simpler
- JSON is larger on the wire than binary formats, though local socket latency makes this negligible

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Daemon IPC round-trip latency for control messages | < 5 ms at p95 on a local socket | Daemon metrics histogram | `2026-07-01` |
| Third-party MCP/LSP clients can connect without custom framing code | 100% of tested clients | Client conformance suite | `2026-07-01` |
| Framing desynchronization incidents in production logs | 0 per week | Framing-error counter dashboard | `2026-10-01` |

## References

- [ADR-008: Default Transports And Relay Boundaries](./008-default-transports-and-relay-boundaries.md)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [LSP Base Protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol)

## Decision Log

| Date       | Event    | Notes         |
| ---------- | -------- | ------------- |
| 2026-04-15 | Proposed | Initial draft |
| 2026-04-15 | Accepted | ADR accepted  |
