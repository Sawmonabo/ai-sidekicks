# Remote Control Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-025 — Remote Control Bootstrap (control-plane tRPC)

The control plane's typed [tRPC v11](https://trpc.io/) router is served from Cloudflare Workers via [`@trpc/server/adapters/fetch`](https://trpc.io/docs/server/adapters/fetch) per [ADR-013 tRPC Control-Plane API](../../decisions/013-trpc-control-plane-api.md). The control plane keeps no session record, so it serves no session route and no session event stream: a device reaches a session only through the machine that holds it, over the relay, and that machine's service answers with its own `session.*` methods (session-payloads.md §Session Method-Name Registry).

The procedure-type assignments follow the tRPC convention: read-only operations use `query` (HTTP GET-like, idempotent); writes / state-changes use `mutation` (HTTP POST-like, non-idempotent). Method-name strings are `dotted-camelCase` per the format defined in local-ipc-payloads.md §Plan-005-Partial — Local IPC Daemon Control — the same convention applies to Plan-025's tRPC HTTP procedures and Plan-005's JSON-RPC IPC methods, so client SDK call-site shape is symmetric across local IPC and remote control-plane calls. Within-segment camelCase is permitted in nested namespaces per LSP precedent (e.g. `textDocument.didOpen`, `session.restorePreview`).

## Plan-025 — Machine Registration

The `runtimenode` namespace names the one machine that runs the daemon; "runtime node" is the backend's word for it. The machine registers with the control plane through `runtimenode.register` each time its service starts, keyed by its id and its owning user and never by a session ([Plan-025](../../plans/025-remote-control.md)). Other devices read whether the machine is reachable from its relay connection, so the namespace has no attach, heartbeat, capability or roster method, and no session carries a `runtime_node.*` event. This document specifies the `runtimenode.*` methods in the §Machine Registration Method Registry below.

Method-name strings are `dotted-camelCase` per `METHOD_NAME_FORMAT`, defined in local-ipc-payloads.md §Plan-005-Partial — Local IPC Daemon Control (the `register(method, …)` guard at the regex constant). The `runtimenode` namespace token is the concatenated domain noun: `runtimeNode` would also validate, but the concatenated root is the registered form and stays as it is. The underscore `runtime_node` form is **rejected** as a method name by `METHOD_NAME_FORMAT` (no underscores).

### Machine Registration Method Registry

The machine's own record on the control plane: the daemon registers it, and the person renames or removes it from any linked device. Every call is decided against the caller's verified PASETO `sub`; a call that changes a row decides against that row read under lock in the same transaction, and a caller who does not own the machine is refused `runtimenode.permission_denied`, the one refusal that never says whether the machine exists. The owning user is always the caller's verified identity and never a request member. The shapes are in `packages/contracts/src/runtime-node/registration.ts`, and the statements rename and remove carry in `packages/contracts/src/trust-statement.ts`.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `runtimenode.register` | `mutation` | `RuntimeNodeRegisterRequest` | `EmptyPayload` (`{}`) — control-plane tRPC ONLY, **daemon-called** each time the service starts; accepted only for the key enrolled at sign-in, and refreshes the machine's row (Plan-025 Phase 3) |
| `runtimenode.rename` | `mutation` | `RuntimeNodeRenameRequest` | `EmptyPayload` (`{}`) — control-plane tRPC ONLY (Plan-025 Phase 3) |
| `runtimenode.remove` | `mutation` | `RuntimeNodeRemoveRequest` | `EmptyPayload` (`{}`) — control-plane tRPC ONLY; the removal is the `runtimenode.removed` statement it posts to the account's chain (Plan-025 Phase 5) |
| `runtimenode.certificateChallengeSet` | `mutation` | `RuntimeNodeCertificateChallengeSetRequest` | `EmptyPayload` (`{}`) — self-hosted relay ONLY, **daemon-called** while a shared-port certificate for the machine's wildcard name is being issued (Plan-025 Phase 8) |

