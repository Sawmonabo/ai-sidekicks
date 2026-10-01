# Plan-028: Remote Control

| Field            | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| **Status**       | `draft`                                                    |
| **NNN**          | `028`                                                      |
| **Slug**         | `remote-control`                                           |
| **Date**         | `2026-09-11`                                               |
| **Author(s)**    | `Sawmon Abo`                                               |
| **Spec**         | [Spec-028: Remote Control](../specs/028-remote-control.md) |
| **Dependencies** | None                                                       |

## Goal

Build Remote Control: one user, many linked devices, each session executing on one of the user's machines, of which there may be any number, with every device able to do everything the desktop can.

## Scope

The daemon as a running background service, the machine's and each device's identity keys, the machine's registration and the encrypted channel through the person's own relay, the method proxy that carries a device's calls to the machine, devices, linking and revocation on the account's statement chain, push sealed on the machine, the device recorded on each event it sends, and — last and gated — the screens and the clients that surface all of it: the Devices page in Settings, the web client, the Android app, the iPhone app and the desktop app as a client of other machines.

## Non-Goals

Anything that admits a second account to a session. Anything that puts a second machine behind one session or moves a session between machines: a session runs on the machine it was started on for its whole life. A relay that serves other people.

## Build order

Backend Phases 1 to 6 in order, Phase 8 after Phase 3, then Phase 7's screens and clients. Within Phase 7 the web client comes first; the Devices page and the one-column fold follow it; the Android app follows the fold; the iPhone app comes last; the desktop app as a client of other machines follows the web client and the main process's window registry; the `sidekicks devices` commands follow Phase 5.

## Phases

### Phase 0 — Existing foundations

These exist and carry no tasks; they are named so the later phases build on them rather than rebuild them.

- **A per-device liveness machine**, keyed by device rather than by account: a live reading goes `online → reconnecting → offline` on missed presence beats, on a fifteen-second and forty-five-second grace pair. It is a device's liveness; a machine's reachability is read from its relay connection (Phase 3).
- **The tRPC host**, serving the runtime-node router behind one fetch handler, with a shared context. Its typed error envelope is built in Phase 3.
- **The client SDK's session client on the daemon transport**, speaking its method strings over the SDK transport.
- **The daemon session store and projector**: SQLite-backed append and read, and a pure fold from the event stream to a session snapshot.
- **The Postgres table for them**: `users`.

### Phase 1 — The daemon as a running process

This phase makes the daemon a process anyone can start. It gains an entry point, a local socket, a request/response surface over that socket, and a lifecycle — start, ready, shut down, and come back after a crash with its state replayed from SQLite. At its first start it mints the machine's id and identity key and reads the machine's friendly name: on macOS `scutil --get ComputerName`; on Linux `PRETTY_HOSTNAME` from `/etc/machine-info`, falling back to the static hostname; on Windows `os.hostname()`, the DNS host name without its domain, never `%COMPUTERNAME%`. The SDK's local transport is pointed at that socket.

The desktop app's main process starts the service and watches it, and never owns its life. A quit must leave the service running, and a utility-process child dies at quit, so the main process starts the service detached and reaches it through its socket (on Linux a logout ends a detached child unless lingering is on, which the install turns on); where a detached child does not survive the app, it starts the service through the per-user service the command line installs. The main process opens with the handshake (`daemon.hello`), sends `daemon.ping` only after 5 seconds with no frame from the service, counts the link as dead after 20 seconds with none, and restarts the service with backoff (100 ms, 300 ms, 1 s, 3 s, 10 s). When the service is asked to stop or restart, after the flush, a daemon that has not exited gets SIGTERM and, 2 seconds later, SIGKILL. The boot card's `Retry` starts the service (`daemon.requestStart()`). The main process carries the service's state to the renderer as the `daemon.status` topic on `daemon.subscribe`: the link state from the liveness check, and the version range — each app accepts its own service version and the previous one, and outside that range the console is read-only, naming the side that is behind with a press to its fix. The bridge refuses every renderer-issued mutating call (`daemon.stop`, `daemon.restart`) unless that topic reads connected, with a valid handshake behind it, returning a typed error; the daemon's own pre-dispatch gate is the check that decides. A quit flushes the service (`daemon.flush`) and leaves it, every run and every shell running; only Settings › Runtime's `Stop` and `Restart` end work. Nothing in this phase is remote.

