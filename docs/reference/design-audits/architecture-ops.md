# Documentation Review: Architecture, Deployment, Data, Security, and Operations

**Date:** 2026-04-14
**Reviewer:** Claude (automated review)
**Scope:** 9 architecture docs, 4 specs (006, 007, 013, 019), 4 plans (006, 007, 013, 019), glossary, 8 operations runbooks

---

## 1. Architecture Completeness

**Verdict:** C4 model is structurally complete at the system-context and container levels. Component-level docs exist for all three major boundaries. No implementation-ready detail exists.

The C4 hierarchy is fully present:

- **System Context** (`system-context.md`) identifies six primary actors and defines the execution-local / coordination-shared split.
- **Container Architecture** (`container-architecture.md`) names seven containers: Desktop Shell, Desktop Renderer, CLI Client, Local Runtime Daemon, Collaboration Control Plane, Local Event Store, and Shared Metadata Store. It also defines the canonical monorepo layout (`packages/contracts/`, `packages/client-sdk/`, `packages/runtime-daemon/`, `packages/control-plane/`, `apps/desktop/shell/`, `apps/desktop/renderer/`, `apps/cli/`).
- **Component docs** exist for all three major containers: Local Daemon (7 components), Desktop App (5 components), and Control Plane (7 components).

Boundaries between the three are clean. The system-context doc explicitly defines three trust boundaries (client/daemon, daemon/control-plane, daemon/providers). The container doc reinforces these: renderer is untrusted vs. shell and daemon; the control plane is trusted for coordination but not code execution.

**Gap:** The component docs are structural inventories. They name components and responsibilities but include no interface signatures, no data contracts, and no sequence diagrams. Implementation would require engineers to derive internal APIs entirely from spec and plan documents.

---

## 2. Data Architecture

**Verdict:** The local/shared storage split is well-reasoned. No schemas, no table definitions, no migration strategy, and no column-level detail exist anywhere.

`data-architecture.md` defines four storage concerns:

| Store                 | Technology         | Ownership                                             |
| --------------------- | ------------------ | ----------------------------------------------------- |
| Local SQLite Store    | SQLite             | Node-local event log, receipts, bindings, projections |
| Shared Postgres Store | Postgres           | Session directory, invites, memberships, presence     |
| Artifact Storage      | Split local/shared | Payloads + manifests with visibility policy           |
| Projection Layer      | Derived            | Read-optimized materializations from events           |

Plan-006 mentions `session_events` and `session_snapshots` tables in passing (under "Data And Storage Changes") but never defines their columns, indexes, or constraints. Plan-019 mentions `notification_preferences` storage. No other plan or spec defines any table.

**Critical gaps:**

- **No schema definitions.** Not a single CREATE TABLE, Kysely migration, or schema diagram exists in any reviewed document.
- **No migration strategy.** There is no mention of how local SQLite schemas evolve across daemon upgrades, or how shared Postgres schemas are versioned.
- **Artifact storage is unresolved.** The data architecture says artifact payloads are "stored locally or shared according to policy," but the storage mechanism (filesystem? blob store? SQLite BLOBs?) is never specified.
- **Projection rebuild** is mentioned as a capability but the projection storage format is unspecified.

---

## 3. IPC and Transport

**Verdict:** The transport hierarchy is well-defined (OS-local socket preferred, loopback fallback, version negotiation required). No wire format is specified.

Spec-007 ("Local IPC And Daemon Control") defines:

- Default transport: Unix domain socket on Unix-like, named pipe on Windows.
- Loopback fallback: explicitly second-class, only when OS-local transport is unavailable.
- Version negotiation: `DaemonHello` / `DaemonHelloAck` before mutating operations.
- Shared typed client SDK: renderer and CLI use the same `packages/client-sdk/`.
- CLI is the first-class delivery track; desktop follows on the same stabilized contract.
- Daemon supervision: `DaemonStart`, `DaemonStop`, `DaemonRestart`, `DaemonStatusRead`.

**Gaps:**