```ts
// A request or reply that carries nothing: the method's whole effect is what it changed. Any member is
// refused.
type EmptyPayload = Record<string, never>; // {}

interface RuntimeNodeRegisterRequest {
  nodeId: NodeId;
  identityKey: MachineIdentityKey; // the service's Ed25519 key, the one key a machine has: `{algorithm: "ed25519", publicKey}`, the public half in base64 (32 bytes); stored as runtime_nodes.public_key and key_algorithm
  name: string; // the machine's name as the person sees it; at most 256 chars
  platform: string; // the operating system the service runs on, as the service reports it; at most 128 chars
  serviceVersion: string; // the service's version; at most 64 chars
}

// A rename, as the `runtimenode.renamed` statement a trusted key signed:
// {kind: "runtimenode.renamed", previousHash, issuedAt, signatures, nodeId, name}.
interface RuntimeNodeRenameRequest {
  statement: RuntimeNodeRenamedStatement;
}

// A removal, as the `runtimenode.removed` statement a trusted key signed:
// {kind: "runtimenode.removed", previousHash, issuedAt, signatures, nodeId}. The machine comes back
// only by being linked again, under a new identity key and its same id.
interface RuntimeNodeRemoveRequest {
  statement: RuntimeNodeRemovedStatement;
}

// The TXT record an ACME DNS challenge asks for. The relay writes it only for a machine that proves
// its key, and only for the minutes of the challenge.
interface RuntimeNodeCertificateChallengeSetRequest {
  name: string; // `_acme-challenge.<domain>`, at most 253 chars, so the request can never write any other record
  value: string; // the 43-character base64url SHA-256 digest
}
```

### Device, Statement Chain And Push Method Registry

The control-plane procedures that keep the person's devices, passkeys and trust chain, and deliver a sealed push. A device calls them directly; the desktop app calls them through the service's `controlPlane.call`. Every call is decided against the caller's verified PASETO `sub`, from any device the chain has not revoked, and the owning user is never a request member. The members are the ones [Spec-027 §Interfaces And Contracts](../../specs/027-remote-control.md#interfaces-and-contracts) states; the `device.*` shapes are in `packages/contracts/src/device.ts` and `push.send`'s in `packages/contracts/src/push.ts`, each landing with the unit that builds it.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `device.list` | `subscription` | `DeviceListRequest` | `DeviceListSnapshot`, then `DeviceListEvent` (stream) — the machines, devices and passkeys with each one's connected state and last-seen time, then each statement's event carrying its kind as its name, `device.forgotten` and `runtimenode.registered`; event-driven, no polling (Plan-025 Phase 5) |
| `device.linkStart` | `mutation` | `DeviceLinkStartRequest` | `DeviceLinkStartResponse` — opens the five-minute single-use link (Plan-025 Phase 5) |
| `device.linkRedeem` | `mutation` | `DeviceLinkRedeemRequest` | `DeviceLinkRedeemResponse` — the new device redeems the link; both devices then show the six digits derived from their keys (Plan-025 Phase 5) |
| `device.link` | `mutation` | `DeviceLinkRequest` | `EmptyPayload` (`{}`) — posts the `device.linked` statement; re-linking on the same key is refused (Plan-025 Phase 5) |
| `device.linkCancel` | `mutation` | `DeviceLinkCancelRequest` | `EmptyPayload` (`{}`) (Plan-025 Phase 5) |
| `device.rename` | `mutation` | `DeviceRenameRequest` | `EmptyPayload` (`{}`) — posts the `device.renamed` statement (Plan-025 Phase 5) |
| `device.revoke` | `mutation` | `DeviceRevokeRequest` | `EmptyPayload` (`{}`) — posts the `device.revoked` statement (Plan-025 Phase 5) |
| `device.forget` | `mutation` | `DeviceForgetRequest` | `EmptyPayload` (`{}`) — removes a revoked device's row; its `device.revoked` stays in the chain (Plan-025 Phase 5) |
| `device.statementList` | `query` | `DeviceStatementListRequest` `{after}` | `DeviceStatementListResponse` — the account's statements after the given head (Plan-025 Phase 2) |
| `device.pushAddressSet` | `mutation` | `DevicePushAddressSetRequest` `{platform: "apns" \| "fcm" \| "webPush", address}` | `EmptyPayload` (`{}`) — stored as `devices.push_address`, dropped at revoke (Plan-025 Phase 5) |
| `push.send` | `mutation` | `PushSendRequest` | `EmptyPayload` (`{}`) — **daemon-called**: the machine hands over a notice it sealed, and the control plane delivers it through the person's own APNs, FCM or VAPID credentials, storing nothing about it; every push expires after 24 hours (Plan-025 Phase 5) |

