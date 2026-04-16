# Spec-002: Invite Membership And Presence

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `002` |
| **Slug** | `invite-membership-and-presence` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Participant And Membership Model](../domain/participant-and-membership-model.md), [Session Model](../domain/session-model.md), [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md), [Security Architecture](../architecture/security-architecture.md), [Shared Session Core](../specs/001-shared-session-core.md) |
| **Implementation Plan** | [Plan-002: Invite Membership And Presence](../plans/002-invite-membership-and-presence.md) |

## Purpose

Define how participants are invited into sessions, how membership is granted, and how live presence is tracked.

## Scope

This spec covers invite lifecycle, join-mode assignment, membership role changes, and participant presence.

## Non-Goals

- Runtime-node attach details
- Artifact-level sharing policy
- Full identity-provider contract

## Domain Dependencies

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)

## Required Behavior

- The system must support issuing an invite into an existing live session.
- Accepting an invite must create or activate membership without interrupting active session runs.
- Invite lifecycle must support `pending`, `accepted`, `revoked`, and `expired`. Declining is implicit in V1 (the invitee does not click the shareable link); no explicit `declined` state is required.
- Membership must be durable and separate from ephemeral presence.
- Invites must support the canonical join modes `viewer`, `collaborator`, and `runtime contributor`.
- A participant must be able to join a session before attaching any runtime node.
- Presence updates must support at least `online`, `idle`, `reconnecting`, and `offline`.
- Role changes and membership revocation must be explicit events in session history.
- Owner elevation must require an existing owner to issue the `MembershipUpdate` with action `change_role` and `newRole: owner`. The target must already hold active membership.
- The system must prevent the last remaining owner from leaving a session. Attempts must return an error directing the owner to transfer ownership first.

## Default Behavior

- Invite default join mode is `collaborator`.
- Session creator default role is `owner`.
- Invite default expiry is `7d` from issuance.
- Presence heartbeat default interval is `15s`, with a reconnect grace window of `45s` before `offline`.
- Presence state is managed using the Yjs Awareness protocol (`y-protocols`), a purpose-built ephemeral CRDT for presence. Presence data is never persisted to durable storage — it lives in memory and is garbage-collected on disconnect.
- Presence heartbeat payload must include at minimum: `deviceType`, `focusedSessionId`, `focusedChannelId`, `lastActivityAt`, `appVisible`.
- When a runtime contributor's membership is revoked mid-run, active runs on their node are interrupted and the node is detached. When a collaborator's membership is revoked, pending interventions are expired immediately; read access is revoked after a 30-second grace period.
- Cross-node presence fan-out uses Postgres `LISTEN/NOTIFY` in V1. Redis Pub/Sub is a documented upgrade path for V1.1 if scale demands it.
- For local IPC (daemon-to-desktop/CLI over JSON-RPC), the daemon exposes a JSON-RPC presence surface (`PresenceUpdate`, `PresenceRead`) that bridges to the Yjs Awareness state. The Yjs binary protocol runs natively on the WebSocket transport to the control plane; the JSON-RPC transport carries serialized presence state.

### Heartbeat Transport

Heartbeats piggyback on the existing event subscription connection. No separate polling endpoint is introduced.

- **Local IPC:** The daemon exposes `PresenceUpdate` and `PresenceRead` JSON-RPC methods (see Interfaces below). The heartbeat is implicit in the WebSocket connection keepalive between the daemon and local clients; a dropped WebSocket triggers the reconnect grace window defined above.
- **Remote (control plane relay):** Presence heartbeats are sent as lightweight messages on the relay WebSocket -- the same connection used for MLS-encrypted session traffic (see [Spec-008](../specs/008-control-plane-relay-and-session-join.md)). No additional transport or endpoint is required.

## Fallback Behavior

- If presence heartbeats are missed, the system must move the participant to `reconnecting` before `offline`.
- If an invited participant in `runtime contributor` mode cannot attach a runtime node yet, they may still join as a human participant according to membership role.
- If invite delivery fails, the invite remains durable and may be re-shared or revoked without recreating the session.

## Interfaces And Contracts

- Invite tokens use PASETO v4 (consistent with the control-plane auth stack per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)). Token payload includes session id, inviter, proposed join mode, and expiry.
- `InviteCreate` must include session id, inviter, proposed join mode, and expiry.
- `InviteAccept` must create active membership and emit participant join events.
- `MembershipUpdate` must support role change, suspension, and revocation.
- `PresenceHeartbeat` must accept participant id, device or client id, and last-known activity state. Presence metadata carried in heartbeats: `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`.
- `PresenceUpdate` (JSON-RPC, local IPC) — daemon pushes serialized Yjs Awareness state to local clients.
- `PresenceRead` (JSON-RPC, local IPC) — local clients read current presence state for a session.
- `ChannelList` — read-only projection of channels in a session. Request: `{sessionId: SessionId}`. Response: `{channels: Array<{id: ChannelId, name?: string, state: ChannelState, participantCount: number}>}`. Channel creation is handled by [Plan-016](../plans/016-multi-agent-channels-and-orchestration.md).
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## Invite Delivery

