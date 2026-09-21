# Spec-006: Local IPC And Daemon Control

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `006` |
| **Slug** | `local-ipc-and-daemon-control` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md), [Runtime Node Model](../domain/runtime-node-model.md) |
| **Implementation Plan** | [Plan-006: Local IPC And Daemon Control](../plans/006-local-ipc-and-daemon-control.md) |

## Purpose

Define the typed local control surface used by the Desktop Shell and CLI to communicate with the local daemon. Renderer-originated traffic reaches the daemon through the Desktop Shell via the preload bridge per [Spec-021 §Trust Stance](./021-desktop-shell-and-renderer.md#trust-stance) — the renderer is not a direct daemon client.

## Scope

This spec covers transport choice, version negotiation, request and stream semantics, and daemon supervision controls.

## Non-Goals

- Remote relay transport
- Provider-driver internal protocols
- UI rendering behavior
- Network reachability configuration. There is no local-network switch, no private-network join, no coordination-server field, no approval link and no address to copy on this surface: how a machine is reached is the layer beneath it, and the only thing the product says about reachability here is whether the daemon is running. Beside the port a workflow started by a web request listens on, no other listening figure is set here either — no domain and no command to update one, no certificate or key path, and no check of a certificate — and that port is the one address this surface sets.
- Reading the diagnostic record back. This surface writes that record and never serves it back as a list: the diagnostic controls say what is written and where it is written, and no read here renders the contents — no recent-activity fold, no credential-attempt list, no audit view.

## Domain Dependencies

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)

## Required Behavior