- **No wire format.** The spec says "typed" repeatedly but never specifies the serialization format (JSON-RPC, protobuf, msgpack, or other). This is a blocking implementation decision.
- **No WebSocket mention.** None of the reviewed architecture, spec, or plan documents mention WebSocket anywhere. If the product vision specifies WebSocket as the adapter layer, that decision has not propagated into the architecture or spec documentation.
- **Control-plane transport is unspecified.** The boundary between client SDK and control plane is described structurally (the client SDK "talks to" the control plane) but the transport protocol is not named.
- **Browser-only clients** are explicitly out of scope for v1 (Spec-007 "Open Questions"), which may constrain future transport decisions.

---

## 4. Event Taxonomy

**Verdict:** The taxonomy categories are comprehensive and match the vision. The event envelope is specified at the field level but individual event type definitions do not exist.

Spec-006 ("Session Event Taxonomy And Audit Log") requires these categories:

- Session lifecycle
- Invite and membership
- Participant and runtime-node presence
- Channel and agent lifecycle
- Run lifecycle
- Queue and intervention
- Approval requests and resolutions
- Repo, workspace, and worktree lifecycle
- Artifact and diff publication

Required envelope fields: `eventId`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, plus correlation/causation metadata.

Key properties: events are immutable after append, replay supports cursor-based and windowed reads, compacted events retain audit stubs, and `EventEnvelope` is versioned.

**Gaps:**

- **No individual event type definitions.** The taxonomy names categories but does not enumerate specific event types (e.g., `run.started`, `run.paused`, `approval.requested`). Implementers must derive these from domain models.
- **Sequence assignment contradiction.** Spec-006 "Open Questions" states "No blocking open questions remain for v1" and makes a V1 decision that "session sequence numbers are assigned by the authoritative session-visible append path at write time." Plan-006 "Risks And Blockers" contradicts this: "Session-sequence assignment across local and shared producers remains unresolved." This is an internal inconsistency that must be reconciled.
- **No compaction policy.** The spec says high-volume payloads "may be compacted" but defines no trigger, retention window, or compaction format.

---

## 5. Visibility/Timeline Spec

**Verdict:** Spec-013 covers the majority of vision entry types but does not enumerate them as discrete timeline-row types. Some entry types from the vision are absent or implicit.

Spec-013 ("Live Timeline Visibility And Reasoning Surfaces") requires timeline rows to cover:

- Messages
- Run state changes
- Tool activity
- Approval events
- Interventions
- Artifacts
- Child-run activity

It also defines: reasoning surfaces (normalized, policy-aware, with redaction placeholders), child-run summaries with lazy-loaded expansion, replay-aware live updates, and durable vs. ephemeral reasoning (summary-first durable, detailed reasoning is ephemeral).

**Coverage against vision entry types:**

| Vision Entry Type   | Coverage                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| message             | Explicit                                                                                                                                |
| tool                | Explicit ("tool activity")                                                                                                              |
| approval            | Explicit                                                                                                                                |
| diff                | Covered under "artifacts"                                                                                                               |
| subtask / child-run | Explicit                                                                                                                                |
| run state changes   | Explicit                                                                                                                                |
| interventions       | Explicit                                                                                                                                |
| handoff             | Not explicitly listed as a timeline row type                                                                                            |
| blocked             | Covered via approval events and intervention rows (Spec-019 names `waiting_for_approval` explicitly), but not a named discrete row type |
| paused              | Implicit under run state changes                                                                                                        |
| resumed             | Implicit under run state changes                                                                                                        |
| finished            | Implicit under run state changes                                                                                                        |

**Gap:** "Handoff" is not mentioned in Spec-013. If handoff between agents or participants is a first-class timeline event, it needs to be added to the required row types. Run-state subtypes (paused, resumed, finished, blocked) are covered implicitly under "run state changes" but are not individually enumerated, which could lead to inconsistent implementation.

---

## 6. Security Architecture

**Verdict:** Trust boundaries and permission layers are structurally well-defined. No implementable security mechanisms are specified.

`security-architecture.md` defines six security components:

1. Identity And Session Authorization
2. Membership Policy Engine
3. Runtime Capability Registry
4. Approval Policy Engine
5. Transport Security Layer
6. Audit Layer

Trust boundaries are clearly stated:

- Session membership does not imply local machine trust.
- Runtime-node capability does not bypass approval policy.
- Relay path is less trusted than direct local transport.
- Local daemon is the enforcement point for local execution permissions.

**Critical gaps:**

