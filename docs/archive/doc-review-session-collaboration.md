# Doc Review: Session, Collaboration, and Multi-Agent

| Field | Value |
| --- | --- |
| **Date** | 2026-04-14 |
| **Scope** | Specs 001, 002, 008, 016, 018; Plans 001, 002, 008, 016, 018; Domain models session, participant-membership, agent-channel-run; ADRs 001, 007, 008; vision.md |
| **Purpose** | Cross-reference gap analysis for implementation readiness |

---

## 1. What's Covered

### Signature Feature 1: Mid-Session Invites and Shared Runtime Contribution

**Session as primary domain object.** ADR-001 establishes `Session` as the root aggregate containing participants, runtime nodes, channels, agents, runs, repo mounts, approvals, artifacts, invites, and presence. The session-model domain doc defines four session states (`provisioning`, `active`, `archived`, `closed`) with explicit allowed transitions. Spec-001 requires session identity to remain stable across reconnect, client restart, and transport changes.

**Invite lifecycle.** Spec-002 defines invite states: `issued`, `accepted`, `declined`, `revoked`, `expired`. Default join mode is `collaborator`. Default expiry is 7 days. Invitees must authenticate before acceptance (v1 decision). Guest/anonymous invites are explicitly out of scope for v1.

**Membership and roles.** The participant-and-membership-model defines four roles: `owner`, `viewer`, `collaborator`, `runtime contributor`. Membership states are `pending`, `active`, `suspended`, `revoked`. The model explicitly states that `owner` is a bootstrap/elevation role, not a normal invite join mode, and that `contributor` alone is never a valid role label.

**Trust layering.** ADR-007 decides on layered trust: membership roles, runtime-node trust, run-level approval policy, and tool/resource permission grants are separate concerns. Membership alone never authorizes cross-node execution.

**Session join and relay.** Spec-008 separates join (membership action) from relay (connectivity action). Control plane provides session directory, invite resolution, presence registration, and relay coordination but never gains execution authority. ADR-008 establishes OS-local IPC as default local transport, control-plane APIs for shared coordination, and relay as secondary fallback.

**Presence.** Spec-002 defines presence states: `online`, `idle`, `reconnecting`, `offline`. Default heartbeat interval is 15s with a 45s reconnect grace window. Spec-018 adds multi-device presence aggregation: one authenticated identity maps to one participant per session, with aggregated status preferring the highest-activity state across devices. Historical event authorship references stable participant ids, not mutable display names.

### Signature Feature 2: Multi-User and Multi-Agent Chat

**Channels.** The agent-channel-and-run-model defines channels as session-local communication streams with states `active`, `muted`, `archived`. Every session gets a default `main` channel at creation (Spec-001). New channels inherit session membership (v1 decision in Spec-016; channel-level permissions deferred).

**Multi-agent orchestration.** Spec-016 requires sessions to support multiple concurrent agents and channels. Cross-agent communication must use channel publication, artifact references, approvals, or run linkage. V1 explicitly prohibits direct run-to-run messaging. Parent-child run relationships must be durable and auditable. Internal helper runs must be distinguishable from user-visible agents.

**Delegation constraints.** V1 limits delegation to one parent-child layer. A child run cannot spawn its own child. Concurrent child runs are allowed but subject to per-runtime scheduler limits. Rejection for depth or capacity violations must be explicit, never silent.

**Agent lifecycle.** The agent-channel-and-run-model defines agent states: `configured`, `ready`, `disabled`, `archived`. Per-agent model, driver, and runtime-node selection is allowed within one session.

### Signature Feature 3 (Partial): Queue, Steer, Pause, Resume

The vision doc specifies that queue must be daemon-backed, steer must be an intervention against an active run, pause must be a runtime state (not a UI illusion), and resume must continue from persisted run state. Spec-016 depends on Spec-004 (Queue Steer Pause Resume) for admission scheduling. However, Spec-004 itself is outside the reviewed document set. The reviewed specs do not define queue semantics, intervention model, or run state machine details.

---

## 2. Spec Completeness

### Spec-001: Shared Session Core

**What's specified:** Session as primary container, required interfaces (`SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe`), default behaviors (active state, owner membership, main channel), `local-only` fallback, canonical event stream and snapshot projection requirements.

**What's hand-waved:** No request/response payload shapes for any interface. No event stream format or schema. No snapshot structure. The `local-only` fallback is described but promotion semantics are explicitly punted ("not promotable in place" per Open Questions). No specification of session id format beyond "globally unique and opaque."

**Assessment:** Sufficient for alignment on behavior contracts. Insufficient for direct implementation without a contracts design pass.

### Spec-002: Invite Membership and Presence

