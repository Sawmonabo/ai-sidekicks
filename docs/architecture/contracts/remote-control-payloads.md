# Remote Control Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-025 — Remote Control Bootstrap (control-plane HTTP routes)

The control plane's request-response operations are HTTP routes served from Cloudflare Workers by `axum` on `worker` per [ADR-013 Control Plane API](../../decisions/013-control-plane-api.md): one POST per procedure with a JSON body, a refusal answered `{code, category, message}`, and the control plane's own streams as Server-Sent Events. The control plane keeps no session record, so it serves no session route and no session event stream: a device reaches a session only through the machine that holds it, and that machine's service answers with its own `session.*` methods (session-payloads.md §Session Method-Name Registry).

The procedure types follow [API Payload Contracts §Procedure Types](./api-payload-contracts.md#procedure-types). Every procedure, event and error code takes its name from the one wire grammar in [Local IPC Payload Contracts §Wire-Name Grammar](./local-ipc-payloads.md#wire-name-grammar), `domain[.resource].action`, lowerCamelCase segments joined by dots with the action last, the same for Plan-025's control-plane HTTP procedures and Plan-005's JSON-RPC IPC methods, so a client's call sites read alike over local IPC and the control plane.

## Plan-025 — Machine Registration

The machine registration methods are those of the one machine that runs the daemon. The machine registers with the control plane through `machine.register` each time its service starts, keyed by its id and its owning user and never by a session ([Plan-025](../../plans/025-remote-control.md)). Other devices read whether the machine is reachable from its relay connection, so registration has no attach, heartbeat, capability or roster method, and no session carries a machine event. This document specifies the four registration methods, `machine.register`, `machine.rename`, `machine.remove` and `machine.certificateChallenge.update`, in the §Machine Registration Method Registry below; `machine.settings.*` and `machine.folder.list` are the daemon's own and are not here.

Method names follow [Local IPC Payload Contracts §Wire-Name Grammar](./local-ipc-payloads.md#wire-name-grammar), whose build-time check refuses an underscore in any segment.

### Machine Registration Method Registry

The machine's own record on the control plane: the daemon registers it, and the person renames or removes it from any linked device. Every call is decided against the caller's verified PASETO `sub`; a call that changes a row decides against that row as read in the transaction that writes it, and a caller who does not own the machine is refused `machine.permissionDenied`, the one refusal that never says whether the machine exists. The owning user is always the caller's verified identity and never a request member. The shapes are in `crates/sidekicks-contracts/src/machine/registration.rs`, and the statements rename and remove carry in `crates/sidekicks-contracts/src/trust_statement.rs`.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `machine.register` | `mutation` | `MachineRegisterRequest` | `EmptyPayload` (`{}`) — control-plane route ONLY, **daemon-called** each time the service starts; accepted only for the key enrolled at sign-in or a removed machine's new key at its relink, and refreshes the machine's row; refused with `machine.keyChanged` (409) when the account holds the id under another identity key, and `machine.permissionDenied` (403) for a machine the caller does not own (Plan-025 Phase 3) |
| `machine.rename` | `mutation` | `MachineRenameRequest` | `EmptyPayload` (`{}`) — control-plane route ONLY (Plan-025 Phase 3) |
| `machine.remove` | `mutation` | `MachineRemoveRequest` | `EmptyPayload` (`{}`) — control-plane route ONLY; the removal is the `machine.removed` statement it posts to the account's chain (Plan-025 Phase 5) |
| `machine.certificateChallenge.update` | `mutation` | `MachineCertificateChallengeUpdateRequest` | `EmptyPayload` (`{}`) — self-hosted relay ONLY, **daemon-called** while a shared-port certificate for the machine's wildcard name is being issued (Plan-025 Phase 8) |

```ts
// A request or reply that carries nothing: the method's whole effect is what it changed. Any member is
// refused.
type EmptyPayload = Record<string, never>; // {}

interface MachineRegisterRequest {
  machineId: MachineId;
  identityKey: MachineIdentityKey; // the service's Ed25519 key, the one key a machine has: `{algorithm: "ed25519", publicKey}`, the public half in base64 (32 bytes); stored as machines.public_key and key_algorithm
  name: string; // the machine's name as the person sees it; at most 256 chars
  platform: string; // the operating system the service runs on, as the service reports it; at most 128 chars
  serviceVersion: string; // the service's version; at most 64 chars
}

// A rename, as the `machine.renamed` statement a trusted key signed:
// {kind: "machine.renamed", previousHash, issuedAt, signatures, machineId, name}.
interface MachineRenameRequest {
  statement: MachineRenamedStatement;
}

// A removal, as the `machine.removed` statement a trusted key signed:
// {kind: "machine.removed", previousHash, issuedAt, signatures, machineId}. The machine comes back
// only by being linked again, under new identity and channel keys and its same id.
interface MachineRemoveRequest {
  statement: MachineRemovedStatement;
}

// The TXT record an ACME DNS challenge asks for. The relay writes it only for a machine that proves
// its key, and only for the minutes of the challenge.
interface MachineCertificateChallengeUpdateRequest {
  name: string; // `_acme-challenge.<domain>`, at most 253 chars, so the request can never write any other record
  value: string; // the 43-character base64url SHA-256 digest
}
```

### Device, Statement Chain And Push Method Registry

The control-plane procedures that keep the person's devices, passkeys and trust chain, and deliver a sealed push. A device calls them directly; the desktop app follows `device.subscribe` through the service's `controlPlane.subscribe` and calls the rest through its `controlPlane.call`. Every call is decided against the caller's verified PASETO `sub`, from any device the chain has not revoked, and the owning user is never a request member. The members are the ones [Spec-027 §Interfaces And Contracts](../../specs/027-remote-control.md#interfaces-and-contracts) states; the `device.*` shapes are in `crates/sidekicks-contracts/src/device.rs` and `device.push.send`'s in `crates/sidekicks-contracts/src/push.rs`, each landing with the unit that builds it.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `device.subscribe` | `subscription` | `EmptyPayload` (`{}`) | `DeviceListSnapshot`, then `DeviceListEvent` (stream) — the machines, devices and passkeys with each one's connected state and last-seen time and `statementHead`, the chain's newest statement; then each statement's event carrying its kind as its name, `device.forgotten` and `machine.registered`, and after every change, a statement's or any other, the whole `DeviceListSnapshot` again, which a reader that holds a list puts in its place; event-driven, no polling; keepalives and the stream's end at its token's expiry or its family's revocation per [ADR-013](../../decisions/013-control-plane-api.md) (Plan-025 Phase 5) |
| `device.link.start` | `mutation` | `EmptyPayload` (`{}`) | `DeviceLinkStartResponse` — opens the five-minute single-use link (Plan-025 Phase 5) |
| `device.link.redeem` | `mutation` | `DeviceLinkRedeemRequest` | `DeviceLinkRedeemResponse` — the new device redeems the link; both devices then show the six digits derived from their keys (Plan-025 Phase 5) |
| `device.link.confirm` | `mutation` | `DeviceLinkConfirmRequest` | `EmptyPayload` (`{}`) — posts the `device.linked` statement; re-linking on the same key is refused (Plan-025 Phase 5) |
| `device.link.cancel` | `mutation` | `DeviceLinkCancelRequest` | `EmptyPayload` (`{}`) (Plan-025 Phase 5) |
| `device.rename` | `mutation` | `DeviceRenameRequest` | `EmptyPayload` (`{}`) — posts the `device.renamed` statement (Plan-025 Phase 5) |
| `device.revoke` | `mutation` | `DeviceRevokeRequest` | `EmptyPayload` (`{}`) — posts the `device.revoked` statement (Plan-025 Phase 5) |
| `device.forget` | `mutation` | `DeviceForgetRequest` | `EmptyPayload` (`{}`) — removes a revoked device's row; its `device.revoked` stays in the chain (Plan-025 Phase 5) |
| `device.statement.list` | `query` | `DeviceStatementListRequest` `{after}` | `DeviceStatementListResponse` — the account's statements after the given head (Plan-025 Phase 2) |
| `device.pushAddress.update` | `mutation` | `DevicePushAddressUpdateRequest` `{platform: "apns" \| "webPush", address}` | `EmptyPayload` (`{}`) — stored as `devices.push_address`, dropped at revoke (Plan-025 Phase 5) |
| `device.push.send` | `mutation` | `DevicePushSendRequest` | `EmptyPayload` (`{}`) — **daemon-called**: the machine hands over a notice it sealed, and the control plane delivers it through the person's own APNs or VAPID credentials, storing nothing about it; every push expires after 24 hours (Plan-025 Phase 5) |

**The six linking digits.** After `device.link.redeem`, both devices compute the six digits from the link's secret, both devices' keys and the list of machine keys: HKDF-SHA256, the secret as input key, an empty salt, the RFC 8785 bytes of `{linkingKey, newKey, machineKeys}` (keys base64url, `machineKeys` sorted by raw key bytes) as info, the first 4 output bytes big-endian mod 10^6, zero-padded to six. One fixed test vector (the secret, both devices' keys, the machine keys and the expected six digits), committed with the code that computes the digits, is checked by the service and by the phone.

```ts
// One sealed push. The machine seals every notice to the device's own push key before it leaves, so
// the control plane and the push services carry bytes they cannot open.
interface DevicePushSendRequest {
  deviceId: DeviceId;
  sealed: string; // standard base64, 1 to 4096 decoded bytes: every platform's 4 KB payload limit
  // Derived from the moment's stable id, so a later notice for the same moment replaces the earlier
  // one in place; 1 to 32 base64url characters, Web Push's `Topic` limit.
  collapseId: string;
  urgency: "high" | "normal"; // `Waiting on you` and a workflow's Notify step go at `high`; `Finished` and `Failed` at `normal`
  expiresAt: string; // ISO-8601 with offset; 24 hours after the moment
}
```

### Terminal Control Method Registry

The shared-terminal write lease ([Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)) has one method, `terminal.control.take`. A **second method sits in the second table row and is not a lease operation at all** — `terminal.flowControl.update`, the renderer's back-pressure signal, registered and specified in its own block after the lease shapes below; it is grouped here because it addresses the same shell surface and takes the same transport posture, and it is called out as separate because it gates no bytes, holds no lease and adjudicates nothing. The lease method is **daemon JSON-RPC ONLY** — deliberately NOT the dual-transport shape of the machine registration mutations above: for those, the control-plane callee is itself the record authority, whereas the lease authority is the terminal-owning daemon, so a control-plane route would place the mutation on a party that can neither adjudicate nor enforce it. A Remote Control device calls the same method over its end-to-end channel to the machine, and the relay carries it as ciphertext it cannot read, so every take is adjudicated where the lease lives. **The machine is the only lease authority, and the control plane keeps no copy of the lease.** Every client — the machine's own windows and every Remote Control device alike — reads the holder by folding the daemon's `terminal.control.changed` broadcasts with the holder each shell's `terminal.subscribe` entry and the scrollback frame opening its output name; the daemon broadcasts every take and the auto-releases (disconnect, a closed pane, and an agent run's command ending or the run leaving `running` — [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)). No control-plane table, roster member or projection-sync call carries a holder, so nothing about a shell reaches the control plane.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `terminal.control.take` | `mutation` | `TerminalControlTakeRequest` | `TerminalControlTakeResponse` — daemon JSON-RPC ONLY in V1 (no control-plane route; [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior) transport posture) |
| `terminal.flowControl.update` | `mutation` | `TerminalFlowControlUpdateRequest` | `TerminalFlowControlUpdateResponse` — daemon JSON-RPC ONLY (the same V1 transport posture as the lease method: the shell's read loop this drives is daemon-local, so no other party can act on the signal). Not a lease operation — consumed by [Plan-021](../../plans/021-terminal.md) T-021-3B-5 |

**One lease per shell.** A session opens as many shells as the machine can hold, each its own tab, and the write lease is keyed per shell rather than per session: `terminalId` is a required member of the take request and of the flow-control signal below, and every `terminal.control.changed` broadcast carries it, so the holder is named PER SHELL: so one device can hold one shell while another of the account's devices — or an agent's running command — holds another. Without the key a take on one tab would silently move every other tab's lease, and the lease line under the tab strip could not speak for the active tab alone. The identifier is the daemon's own handle for that shell; no client mints one. The daemon's own lease record is keyed per shell with it, so two shells' transitions never serialize against each other.

**No release verb.** Each binding of a shell's lease is a connection and the output subscription of the pane it took or wrote to the shell through; a further connection or pane of the holding device that takes the shell, or a further pane of a bound connection that writes to it, joins the hold with a binding of its own. The connection ending or the subscription closing ends that binding, and the hold ends with its last. A device gives a shell back only by another device taking it, or by the last of those bindings ending: the socket dropping, a lid closed mid-command included, which is the disconnect auto-release (a connection's end is read before the ends of the subscriptions it carried), or the pane closing, which is the pane-closed auto-release, so closing a pane gives back this device's leases on that pane's shells unless another of its panes took them too, and the shells keep running. Nothing on any screen releases a shell, so no operation does.

**The lease version.** Every change of a shell's holder raises that shell's lease version, a whole number that is zero before anyone has held the shell, by one. The daemon never gives a terminal id to a second shell, so one id's versions always count one shell's changes. `terminal.control.changed` carries the version after the change, and the shell's `terminal.subscribe` entry and the scrollback frame that opens its `terminal.output.subscribe` carry the version of the holder they name, so a client folding all three keeps whichever reading carries the higher version: a change delivered after a newer listing never undoes it.

**The forced take.** `terminal.control.take` carries a `force` member rather than a second method, because the act is the same act under a stronger precondition. A forced take moves the shell's lease off ANOTHER OF THE ACCOUNT'S DEVICES, broadcasts `terminal.control.changed` with the reason `takenByForce`, and never touches the foreground process — the handoff lands between write frames, so a running program is untouched and the displaced device loses only a half-typed line. It is **refused while an agent run's command holds the shell**, and that refusal is normative rather than a courtesy: the person stops that command from its row, or pauses or interrupts the run, and the hold ends when the command ends or the run leaves `running`, whichever comes first. The refusal is what makes the agent-path hold different from the device-path hold, so an agent-held shell is NOT the idempotent self-retake case even though both holds sit on the same device: a run's hold is a holder of its own, named on the lease record and on every broadcast as `holderRunId`, which is exactly what the precondition reads.

```ts
interface TerminalControlTakeRequest {
  sessionId: SessionId; // no caller field on the wire — the caller is the connection's device, per the transport rule below
  // The shell this lease is for. The lease is one per shell, so every take names its shell.
  terminalId: string;
  // The caller's own `terminal.output.subscribe` subscription to this shell: the pane the take is
  // made from, refused `terminal.output.subscriptionNotFound` when it is not the calling
  // connection's open subscription to this shell. The hold is bound to it; its close ends that
  // binding, and the hold ends with its last.
  outputSubscriptionId: SubscriptionId;
  // A forced take moves the lease off another of the account's devices. Absent or `false` is the
  // ordinary first-acquire take, which refuses `terminal.control.heldByOther` against a live
  // holder.
  force?: boolean;
}

interface TerminalControlTakeResponse {
  terminalId: string;
  holderDeviceId: string; // the calling DEVICE's identifier — first-acquire-holds, or the force, succeeded
}
```

**The renderer's back-pressure signal.** `terminal.flowControl.update` is the daemon-facing operation behind the renderer terminal's own flow control, declared per shell by each connection watching that shell: the connection declares the shell paused when its terminal says it is behind, and resumed once it has caught up. The daemon pauses the shell's read only while every live watcher of that shell is behind, so a flooding process is slowed where it is producing rather than filling the renderer and losing output at a discard watermark ([Plan-021](../../plans/021-terminal.md) T-021-3B-5, which consumes this method and maps the pause onto the daemon's per-shell read loop in `sidekicks-terminal`: the loop stops draining the PTY, so the kernel buffer or ConPTY's 1 MiB pipe fills and the child blocks on write, and it reads again on resume). A single watcher that falls behind while another keeps up stops receiving output and catches up from the shell's scrollback window or from a snapshot, so one slow device never freezes a healthy one, and a connection's behind state clears when that connection ends. **It is keyed by the shell and the watching connection**: `terminalId` is a required member, because a session opens several shells and a pause on one never stalls another, and the connection is the caller's own, known from the transport and never a request member. **One method with a boolean rather than a pair**, because the renderer is declaring a state it is in rather than asking for two different acts, and a declared state is idempotent — the same value twice is the same state and changes nothing. It is **not gated by the write lease**: it moves no bytes toward the shell and asserts no authority over it, so making it lease-held would let a device without the lease be flooded by its own terminal with no way to say so. It mints **no error code**: a call naming a shell its session does not have is an accepted no-op, because a back-pressure signal racing a closing shell is ordinary and a refusal would hand the client something it can do nothing about.

```ts
interface TerminalFlowControlUpdateRequest {
  sessionId: SessionId; // no caller field on the wire — the caller is the connection's device, per the transport rule below
  // The shell this connection is declaring its state for; the daemon's own handle, as on the take.
  terminalId: string;
  // The state this connection is declaring for that shell: true while it is behind, false once it has
  // caught up. Not a pair of verbs — the same value twice is the same state.
  paused: boolean;
}

interface TerminalFlowControlUpdateResponse {
  accepted: true; // the uniform lifecycle-success shape this document already uses; nothing is read back
}
```

Refusals are typed in [Error Contracts §Terminal](./error-contracts.md#terminal): holder identity is session-visible presence metadata (the `terminal.control.changed` broadcast exposes it to the account's own devices); a take while another of the account's devices holds the lease returns `terminal.control.heldByOther` with `data.fields.holderDeviceId`; a device's first write to a shell nobody holds takes that shell for the connection it came on and the output subscription the write names, broadcast `reason: 'taken'`, and lands, so of two devices writing at once exactly one takes it; any other write from a writer the hold is not bound to, another connection of the holding device included until it takes the shell, returns `terminal.control.notHeld`, and a bound connection's write through another of its panes' subscriptions binds that subscription too. A take by the holding device is idempotent success — its connection and subscription join the hold, no transition occurs and nothing broadcasts. A take or write naming a subscription that is not the calling connection's open subscription to that shell returns `terminal.output.subscriptionNotFound`, and every request but the flow-control signal naming a shell its session does not have returns `terminal.notFound`. Every successful transition broadcasts `terminal.control.changed` ([Spec-005 census](../../specs/005-session-event-taxonomy-and-audit-log.md#terminal-control-sessionlifecycle)), authored by the terminal-owning daemon; transitions include the auto-releases — holder disconnect, a closed pane and the agent-run release (the end of the command the run took the shell for, or the acquiring run's first lifecycle transition out of `running` after an agent-path take, whichever comes first; the acquiring run and its command are set by the daemon on the lease record, with the agent read from the run, never taken from a request field, and move to the new run on an agent-path take from a different run on the same device, which broadcasts like any change of holder; an agent-path take off a device's hold keeps that hold aside with its bindings, and the agent-run release hands the shell back to it, naming that device as the holder, while one of those bindings is open, and to nobody otherwise). A take broadcasts `reason: 'taken'`, a forced take `'takenByForce'`, and the auto-release classes `'autoReleasedDisconnect' | 'autoReleasedPaneClosed' | 'autoReleasedCommandEnded' | 'autoReleasedRunIdle'` ([Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)); every broadcast carries `terminalId` and `leaseVersion`, and `previousHolderDeviceId` names the holder the change ended, `null` only on a take of a shell nobody held, so every release names one. A client reads a broadcast carrying `released` or `autoReleasedAuthorizationLost` as an unread transition. The take request carries no caller field: the caller is the connection's device. A local daemon JSON-RPC caller is the **device on the machine**, the daemon's own recorded local device, and the machine's own agent runs take a shell for each command through the daemon's in-process lease authority on that **same device** (no wire hop), but a run's hold is a holder of its own. The lease record keeps the run, and the `terminal.control.changed` broadcast names it as `holderRunId`, absent while a device holds the shell, while `holderDeviceId` stays the machine's own device identity; the agent is read from the run, so every device reads that an agent's running command holds the shell and is offered the run's own stop rather than a take, and a take against a run's hold — from the machine's own device included — is refused with `terminal.control.heldByOther` rather than treated as the idempotent self-retake case. A linked device's take binds the **device identity** its channel's handshake proves ([§Authenticated Principal And Authorization Model](./api-payload-contracts.md#authenticated-principal-and-authorization-model)) and rides the terminal-byte channel per Spec-002's forward constraint — so `holderDeviceId` and the idempotent self-retake comparison are well-defined on every path that can reach the lease authority.

## Plan-025 — Remote Control Relay

```ts
// RelayNegotiation — one relay connection per machine key and, for each machine, one per device key.
// No session appears here: one channel joins one device and one machine and carries every session
// on that machine.
interface RelayNegotiationRequest {
  machineId: MachineId; // the machine the connection reaches: the caller's own machine, or the machine a device opens its channel to
  transportPreferences: string[]; // e.g. ['websocket', 'http2']
}
interface RelayNegotiationResponse {
  relayEndpoint: string; // the WSS URL the caller dials
  // the forwarding object's name on the Workers relay, the machine id and its continent key; absent
  // on the Compose relay, whose one process forwards every channel
  forwardingObject?: string;
  // where each end asks its public address for the direct path, as host:port:
  // `stun.cloudflare.com:3478` on the Workers relay, the relay's own UDP 3478 on the Compose relay
  stunAddress: string;
  transportProtocol: string;
  connectionToken: string; // short-lived connect token bound to the calling device or machine and to the machine it reaches; a token presented for another device or machine is refused, and an expired one is refused
  ttl: number; // seconds
}

// The control plane keeps no presence record and no session. Whether a device is connected is read
// from its relay connection onto `device.subscribe` (§Device, Statement Chain And Push Method
// Registry). After a reconnect the
// device runs a fresh handshake on its channel and reopens its sessions over it, each stream resuming
// from its last event through the machine's own `session.*` methods.
```

**The channel.** Each channel is the Noise Protocol Framework's KK handshake and transport in one of two profiles, run afresh on every connection and every 10 minutes on a long one ([Spec-027 §The encryption envelope](../../specs/027-remote-control.md#the-encryption-envelope)). The connection's first frame, before any handshake message, is `{channelVersion, profiles}`: the channel version and the profiles the connecting device runs, in its order of preference. The machine answers `{profile}`, the first of them it also runs, or closes the connection with `channel.noCommonProfile` ([Error Contracts §Relay](./error-contracts.md#relay)), with nothing to fall back to. Both ends bind the offer and the answer into the handshake's prologue. A profile is one full Noise protocol name, and there are two, `Noise_KK_25519_AESGCM_SHA256` offered first and `Noise_KK_25519_ChaChaPoly_SHA256` second, on `snow` (built with `ring-accelerated`) on the machine. The first frame's shape, the profile names and `channel.noCommonProfile` are wire, so they live in `crates/sidekicks-contracts`, and the channel's TypeScript side for the web client and the iPhone app, under `packages/`, imports their generated TypeScript.