- **No authentication mechanism.** OAuth, JWT, SAML, passkeys -- nothing is named. The Identity Service is a responsibility box, not a buildable component.
- **No token model.** No token format, lifetime, refresh strategy, or revocation mechanism.
- **No encryption spec.** Transport security is named as a component but TLS requirements, certificate management, and end-to-end encryption for relay paths are unspecified.
- **No permission scoping detail.** The Membership Policy Engine "determines session roles and participant capabilities" but the actual permission matrix (what can an owner do that a collaborator cannot?) is not defined in the architecture doc. This may exist in Spec-012 ("Approvals Permissions And Trust Boundaries"), which was not in the review scope.
- **Invite security.** Invite tokens, link security, and rate limiting are unspecified.

---

## 7. Operations Readiness

**Verdict:** Runbooks are well-structured and cover realistic failure modes. They are actionable for experienced operators who already understand the system internals.

Eight runbooks were reviewed:

| Runbook                              | Scope                                                   |
| ------------------------------------ | ------------------------------------------------------- |
| Control-Plane Runbook                | Auth, DB, membership, presence, relay failures          |
| Local Daemon Runbook                 | IPC, SQLite, replay, provider resume failures           |
| Provider Failure Runbook             | Driver startup, active-run, capability, resume failures |
| Replay And Audit Runbook             | Missing events, stale projections, rebuild failures     |
| Local Persistence Repair And Restore | SQLite corruption, WAL failures, backup restore         |
| Stuck Run Debugging                  | Runs stuck in `running` or `starting`                   |
| Invite Session Desync Recovery       | Invite/membership/presence projection mismatches        |
| Repo And Worktree Recovery           | RepoMount, workspace, worktree failures                 |

Each runbook follows a consistent structure: Purpose, Symptoms, Detection, Preconditions, Recovery Steps, Validation, Escalation, and Related Docs. Recovery steps reference specific API surfaces (`DaemonStatusRead`, `RecoveryStatusRead`, `HealthStatusRead`, `ProjectionRebuild`, etc.).

**Strengths:**

- Cross-referencing between runbooks is good (e.g., Local Daemon Runbook routes to Local Persistence Repair when SQLite fails, and to Provider Failure Runbook when driver recovery fails).
- Escalation criteria are defined for each runbook.
- "Scope and blast radius" is stated in every Symptoms section.

**Gaps:**

- **No concrete commands or scripts.** Runbooks reference API surfaces and health projections but never include actual CLI commands, SQL queries, or scripts.
- **No SLOs or thresholds.** "Presence becomes stale" lacks a definition of stale. "Stuck threshold" in the stuck-run runbook is not quantified.
- **No on-call routing.** Escalation says "escalate when..." but never says to whom or through what channel.

---

## 8. Deployment Topology

**Verdict:** The deployment model is well-reasoned for correctness (execution stays local, coordination is shared). No scaling, capacity, or operational infrastructure detail exists.

`deployment-topology.md` defines four topologies:

1. **Single-Participant Local** -- desktop/CLI + one daemon, no control plane needed.
2. **Collaborative Hosted Control Plane** -- multiple daemons + one hosted control plane.
3. **Collaborative Self-Hosted Control Plane** -- same split, operator-managed.
4. **Relay-Assisted Remote Access** -- relay coordination without moving execution.

Degradation modes are documented: collaborative mode degrades to partial local-only when control plane is unavailable; relay fails independently of local daemon health.

**Gaps:**

- **No horizontal scaling strategy.** How does the control plane scale? Is it a single process, a set of microservices, a managed container service? No load balancing, auto-scaling, or replica strategy.
- **No database replication.** Shared Postgres is the collaboration store but HA/DR strategy is unmentioned.
- **No capacity numbers.** Maximum sessions, participants, events/second -- nothing.
- **No infrastructure requirements.** No CPU/memory/disk guidance for daemon or control plane.
- **No CI/CD or release process.** Container images, daemon packaging, desktop app distribution channels -- none specified.
- **No multi-region considerations.** Relay-assisted access is defined but latency, data residency, and region failover are not addressed.

---

## 9. Notifications Model

**Verdict:** The attention model is well-specified with clear separation between actionable and informational attention, run-scoped and session-scoped projections, and degradation paths.

