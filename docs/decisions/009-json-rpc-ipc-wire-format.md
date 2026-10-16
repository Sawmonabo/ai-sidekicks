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

MCP (Anthropic) and LSP (Microsoft) both standardize on JSON-RPC 2.0 for local IPC. Claude Code, Cursor and Windsurf use JSON over stdio or sockets. Both ends parse JSON natively, `serde_json` in the daemon and each client engine's own JSON parse, so a binary wire format adds complexity without a measurable speed gain in this tier (§Assumptions Audit row 1).

## Problem Statement

What wire format should the daemon use for local IPC, and how should the same payloads reach browser and remote clients without introducing a second serialization surface?

### Trigger

The architecture program needs a stable IPC contract before CLI, desktop, and daemon components can be specified independently. Without a committed wire format, client libraries, framing, and transport adapters cannot be written without rework.

## Decision

Use JSON-RPC 2.0 messages in one frame codec (a 10-byte header per frame, with binary attachments carried beside the JSON) over a Unix domain socket (named pipe on Windows) for local daemon IPC; the same frames ride inside each sealed Noise message. A device other than the machine calls the same JSON-RPC methods, sealed inside its own Noise channel through the person's relay ([Spec-027](../specs/027-remote-control.md)): every method the local transport serves is served there, and event subscriptions, the session transcript and run output included, ride the same channel, per [ADR-008](./008-default-transports-and-relay-boundaries.md)'s transport assignment. The relay's WSS connection carries only the sealed channel frames Spec-027 defines and never a payload the relay can read. The control plane's own API is HTTP routes served by `axum` on `worker` per [ADR-013](./013-control-plane-api.md).