In V1, invites are delivered as shareable links. The inviter's client (desktop or CLI) calls the `InviteCreate` API, which returns a link in the form:

```
https://<control-plane-host>/invite/<token>
```

The `<token>` is a PASETO v4.local encrypted token (consistent with [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) and the control-plane auth stack defined in [Security Architecture](../architecture/security-architecture.md)). The link is shared out-of-band by the inviter — copied to clipboard and pasted into Slack, email, or any other communication channel. No email delivery service is required for V1.

When a recipient clicks the link, it resolves to a web page hosted by the control plane that:
1. Validates the token (checks signature, expiry, and revocation status).
2. Displays the session name and proposed join mode.
3. Prompts the recipient to authenticate before acceptance. Guest (unauthenticated) invites are out of scope for V1.

### Token Security Properties

- **Single-use:** A token is consumed on first successful accept. The control plane sets the invite state to `accepted` atomically. Subsequent attempts to use the same token return an "invite already accepted" error.
- **Entropy:** The PASETO payload includes 256-bit CSPRNG randomness (consistent with the daemon token specification in [Security Architecture](../architecture/security-architecture.md), which uses `crypto.randomBytes(32)`).
- **Hash storage:** The control plane stores only the SHA-256 hash of the token in the `session_invites.token_hash` column (see [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md)). The plaintext token is never persisted.
- **Expiry enforcement:** The server validates the `expires_at` claim in the PASETO payload on every access. Expired tokens return an "invite expired" error regardless of database state.
- **Token payload structure:** `{session_id, inviter_id, join_mode, expires_at, jti}` — all fields are encrypted inside the PASETO v4.local envelope. The `jti` (JWT ID) claim uniquely identifies the token and is used for single-use enforcement and revocation lookups.

### Rate Limiting

Invite creation is rate-limited to prevent abuse:

| Limit | Threshold |
| --- | --- |
| Max invites per session per hour | 20 |
| Max invites per participant per hour (across all sessions) | 50 |
| Max pending (non-accepted, non-expired) invites per session | 100 |

When a rate limit is exceeded, the API returns the standard `RateLimitResponse` contract (see [API Payload Contracts](../architecture/contracts/api-payload-contracts.md)):

```typescript
{
  code: 'rate_limited',
  retryAfter: number,    // seconds until the limit resets
  limit: number,         // the applicable threshold
  remaining: number      // always 0 when rate-limited
}
```

### Invite Revocation

- Revocation is immediate: the control plane sets `session_invites.state` to `'revoked'` in the database upon the revocation request.
- A revoked token that is subsequently clicked returns a clear error: "This invite has been revoked."
- No push notification is sent to the invitee about revocation. The invitee may not have the application installed yet, so the error is surfaced only when the link is accessed.
- Revocation events are recorded in session history for audit (consistent with the Required Behavior above: "Role changes and membership revocation must be explicit events in session history").
- Only the session owner can revoke invites, per the permission matrix in [Security Architecture](../architecture/security-architecture.md) (owner-only: "Invite participants", "Suspend/revoke member").

### Future Delivery Mechanisms (V2)

The following delivery mechanisms are deferred to V2. All V2 mechanisms will use the same underlying PASETO v4.local token; only the delivery channel changes.

- **Email delivery:** Transactional email service sends the invite link directly to the recipient's email address.
- **In-app notifications:** For users already on the platform, invites appear as in-app notifications with a one-click accept flow.
- **Deep links:** Mobile clients receive invite links as deep links that open directly into the session join flow.
- **QR codes:** For in-person collaboration, the invite link is encoded as a QR code that can be scanned by a mobile client.

## State And Data Implications

- Invite records must be durable until accepted, declined, revoked, or expired.
- Membership records must survive client restart and presence loss.
- Presence records are ephemeral (Yjs Awareness CRDT, in-memory only). Durable state-change events (`participant.went_online`, `participant.went_offline`) are emitted to the session event log for audit. Presence data itself is never written to SQLite or Postgres.

## Example Flows

- `Example: A reviewer is invited into an active implementation session in viewer mode, accepts the invite, appears online in the participant roster, and reads the active timeline without interrupting the current run.`
- `Example: A participant drops offline mid-session. Their membership remains active while presence moves through reconnecting to offline.`

## Implementation Notes

- Presence timing values must be configurable, but the default behavior must be stable enough for testing.
- Membership state belongs to shared control-plane storage, not client cache.
- Invite acceptance should not imply approval or execution authority on any participant machine.

## Pitfalls To Avoid

- Treating socket connectivity as proof of membership
- Auto-attaching runtime nodes as part of invite acceptance
- Hiding role changes or revocations from audit history

## Acceptance Criteria

- [ ] An invited participant can join an already active session without resetting active runs.
- [ ] Membership remains durable when presence goes offline and later returns.
- [ ] Revoking membership prevents further join and approval actions while preserving historical authorship.

## ADR Triggers

- If membership and runtime trust are collapsed into one permission model, create or update `../decisions/007-collaboration-trust-and-permission-model.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: invitees must authenticate before acceptance. Guest invites are out of scope for the first release.

## References

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [PASETO WebAuthn MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
