# Plan-031: Remote Control

| Field            | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| **Status**       | `draft`                                                    |
| **NNN**          | `031`                                                      |
| **Slug**         | `remote-control`                                           |
| **Date**         | `2026-09-11`                                               |
| **Author(s)**    | `Sawmon Abo`                                               |
| **Spec**         | [Spec-031: Remote Control](../specs/031-remote-control.md) |
| **Dependencies** | None                                                       |

## Goal

Build Remote Control: one user, many linked devices, one machine executing, with every device able to do everything the desktop can.

## Scope

The daemon as a real process, device identity keys, the encrypted relay, the method proxy that carries a device's calls to the runtime node, device registration and revocation, per-device attestation, and — last and gated — the frontend that surfaces all of it.

## Non-Goals

Anything that admits a second account to a session. Anything that puts a second executing machine behind one session; that is cross-node dispatch, and it consumes this plan rather than living in it.

## Build order

This plan sits at Tier 10, and [Plan-027](027-cross-node-dispatch-and-approval.md) moves to Tier 11 because it consumes the relay built here in Phase 3.

## Phases

### Phase 0 — Already shipped

Landed facts, not work. Nothing in this phase has tasks; it is written down so the phases above it do not rebuild what exists.

- **The Postgres session directory**, with session creation bound to an owner at create time and session read and subscribe beside it.
- **Runtime-node attach and heartbeat**, including capability update, detach, and the node roster, with one active attachment per node.
- **A per-device liveness machine**, keyed by device rather than by account: a live reading degrades `online → reconnecting → offline` on missed heartbeats, on a fifteen-second and forty-five-second grace pair.
- **Event-log anchors**, with their upload path and store.
- **The tRPC host**, merging three routers — session, runtime node, and event anchor — as ten procedures behind one fetch handler, with a shared context and error formatter.
- **The client SDK's session and runtime-node clients**, each speaking its method strings over the SDK transport.
- **The daemon session store and projector**: SQLite-backed append and read, and a pure fold from the event stream to a session snapshot.
- **Six Postgres tables**: `sessions`, `users`, `runtime_node_attachments`, `runtime_node_presence`, `event_log_anchors`, and `schema_migrations`.

### Phase 1 — The daemon as a running process

The daemon is a library today: modules and tests, with no process anyone can start. This phase gives it one. It gains an entry point, a local socket, a request/response surface over that socket, and a lifecycle — start, ready, shut down, and come back after a crash with its state replayed from SQLite. The SDK's local transport is pointed at that socket, and the desktop shell supervises the process rather than linking the library. Nothing in this phase is remote.

**Done when**

- The daemon starts from a command and answers a method call over its local socket.
- A client that loses the socket reconnects without losing session state.
- Shutdown is clean, and a restart replays the session from its own event log.
- The desktop shell starts, supervises, and stops the daemon as a child process.

### Phase 2 — Device identity keys

Identity keys are described in the corpus and no migration ships them. This phase ships them. A device mints its own long-term signing key at link time, keeps the secret half on the device and exports it never, and registers the public half against the user alongside the device id. Both the daemon and the control plane learn to resolve a device id to a public key, because Phase 3 needs it to seal a frame and Phase 6 needs it to verify one.

**Done when**

- A device mints a key, and no code path can read the secret half off the device.
- The public half is stored against the user with its device id, by a migration that ships in this phase.
- The daemon and the control plane can each resolve a device id to its current public key.
- A device id that resolves to no key fails closed rather than defaulting to anything.

### Phase 3 — The relay

The control plane gains a relay: a session-scoped connection that forwards sealed frames and inspects none of them. Each endpoint posts a signed per-session ephemeral public key and fetches the others, derives a pairwise key per counterpart, and seals every frame to exactly one recipient with a sequence number that makes a replay detectable. Negotiation hands back a relay endpoint and a short-lived connect token bound to the one session it was minted for. The relay stores nothing beyond the live connection and the envelope's expiry, so there is no mailbox to drain and nothing to read after both ends disconnect. [Plan-027](027-cross-node-dispatch-and-approval.md) consumes this phase.

**Done when**

- Two endpoints exchange frames the control plane cannot decrypt, proven by a test that holds the relay's whole view and fails to read a payload.
- A connect token replayed against a different session is refused, and an expired one is refused.
- A dropped connection reconnects and re-derives keys.
- After both endpoints disconnect there is no stored frame anywhere on the control plane.

### Phase 4 — Phone-to-host method proxy with terminal streaming