```ts
// One sealed push. The machine seals every notice to the device's own push key before it leaves, so
// the control plane and the push services carry bytes they cannot open.
interface PushSendRequest {
  deviceId: DeviceId;
  sealed: string; // standard base64, 1 to 4096 decoded bytes: every platform's 4 KB payload limit
  // Derived from the moment's stable id, so a later notice for the same moment replaces the earlier
  // one in place; 1 to 32 base64url characters, Web Push's `Topic` limit.
  collapseId: string;
  urgency: "high" | "normal"; // `Waiting on you` and a workflow's Notify step go at `high`; `Finished` and `Failed` at `normal`
  expiresAt: string; // ISO-8601 with offset; 24 hours after the moment
}
```

### Session Terminal-Control Method Registry

The shared-terminal write lease ([Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)) exposes one `session.*` method, `session.takeControl`. A **second `session.*` method sits in the second table row and is not a lease operation at all** — `session.setTerminalFlowControl`, the renderer's back-pressure signal, registered and specified in its own block after the lease shapes below; it is grouped here because it addresses the same shell surface and takes the same transport posture, and it is called out as separate because it gates no bytes, holds no lease and adjudicates nothing. The lease method is **daemon JSON-RPC ONLY** — deliberately NOT the dual-transport shape of the `runtimenode.*` mutations above: for those, the tRPC callee (the control plane) is itself the record authority, whereas the lease authority is the terminal-owning daemon, so a tRPC registration would place the mutation on a party that can neither adjudicate nor enforce it. A Remote Control device calls the same method over its end-to-end channel to the machine, and the relay carries it as ciphertext it cannot read, so every take is adjudicated where the lease lives. **The machine is the only lease authority, and the control plane keeps no copy of the lease.** Every client — the machine's own windows and every Remote Control device alike — reads the holder by folding the daemon's `pty.control_changed` broadcasts; the daemon broadcasts every take and the auto-releases (disconnect, and an agent run's command ending or the run leaving `running` — [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)). No control-plane table, roster member or projection-sync call carries a holder, so nothing about a shell reaches the control plane.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.takeControl` | `mutation` | `SessionTakeControlRequest` | `SessionTakeControlResponse` — daemon JSON-RPC ONLY in V1 (no control-plane tRPC registration; [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior) transport posture) |
| `session.setTerminalFlowControl` | `mutation` | `SessionSetTerminalFlowControlRequest` | `SessionSetTerminalFlowControlResponse` — daemon JSON-RPC ONLY (the same V1 transport posture as the lease method: the PTY host this drives is daemon-local, so no other party can act on the signal). Not a lease operation — consumed by [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-7 |

**One lease per shell.** A session opens as many shells as the machine can hold, each its own tab, and the write lease is keyed per shell rather than per session: `terminalId` is a required member of the take request and of the flow-control signal below, and every `pty.control_changed` broadcast carries it, so the holder is named PER SHELL: so one device can hold one shell while another of the account's devices — or an agent's running command — holds another. Without the key a take on one tab would silently move every other tab's lease, and the lease line under the tab strip could not speak for the active tab alone. The identifier is the daemon's own handle for that shell; no client mints one. The daemon's own lease record is keyed per shell with it, so two shells' transitions never serialize against each other.

**No release verb.** A shell's lease belongs to the connections of the holding device that took it; a device's connection that takes a shell the device already holds joins the hold. A device gives a shell back only by another device taking it, or by the last of those connections ending — the pane closing or the socket dropping, a lid closed mid-command included — which is the disconnect auto-release; closing a pane gives back only the leases no other connection of that device took too. Nothing on any screen releases a shell, so no operation does.

**The forced take.** `session.takeControl` carries a `force` member rather than a second method, because the act is the same act under a stronger precondition. A forced take moves the shell's lease off ANOTHER OF THE ACCOUNT'S DEVICES, broadcasts `pty.control_changed` with the reason `taken_by_force`, and never touches the foreground process — the handoff lands between write frames, so a running program is untouched and the displaced device loses only a half-typed line. It is **refused while an agent run's command holds the shell**, and that refusal is normative rather than a courtesy: the person stops that command from its row, or pauses or interrupts the run, and the hold ends when the command ends or the run leaves `running`, whichever comes first. The refusal is what makes the agent-path hold different from the device-path hold, so an agent-held shell is NOT the idempotent self-retake case even though both holds sit on the same device: a run's hold is a holder of its own, named on the lease record and on every broadcast as `holderRunId`, which is exactly what the precondition reads.

```ts
interface SessionTakeControlRequest {
  sessionId: SessionId; // no caller field on the wire — the caller is the connection's device, per the transport rule below
  // The shell this lease is for. The lease is one per shell, so every take names its shell.
  terminalId: string;
  // A forced take moves the lease off another of the account's devices. Absent or `false` is the
  // ordinary first-acquire take, which refuses `pty.control_held_by_other` against a live holder.
  force?: boolean;
}

