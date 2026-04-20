# Spec-008: Control-Plane Relay And Session Join

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `008` |
| **Slug** | `control-plane-relay-and-session-join` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [System Context](../architecture/system-context.md), [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md), [Security Architecture](../architecture/security-architecture.md), [Shared Session Core](../specs/001-shared-session-core.md), [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md) |
| **Implementation Plan** | [Plan-008: Control Plane Relay And Session Join](../plans/008-control-plane-relay-and-session-join.md) |

## Purpose

Define how participants authenticate, join shared sessions, and use relay-assisted connectivity without moving execution into the control plane.

## Scope

This spec covers session join, relay negotiation, presence attachment, and remote coordination boundaries.

## Non-Goals

- Local IPC details
- Full runtime-node attach handshake
- Provider transport internals

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

## Architectural Dependencies

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [Deployment Topology](../architecture/deployment-topology.md)
- [ADR-002: Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)

## Required Behavior

- Shared session join must require authenticated membership verification.
- A participant must be able to join a live session before attaching any runtime node.
- The control plane must provide session directory, invite resolution, presence registration, and relay coordination.
- Relay coordination must not grant the control plane arbitrary execution authority over participant nodes.
- A participant changing between direct and relay connectivity must remain attached to the same session identity when membership is still valid.
- The control plane must track presence for both participants and runtime nodes, even when relay is not currently in use.

## Control-Plane Transport Protocol

The control plane uses a dual-transport architecture per [ADR-014](../decisions/014-trpc-control-plane-api.md):

- **tRPC v11** for request-response operations and SSE subscriptions.
- **WebSocket (JSON-RPC 2.0)** for bidirectional collaboration channels.

**tRPC (request-response) handles:**

- Session CRUD (create, read, update, archive)
- Membership management (add, remove, role changes)
- Invite lifecycle (create, revoke, accept)
- Approval operations (request, resolve, escalate)
- Artifact metadata (publish, query, reference)
- Health checks

**SSE (via tRPC subscriptions) handles:**

- Event streaming (session timeline, run output)
- Run state updates (started, paused, resumed, completed, failed)
- Notification delivery (mentions, approval requests, membership changes)

**WebSocket (JSON-RPC 2.0) handles:**

- Presence sync (heartbeats, cursor position, active/idle state)
- Relay message exchange (end-to-end encrypted collaboration traffic; V1 pairwise X25519 + XChaCha20-Poly1305, V1.1+ MLS — see §Relay Encryption)
- Live collaboration events (typing indicators, shared editing state)

### Client SDK Implementation Guidance

**Desktop renderer:**

- Uses tRPC client with React Query integration for typed queries and mutations.
- SSE subscription (via tRPC `subscription`) for live timeline updates and notifications.
- WebSocket connection for presence sync and collaboration events.

**CLI:**

- Uses tRPC client (vanilla, no React Query) for typed queries and mutations.
- SSE for event tailing (run output, session timeline).
- WebSocket for presence is optional -- CLI may skip live presence when non-interactive.

**Shared contract surface:**

- Both clients import types from `packages/contracts/` -- no codegen needed (tRPC router type inference).

**Connection lifecycle:**

- tRPC client reuses HTTP/2 connections; connection pooling is handled by the runtime (Node.js `fetch` or browser).
- WebSocket reconnects with exponential backoff (initial 1s, max 30s, jitter).
- SSE auto-reconnects via the EventSource spec (`Last-Event-ID` header for resumption).

## Relay Encryption

V1 relay encryption is defined by [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md); the properties summarized here are authoritative for V1 implementation.

**V1 cipher suite (pairwise X25519 ECDH + XChaCha20-Poly1305):**

- Libraries: `@noble/curves` (X25519; audited by Cure53, Kudelski Security, and Trail of Bits) and `@noble/ciphers` (XChaCha20-Poly1305; audited by Cure53).
- Each participant generates an **ephemeral X25519 key pair per session** (not per message); these are zeroed when the session ends. A long-term **Ed25519 identity key** signs the ephemeral X25519 public key, binding the session key exchange to the participant's control-plane-registered identity. CLI at-rest storage of this long-term Ed25519 identity key is specified by [ADR-021](../decisions/021-cli-identity-key-storage-custody.md); desktop clients derive the key from a WebAuthn PRF ceremony per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md).
- The control plane distributes signed `SessionKeyBundle` entries (`{ephemeral_x25519_public, ed25519_identity_public, signature}`). A compromised control plane cannot forge valid Ed25519 signatures.
- Session keys are derived via HKDF-SHA256 (RFC 5869) from the ECDH shared secret: `sessionKey = HKDF-SHA256(shared, salt=session_id, info="ai-sidekicks/v1/pairwise", length=32)`.
- Each message is encrypted per-recipient with a fresh 24-byte random nonce and the recipient's principal identifier as AEAD associated data, yielding per-recipient `(recipient_id, nonce, ciphertext+tag)` envelopes. Per-sender monotonic sequence numbers included in the associated data provide replay protection within a session.
- Properties: **session-granularity forward secrecy** (ephemeral X25519 discarded at session end), zero-knowledge relay. Post-compromise security and per-message ratcheting are V1.1 properties delivered by the MLS upgrade (see below).
- **Participant cap:** V1 pairwise sessions are limited to ≤ 10 active participants to bound the N² per-message fan-out cost.
- Wire format: 4-byte length prefix + 1-byte message type (pairwise ciphertext envelope vs relay control) + payload.
- Connection authentication: PASETO v4 tokens.
- WebSocket Hibernation: relay DOs sleep between messages for cost efficiency.