The SDK transport gains a relay arm. A call from a device is sealed, relayed, unsealed by the daemon, executed against the session, and answered back over the same path. Event subscriptions ride the same channel, so the timeline streams to a device live rather than by polling. Terminal traffic is the hard case and gets its own handling: it is high-rate, ordered, and bidirectional, so it carries backpressure and a resume point instead of being a best-effort stream that silently drops.

**Done when**

- Every method the local transport serves is served over the relay, with one suite run against both.
- Timeline events stream to a device with no gaps across a reconnect.
- Terminal output streams to a device and input streams back, with ordering preserved and a bounded buffer under load.
- A slow device applies backpressure rather than making the runtime node buffer without limit.

### Phase 5 — Device registration and revocation

`device.list`, `device.link`, `device.rename`, and `device.revoke`, over the registry. Linking pairs a new device with the account and registers the key Phase 2 defined. Renaming is durable and visible everywhere the device is listed. Revoking removes the key from the resolvable set and closes any relay connection the revoked device holds, rather than waiting for it to expire. Every one of these is reachable from any non-revoked device, so a lost phone can be revoked from a laptop.

**Done when**

- Linking a second device works end to end, from an unlinked state to a device driving a session.
- The list shows name, kind, linked-at, and last-seen for every device.
- Renaming survives a restart of both the device and the daemon.
- Revoking closes the revoked device's connection promptly and its next call refuses; re-linking on the same key is refused.
- Linking and revoking are both recorded on the session event log.

### Phase 6 — Per-device event attestation

An event a device originates is signed by that device's identity key, so the log records which device acted rather than only that the account did. The daemon verifies the signature before it appends and refuses one it cannot resolve to a known device key. Revoking a device does not retroactively invalidate what that device already signed — the history stays verifiable — but nothing new signed by a revoked key is admitted.

**Done when**

- An event carries a device signature that resolves to a registry row.
- An event signed by a revoked or unknown key is refused at append, not at read.
- Verification still passes after a replay of the whole log.
- The timeline can say which device sent a given message.

### Phase 7 — Frontend

This phase is gated on Phases 1 through 6 being merged. No frontend work for Remote Control starts before then; the screens are built against a relay that already works, not against a mock of one.

It builds three things: the in-session connected-devices banner, the Settings → Linked Devices screen, and the CLI device commands. The banner names the devices currently connected to the session. The screen renders the registry and drives link, rename, and revoke. The CLI covers the same four operations for people who never open the shell.

**Done when**

- The banner shows connected devices and updates as they connect and drop.
- The Linked Devices screen lists, renames, and revokes, and walks a new device through linking.
- The CLI has list, link, rename, and revoke.
- Each surface is exercised against a device driving a session over the relay, not a fixture.

### Phase 8 — Self-host deployment

Gated on Phase 3: there is nothing to deploy until the relay exists. This phase makes the relay a thing an operator can stand up, and it is the owner of the relay-side half of [Spec-027: Self-Host Secure Defaults](../specs/027-self-host-secure-defaults.md) — rows 1, 2, 3, 4, 5, 8, 9b, and 10, and no other row.

The relay runs behind a TLS front rather than terminating TLS itself: Caddy v2 on `:443`, with `:80` open only for the ACME HTTP-01 challenge. `DEPLOY_MODE` is declared at config time and decides the issuance path, and renewals run on ACME Renewal Information windows rather than a fixed fraction of the certificate's life. `RELAY_BIND` stays container-internal and is never port-forwarded by the shipped Compose file, and a non-loopback bind with no TLS in front of it exits non-zero at config-parse time instead of starting. The relay's admin token is generated on first run and persisted `0600`. The `/metrics` endpoint consumes Plan-020's bind and auth contract rather than inventing one, and refuses a non-loopback scrape that carries no credential. The startup banner prints the relay's effective binds, TLS mode and fingerprint, admin-token path, and any active override. The daemon's Postgres client defaults to `sslmode=verify-full`, ships the cert-generation helper that makes that reachable on a self-hosted Compose stack, and probes the server's auth configuration and version at startup.

**Done when**

- A `git clone` plus one command brings up relay, Caddy, and Postgres with a valid certificate and no hardening steps read first.
- A non-loopback bind without TLS refuses to start, naming the option that is wrong.
- A certificate renews on an ARI window in a test that advances the clock, without a rate-limit retry storm.
- The admin token is generated once, is `0600`, and is never printed to a log.
- `/metrics` answers on loopback and refuses an unauthenticated non-loopback scrape.
- The banner prints on every start and names every active override.
- A Postgres server offering weak auth, or an unverifiable certificate, is refused at startup rather than connected to.