interface SessionTakeControlResponse {
  terminalId: string;
  holderDeviceId: string; // the calling DEVICE's identifier — first-acquire-holds, or the force, succeeded
}
```

**The renderer's back-pressure signal.** `session.setTerminalFlowControl` is the daemon-facing operation behind the renderer terminal's own flow control, declared per shell by each connection watching that shell: the connection declares the shell paused when its terminal says it is behind, and resumed once it has caught up. The daemon pauses the shell's read on its PTY host only while every live watcher of that shell is behind, so a flooding process is slowed where it is producing rather than filling the renderer and losing output at a discard watermark ([Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-7, which consumes this method and maps the pause onto each backend). A single watcher that falls behind while another keeps up stops receiving output and catches up from the shell's scrollback window or from a snapshot, so one slow device never freezes a healthy one, and a connection's behind state clears when that connection ends. **It is keyed by the shell and the watching connection**: `terminalId` is a required member, because a session opens several shells and a pause on one never stalls another, and the connection is the caller's own, known from the transport and never a request member. **One method with a boolean rather than a pair**, because the renderer is declaring a state it is in rather than asking for two different acts, and a declared state is idempotent — the same value twice is the same state and changes nothing. It is **not gated by the write lease**: it moves no bytes toward the shell and asserts no authority over it, so making it lease-held would let a device without the lease be flooded by its own terminal with no way to say so. It mints **no error code**: a call naming a shell this daemon does not hold is an accepted no-op, because a back-pressure signal racing a closing shell is ordinary and a refusal would hand the client something it can do nothing about.

```ts
interface SessionSetTerminalFlowControlRequest {
  sessionId: SessionId; // no caller field on the wire — the caller is the connection's device, per the transport rule below
  // The shell this connection is declaring its state for; the daemon's own handle, as on the take.
  terminalId: string;
  // The state this connection is declaring for that shell: true while it is behind, false once it has
  // caught up. Not a pair of verbs — the same value twice is the same state.
  paused: boolean;
}