**What's specified:** Full invite lifecycle states, join modes, role model, presence states and timing defaults, interface names (`InviteCreate`, `InviteAccept`, `MembershipUpdate`, `PresenceHeartbeat`), durability requirements for invites vs. ephemeral presence.

**What's hand-waved:** No invite delivery mechanism (how the invite reaches the invitee -- email, link, in-app notification are all unspecified). No rate limiting on invite creation. No specification of invite token format or security properties. No payload shapes for any interface.

**Assessment:** Strong behavioral contract. Invite delivery is a real implementation gap that will need resolution before the desktop invite acceptance flow can be built.

### Spec-008: Control-Plane Relay and Session Join

**What's specified:** Authentication requirement for join, separation of join from relay, relay as secondary connectivity, presence registration independent of node attach, reconnect grace window behavior, interface names (`SessionJoin`, `RelayNegotiation`, `PresenceRegister`, `SessionResumeAfterReconnect`).

**What's hand-waved:** No relay protocol specification. No authentication protocol specification (deferred to Security Architecture). No payload shapes. "Minimum transport data" for relay negotiation is undefined.

**Assessment:** Clear boundary definitions. Relay negotiation will need its own protocol design pass before implementation.

### Spec-016: Multi-Agent Channels and Orchestration

**What's specified:** Multiple concurrent agents, channel creation, parent-child run linkage, internal helper run visibility, one-level delegation depth limit, explicit rejection on depth/capacity violations, provider-agnostic orchestration, interface names (`ChannelCreate`, `OrchestrationRunCreate`, `ChildRunLinkRead`, `InternalRunFlag`).

**What's hand-waved:** No payload shapes. No scheduling algorithm or admission control details. "Summarized row" publication format for child runs is undefined. Depends on Spec-004 (queue/steer/pause/resume) which was not reviewed. Run lifecycle is referenced as defined in `run-state-machine.md` (not in this review set). No channel naming, discovery, or listing mechanism.

**Assessment:** Good behavioral boundaries and explicit v1 scoping decisions. The dependency on Spec-004 and the run state machine are material gaps for anyone implementing orchestration.

### Spec-018: Identity and Participant State

**What's specified:** One canonical participant per session per authenticated identity, multi-device presence aggregation with highest-activity-wins precedence, stable historical authorship via participant ids, placeholder identity fallback, interface names (`ParticipantProjectionRead`, `ParticipantStateUpdate`, `PresenceDetailRead`).

**What's hand-waved:** No specification of how authenticated identity is resolved (deferred to auth/identity provider). No payload shapes. No specification of what "authorized operators" means for `PresenceDetailRead` device-level access.

**Assessment:** Solid identity mapping design. Clean separation of mutable display metadata from stable authorship. Implementable once auth contracts are available.

---

## 3. Plan Completeness

### Common Issues Across All Plans

- All five plans are in `review` status with `[ ] Required ADRs are accepted` unchecked. Every required ADR (001, 002, 004, 005, 007, 008) is in `proposed` status. This is a universal process blocker.
- Implementation steps are 4 high-level bullets each. They are directional (e.g., "Define contracts", "Implement services", "Add client SDK", "Add desktop surfaces") but not task-level decompositions.
- No time estimates or sizing on any plan.
- No cross-plan dependency ordering is declared. Plans reference target paths that overlap but do not specify sequencing.

### Plan-001: Shared Session Core

**Concrete target paths:** 6 specific files/directories across contracts, client-sdk, runtime-daemon, control-plane, and desktop. **Data changes:** sessions and session_memberships tables (control plane), session_events and session_snapshots (local SQLite). **Parallelization:** Contracts + control plane can parallel with daemon projection. Desktop waits for SDK stability. **Acceptance:** Contract tests, integration tests, manual multi-client verification.

**Gaps:** Claims ownership of `session_memberships` table, which conflicts with Plan-002 (see Internal Consistency below). No migration script details. No definition of what "stable" SDK contracts means as a gate.

### Plan-002: Invite Membership and Presence

**Concrete target paths:** 6 specific files/directories. **Data changes:** session_invites, session_memberships, participant_presences tables. **Parallelization:** Invite and presence services can parallel after identity assumptions are fixed. **Acceptance:** Invite acceptance/revocation integration tests, presence timeout tests, manual live join.

**Gaps:** Implicitly requires Plan-001's session tables but does not declare this dependency. Also claims `session_memberships` (see conflict with Plan-001). Lists "Guest identity policy remains unresolved" as a risk but the spec already punts this to post-v1.

### Plan-008: Control Plane Relay and Session Join

**Concrete target paths:** 7 specific files/directories (including CLI session-join). **Data changes:** Join, reconnect, and relay-negotiation records; presence history extension. **Parallelization:** Join service and relay broker can parallel once presence contracts are stable.

