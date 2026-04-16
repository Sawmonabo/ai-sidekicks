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

## Required Behavior

- Shared session join must require authenticated membership verification.
- A participant must be able to join a live session before attaching any runtime node.
- The control plane must provide session directory, invite resolution, presence registration, and relay coordination.
- Relay coordination must not grant the control plane arbitrary execution authority over participant nodes.
- A participant changing between direct and relay connectivity must remain attached to the same session identity when membership is still valid.
- The control plane must track presence for both participants and runtime nodes, even when relay is not currently in use.

## Relay Encryption

- Relay encryption uses MLS (RFC 9420) for group E2E encryption. Library: `ts-mls`.
- Properties: forward secrecy, post-compromise security, O(1) sender operations, built-in replay protection.
- KeyPackages are distributed via the control plane. Each participant's KeyPackage must be signed with their Ed25519 signing key. Recipients verify the signature against the participant's registered public key before accepting a KeyPackage. A compromised control plane cannot forge valid signatures.
- Wire format: 4-byte length prefix + 1-byte message type (MLS ciphertext vs relay control) + payload.
- The relay is zero-knowledge -- it forwards opaque encrypted bytes and cannot read, forge, or replay messages.
- Connection authentication: PASETO v4 tokens.
- WebSocket Hibernation: relay DOs sleep between messages for cost efficiency.
- Fallback: if MLS libraries prove immature, fall back to X25519 ECDH + XChaCha20-Poly1305 via `@noble/curves` + `@noble/ciphers` with per-sender sequence numbers for replay protection.

## Relay Connection Lifecycle

1. **Connect**: Client establishes a WSS connection to the relay endpoint. The endpoint URL is provided by the control plane via `RelayNegotiationResponse`.
2. **Authenticate**: Client presents a PASETO v4.public token in the WebSocket handshake (`Sec-WebSocket-Protocol: paseto-v4`). The relay validates the token and establishes the session-scoped channel.
3. **Group Join**: If an MLS group already exists for the session, the client fetches KeyPackages from the control plane and joins. If no group exists yet, the client creates one and uploads the initial epoch state to the control plane.
4. **Message Exchange**: All messages are MLS-encrypted. The relay sees only opaque ciphertext and forwards it without inspection.
5. **Graceful Close**: The client sends an MLS `Remove` proposal for itself, the group state is updated via `Commit`, and the WebSocket connection is closed.
6. **Reconnect**: The client re-authenticates with a fresh PASETO token, fetches any missed messages via the control plane, and re-joins the MLS group with a new KeyPackage.

### Message Framing

- **Wire format**: WebSocket binary frames.
- **Frame structure**: `[4-byte big-endian length][MLS ciphertext]`.
- **Maximum frame size**: 64 KB. Messages larger than 64 KB must be chunked at the application layer before encryption.
- **Heartbeat**: WebSocket ping/pong at 30-second intervals for keepalive. If no pong is received within 60 seconds, the client must treat the connection as dead and begin reconnect.

### MLS Group Management

- **Group creation**: The first participant in a session creates the MLS group and uploads the initial epoch state to the control plane.
- **Member addition**: The control plane distributes the new member's KeyPackage to existing group members. An existing member issues an MLS `Add` proposal followed by a `Commit`.
- **Member removal**: Any member can propose `Remove`. The remover issues a `Commit` that re-keys the group, ensuring the removed member loses access to future messages.
- **Key rotation**: Automatic after every 100 messages or 1 hour, whichever comes first. The committer sends an `Update` proposal followed by a `Commit`.
- **Epoch advancement**: Each `Commit` advances the epoch. Clients must track epoch state locally and reject messages from prior epochs.

### Relay Negotiation

The control plane provides the following via `RelayNegotiationResponse`:

| Field | Value |
| --- | --- |
| Relay endpoint URL | WSS URL for the relay Durable Object |
| Transport protocol | `websocket` |
| Connection token | Short-lived PASETO v4.public token (TTL: 300 seconds) |
| MLS group ID | The session's MLS group identifier |

**KeyPackage requirements:**

- Signing key: Ed25519
- Init key: X25519
- Cipher suite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`

Clients must upload a fresh KeyPackage to the control plane before requesting relay negotiation. Stale or reused KeyPackages must be rejected by the control plane.

### Trust Properties

**Threat model**: The relay operator is honest-but-curious. The relay can observe metadata (who connects, when, message sizes) but cannot read message content.

**Trust anchors**: Participant identity is established via control plane authentication. KeyPackage signing keys are bound to participant identity via the control plane. Any KeyPackage with an unrecognized signing key is rejected.

**Guarantees:**

- **Forward secrecy** -- past messages become undecryptable after key update (tree-based ratcheting).
- **Post-compromise security** -- a compromised member can be removed and the group re-keyed, restoring confidentiality for future messages.
- **Zero-knowledge relay** -- the relay sees only opaque ciphertext and cannot read, forge, or replay messages.

**Non-guarantees**: The relay CAN perform traffic analysis (timing, message sizes, connection patterns). Metadata protection is out of scope for V1.

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

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: direct control-plane connectivity is required for admin and join-establishment flows. Relay is a secondary connectivity path for session participation after direct control-plane join succeeds.

## References

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [Deployment Topology](../architecture/deployment-topology.md)
- [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)
- [RFC 9420](https://datatracker.ietf.org/doc/rfc9420/)