interface SessionSetTerminalFlowControlResponse {
  accepted: true; // the uniform lifecycle-success shape this document already uses; nothing is read back
}
```

Refusals are typed in [Error Contracts §PTY](./error-contracts.md#pty): holder identity is session-visible presence metadata (the `pty.control_changed` broadcast exposes it to the account's own devices); a take while another of the account's devices holds the lease returns `pty.control_held_by_other` with `data.fields.holderDeviceId`; a device's first write to a shell nobody holds takes that shell for the connection it came on, broadcast `reason: 'taken'`, and lands, so of two devices writing at once exactly one takes it; any other write from a writer that does not hold the shell returns `pty.control_not_held`. A take by the current holder is idempotent success — no transition occurs and nothing broadcasts. Every successful transition broadcasts `pty.control_changed` ([Spec-005 census](../../specs/005-session-event-taxonomy-and-audit-log.md#pty-control-session_lifecycle)), authored by the terminal-owning daemon; transitions include the auto-releases — holder disconnect and the agent-run release (the end of the command the run took the shell for, or the acquiring run's first lifecycle transition out of `running` after an agent-path take, whichever comes first; the acquiring run and its command are set by the daemon on the lease record, with the agent read from the run, never taken from a request field, and move to the new run on an agent-path take from a different run on the same device, which broadcasts like any change of holder; an agent-path take off a device's hold keeps that hold aside with its connections, and the agent-run release hands the shell back to it, naming that device as the holder, while one of those connections is open, and to nobody otherwise). A take broadcasts `reason: 'taken'`, a forced take `'taken_by_force'`, and the auto-release classes `'auto_released_disconnect' | 'auto_released_command_ended' | 'auto_released_run_idle'` ([Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)); every broadcast carries `terminalId`, and `previousHolderDeviceId` names the holder the change ended, `null` only on a take of a shell nobody held, so every release names one. A client reads a broadcast carrying `released` or `auto_released_authorization_lost` as an unread transition. The take request carries no caller field: the caller is the connection's device. A local daemon JSON-RPC caller is the **device co-located with the node**, the daemon's own recorded local device, and the node's own agent runs take a shell for each command through the daemon's in-process lease authority on that **same device** (no wire hop), but a run's hold is a holder of its own. The lease record keeps the run, and the `pty.control_changed` broadcast names it as `holderRunId`, absent while a device holds the shell, while `holderDeviceId` stays the machine's own device identity; the agent is read from the run, so every device reads that an agent's running command holds the shell and is offered the run's own stop rather than a take, and a take against a run's hold — from the node's own device included — is refused with `pty.control_held_by_other` rather than treated as the idempotent self-retake case. A linked device's take binds the **device identity** its channel's handshake proves ([§Authenticated Principal And Authorization Model](./api-payload-contracts.md#authenticated-principal-and-authorization-model)) and rides the terminal-byte channel per Spec-002's forward constraint — so `holderDeviceId` and the idempotent self-retake comparison are well-defined on every path that can reach the lease authority.

## Plan-025 — Remote Control Relay

```ts
// RelayNegotiation — one relay connection per device key and one per machine key. No session appears
// here: one channel joins one device and one machine and carries every session on that machine.
interface RelayNegotiationRequest {
  nodeId: NodeId; // the machine the connection reaches: the caller's own machine, or the machine a device opens its channel to
  transportPreferences: string[]; // e.g. ['websocket', 'http2']
}
interface RelayNegotiationResponse {
  relayEndpoint: string; // the WSS URL the caller dials
  transportProtocol: string;
  connectionToken: string; // short-lived connect token bound to the calling device or machine and to the machine it reaches; a token presented for another device or machine is refused, and an expired one is refused
  ttl: number; // seconds
}

// The control plane keeps no presence record and no session. Whether a device is connected is read
// from its relay connection onto `device.list` (§Device, Statement Chain And Push Method
// Registry). After a reconnect the
// device runs a fresh handshake on its channel and reopens its sessions over it, each stream resuming
// from its last event through the machine's own `session.*` methods.
```

**The channel.** Each channel is the Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256` handshake and transport, run afresh on every connection and every 10 minutes on a long one ([Spec-027 §The encryption envelope](../../specs/027-remote-control.md#the-encryption-envelope)). The connection's first frame, before any handshake message, is `{channelVersion, profiles}`: the channel version and the profiles the connecting device runs, in its order of preference. The machine answers `{profile}`, the first of them it also runs, or closes the connection with `channel.no_common_profile` ([Error Contracts §Relay](./error-contracts.md#relay)), with nothing to fall back to. Both ends bind the offer and the answer into the handshake's prologue. A profile is one full Noise protocol name, and there is one, `Noise_KK_25519_ChaChaPoly_SHA256`. The first frame's shape, the profile names and `channel.no_common_profile` are wire, so they live in `packages/contracts`, and the shared channel package, which holds the handshake and the transport, imports them.