**Gaps:** Implicitly requires Plan-002's invite acceptance but does not declare this. "Session-join traffic requirements for admin or recovery flows remain unresolved" is listed as a risk -- this is an operational capacity question that affects relay sizing.

### Plan-016: Multi-Agent Channels and Orchestration

**Concrete target paths:** 8 specific files/directories. **Data changes:** Channels, run_links, internal-run metadata in local persistence. **Parallelization:** Channel identity and run-link persistence can parallel once orchestration payloads are fixed.

**Gaps:** Required ADRs include ADR-005 (provider-drivers-use-a-normalized-interface) which was not reviewed. Depends on run state machine defined elsewhere. No specification of how "provider-agnostic orchestration hooks" work concretely when the driver has no native subagent concept. "Scheduler-limit policy must remain visible" but no default scheduler limits are proposed.

### Plan-018: Identity and Participant State

**Concrete target paths:** 7 specific files/directories. **Data changes:** Participants, participant-profile projections, device-presence/presence-lease storage. **Parallelization:** Participant mapping and presence aggregation can parallel once id/authorship contracts are fixed.

**Gaps:** Implicitly requires Plan-002's presence infrastructure. "Guest or anonymous identity support remains unresolved" restated as a risk despite being explicitly deferred in the spec.

---

## 4. Internal Consistency

### Consistent (good)

- **Term discipline is strong.** The participant-and-membership-model explicitly prohibits `contributor` as a standalone role label, requiring `collaborator` or `runtime contributor`. This is respected across all reviewed specs and plans.
- **Session-as-root-aggregate.** All five specs, all three domain models, and all three ADRs consistently treat session as the primary domain object.
- **Separation of membership from presence.** Every doc that touches both concepts maintains the distinction between durable membership and ephemeral presence.
- **Execution stays local.** All docs consistently place execution authority in the Local Runtime Daemon and coordination in the control plane. No spec or plan violates this boundary.
- **Channel-as-communication-boundary.** Spec-016, the agent-channel-and-run model, and the vision doc all treat channels as the canonical communication surface. No doc introduces an alternative cross-agent messaging primitive.

### Inconsistent or Ambiguous

1. **`session_memberships` table ownership conflict.** Plan-001 "Data And Storage Changes" says: "Add shared `sessions` and `session_memberships` tables to Collaboration Control Plane storage." Plan-002 "Data And Storage Changes" says: "Add shared `session_invites`, `session_memberships`, and `participant_presences` tables." Both plans claim ownership of the `session_memberships` migration. This will cause a concrete implementation conflict.

2. **Presence package claimed by three plans.** Plan-002 targets `packages/control-plane/src/presence/`. Plan-008 targets `packages/control-plane/src/presence/presence-register-service.ts`. Plan-018 targets `packages/control-plane/src/presence/presence-aggregation-service.ts`. No plan declares ownership of the presence package or specifies coordination order among these services.

3. **Owner elevation has no mechanism.** The participant-and-membership-model states: "`owner` is not a normal invite join mode; it is a bootstrap or explicit elevation role." No spec defines how a second owner is created, how elevation from collaborator to owner works, or what authorization is required. The only specified path to `owner` is session creation bootstrap.

4. **Run lifecycle is a dangling reference.** The agent-channel-and-run-model says: "Run lifecycle is defined in `run-state-machine.md`." Spec-016's orchestration behavior (parent-child runs, delegation rejection, internal helper runs) depends on run states that are not defined in any reviewed document. The run state machine is assumed but never specified within this document set.

5. **Spec-016 depends on Spec-004 (Queue Steer Pause Resume).** The dependency is declared in the spec header, but Spec-004 is not in the reviewed set. Orchestration admission ("admission remains subject to explicit runtime scheduler limits") cannot be fully evaluated without the queue and intervention model.

6. **Spec-006 (Session Event Taxonomy and Audit Log) is referenced but not reviewed.** The session-model domain doc references it. Every spec assumes a canonical session event stream, but the event format, schema, and taxonomy are not defined in any reviewed document.

---

## 5. Open Questions

### Explicitly Deferred by the Docs

- Guest/anonymous participant identity (Spec-002, Spec-018): out of scope for v1.
- Channel-level permission restrictions (Spec-016): deferred; new channels inherit session membership.
- Direct run-to-run messaging (Spec-016): out of scope for v1; channels are the only cross-agent boundary.
- Nested delegation beyond one parent-child layer (Spec-016): deferred to future spec revision.
- `local-only` session promotion to shared mode (Spec-001): v1 decision is "not promotable in place."
- Organization directory sync (Spec-018): out of scope.
- Remembered-grant customization beyond base model (ADR-007): listed as an unknown.
- Relay frequency in typical deployments (ADR-008): listed as an unknown.