**V1.1+ upgrade path (MLS, RFC 9420):**

MLS via an audited implementation (OpenMLS, mls-rs, or a post-audit TypeScript implementation) is the planned V1.1 relay encryption layer, adding post-compromise security and O(log N) group rekeying. MLS ships behind a feature flag and is promoted to the default cipher once all three promotion gates in [ADR-010 §Success Criteria](../decisions/010-paseto-webauthn-mls-auth.md) pass (external audit, interop testing, production soak). The V1 pairwise layer continues to serve sessions whose participants have not yet adopted V1.1. KeyPackage distribution, group-add/remove, and welcome-message flows will be specified in the V1.1 relay spec revision once implementation selection lands.

## Relay Connection Lifecycle

1. **Connect**: Client establishes a WSS connection to the relay endpoint. The endpoint URL is provided by the control plane via `RelayNegotiationResponse`.
2. **Authenticate**: Client presents a PASETO v4.public token in the WebSocket handshake (`Sec-WebSocket-Protocol: paseto-v4`). The relay validates the token and establishes the session-scoped channel.
3. **Session Key Establishment**: The client generates an ephemeral X25519 key pair, signs the public key with its long-term Ed25519 identity key, and posts the resulting `SessionKeyBundle` to the control plane. The control plane verifies the Ed25519 signature, publishes the bundle to other session participants, and returns their bundles. The client derives per-pair session keys via HKDF-SHA256 from each X25519 ECDH shared secret and caches them for the session's lifetime.
4. **Message Exchange**: All message payloads are encrypted per-recipient under the derived pairwise session keys. The relay sees only opaque per-recipient ciphertext envelopes and forwards them without inspection.
5. **Graceful Close**: The client notifies the control plane that the session has ended, zeroes its ephemeral X25519 secret key and derived session keys in memory, and closes the WebSocket connection. The control plane discards the participant's `SessionKeyBundle`.
6. **Reconnect**: The client re-authenticates with a fresh PASETO token, fetches any missed messages via the control plane, and (if its ephemeral X25519 material is still resident) resumes using the same session keys. If the client restarted between sessions, it generates a new ephemeral X25519 key pair and re-establishes session keys as in step 3.

### Message Framing

- **Wire format**: WebSocket binary frames.
- **Frame structure**: `[4-byte big-endian length][1-byte message type][payload]`. V1 payload is a pairwise ciphertext envelope (`{recipient_id, nonce, ciphertext+tag}`). V1.1+ payload (MLS) is an MLSCiphertext structure.
- **Maximum frame size**: 64 KB. Messages larger than 64 KB must be chunked at the application layer before encryption.
- **Heartbeat**: WebSocket ping/pong at 30-second intervals for keepalive. If no pong is received within 60 seconds, the client must treat the connection as dead and begin reconnect.

### Session Membership Management (V1 Pairwise)

- **Session creation**: The first participant posts a `SessionKeyBundle` (ephemeral X25519 public key signed by the long-term Ed25519 identity key) to the control plane. No group state is maintained beyond the set of active `SessionKeyBundle` entries.
- **Member addition**: The joining participant posts its own `SessionKeyBundle`. Existing members fetch the new bundle, verify the Ed25519 signature, and derive a pairwise session key with the new member via X25519 + HKDF-SHA256.
- **Member removal**: When a participant leaves (or is removed for policy reasons), the control plane discards that participant's `SessionKeyBundle`. Remaining participants drop the per-pair session keys that reference the removed participant. Because there is no shared group key, no rekey is required on removal — future messages are simply not addressed to the removed participant.
- **Key rotation**: Session keys rotate at session boundary. Long-running sessions that require intra-session key rotation must end and restart the session (acceptable trade-off for V1; V1.1+ MLS adds automatic mid-session rekeying via `Update`/`Commit`).

### Group Management (V1.1+ MLS — Planned)

Once the MLS promotion gates in [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) pass, V1.1+ relay sessions use MLS group management: a participant-opened group, `Add`/`Remove`/`Update` proposals followed by `Commit` messages that advance the group epoch, and automatic rekey every 100 messages or 1 hour. KeyPackage distribution flows and epoch-tracking requirements will be detailed in the V1.1 relay spec revision.

### Relay Negotiation

The control plane provides the following via `RelayNegotiationResponse`:

| Field | Value |
| --- | --- |
| Relay endpoint URL | WSS URL for the relay Durable Object |
| Transport protocol | `websocket` |
| Connection token | Short-lived PASETO v4.public token (TTL: 300 seconds) |
| Session ID | The session's identifier, used as HKDF salt during session-key derivation |
| Cipher suite version | `v1/pairwise` for V1; a V1.1+ client may indicate MLS capability and the control plane returns the negotiated suite |

**V1 SessionKeyBundle requirements:**

- Ephemeral X25519 public key (32 bytes)
- Long-term Ed25519 identity public key (32 bytes)
- Ed25519 signature over the concatenation of session ID and ephemeral X25519 public key
- Bundle lifetime: the session's lifetime. Each new session requires a fresh ephemeral X25519 key pair.

Clients must post a fresh `SessionKeyBundle` to the control plane before requesting relay negotiation. Reused ephemeral X25519 public keys across distinct sessions must be rejected by the control plane.

**V1.1+ KeyPackage requirements (planned, ships with MLS upgrade):**

- Signing key: Ed25519
- Init key: X25519
- Cipher suite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`

### Trust Properties

**Threat model**: The relay operator is honest-but-curious. The relay can observe metadata (who connects, when, message sizes) but cannot read message content.

**Trust anchors**: Participant identity is established via control plane authentication. In V1, each participant's long-term Ed25519 identity key signs its per-session ephemeral X25519 public key; the control plane verifies each signature before distributing the `SessionKeyBundle` to other participants, and any bundle whose Ed25519 signing key is not bound to a registered participant identity is rejected. In V1.1+, the same identity-binding applies to MLS KeyPackages.

**V1 guarantees:**

- **Session-granularity forward secrecy** -- past session keys become undecryptable after the session ends, because the ephemeral X25519 material is zeroed. Compromise of the long-term Ed25519 identity key does not reveal past session keys.
- **Zero-knowledge relay** -- the relay sees only opaque per-recipient ciphertext and cannot read, forge, or replay messages. Per-sender monotonic sequence numbers bound into AEAD associated data provide in-session replay protection.

**V1.1+ additional guarantees (delivered by MLS upgrade):**

- **Per-message forward secrecy** via tree-based key ratcheting.
- **Post-compromise security** -- a compromised member can be removed and the group re-keyed, restoring confidentiality for future messages.

**Non-guarantees (V1 and V1.1+)**: The relay CAN perform traffic analysis (timing, message sizes, connection patterns). Metadata protection is out of scope for V1. Post-compromise security and per-message forward secrecy are V1.1+ properties, not V1.

## Default Behavior

- Session join defaults to direct control-plane API and event-stream attachment.
- Relay is used only when required by topology or reachability constraints.
- The control plane returns session metadata, membership state, and live replay cursors as part of successful join.

## Fallback Behavior

- If the control plane is unavailable, existing `local-only` sessions remain usable on their local nodes, but new shared-session join and invite actions must fail explicitly.
- If relay setup fails, the join remains valid but remote live connectivity may remain degraded until an alternate path succeeds.
- If a client switches connectivity path while within the reconnect grace window, the same participant presence should be re-associated rather than duplicated when possible.

## Interfaces And Contracts

- `SessionJoin` must require authenticated identity and valid membership or invite acceptance.
- `RelayNegotiation` must return only the information needed to establish remote session connectivity.
- `PresenceRegister` must exist independently of runtime-node attach.
- `SessionResumeAfterReconnect` must accept a prior participant or client identity handle where applicable.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Control-plane join emits membership and presence events into session history.
- Relay negotiation state may be ephemeral, but successful join and presence changes must be durably represented.
- Control-plane metadata must not become the local source of truth for run execution state.

## Example Flows

- `Example: A participant accepts an invite, authenticates to the control plane, joins a live session, and reads the existing timeline before deciding whether to attach a runtime node.`
- `Example: A participant loses direct connectivity and falls back to relay coordination while remaining in the same session and retaining the same membership.`

## Implementation Notes

- Join and relay should be separate sub-protocols. Joining a session is a membership action; relay is a connectivity action.
- Control-plane session join responses should be small and replay-oriented, not giant state dumps.
- Presence should be resilient to brief network path flips.

## Pitfalls To Avoid

- Treating relay connectivity as proof of execution authority
- Binding session identity to a specific transport path
- Making runtime-node attach a prerequisite for reading or discussing in a session

## Acceptance Criteria

- [ ] A participant can authenticate and join a live session without restarting active runs.
- [ ] Switching between direct and relay connectivity does not create a second session identity.
- [ ] Control-plane services never become the execution authority for local repo and tool actions.

## ADR Triggers

- If relay boundaries, trust assumptions, or default transport choices change materially, create or update `../decisions/008-default-transports-and-relay-boundaries.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: direct control-plane connectivity is required for admin and join-establishment flows. Relay is a secondary connectivity path for session participation after direct control-plane join succeeds.

## References

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [Deployment Topology](../architecture/deployment-topology.md)
- [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)
- [RFC 9420](https://datatracker.ietf.org/doc/rfc9420/)
