# Spec-002: Invite Membership And Presence

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `002` |
| **Slug** | `invite-membership-and-presence` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Participant And Membership Model](../domain/participant-and-membership-model.md), [Session Model](../domain/session-model.md), [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md), [Security Architecture](../architecture/security-architecture.md), [Shared Session Core](../specs/001-shared-session-core.md) |
| **Implementation Plan** | [Plan-002: Invite Membership And Presence](../plans/002-invite-membership-and-presence.md) |

> **Amendment (2026-08-03, V1 product-vision reconciliation — two coordinated presence/contract changes; amends the previously-`approved` spec, so the header is flipped to `review` for the amendment's review window per the audit runbook's spec-amendment rule, and one restoring re-promotion returns `approved` across both legs; dependent code dispatch stays census-gated on that restoration).** **(1) Transient typing-indicator presence contract.** [`docs/vision.md` §The Collaboration Model](../vision.md#the-collaboration-model) ratifies a typing indicator — composition presence, never keystroke mirroring — as a V1 collaboration surface, and Spec-006, Spec-008, and [ADR-014](../decisions/014-trpc-control-plane-api.md) already presuppose it riding Yjs Awareness, but this spec — the presence contract itself — never named it. The amendment adds the indicator to §Required Behavior, its field shape and timing defaults to §Default Behavior, and its no-durable-event property to §State And Data Implications. It mints **no** new `presence.*` event type and **no** fifth presence state: the four durable presence states and the four durable `presence.*` event types are unchanged. **(2) `ChannelList` per-caller `direct`-channel filter.** [Spec-016 §Interfaces And Contracts](../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts) (D-016-21) adds a `direct` two-human channel kind and omits it from its own `channel.rosterRead` roster for non-members, but scopes that omission to that surface because this spec's `ChannelList` projection enumerated a session's channels per `sessionId` with **no** per-caller filter — leaving a non-member able to observe a `direct` channel's existence through the control-plane surface. Spec-016 names closing that leg as a Plan-002-owned dependency; this amendment supplies it in §Interfaces And Contracts: `ChannelList` omits a `direct` channel entirely for any caller outside its member pair, keyed on the authenticated principal the control-plane auth context resolves. Request and response **shapes are unchanged** — the filter changes which channels a response carries, not what a channel row looks like — and it mints **no** new wire method, event type, error code, or table.

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
- [ADR-001: Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
- [ADR-007: Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)

## Required Behavior

- The system must support issuing an invite into an existing live session.
- Accepting an invite must create or activate membership without interrupting active session runs.
- Invite lifecycle must support `pending`, `accepted`, `revoked`, and `expired`. Declining is implicit in V1 (the invitee does not click the shareable link); no explicit `declined` state is required.
- Membership must be durable and separate from ephemeral presence.
- Invites must support the canonical join modes `viewer`, `collaborator`, and `runtime contributor`.
- A participant must be able to join a session before attaching any runtime node.
- Presence updates must support at least `online`, `idle`, `reconnecting`, and `offline`.
- Presence must additionally carry a **transient typing indicator**: a per-participant, per-channel signal that composition is occurring, surfaced as "user is typing…". It is an ephemeral Yjs Awareness local-state field — **not** a member of the heartbeat payload and **not** a fifth presence state, so a participant is `online` and composing, never "in the typing state", and the four presence states above remain exactly four. It conveys only that composition is occurring: message content, keystrokes, and draft text are never transmitted.
- Role changes and membership revocation must be explicit events in session history.
- Owner elevation must require an existing owner to issue the `MembershipUpdate` with action `change_role` and `newRole: owner`. The target must already hold active membership.
- The system must prevent the last remaining owner from leaving a session. Attempts must return an error directing the owner to transfer ownership first.

## Default Behavior

- Invite default join mode is `collaborator`.
- Session creator default role is `owner`.
- Invite default expiry is `7d` from issuance.
- Presence heartbeat default interval is `15s`, with a reconnect grace window of `45s` before `offline`.
- Presence state is managed using the Yjs Awareness protocol (`y-protocols`), a purpose-built ephemeral CRDT for presence. Presence data is never persisted to durable storage — it lives in memory and is garbage-collected on disconnect.
- Presence heartbeat payload must include at minimum: `deviceType`, `focusedSessionId`, `focusedChannelId`, `lastActivityAt`, `appVisible`. **Membership-restricted channel suppression (2026-08-03, D-016-21):** a publishing daemon never places a membership-restricted channel's id into any presence surface — while focus sits in one, `focusedChannelId` publishes **absent** (absence is already ambiguous with no-focus, which is the point: it discloses nothing). The suppression is **sender-side and structural**, not a per-subscriber delivery filter: presence rides the control-plane channel in operator-readable form (see the transport bullet below), so filtering at delivery would still hand the operator — and any later subscriber path — the restricted id; suppressing at the publishing daemon, which holds the channel record locally, keeps the id off the wire entirely. Fail-closed: a channel id the publishing daemon cannot resolve against its own channel records is suppressed. V1's one membership-restricting kind is [Spec-016 §Interfaces And Contracts](016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts)'s `direct` channel.
- The typing indicator lives under the `activity` namespace of Yjs Awareness local state — `activity.typing = {channelId, since}`, absent entirely when not composing — a third top-level key alongside `user` and `cursor`, which the wider Yjs ecosystem treats as de-facto reserved. It is updated **event-driven and out of band from the 15s heartbeat cadence** and is never carried in `PresenceHeartbeat`. It carries **no sender-stamped expiry deadline**: Awareness is skew-free by construction because each receiver stamps observation time from its own clock, so a sender-stamped `expiresAt` would re-introduce exactly the clock skew the protocol avoids. `since` is display-only and is never an input to any expiry decision. The heartbeat bullet's sender-side suppression governs this field identically (2026-08-03, D-016-21): composing in a membership-restricted channel publishes **no typing indicator at all** — not a blanked or masked `channelId`, which would still disclose that some private exchange is live. **Named residual:** the pair members of a `direct` channel therefore also lose each other's in-channel typing indicator in V1 — the indicator is a `participants`-audience-channel feature; a pairwise presence leg riding the E2E relay is the V1.1+ shape if it proves wanted. (An agent's indicator never names a `direct` channel — no agent is addressable in one.)
- Typing-indicator timing defaults: sender stop-debounce `3s` (stop emitting after 3 seconds without input) and receiver display TTL `10s` (clear an indicator that has not been refreshed within 10 seconds). The short-sender-cutoff-against-longer-receiver-backstop split and both constants are the field's convergent values, and both must clear well inside the `y-protocols` Awareness `outdatedTimeout` of `30s` — a module-level constant with no constructor option, so any sub-30s clearing is application-managed and the indicator's liveness is receiver-evaluated, never protocol-expired. The indicator clears immediately on send, on composition-idle, and on disconnect (Awareness garbage collection). Client emission must be throttled rather than per-keystroke: the Postgres `LISTEN/NOTIFY` fan-out below amplifies every update across each session subscriber. Any _enforced_ tightening belongs in [Spec-021 §Canonical Endpoint Group Registry](./021-rate-limiting-policy.md#canonical-endpoint-group-registry) rather than here — noting that its `presence.heartbeat` row is priced but dormant in V1, since the collaboration channel ships no per-message admission surface.
- **A human's typing indicator and an agent's activity indicator differ by mechanism, not by constants.** A human's stop signal is silent and must be inferred, which is what the debounce and receiver TTL above buy. An agent's indicator is **edge-triggered** — set on run start, cleared on run end, driven off the run state machine rather than any timer — and it must be written by the owning **daemon's** Awareness client, not by a renderer, so that a renderer crash can neither strand a live run's indicator nor falsely clear it. **Named limitation (Codex PR #284 round 3), pinned on Plan-002's queued restoring delta:** `activity.typing` is one scalar per publishing Awareness client, while the owning daemon — the required writer of every agent indicator it hosts — can hold several runs live at once, so concurrent indicators would overwrite one another on the single field and either run's end edge would falsely clear the survivor. No V1 producer arms before the run-lifecycle substrate lands (the deferred seam [Plan-002](../plans/002-invite-membership-and-presence.md) records against Plan-004 Tier 5), so no live defect ships; the run-keyed agent-activity shape — one entry per run, set on its start edge, deleted only by its own end edge, beside rather than through the human composer scalar (itself sound: one composer per publishing client) — is owed by that restoring delta before the agent leg arms.
- When a runtime contributor's membership is revoked mid-run, active runs on their node are interrupted and the node is detached. When a collaborator's membership is revoked, pending interventions are expired immediately; read access is revoked after a 30-second grace period.
- Cross-node presence fan-out uses Postgres `LISTEN/NOTIFY` in V1. Redis Pub/Sub is a documented upgrade path for V1.1 if scale demands it.
- For local IPC (daemon-to-desktop/CLI over JSON-RPC), the daemon exposes a JSON-RPC presence surface (`PresenceUpdate`, `PresenceRead`) that bridges to the Yjs Awareness state. Presence rides the **WebSocket (JSON-RPC 2.0)** collaboration channel to the control plane per [ADR-014](../decisions/014-trpc-control-plane-api.md) / [Spec-008](../specs/008-control-plane-relay-and-session-join.md) §Control-Plane Transport Protocol; the relay WSS connection is reserved for the `Spec-008 §Message Framing` binary wire frames (E2E session ciphertext) and carries no presence.

### Heartbeat Transport

Heartbeats piggyback on the existing event subscription connection. No separate polling endpoint is introduced.

- **Local IPC:** The daemon exposes `PresenceUpdate` and `PresenceRead` JSON-RPC methods (see Interfaces below). The heartbeat is implicit in the WebSocket connection keepalive between the daemon and local clients; a dropped WebSocket triggers the reconnect grace window defined above.
- **Remote (control plane):** Presence heartbeats ride the **WebSocket (JSON-RPC 2.0)** collaboration channel per [ADR-014](../decisions/014-trpc-control-plane-api.md) / [Spec-008](../specs/008-control-plane-relay-and-session-join.md) §Control-Plane Transport Protocol -- **not** the relay WSS connection, which is reserved for the §Message Framing binary wire frames that tunnel E2E-encrypted session ciphertext. No additional transport or endpoint is required.

## Fallback Behavior

- If presence heartbeats are missed, the system must move the participant to `reconnecting` before `offline`.
- If an invited participant in `runtime contributor` mode cannot attach a runtime node yet, they may still join as a human participant according to membership role.
- If invite delivery fails, the invite remains durable and may be re-shared or revoked without recreating the session.

## Interfaces And Contracts

- Invite tokens use PASETO v4 (consistent with the control-plane auth stack per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)). Token payload includes session id, inviter, proposed join mode, and expiry.
- `InviteCreate` must include session id, inviter, proposed join mode, and expiry.
- `InviteAccept` must create active membership and emit participant join events.
- `InviteRevoke` must accept session id, invite id, and an optional reason. Request: `{sessionId: SessionId, inviteId: InviteId, reason?: string}`. Only the session owner may invoke (per the permission matrix in [Security Architecture](../architecture/security-architecture.md)); see [§Invite Revocation](#invite-revocation) below for revocation semantics and audit-log requirements.
- `MembershipUpdate` must support role change, suspension, and revocation.
- `PresenceHeartbeat` must accept participant id, device or client id, and last-known activity state. Presence metadata carried in heartbeats: `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`.
- `PresenceUpdate` (JSON-RPC, local IPC) — daemon pushes serialized Yjs Awareness state to local clients.
- `PresenceRead` (JSON-RPC, local IPC) — local clients read current presence state for a session.
- `ChannelList` — read-only, **per-caller-filtered** projection of channels in a session. Request: `{sessionId: SessionId}`. Response: `{channels: Array<{id: ChannelId, name?: string, state: ChannelState, participantCount: number}>}`. A channel of the `direct` kind ([Spec-016 §Interfaces And Contracts](../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts), D-016-21 — an immutable two-human member pair fixed at creation, `humans-only` by construction and daemon-forced) is **omitted entirely** for any caller outside that pair: `id`, `name`, `state`, and `participantCount` are all non-disclosed rather than blanked, so the response carries no evidence the channel exists — a blanked row would still disclose the one fact at stake, that the channel is there. The caller is the **authenticated principal resolved from the control-plane auth context** (the PASETO v4 identity per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) and [Security Architecture](../architecture/security-architecture.md)), **never** a caller-supplied field on the request — the request shape above is unchanged, so this surface carries no identity claim to forge. Spec-016's `channel.rosterRead` non-member omission (the daemon surface) and this filter (the control-plane surface) are counterparts: together they close channel-existence metadata across both V1 channel-enumeration surfaces, and neither closes it alone — which is why Spec-016 scopes its omission claim to its own surface rather than asserting one session-wide. A third, non-enumeration vector is closed sender-side (2026-08-03): presence metadata — `focusedChannelId` and `activity.typing` — never carries a membership-restricted channel's id per §Default Behavior's suppression rule, so the session-wide presence fan-out, which bypasses both the relay recipient filter and this projection, cannot disclose what the two enumeration surfaces omit. Two limits are deliberate. The filter does **not** hide `participants`-audience channels — session-membership inheritance stays their V1 posture per [Spec-016 §Resolved Questions and V1 Scope Decisions](../specs/016-multi-agent-channels-and-orchestration.md#resolved-questions-and-v1-scope-decisions), and the bootstrap `main` channel is always among them. And it is **metadata non-disclosure only**: content confidentiality for a `direct` channel is a distinct relay-layer property — per-channel recipient scoping in the session's end-to-end encryption, defined in [Spec-008 §Per-Channel Recipient Scoping (V1)](../specs/008-control-plane-relay-and-session-join.md#per-channel-recipient-scoping-v1) — that this filter consumes rather than provides. Channel creation is handled by [Plan-016](../plans/016-multi-agent-channels-and-orchestration.md).
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

| Limit                                                       | Threshold |
| ----------------------------------------------------------- | --------- |
| Max invites per session per hour                            | 20        |
| Max invites per participant per hour (across all sessions)  | 50        |
| Max pending (non-accepted, non-expired) invites per session | 100       |

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

- Invite records must be durable until they reach a terminal state (`accepted`, `revoked`, or `expired`).
- Membership records must survive client restart and presence loss.
- Presence records are ephemeral (Yjs Awareness CRDT, in-memory only). Durable state-change events under the `presence` category — `presence.online`, `presence.idle`, `presence.reconnecting`, `presence.offline` — are emitted to the session event log for audit per [Spec-006 §Presence](./006-session-event-taxonomy-and-audit-log.md#presence-membership_change). Presence data itself is never written to SQLite or Postgres. The typing indicator is Awareness-only and mints **no** durable event: the four `presence.*` types above remain the complete durable presence set, and typing is deliberately excluded from the audit log — a per-keystroke audit trail of composition activity is surveillance exhaust, not collaboration state. Its no-persistence property is already bound by [Plan-002 §Invariants I-002-3](../plans/002-invite-membership-and-presence.md#invariants).

## Example Flows

- `Example: A reviewer is invited into an active implementation session in viewer mode, accepts the invite, appears online in the participant roster, and reads the active timeline without interrupting the current run.`
- `Example: A participant drops offline mid-session. Their membership remains active while presence moves through reconnecting to offline.`

## Implementation Notes

- Presence timing values must be configurable, but the default behavior must be stable enough for testing.
- Membership state belongs to shared control-plane storage, not client cache.
- Invite acceptance should not imply approval or execution authority on any participant machine.
- Consumers of the typing indicator must subscribe to the Awareness `change` event, not the raw `update` event: `update` fires on every local-state write including the protocol's own ~15s self-renewal, so an `update` subscriber re-renders on every keepalive tick for every participant.
- The typing indicator is hand-rolled over `y-protocols` Awareness; no purpose-built library is adopted, because both candidate npm packages are abandoned upstream: [`y-presence`](https://registry.npmjs.org/y-presence) last published 0.2.3 on 2023-01-15, and [`@y-presence/react`](https://registry.npmjs.org/@y-presence%2Freact) last published 2.0.1 on 2022-07-27 with a `react: ^18.0.0` peer pin against this repo's React 19 (npm registry metadata, both accessed 2026-08-03). Do not relitigate without new evidence.

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

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: invitees must authenticate before acceptance. Guest invites are out of scope for the first release.

## References

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [PASETO WebAuthn MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)

### Typing-Indicator Primary Sources (2026-08-03 amendment)

- [`y-protocols` v1.0.7 `awareness.js`](https://github.com/yjs/y-protocols/blob/v1.0.7/awareness.js) — the installed Awareness implementation. `outdatedTimeout` is a module-level `30000`ms constant with no constructor option, and `applyAwarenessUpdate` stamps `lastUpdated` from the **receiver's** clock — the basis for the receiver-evaluated, no-sender-deadline rule in §Default Behavior. Cite the `v1.0.7` tag, not `master`: `master` carries a different package identity and different line offsets.
- [`y-protocols` `PROTOCOL.md`](https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md) — the 30s removal / 15s re-broadcast rule, and the statement that Awareness payloads are unauthenticated so participant identity must be enforced at a higher layer.
- [Signal-Android](https://github.com/signalapp/Signal-Android) — `TypingStatusSender.java` pins a 3-second pause-typing stop-debounce; the source of the `3s` sender constant.
- [Element Web](https://github.com/element-hq/element-web) — `apps/web/src/stores/TypingStore.ts` pins `TYPING_USER_TIMEOUT = 10000` against a longer `TYPING_SERVER_TIMEOUT = 30000`; the source of the short-local-cutoff / longer-backstop split.
- [Discord — Trigger Typing Indicator](https://docs.discord.com/developers/resources/channel) — the indicator expires after 10 seconds, and the docs advise bots not to emit it except to cover a known-slow computation; independent convergence on the `10s` receiver TTL and the edge-triggered agent posture.
- [XEP-0085: Chat State Notifications](https://xmpp.org/extensions/xep-0085.html) — the standardized composing / paused / inactive state model this contract's activity-only (never content-bearing) framing follows.