### Not Addressed

- **Invite delivery mechanism.** How does an invite reach the invitee? Email, shareable link, in-app notification, deep link? Spec-002 covers lifecycle but not delivery.
- **Session deletion or data retention.** Sessions can be `closed` or `archived`, but no spec addresses data retention, purging, or GDPR-style deletion.
- **Session limits.** No maximum on participants per session, channels per session, concurrent runs per session, or agents per session is defined anywhere.
- **Channel naming, discovery, and listing.** Channels are created and used but no spec defines how participants discover or list available channels.
- **Conflict resolution for concurrent membership changes.** If two owners simultaneously revoke each other, what happens?
- **Presence heartbeat transport.** Is it WebSocket, polling, SSE? Spec-002 specifies timing but not transport.
- **Invite token security.** No specification of token format, entropy, single-use vs. multi-use, or revocation propagation timing.
- **Session snapshot compaction.** The vision doc mentions projection tuning and ADR-001 lists "projection lag" as a failure mode, but no spec defines compaction or snapshot truncation strategy.
- **Rate limiting.** No rate limits specified for any API (invite creation, session creation, presence heartbeats, channel creation).
- **Error contract.** No spec defines error response shapes or error codes for any interface.

### Edge Cases Unhandled

- What happens when the last `owner` leaves or is revoked? Is the session orphaned?
- Can a `viewer` be elevated to `collaborator` or `runtime contributor` without a new invite?
- What happens to active runs when a `runtime contributor`'s membership is revoked mid-run?
- What happens to child runs when a parent run is paused or terminated?

---

## 6. Critical Gaps

These must be resolved before implementation can begin.

### 1. All Required ADRs Are `proposed`, Not `accepted`

Every plan lists `[ ] Required ADRs are accepted` as an unchecked precondition. ADR-001 (session as primary domain object), ADR-007 (collaboration trust and permission model), and ADR-008 (default transports and relay boundaries) are all in `proposed` status with "Reviewers: Pending assignment." Additionally, Plans 001 and 016 depend on ADR-002, ADR-004, and ADR-005 which were not even in this review set. By the plans' own stated preconditions, no plan can proceed to implementation.

**Resolution needed:** Accept or amend each ADR through the review process and update plan preconditions.

### 2. No API Payload Contracts

Every spec names interfaces (e.g., `SessionCreate`, `InviteAccept`, `OrchestrationRunCreate`) but none define request/response payload shapes, field types, validation rules, or error responses. The plans target `packages/contracts/src/` as the first implementation step, but there is no design input for what those contracts contain.

**Resolution needed:** A contracts design pass that produces typed payload definitions for at least the core interfaces: `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe`, `InviteCreate`, `InviteAccept`, `MembershipUpdate`, `PresenceHeartbeat`, `ChannelCreate`, `OrchestrationRunCreate`.

### 3. Cross-Plan Dependency Ordering Is Undefined

Plan-002 requires Plan-001's session tables. Plan-008 requires Plan-002's invite acceptance. Plan-018 requires Plan-002's presence infrastructure. Plan-016 requires run state machines from outside this set. None of these dependencies are declared in the plans, and no global implementation sequencing exists.

**Resolution needed:** Produce a cross-plan dependency graph and implementation order. At minimum: Plan-001 ships first, then Plan-002, then Plans 008/018 can parallel, then Plan-016.

### 4. Shared Table and Package Ownership Conflicts

`session_memberships` is claimed by both Plan-001 and Plan-002. The `packages/control-plane/src/presence/` package is targeted by Plans 002, 008, and 018 with no coordination. These will cause concrete merge conflicts.

**Resolution needed:** Assign ownership of each shared table migration and shared package to exactly one plan. Other plans depend on that plan's output.

### 5. Spec-006 (Event Taxonomy) and Run State Machine Are Missing Dependencies

Every spec assumes a canonical session event stream. Spec-016's orchestration depends on run states. Neither the event taxonomy nor the run state machine is defined in the reviewed documents. Without these, the event append and replay requirements in Spec-001 and the orchestration admission in Spec-016 are underspecified.

**Resolution needed:** Confirm that Spec-006 and the run state machine doc exist, are approved, and are compatible with the assumptions made in Specs 001 and 016.

### 6. Invite Delivery Mechanism Is Unspecified

Spec-002 defines invite lifecycle but not delivery. Plan-002 step 4 says "Integrate desktop invite acceptance and participant roster surfaces" but there is no specification for how the invite reaches the invitee. This blocks the end-to-end invite flow.

**Resolution needed:** Specify at least one invite delivery mechanism for v1 (e.g., shareable link with token).