- The Desktop Shell and CLI must use one shared typed client SDK. Renderer-originated traffic is brokered by the Shell via the preload bridge per [Spec-021 §Trust Stance](./021-desktop-shell-and-renderer.md#trust-stance) and reaches the daemon as Shell-originated JSON-RPC traffic.
- The CLI must be treated as a first-class local client and the first delivery track for the typed daemon contract.
- The local daemon must expose a typed request-response and subscription contract for session, run, repo, artifact, settings, and daemon lifecycle operations.
- The default local IPC transport must be OS-local:
  - Unix domain socket on Unix-like platforms
  - named pipe on Windows
- The system may expose a loopback fallback transport only when OS-local transport is unavailable or a non-desktop client requires it.
- Local IPC must support protocol version negotiation before mutating operations are accepted.
- The desktop shell must be able to start, stop, supervise, and reconnect to the daemon.
- The daemon must resolve the calling principal from the transport and make it available to every handler it dispatches, so a handler that authorizes reads or writes evaluates one daemon-resolved identity rather than resolving its own. Resolution follows [api-payload-contracts.md §Authenticated Principal And Authorization Model](../architecture/contracts/api-payload-contracts.md#authenticated-principal-and-authorization-model) unchanged — on this local socket the principal is the daemon's node-owner user identity, never read from a request body field — and it fails **closed**: while the identity provider is unwired the principal is absent, and a handler that requires one refuses rather than proceeding unauthenticated. The identity is a dispatch-context fact and never a wire field, so no request schema gains a principal member and a caller-supplied one stays refused rather than trusted.
- The daemon outlives its clients. Closing the desktop window leaves every session, run, and shell on that machine going, and the app reattaches to them when it opens again; the one sentence the product says about this is that closing the window leaves the background service running, and no surface claims where the work runs.
- `sidekicks daemon status` must report whether the daemon is up, since when, and which workspace it holds, in its text output and in `--json` alike. While a relay is configured it carries one further block: each linked device by name, whether it is connected, the age of the last frame out and of the last frame in, the reconnect count, and the rejected-frame count. With no relay configured the block is absent — never printed empty and never printed disabled. Its fields follow the relay wire [Spec-028](./028-remote-control.md) defines, and the block adds no command, no exit-code path, and nothing to any screen.
- The CLI must be able to run the daemon as a background service of the user's own account — install, uninstall, start, stop, restart, status — so that it survives logging out and a reboot, and one command must be enough to install and start it, so a machine with no desktop is running after a single line. The install captures the environment it was run in, so provider binaries are still found when no shell is open.
- One CLI command must check for a newer release and apply it down the same path the desktop app's own update uses, so the app and the CLI can never disagree about which version is current. A check-only flag reports and exits with a code that says whether an update is waiting, and it is the command an install that cannot update itself names.
- Signing in to and out of the product's hosted account is one CLI verb each, and either is refused while the daemon holds the data directory, naming what to stop. What signing in means — the ceremony, the credential it produces and the state it leaves behind — belongs to [Spec-016 §Required Behavior](./016-identity-and-user-state.md#required-behavior); what this surface owes is the two verbs and that refusal.
- Machine-wide daemon configuration is read and written through this surface, one place per value and no second one: how long diagnostic logs are kept, how long finished sessions and workflow-run step data are kept, the port a workflow started by a web request listens on, the time limit after which a run is ended, the memory cap for tool processes, and the two diagnostic switches — recording traces, and recording an event-replay log, which names the file it writes. Three of them carry a shape of their own: the run limit is no limit by default and is otherwise `30 minutes`, `1 hour`, `4 hours`, `12 hours` or `24 hours`; the memory cap is empty until a size is given, and empty means no cap; and both diagnostic switches are off until they are turned on. Each value's own policy belongs to the spec that owns it: the diagnostic-log bound, and with it the warning the daemon records when that bound is set past thirty days, to [Spec-018 §PII in Diagnostics](./018-observability-and-failure-recovery.md#pii-in-diagnostics), the finished-session bound and the workflow-run step-data bound to [Spec-020 §Retention Policy](./020-data-retention-and-gdpr.md#retention-policy). What this surface owes is that the value is set in one place, that a value the operating system will not let the daemon enforce says so where it is set, and that a refused value — something that is not a port, something that is not a size — is refused in place with nothing written and the field left as it was; a port already taken is answered the same way, saying that nothing is listening, and the daemon never moves to another port of its own.
- Removing data that is past its bound is an explicit act on this surface and never a consequence of setting one: no configuration value here deletes anything, and the one operation that does asks first, names what goes and what stays, and cannot be undone ([Spec-020 §Required Behavior](./020-data-retention-and-gdpr.md#required-behavior)).
- The folders this machine can reach are read and changed through this surface: the list, each folder's row with what is using it, and the removal, which is refused while a session is using that folder and names how many ([Spec-002 §Required Behavior](./002-runtime-node-attach.md#required-behavior)). A read with no folder mounted answers an empty list rather than an error, and the surface showing it says so rather than drawing an empty table.
- The daemon's own supervision facts are read by the surface that shows them and edited nowhere: whether it is running and since when, its version, and how much of the machine's processor and memory it is using — each reading stamped with the time it was taken and taken again only when it is asked for, never sampled on a timer. Stop and restart are the two supervised controls; each confirms before it acts and each says that work in flight on this machine stops. The daemon is updated separately from the desktop app: the update shows the step it is on, offers a cancel for as long as the daemon still allows one, and settles by naming the version it came from and the one it reached, or both versions and the reason where it rolled back, or that this machine is already at the newest version.

## Wire Format

- The wire format is JSON-RPC 2.0 with LSP-style Content-Length framing (not newline-delimited). Each message is preceded by `Content-Length: <byte-count>\r\n\r\n`.
- Maximum message size: 1 MB.
- Maximum request `id` size: 256 bytes once JSON-encoded. The `id` is opaque to the substrate and echoed verbatim, which makes it the one member of a response the caller sizes; an id past the bound is refused as `-32600 Invalid Request` **before dispatch**, and the refusal — like every error frame for an envelope whose id could not be recovered — carries `id: null` rather than echoing the offending value, per JSON-RPC 2.0 §5. Refusing the request is the only place the rule can be enforced: an oversized **response** cannot carry its own error, so the alternative is a closed connection on a request the daemon accepted.
- Every request (except health checks) must include a `protocolVersion` field carrying an ISO 8601 date-string in `YYYY-MM-DD` form (per §Tier 1 (cont.): Plan-006 ratification in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md)).
- Serialization: JSON via `JSON.stringify`/`JSON.parse`. No binary serialization.
- The client SDK in `packages/client-sdk/` wraps JSON-RPC in a thin typed Zod layer (~500-1000 LOC), following the MCP TypeScript SDK pattern.

## Default Behavior

- Desktop app default is auto-connect to the local daemon through OS-local IPC.
- If the daemon is not running, the desktop shell may auto-start it before the renderer gives up.
- CLI default is connect to the same typed local daemon contract rather than reimplement daemon logic inline.
- The first implementation release of the local control surface is CLI-first, with the Desktop Shell consuming the same stabilized contract afterward. The renderer consumes the preload bridge API per [Spec-021 §Trust Stance](./021-desktop-shell-and-renderer.md#trust-stance), not this daemon contract directly.

## Fallback Behavior

- If OS-local transport is unavailable, the client SDK may fall back to loopback transport with explicit authentication and version checks.
- If version negotiation fails, read-only compatibility may continue, but mutating operations must be blocked until versions are compatible.
- If the daemon cannot be started automatically, the client must return actionable status instead of hanging.
- While the daemon is unreachable or reconnecting, the client retries and says so in exactly one place rather than hanging, and it offers an explicit retry. Nothing already read is emptied, dimmed, or disabled: a list that could not be refreshed says only that, a draft keeps its text, and no open surface closes. The reading arms only once the daemon has answered at least once since the client started, so a client started into an outage reports a daemon that would not start rather than a connection that was lost. In the console that one place is the session's working line ([Spec-018 §Required Behavior](./018-observability-and-failure-recovery.md#required-behavior)).

## Interfaces And Contracts

- `DaemonHello` and `DaemonHelloAck` must perform version negotiation.
- `DaemonStatusRead`, `DaemonStop`, and `DaemonRestart` must exist as IPC methods for supervised environments. Daemon **start** is a supervisor capability realized by **process spawn** — the `sidekicks daemon start` CLI command (and the desktop shell's auto-start per § Default Behavior and § Example Flows) launches the daemon process and awaits `DaemonHelloAck` — NOT a JSON-RPC method on the daemon: a stopped daemon has no IPC server to receive a `daemon.start` call. See [Plan-006 Phase R1/R3](../plans/006-local-ipc-and-daemon-control.md) (`daemon.stop` / `daemon.restart` are R1 IPC handlers; `daemon start` is the R3 CLI process-spawn path, T-006r-3-4).
- `LocalSubscriptionConsumer<T>` must support replay-capable event streams where appropriate.
- `DaemonStatusRead` must carry everything a status surface prints, in one response rather than several reads: whether the daemon is up, since when, the workspace it holds, its version, and its processor and memory use with the time each reading was taken — plus, while a relay is configured, the per-device relay block §Required Behavior describes. The CLI's text output and its `--json` output are two renderings of that one response.
- The desktop shell exposes the daemon's typed surface to its renderer as one generic call and one generic subscribe rather than a bridge member per verb, so a method the daemon registers reaches the renderer without a new door being cut; the renderer still holds no daemon connection of its own per [Spec-021 §Trust Stance](./021-desktop-shell-and-renderer.md#trust-stance).
- The operator surface for this machine's own configuration is owed rather than registered, and it is listed here so it is built once: the mounted-folder list with its removal; the three retention bounds — diagnostic logs, finished sessions and workflow-run step data; the removal of data past a bound; the two diagnostic switches and the file the replay log writes; the port a workflow started by a web request listens on; the limit after which a run is ended; and the memory cap for tool processes. The daemon's own update owes two more: the step it is on while it runs, and the cancel it accepts for as long as it still allows one. The daemon's own processor and memory readings, and the read that takes them again, ride the status read above rather than a verb of their own. No method is minted here for any of them, and none of them is a second place a value already set on this surface can be set.
- The typed client SDK must expose the same semantic surface to Desktop Shell and CLI callers. The renderer consumes a narrower preload bridge API per [Spec-021 §Trust Stance](./021-desktop-shell-and-renderer.md#trust-stance), not this SDK directly.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

> **Clarifying amendment (approved spec, 2026-05-28, PR #124).** The prior wording listed `DaemonStart` alongside the IPC methods, which a conformance reader could mis-read as mandating a `daemon.start` JSON-RPC handler. Daemon start is a process-spawn capability (CLI / desktop shell), not an IPC method — clarified above to match § Default Behavior and § Example Flows (both already model start as the shell launching the daemon). No capability change; this records a defect-fix to an approved spec, not a routine editorial change.

## State And Data Implications

- Client cache must not become the daemon's state store.
- Daemon supervision state may be shell-local, but daemon runtime truth remains in daemon-owned persistence and projections.
- Version compatibility decisions must be visible to clients and logs.

## Example Flows

- `Example: The desktop renderer starts while the daemon is not running. The shell launches the daemon, negotiates protocol version via the typed client SDK, and then exposes renderer-accessible capabilities via the preload bridge per Spec-021 §Trust Stance; the renderer is not a direct daemon client.`
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

- [ ] Desktop Shell and CLI share one typed daemon client surface; the renderer consumes the preload bridge API per [Spec-021 §Trust Stance](./021-desktop-shell-and-renderer.md#trust-stance), not this daemon contract directly.
- [ ] The daemon can be started, pinged, and subscribed to through local IPC.
- [ ] Version mismatch blocks unsafe mutation while keeping status visibility available.
- [ ] **AC-N1** (`session.create`) — handler accepts a valid request envelope and returns a `SessionRead`-shape result with a stable `sessionId` (per [Spec-001 §Interfaces And Contracts](./001-session-core.md#interfaces-and-contracts)); a malformed payload rejects with `-32602 InvalidParams` and the handler closure is never invoked (per [I-006-7](../plans/006-local-ipc-and-daemon-control.md), schema-validates-before-dispatch). Verified directly by Plan-006 Phase 3 test IDs `I-006-3-T1` (round-trip identity) + `I-006-3-T2` (malformed-payload rejection + I-006-7 enforcement); both live in `packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts` and are grep-discoverable in [Plan-006 §Phase 3 test plan](../plans/006-local-ipc-and-daemon-control.md).
- [ ] **AC-N2** (`session.read`) — handler returns a `SessionRead`-shape result for a known session id (per [Spec-001 §Interfaces And Contracts](./001-session-core.md#interfaces-and-contracts)). The unknown-id rejection wire-shape is `-32602 InvalidParams` + `data.type: "session.not_found"` per [error-contracts.md §JSON-RPC Wire Mapping](../architecture/contracts/error-contracts.md#json-rpc-wire-mapping) + [Plan-006 §Invariants I-006-8](../plans/006-local-ipc-and-daemon-control.md#invariants) (the registered dotted-namespace code rides as `data.type` in the two-layer envelope), implemented via `SessionNotFoundError` at `packages/runtime-daemon/src/ipc/session-errors.ts` and its `mapJsonRpcError` discriminator branch at `packages/runtime-daemon/src/ipc/jsonrpc-error-mapping.ts`. Wire shape inherits [Spec-001 §Required Behavior](./001-session-core.md#required-behavior). Structural invariants (I-006-6 duplicate-registration rejection at register-time + I-006-7 schema-validates-before-dispatch) inherit via the shared `router.register` substrate, proven by Plan-006 Phase 3 test ID `I-006-3-T5` against `session.create`'s identical binding shape; the per-method binding lives at `packages/runtime-daemon/src/ipc/handlers/session-read.ts`. Verified directly by Plan-006 Phase 3 test ID `I-006-3-T8` (happy-path round-trip + unknown-id `SessionNotFoundError` → `-32602` + `data.type: "session.not_found"` wire shape); lives in `packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts`.
- [ ] **AC-N3** (`session.subscribe`) — handler returns the subscribe-init envelope (`{ subscriptionId }`) BEFORE the first replay-flush notification per [I-006-10](../plans/006-local-ipc-and-daemon-control.md) (subscribe-init response precedes the first notification frame); the SDK-side `LocalSubscriptionConsumer<EventEnvelope>` supports `[Symbol.asyncIterator]` per [CP-006-4](../plans/006-local-ipc-and-daemon-control.md) (typed JSON-RPC client transport cross-plan obligation); `onCancel` fires across externally-imposed cancel paths per [I-006-11](../plans/006-local-ipc-and-daemon-control.md). Verified directly by Plan-006 Phase 3 test IDs `I-006-3-T3` (subscribe round-trip + cancel idempotency + frame shape) + `I-006-3-T6` (daemon-side `setImmediate`-buffered response-before-notify wire-ordering invariant) + `I-006-3-T7` (SDK-side synchronous `#subscriptions` registration in `#handleResponse`; Codex P1 regression). T3 + T6 live in `packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts`; T7 lives in `packages/client-sdk/src/transport/__tests__/jsonRpcClient.test.ts`.
- [ ] A request whose `id` exceeds the §Wire Format bound is refused as `-32600 Invalid Request` before the handler runs, the refusal carries `id: null` rather than the offending value, and the connection stays open — the request fails, not the session. Stated as [I-006-22](../plans/006-local-ipc-and-daemon-control.md); verified by the oversized-id group of the gateway suite at `packages/runtime-daemon/src/ipc/__tests__/local-ipc-gateway.test.ts`, which covers both gate orders — the id gate's own refusal and an earlier envelope gate answering first — and carries an under-bound id as its negative control.
- [ ] A dispatched handler can read the daemon-resolved calling principal from its dispatch context, and a handler that requires one refuses rather than proceeding when the identity provider has not supplied it. Stated as [I-006-21](../plans/006-local-ipc-and-daemon-control.md); verified by [Plan-006](../plans/006-local-ipc-and-daemon-control.md) Phase 2B task `T-006p-2B-1`, whose tests include the fail-closed negative control (provider unwired ⇒ absent member ⇒ a requiring handler refuses rather than defaulting).

## ADR Triggers

- If the system chooses a different default local transport boundary, create or update `../decisions/008-default-transports-and-relay-boundaries.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: browser-only local clients are out of scope. Desktop and CLI are the only first-class local clients in the first release.

## References

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md)