**Done when**

- The daemon starts from a command and answers a method call over its local socket.
- A client that loses the socket reconnects without losing session state.
- Shutdown is clean, and a restart replays the session from its own event log.
- The machine's id, identity key and name exist after the first start and are the same after every later start.
- The desktop app starts the service detached, and quitting the app leaves the service, its runs and its shells running.
- A hung service is noticed within 20 seconds and restarted with backoff; a killed one is noticed when its socket closes.
- A renderer-issued `daemon.restart` without a connected status topic is refused with a typed error.

### Phase 2 — Identity keys and the statement chain

**Precondition:** Phase 1 merged.

This phase builds the identity keys, and the statement chain that decides which of them a machine trusts.

- **The machine key** is the service's Ed25519 identity key, minted in Phase 1, kept in the operating system's credential store as its own item through `@napi-rs/keyring` ([ADR-021](../decisions/021-cli-identity-key-storage-custody.md)).
- **A device key** is made on the device and never exported: P-256 in the iPhone's Secure Enclave, in the Android Keystore (StrongBox where there is one), and a non-extractable WebCrypto key in the web client.
- **Every public key carries its algorithm** (`p256` or `ed25519`).
- **Channel keys.** Every device and machine also keeps an X25519 channel key beside its identity key, for Phase 3's channel: the machine's kept in the credential store as its own item, like its identity key, on the phones in the Keychain and the Android Keystore's wrapped storage, in the web client a non-extractable WebCrypto key.
- **The statement chain.** The account's trust is an append-only chain of signed statements the control plane keeps — `device.linked`, `device.renamed`, `device.revoked`, `passkey.added`, `passkey.removed`, `runtimenode.added`, `runtimenode.renamed`, `runtimenode.removed` and `runtimenode.key_rotated` — each naming the hash of the one before it, each kind a past-tense fact, and each announced by a control-plane event that carries its kind as its name. The person's first machine opens it with a `runtimenode.added` it signs itself, and linking a later machine records its `runtimenode.added` signed by the device or machine that links it. The control plane keeps the chain in `trust_statements` and serves it through `device.statementList {after}`. On each machine, `device.statementApply {statements}` (its shapes, like `device.statementList`'s, in `packages/contracts/src/device.ts`) verifies the chain and keeps it in the machine's own `trust_statements` with the devices the machine trusts, and `device.trustedList` is the machine's own verified view.
- **Where a key is trusted.** A machine trusts a key only when a path of `runtimenode.added`, `device.linked`, `passkey.added` and `runtimenode.key_rotated` statements reaches it from the machine's own key, each signed while its signer was still trusted at that point in the chain. A `device.revoked`, `runtimenode.removed`, `passkey.removed` or `runtimenode.key_rotated` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted. An ended key is never trusted again. A removed machine that is linked again first mints a new identity key under its same machine id, and its new `runtimenode.added` trusts that key and moves every device's pin for the id; its store, sessions and id stay. Phase 3's handshake reads that verified view and nothing else. A device reads the chain (`device.statementList`) in the relay transport the one front end carries on every device host (Phase 7); the desktop app, which reaches other machines as its machine, makes that read through its own service.
- **`devices` replaces `user_identity_keys`** in the one schema: each device's id, name, kind and platform, public key with its tag, and revocation. A machine's identity key is never a `devices` row: it lives on the machine's `runtime_nodes` row (Phase 3). The control plane resolves a device id to its public key there for relay admission only, which is for spam and cost; no machine reads that lookup to decide trust.

**Done when**

- A device key made in hardware signs, and no code path reads its secret half.
- Every public key carries its algorithm, and a key with an unknown tag is refused.
- A machine trusts a device key only through a verified chain from its own machine key; a key the chain does not reach, or reaches only through a statement its signer made after its own key was ended, is refused, whatever the control plane's `devices` row says.
- A statement a key signs after the `device.revoked`, `runtimenode.removed`, `passkey.removed` or `runtimenode.key_rotated` that names it is refused, while every device, machine and passkey that key added before stays trusted; an ended key is never trusted again, and a removed machine's rejoin is trusted only under the new key its new `runtimenode.added` names.
- A chain with a broken hash link or a bad signature is refused whole, and the machine keeps the last chain it verified.
- A device id that resolves to no key fails closed rather than defaulting to anything.

### Phase 3 — The relay and the channel

**Precondition:** Phase 2 merged.

The control plane gains a relay the person deploys for themself, in their own Cloudflare account or on their own server. It forwards sealed frames and inspects none of them.

- **The machine registers.** At its first connection to the control plane the machine registers (`runtimenode.register`, its shapes in `packages/contracts/src/runtime-node.ts`) with its id, public key, name, platform and service version, keyed by the machine and its owning user and never by a session. The control plane accepts it only for a key enrolled to that owner: `sidekicks sign-in`, run while the service is stopped, enrolls the identity key's public half as this machine's key through the daemon's custody code ([Plan-006](./006-local-ipc-and-daemon-control.md) T-006r-3-18), and a removed machine linked again re-enrolls the new key it mints with its new `runtimenode.added`. The control plane keeps that key as the machine's current key in `runtime_nodes.public_key`, never in `devices`; a replaced machine key is kept only in the chain's statement that ended it. `runtimenode.rename` lets the person rename it. The machine keeps one outbound relay connection while its service runs, and its reachability is read from that connection: reachable while it is up, not reachable after 45 seconds without a frame, with no heartbeat.
- **Typed refusals.** This phase builds the control plane's typed error envelope with its first typed refusal, `runtimenode.permission_denied`: a refusal is thrown as a typed exception, and tRPC's own `errorFormatter` projects it to `{ code, message }` in the error's `data`, so a caller reads the code without parsing the message.
- **One channel per device and machine**, carrying every session and screen on that machine, on the Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256` handshake and transport, with no construction of the product's own. Each end's X25519 channel key is certified by its identity key in the statement that trusts it. A fresh handshake runs on every connection and every 10 minutes on a long one, and the old keys are erased.
- **The channel's first frame** carries the channel version and the profiles the device runs; the machine answers with the first it also runs or closes the connection with `channel.no_common_profile`. Both ends bind the offer and the answer into the handshake's prologue. There is one profile and no fallback. The classical handshake is not post-quantum, and the docs say so; the hybrid profile joins later through this negotiation, on the same keys and frames, once its specification is finished and reviewed.
- **Relay access.** `RelayNegotiationRequest` carries no session id: negotiation hands back a relay endpoint and a short-lived connect token bound to the device and the machine. The relay holds at most one live connection per key; a new one closes the one before it, so the newest connection wins, and a key that keeps displacing itself, three times within a minute, is flagged.
- **The relay's own rules.** The relay counts requests on its sign-in routes only — sign-in, token refresh and device linking — and answers a caller over the limit with 429 and a `Retry-After` ([Plan-019](./019-rate-limiting-policy.md)): on the Workers relay in the per-identity Durable Object, one global counter that rotating edge locations do not reset, and on the Compose relay in the relay process's memory. A counter error fails that one request like any backend error. On the WebSocket the relay sees only encrypted frames and counts none: it forwards each device's frames as fast as the machine drains them, and backpressure on the channel bounds frames and bytes in both directions. A method inside a frame is the machine's to limit, never the relay's: Phase 4's method proxy enforces `presence.heartbeat` at 10 a minute per device. A relay's key is pinned only when it has no publicly trusted certificate: a pinned relay whose key changed is refused and recorded (`relay.pin_refused`, `relay.spki_mismatch`), and `sidekicks relay repin --force` accepts the new one through the daemon's `relay.repin {spkiHash}`, which refuses and changes nothing when the hash does not match the key the relay presents. The relay block of `sidekicks daemon status`, the `relay` field of `daemon.status.read`, counts since the service started.
- **The shared channel package**, new under `packages/`, holds the channel for every host: the Noise handshake and transport code. The first frame's shape, the profile names and `channel.no_common_profile` are wire, so they live in `packages/contracts`, and the package imports them. It takes a maintained Noise implementation whose Diffie-Hellman can be supplied from WebCrypto; the library chosen, and why, is recorded in this plan when this phase picks it.
- The relay stores nothing beyond the live connection, so there is no mailbox to drain and nothing to read after both ends disconnect.
- **The desktop app's control-plane calls.** The service answers `controlPlane.call {procedure, input}` on its local socket for the desktop app's main process, its schema in `packages/contracts/src/device.ts`, beside the procedures it forwards: it attaches this machine's access token and signs each request's DPoP proof. `procedure` is one of `device.list`, `device.linkStart`, `device.linkRedeem`, `device.link`, `device.linkCancel`, `device.rename`, `device.revoke`, `device.forget`, `device.statementList`, `device.pushAddressSet`, `runtimenode.rename` and `runtimenode.remove`; relay negotiation or any other procedure is refused.
- **The control plane's database client.** The tRPC host composes the production `pg.Pool` `Querier` — Hyperdrive-backed on the Workers relay, a pool to the stack's own Postgres on the Compose relay — and hands it to every control-plane store, in place of the placeholder that refuses every query.

**Done when**

- Two endpoints exchange frames the control plane cannot decrypt, proven by a test that holds the relay's whole view and fails to read a payload.
- A connect token replayed for another device or machine is refused, and an expired one is refused.
- A refused registration reaches the caller with `{ code, message }` in the error's `data`, the code read without parsing the message.
- A dropped connection reconnects with a fresh handshake, and a long connection rekeys every 10 minutes, erasing the old keys.
- A machine that answers with a key the device has not pinned, and no `runtimenode.key_rotated` or later `runtimenode.added` for its id behind it, is refused.
- An altered profile offer fails the handshake on both ends, and a machine with no common profile closes the connection with `channel.no_common_profile`.
- A key that connects from two places three times in a minute is flagged, and its newest connection is the one that stays open.
- A relay whose certificate chains to a root the operating system trusts is never pinned, and a renewal that changes its key connects; a pinned relay whose key changed is refused and records `relay.pin_refused`, and `sidekicks relay repin --force` accepts the new key over the daemon's `relay.repin {spkiHash}`; a hash that does not match the key the relay presents is refused and changes nothing.
- A machine registers once, keyed by machine and owner, and reads as not reachable 45 seconds after its relay connection goes quiet; a registration whose key is not the one enrolled to that owner is refused.
- After both endpoints disconnect there is no stored frame anywhere on the control plane.
- A `controlPlane.call` naming a procedure off the list, relay negotiation included, is refused and never reaches the control plane; one on the list reaches the control plane under the machine's token and a fresh DPoP proof.

### Phase 4 — Phone-to-host method proxy with terminal streaming

**Precondition:** Phase 3 merged.

The SDK transport gains a relay arm. A call from a device is sealed, relayed, opened by the daemon, executed against the machine, and answered back over the same channel. Event subscriptions ride the same channel, so the timeline streams to a device live rather than by polling, and a reconnecting device resumes every stream from its last event. Terminal traffic is the hard case and gets its own handling: it is high-rate, ordered, and bidirectional, so it carries backpressure and a resume point instead of being a best-effort stream that silently drops. A shared port is one byte stream per TCP connection the device's listener accepts (`preview.portTunnelOpen`, `preview.portTunnelClose`, their shapes in `packages/contracts/src/preview.ts`), at most 256 KB buffered each way, under the same backpressure; the machine forwards only to listed ports on its own loopback. Another device's Preview is a live picture: a screencast the service produces on whichever host runs the page (`preview.screencastSubscribe`), with focus emulation, the device's touches reaching the page as touch events, carried over the same channel with no debug port on either host. The method proxy admits at most 10 `presence.heartbeat` a minute per device, counted inside the sealed connection: it drops the excess and keeps the last heartbeat per device, so a device's presence is always its latest.

**Done when**

- Every method the local transport serves is served over the relay, with one suite run against both.
- Timeline events stream to a device with no gaps across a reconnect.
- Terminal output streams to a device and input streams back, with ordering preserved and a bounded buffer under load.
- A slow device applies backpressure rather than making the machine buffer without limit, on every stream the machine sends: the terminal, the live picture, a shared port's bytes and a voice reply.
- A forward to a port that is not on the list, or to an address that is not the machine's loopback, is refused.
- A device that opens a session through its machine gets the same session id and its full history, and opening it never forks the session, changes its id or resets its runs.
- Several devices driving one session through its machine at once leave its timeline whole, every event in one order.
- A device that sends `presence.heartbeat` faster than 10 a minute has the excess dropped by its machine, which keeps that device's last heartbeat, and the relay forwards every one of those frames unread.

### Phase 5 — Devices, linking and revocation

**Precondition:** Phases 2 and 3 merged.

Linking, renaming, revoking and removing are statements in the chain Phase 2 builds, and every machine verifies them itself.

- **On the control plane:** `device.list` (what the Devices page in Settings draws: a live read of machines, devices and passkeys, with each one's connected state and last-seen time, the relay writing last seen at most once a minute, and the events: each statement's, carrying its kind as its name — `device.linked`, `device.renamed`, `device.revoked`, `passkey.added`, `passkey.removed`, `runtimenode.added`, `runtimenode.renamed`, `runtimenode.removed` and `runtimenode.key_rotated` — beside `device.forgotten` and `runtimenode.registered`), `device.linkStart`, `device.linkRedeem`, `device.link`, `device.linkCancel`, `device.rename`, `device.revoke`, `device.forget` and `runtimenode.remove`, which posts `runtimenode.removed`. The `device.*` shapes are in `packages/contracts/src/device.ts`, and `runtimenode.rename` and `runtimenode.remove` in `packages/contracts/src/runtime-node.ts`.
- **On each machine, over the channel:** the chain head is exchanged at every channel open and applied through Phase 2's `device.statementApply`, and a revoking device also sends its statement to every machine it can reach.
- **Linking** is a 5-minute single-use link whose fragment carries a 32-byte linking secret the control plane never sees, confirmed by six digits both sides compute from that secret, both devices' keys and the list of machine keys. A passkey links a device with no other device at hand, outside the desktop app only, through [Plan-016](./016-identity-and-user-state.md) Phase 6's WebAuthn ceremony routes (CP-016-14).
- **A replaced key.** A `runtimenode.key_rotated` is signed by the old key and the new one; the control plane keeps only the new key as the machine's current key on its `runtime_nodes` row, the statement is where the old key is kept, a statement the old key signs afterward is refused, and every device moves its pin on reading the statement.
- **A removed machine linked again.** Removing a machine posts `runtimenode.removed`, and the machine comes back only by being linked, as a new computer joins. Before it is linked again its service mints a new identity key under its same machine id; its new `runtimenode.added` trusts that key and moves every device's pin for the id, and its store, sessions and id stay as they were. The service mints its identity key at first start and at this rejoin, and never otherwise.
- **Revoking** closes the revoked device's channel at once rather than waiting for anything to expire. Every device and passkey the revoked device linked or added before stays trusted: a device it linked carries `Linked from <device>, which you revoked. Revoke it if that device was lost.` on its card, and a passkey it added carries `Added from <device>, which you revoked. Remove it if that device was lost.` on its row, both read from the chain.
- **Push.** `device.pushAddressSet {platform: apns | fcm | webPush, address}` at link time and whenever the platform changes the address, stored with the device and dropped at revoke; `device.notificationSettingsSet` hands each machine the device's switches and push keys; `push.send` carries a notice the machine sealed, its request and the plaintext notice the phone apps and the service worker open being in `packages/contracts`, the notice beside the attention schemas in `attention.ts`; and the APNs, FCM and VAPID senders on the control plane present the person's own credentials. There is no notification-preferences table and no control-plane queue.
- **Presence.** Each device sends `presence.heartbeat`, carrying `PresenceHeartbeat`, on each machine connection it holds, when `appVisible` changes and otherwise every 15 seconds; the machine keeps the last one per device in memory only. Presence is per machine and held by the machine, never by the control plane: `presence.read {}` and `presence.subscribe {}` report the devices connected to this machine and whether an app window is in front on each, a lock or sleep counting as not in front, with no session id.

**Done when**

- Linking a second device works end to end, from an unlinked state to a device driving a session, on both sides of the six-digit check.
- Linking, renaming and revoking are statements in the account's chain, and every machine verifies the chain itself; a link is a fact of the account, never of a session.
- Re-linking on the same key is refused.
- A revoke withheld from one machine is caught at the next connection of any other device.
- Revoking closes the revoked device's connection promptly and its next call refuses; a device it linked before stays linked and reads `Linked from <device>, which you revoked. Revoke it if that device was lost.`, and a passkey it added reads `Added from <device>, which you revoked. Remove it if that device was lost.`
- A removed machine linked again connects under its new key: every device moves its pin for the machine's id on the new `runtimenode.added`, the old key stays refused, and the machine's sessions are there as they were.
- A rename reaches every device, and every machine the next time it connects.
- A sealed push reaches a device whose connection is down, and the relay cannot open it.

Rule 15: `web-push` 3.6.7's `encrypt` on the machine and its `getVapidHeaders` on the control plane, over `@pushforge/builder` 2.0.5, which would put the subscription keys and the VAPID key in one place; `apns2` 12.2.0 over `@parse/node-apn` 8.1.0; FCM's HTTP v1 API with `google-auth-library` 11.1.0 over `firebase-admin` 14.5.0; `@hpke/core` 1.9.0 with `@hpke/hybridkem-x-wing` 0.7.0 for HPKE on the machine.

### Phase 6 — The device recorded on each event

**Precondition:** Phase 5 merged.

The channel's handshake proves which device holds each connection, and the machine records that connection's device on every event the device originates, so the log records which device acted rather than only that the account did. No device signs the events it sends.

**Done when**

- An event a device originates carries the device of the connection it arrived on.
- The log records which device sent a given message, and the resolution of an approval, a question or a plan carries the answering device's id; the screen names a device only in `Answered on <device>`.

### Phase 7 — Frontend

**Precondition:** Phases 1-6 merged.

No frontend work for Remote Control starts before Phases 1 to 6 are in; the screens are built against a relay that already works, not against a mock of one.

It builds the screens and the clients, each with the one front end the desktop runs. The web client's and the phone apps' hosts each implement the front end's `PlatformBridge` from the same front-end source the desktop runs; a member a host cannot serve is absent from that host's implementation, so its control is absent from the screen:

- **The web client**: the browser's implementation of `PlatformBridge`, the relay transport in the renderer, a web app manifest, the Web Push service worker, the device key as a non-extractable WebCrypto key, passkey creation and sign-in through [Plan-016](./016-identity-and-user-state.md) Phase 6's WebAuthn ceremony routes (CP-016-14) and, after each sign-in, `PublicKeyCredential.signalAllAcceptedCredentials({rpId, userId, allAcceptedCredentialIds})` with the ids `device.list` reports, so the browser stops offering a removed passkey, the microphone for voice, and the machine switch at the head of the sessions list, which every host shares and which serves any number of machines.
- **The Devices page in Settings**, the last page, after Runtime (`#/settings/devices`, `#/settings/devices/<id>`), contributed to the Settings page list through the settings page registry: the machine, device and passkey cards, linking on both sides, the shared-ports list (`preview.portShareList`, `preview.portShareAdd`, `preview.portShareRemove`), and each removal confirmed in place. A device card whose device a since-revoked device linked carries `Linked from <device>, which you revoked. Revoke it if that device was lost.`, and a passkey row a since-revoked device added carries `Added from <device>, which you revoked. Remove it if that device was lost.` The web client and the phone apps tell their platform which passkeys still count after each sign-in (the WebAuthn Signal API, `ASCredentialUpdater`, Android Credential Manager). The rail keeps its destinations.
- **One column on every screen**: the fold on Sessions, Sidekicks, Skills, Workflows and Settings, back controls, coarse-pointer presses for every drag, the phone terminal key row, Back, and `Open folder…` listing the machine's folders in place.
- **The Android app**: a Capacitor shell and `PlatformBridge`'s Android members, the Keystore key, FCM, Back, the scan, the cover, the in-app page view for shared ports and the microphone permission, passkeys through the same routes and, after each sign-in, Credential Manager's `SignalAllAcceptedCredentialIdsRequest`, signed under the person's own Google developer account with push through the person's own Firebase project. It gets each linked machine's console from that machine: the machine serves its console bundle over the channel, checked file by file and staged for the next start, one bundle per machine, so a phone linked to two machines at different versions opens each with its own. Only the shared console assets come from the machine; the app's native code and its `PlatformBridge` members ship with the app and are never downloaded from a machine.
- **The iPhone app** ([Spec-029](../specs/029-ios-remote-client.md)): the one front end in a Capacitor shell, native only for the Secure Enclave key, the Notification Service Extension, the cover, the scan, the page view for shared ports and staging each machine's console bundle as the Android app does, passkeys through the same routes and, after each sign-in, `ASCredentialUpdater.reportAllAcceptedPublicKeyCredentials`; iOS 26 and later; signed under the person's own Apple developer account.
- **The desktop app as a client of other machines**: the desktop app reaches the person's other machines as its machine, through its own service, which holds this machine's keys and relay tokens and negotiates and authenticates one channel per other machine, so the main process holds no key and no channel; the machine switch, the bell merged across machines, and the loopback listener for shared ports.
- **`sidekicks devices`**, with `link`, `rename`, `revoke` and `forget`, each with `--json`.

The front end runs in WebKit as well as Chromium: every page declares its doctype and `utf-8`, and the renderer build's `build.cssTarget` names the desktop's Chromium and the Safari and iOS versions the hosts carry, so the build writes the `-webkit-` forms. There is no connected-devices banner: who is connected is on the Devices page's cards. Every client with a hardware back gesture obeys the dismiss-only rule the spec sets: Back walks the same ladder the escape key walks and never interrupts a turn.

**Done when**

- The Devices page lists, renames, revokes, forgets and removes, walks a new device through linking on both sides, and each removal confirms in place; after a revoke, each device and passkey the revoked device added stays listed with its flag line.
- The CLI has list, link, rename, revoke and forget.
- A phone app linked to two machines at different versions opens each with the console bundle that machine served.
- The web client, the Android app and the iPhone app each read the timeline, send, steer, stop, answer an approval, a question or a plan, drive agents, view the diff, use the terminal and reach every screen, over the relay.
- The shared-ports list adds a port before anything is listening on it and stops sharing one, and a shared port opens from the desktop app on another computer and from each phone app; on the self-hosted relay it also opens in a browser tab.
- With two machines, the machine switch changes every screen and the bell counts what waits on both.
- A back gesture dismisses the topmost surface and never interrupts a running turn.
- Each surface is exercised against a device driving a session over the relay, not a fixture.

### Phase 8 — Self-host deployment

**Precondition:** Phase 3 merged.

There is nothing to deploy until the relay exists. This phase makes the relay a thing the person can stand up, and it is the owner of the relay-side half of [Spec-024: Self-Host Secure Defaults](../specs/024-self-host-secure-defaults.md) — rows 1, 2, 3, 4, 5, 8, and 10.

The relay runs behind a TLS front rather than terminating TLS itself: Caddy v2 on `:443`, with `:80` open only for the ACME HTTP-01 challenge. `DEPLOY_MODE` is declared at config time and decides the issuance path, and renewals run on ACME Renewal Information windows rather than a fixed fraction of the certificate's life. `RELAY_BIND` stays container-internal and is never port-forwarded by the shipped Compose file, and a non-loopback bind with no TLS in front of it exits non-zero at config-parse time instead of starting. The first run is a one-shot service in the Compose file that Postgres and the relay each wait on (`depends_on` with `condition: service_completed_successfully`). It generates the relay's secrets, persists them `0600` and writes the first-run sentinel: the control plane's two token keys, the Ed25519 key that signs access tokens and the symmetric key that seals refresh tokens, with `crypto.randomBytes`; the Web Push VAPID key pair (ECDSA P-256, RFC 8292), whose public key the relay serves to the web client for its push subscription; and the Postgres role's password, with `crypto.randomBytes` (N ≥ 32), before Postgres first starts. Compose hands the password to Postgres as a secret file (`POSTGRES_PASSWORD_FILE`, with `POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256` so initdb writes SCRAM rows) and to the relay as the same file; it never passes through an env var or `.env.example`, and the relay signs in with `scram-sha-256` over the `verify-full` TLS. The APNs and FCM credentials are issued by Apple and Google, so the person supplies them and the relay keeps them. A relay that finds the sentinel absent with its secrets present refuses to start, naming the sentinel and the secrets it found. The startup banner prints the relay's effective binds, TLS mode and fingerprint, and each active override on its own `WARNING:` line. The relay's Postgres client defaults to `sslmode=verify-full` and ships the cert-generation helper that makes that reachable on a self-hosted Compose stack, and the Compose file names the Postgres image it runs.

On the Compose relay a server-name router sits in front of Caddy on `:443`, so a shared port's address (`https://<port>-<machine label>.<relay's domain>/`) passes through by its server name to the machine, which ends TLS itself; each machine has a wildcard name under the person's domain, and the relay writes the DNS challenge record (`runtimenode.certificateChallengeSet`, in `packages/contracts/src/runtime-node.ts`) only for a machine that proves its key: the request carries the machine identity key's signature (`machineSignature`) over the canonical `{nodeId, challengeValue}`, checked against `runtime_nodes.public_key`, and the record stands for the minutes of a challenge. In the web client `Open` first fetches a one-time ticket over the channel (`preview.portTicketIssue {port}`), good for 60 seconds, which the machine trades for a cookie scoped to that address (`HttpOnly`, `Secure`, `SameSite=Lax`) that lives until the port stops being shared or the device is revoked; a request without it gets a plain 404. Caddy takes `ACME_PROFILE`, empty by default. The Workers relay cannot pass TLS through and TLS is never ended at Cloudflare, so there the web client has no shared ports and says so.

**The machine's certificate client.** The machine holds its shared-port name's certificate and ends TLS itself, so the client that obtains that certificate runs in the daemon: it obtains the certificate with a maintained ACME client library, answering the DNS challenge through `runtimenode.certificateChallengeSet`. Choosing the library is this task's acceptance, recorded in this plan with what was considered and what decided it.

The relay process and its Postgres are measured under the named workload — one person, their machines and their devices, on one relay — against the budget in [deployment-topology §Infrastructure Requirements](../architecture/deployment-topology.md#infrastructure-requirements); the baseline is recorded in the PR that lands this phase, and measured again after each relay change that affects it.

**Done when**

- A `git clone` plus one command brings up relay, Caddy, and Postgres with a valid certificate and no hardening steps read first.
- A non-loopback bind without TLS refuses to start, naming the option that is wrong.
- A certificate renews on an ARI window in a test that advances the clock, without a rate-limit retry storm.
- The first-run step generates the two token keys, the VAPID key pair and the Postgres password once, each `0600` and never printed to a log, and Postgres and the relay start only after it exits successfully; with the sentinel deleted and the secrets present, the relay refuses to start and names them.
- The relay's Postgres role signs in with SCRAM-SHA-256 over `verify-full`, and no env var or `.env.example` carries its password.
- The banner prints on every start and names every active override on its own `WARNING:` line.
- A Postgres server with an unverifiable certificate is refused rather than connected to.
- A shared port opens in a browser tab at its machine's address, and the relay's view of the connection holds no plaintext.
- The daemon obtains its shared-port name's certificate through the chosen ACME client library, answering the DNS challenge through `runtimenode.certificateChallengeSet`, and the library choice is recorded.
- The relay process and its Postgres, measured under the named workload, fit the deployment-topology budget, and the baseline is recorded.

## Cross-Plan Obligations

- **Account deletion reaches this plan's tables (⇄ [Plan-020](./020-data-retention-and-gdpr.md) CP-020-6, through [Plan-016](./016-identity-and-user-state.md) CP-016-11).** When the control plane's `account.delete` (Plan-016 T5.10) runs, the account's `devices` and `trust_statements` rows (Phase 2) and its `runtime_nodes` rows (Phase 3) are hard-deleted by `user_id` in [Spec-020 §Path 2 — Postgres PII rows (hard DELETE)](../specs/020-data-retention-and-gdpr.md#path-2--postgres-pii-rows-hard-delete). Each table references `users(id)`, so it falls inside Path 2's inbound-foreign-key closure; the fan-out driver is Plan-020's. **Done when:** after `account.delete`, no `devices`, `runtime_nodes` or `trust_statements` row carries the account's `user_id`.