Spec-019 ("Notifications And Attention Model") defines:

**Attention triggers:** pending approval/input, run completion, run failure, invite receipt, mention/direct request.

**Two attention categories:**

- Actionable (blocking): pending approval, required input.
- Informational: run completion, invite receipt.

**Two projection scopes:**

- Run-scoped: fine-grained source of truth for execution-related attention.
- Session-scoped: aggregate of unresolved run, invite, and participant-request signals.

**Degradation:** OS notification unavailable falls back to in-app badges; muted sessions still surface critical approval-required attention.

**Contracts:** `AttentionProjectionRead`, `NotificationPreferenceRead`, `NotificationPreferenceUpdate`, `NotificationEmit`.

**V1 scope decisions:** notification preferences are global (no per-session overrides); attention exists at both run and session scope.

**Gap:** No notification delivery mechanism is specified for the control plane (how does an invite notification reach a user who is offline or on a different device?). The spec explicitly excludes mobile push and email, but the desktop-only delivery path is not fully specified either (does the control plane push to the desktop shell? does the desktop shell poll?).

---

## 10. Internal Consistency

**Verdict:** Documents are generally consistent in terminology and boundary definitions. Two notable contradictions exist.

**Contradiction 1 -- Event sequence assignment.**

- Spec-006 "Open Questions" states: "No blocking open questions remain for v1. V1 decision: session sequence numbers are assigned by the authoritative session-visible append path at write time."
- Plan-006 "Risks And Blockers" states: "Session-sequence assignment across local and shared producers remains unresolved."
- These directly contradict each other. The spec claims the question is resolved; the plan claims it is not.

**Contradiction 2 -- Plan preconditions vs. ADR status.**

- All four reviewed plans (006, 007, 013, 019) list "Required ADRs are accepted" as a precondition, and all four show that precondition as unchecked (`[ ]`).
- This means none of the reviewed plans can proceed to implementation under their own stated preconditions, despite their specs being approved.

**Terminology consistency is good.** All documents use glossary terms consistently: Session, Participant, RuntimeNode, Run, Workspace, Worktree, Artifact, Approval. The term "local-only" is used consistently per the glossary invariant.

**Cross-reference consistency is good.** Architecture docs reference the correct specs and ADRs. Plans reference the correct specs. Runbooks reference the correct architecture docs and specs.

---

## 11. Open Questions and Critical Gaps

### Must resolve before implementation begins

1. **Define database schemas.** No reviewed document contains a table definition, column list, or migration file. This is the single largest gap between documentation and implementation readiness. Both SQLite (local) and Postgres (shared) schemas need to be specified.

2. **Choose a wire format for IPC.** Spec-007 defines transport (Unix socket / named pipe) and version negotiation but not serialization format. JSON-RPC, protobuf, msgpack, or another format must be decided. This affects `packages/contracts/` and `packages/client-sdk/` fundamentally.

3. **Resolve the sequence-assignment contradiction.** Spec-006 and Plan-006 disagree on whether session-sequence assignment across local and shared producers is resolved. One document must be corrected.

4. **Accept the required ADRs.** ADR-001, ADR-002, ADR-004, ADR-007, and ADR-008 are listed as required but unchecked across all four reviewed plans. Plans cannot proceed under their own preconditions.

5. **Specify authentication and token model.** The Identity Service and transport security are named but have no implementable detail. At minimum: auth mechanism, token format, token lifetime, and refresh/revocation strategy.

### Should resolve before implementation proceeds far

6. **Enumerate individual event types within each taxonomy category.** Categories are defined but specific `type` values are not.

7. **Define the control-plane transport protocol.** Client-to-control-plane communication is described structurally but no protocol is named.

8. **Add "handoff" as an explicit timeline entry type** if agent-to-agent or participant-to-agent handoffs are first-class vision concepts.

9. **Specify artifact storage mechanism.** Filesystem paths? S3-compatible blob store? SQLite BLOBs? The split between local and shared artifacts needs a concrete storage decision.

10. **Define scaling and HA strategy for the control plane.** The deployment topology doc describes correct logical shapes but provides no operational infrastructure guidance.

11. **Add concrete commands, thresholds, and on-call routing to runbooks** to make them usable by operators who did not write the system.