Errors use JSON-RPC 2.0's error object. Only protocol outcomes take JSON-RPC's numbers (`-32700` a parse error, `-32600` the envelope or framing, `-32601` an unknown method, `-32602` params that fail the method's contract check, `-32603` the daemon's own fault), with LSP's `-32800` for a call canceled by `$/cancelRequest`. Every domain refusal answers one application number, `-31000`, which lies outside the ranges JSON-RPC, LSP, MCP and A2A claim; the refusal's name rides in `data.type` and its category in `data.category`, so a client branches on the name and falls back to the category only for a name it does not know. An id that resolves to nothing is a domain refusal with category `notFound`, never `-32602` ([Error Contracts §JSON-RPC Wire Mapping](../architecture/contracts/error-contracts.md#json-rpc-wire-mapping)). Every request, event and error code takes its name from one grammar ([Local IPC Payload Contracts §Wire-Name Grammar](../architecture/contracts/local-ipc-payloads.md#wire-name-grammar)).

## Alternatives Considered

### Option A: JSON-RPC 2.0 + Frame Codec (Chosen)

- **What:** Standard JSON-RPC 2.0 messages, each in a length-prefixed frame with a fixed 10-byte header, identical on the local socket and inside the remote channel.
- **Steel man:** Length-prefixed framing, human-readable payloads, `serde_json` in the daemon and each client engine's native JSON, binary attachments with no base64.

### Option B: tRPC Over HTTP (Rejected)

- **What:** Use tRPC's HTTP transport for local IPC.
- **Why rejected:** tRPC is TypeScript only, so the Rust daemon cannot serve it, and it has no Unix domain socket adapter; HTTP overhead is unnecessary for local daemon traffic.

### Option C: Protocol Buffers (Rejected)

- **What:** Binary serialization with proto schema.
- **Why rejected:** Adds a codegen step and schema compilation toolchain for no meaningful throughput gain at this message volume.

### Option D: MessagePack (Rejected)

- **What:** Binary JSON-compatible serialization.
- **Why rejected:** Removes human-readable debugging without compensating performance benefit for `serde_json` or the clients' native JSON.

### Option E: Newline-Delimited JSON (Rejected)

- **What:** One JSON object per `\n`-terminated line.
- **Why rejected:** Breaks on embedded newlines in string payloads; a length-prefixed frame is strictly safer.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `serde_json` in the daemon and each client engine's native JSON parse are fast enough for daemon message volume. | MCP, LSP, Claude Code, Cursor and Windsurf ship on JSON/stdio at scale. | If tool-call payloads or streamed artifacts push per-message parse cost above the single-digit-ms budget, we would need a binary format. |
| 2 | Local IPC consumers can open a Unix domain socket on macOS/Linux and a named pipe on Windows. | tokio serves both: `UnixListener` on macOS and Linux, and the named-pipe `ServerOptions` that `sidekicks-platforms` wraps on Windows. | If a supported runtime cannot speak either, we would need a TCP loopback fallback with its own auth story. |
| 3 | The same JSON-RPC payloads can be reused verbatim inside a device's sealed channel, which the relay carries over its WSS connection; [ADR-013](./013-control-plane-api.md) owns the control plane's own request-response transport. | ADR-008 sends every device other than the machine through the relay, the client SDK's relay arm serves every method the local transport serves, and JSON-RPC 2.0 is transport-agnostic. | If remote clients need a different payload shape, we would carry two serialization schemas. |
| 4 | The frame codec's length-prefixed frames are robust against embedded newlines and partial reads. | Length-prefixed framing (LSP's `Content-Length` header among it) has carried tooling traffic for years without corruption issues across large tooling ecosystems. | If framing proves ambiguous (e.g., mismatched header parsers), we would have to version the frame header. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| JSON payloads become too large (streamed artifacts, large tool results) and parse latency spikes | Med | Med | Round-trip latency measured in the daemon's tests | Add chunked streaming for large artifacts outside the JSON-RPC envelope; keep control messages JSON |
| A client implements the frame codec wrongly and desyncs the stream | Med | High | Framing-error counters and dropped-connection logs | Publish a conformance test suite and reject malformed frames with a clear close code |
| JSON-RPC 2.0 evolves or a competing successor emerges before the relay arm lands | Low | Low | Spec tracker and upstream MCP/LSP release notes | JSON-RPC 2.0 is effectively frozen; transport layer can wrap a successor without rewriting clients |
| Windows named pipe semantics diverge from Unix socket behavior (permissions, reconnection) | Med | Med | Platform-specific integration tests and daemon crash reports | Abstract transport in a thin adapter; document per-platform quirks |

## Reversibility Assessment

- **Reversal cost:** High. Replacing JSON-RPC with a binary format requires rewriting the daemon, CLI, desktop, and the client SDK with its relay arm.
- **Blast radius:** Every component that talks to the daemon: CLI, desktop app, and the phone and web clients over the relay.
- **Migration path:** Introduce a new transport version flag, run dual-format servers during a deprecation window, and migrate clients one at a time. Retire the JSON transport only after every client has cut over.
- **Point of no return:** Once phones and relay deployments depend on JSON-RPC payloads in the frame codec, reversal requires coordinated upgrades outside the machine.

## Consequences

### Positive

- JSON-RPC 2.0 is the message shape MCP and LSP use; outside tools reach the product through the daemon's `sidekicks` MCP server over standard MCP, so none needs the frame codec
- Human-readable messages simplify debugging and logging

### Negative (accepted trade-offs)

- The frame codec requires a small parser in every client; raw newline-delimited would be simpler
- JSON is larger on the wire than binary formats, though local socket latency makes this negligible

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Daemon IPC round-trip latency for control messages | < 5 ms at p95 on a local socket | Round-trip latency measured in the daemon's tests | When the daemon's JSON-RPC transport lands |
| Outside tools reach the product through the daemon's `sidekicks` MCP server over standard MCP; the local socket serves only the desktop app and the CLI, in the one 10-byte-header frame codec; the Claude Code plugin's held read (`session.overviewRead {afterRevision}`) is HTTP on a second socket of its own, served by `axum` (`axum::serve` over tokio's `UnixListener` on Unix, an `axum::serve::Listener` over `uds_windows`' listener in `async-io` (wrapped for `AsSocket`, as Codex's `codex-rs/uds` does, and through `tokio_util::compat`) on Windows, each listener in `sidekicks-platforms`), its path checked before binding. Claude Code's plugin MCP and LSP servers (it starts them itself, over stdio) and Codex's MCP servers (through the daemon's own MCP client) never use that socket, so nothing a person uses changes. | 100% of tested outside tools | MCP conformance run against the `sidekicks` MCP server | When the daemon's JSON-RPC transport lands |
| Framing desynchronization incidents in production logs | 0 per week | Framing-error lines in the service log | Each week from the first release |

## References

- [ADR-008: Default Transports And Relay Boundaries](./008-default-transports-and-relay-boundaries.md)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [LSP Base Protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol)
