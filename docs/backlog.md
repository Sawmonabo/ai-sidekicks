# Backlog

## Purpose

This file is the active development backlog for the product defined in [vision.md](./vision.md).

## How To Use This Backlog

- Add items only when they represent real remaining work.
- Link every item to the governing spec, plan, ADR, or operations doc where possible.
- Keep items outcome-oriented. A backlog item should describe a deliverable, not a vague area of concern.
- Remove or rewrite stale items instead of letting the file become a historical log.
- When work is complete, update the canonical docs it depends on first, then remove the backlog item.

## Status Values

- `todo`
- `in_progress`
- `blocked`
- `completed`

## Priority Values

- `P0` — blocks all implementation or blocks a critical feature
- `P1` — blocks a specific feature or must resolve before v1
- `P2` — should resolve before v1 ship

---

## P0: Blocks All Implementation

These items block every plan and feature. Nothing can proceed until they are resolved.

### BL-001: Accept All 8 ADRs

- Status: `completed`
- Resolution: All 8 ADRs accepted 2026-04-15. All plan precondition checkboxes checked.
- Priority: `P0`
- Owner: `unassigned`
- References: [ADR-001](./decisions/001-session-is-the-primary-domain-object.md), [ADR-002](./decisions/002-local-execution-shared-control-plane.md), [ADR-003](./decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](./decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](./decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-006](./decisions/006-worktree-first-execution-mode.md), [ADR-007](./decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](./decisions/008-default-transports-and-relay-boundaries.md)
- Summary: Every plan lists `[ ] Required ADRs are accepted` as an unchecked precondition. All 8 ADRs (001-008) remain at status `proposed` with "Reviewers: Pending assignment." By the plans' own stated rules, no plan can proceed. This is compounded by a process integrity issue: several specs have already reached `approved` status while their prerequisite ADRs remain `proposed`. Review and accept or amend each ADR, then update all plan precondition checkboxes.
- Exit Criteria: All 8 ADRs have status `accepted`. All plan precondition checkboxes for ADR acceptance are checked.

### BL-002: Choose IPC Wire Format

- Status: `completed`
- Resolution: JSON-RPC 2.0 + Content-Length framing. See ADR-009, Spec-007.
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-007](./specs/007-local-ipc-and-daemon-control.md), [Vision](./vision.md)
- Summary: Spec-007 defines transport (Unix socket on macOS/Linux, named pipe on Windows) and version negotiation (`DaemonHello` / `DaemonHelloAck`) but never specifies the serialization format. JSON-RPC, protobuf, msgpack — nothing is chosen. No reviewed document mentions WebSocket despite the vision saying "Treat WebSocket as an adapter, not the center of the design." This decision affects `packages/contracts/` and `packages/client-sdk/` fundamentally. Reference apps: Forge uses WebSocket-based RPC with 50+ methods; CodexMonitor uses newline-delimited JSON-RPC over stdio; Paseo uses WebSocket with ~90+ message types. JSON-RPC over Unix socket (with WebSocket adapter for browser/remote) aligns with the vision and matches reference patterns.
- Exit Criteria: Spec-007 updated with chosen wire format. Decision documented as either an amendment to Spec-007 or a new ADR.

### BL-003: Design Database Schemas

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Data Architecture](./architecture/data-architecture.md), All plans
- Summary: Not a single table definition, column list, migration file, or schema diagram exists in any document. Both SQLite (local daemon) and Postgres (control plane) stores are named and their responsibilities defined, but no implementable schema exists. For context, Forge has 34 SQLite migrations covering 25+ tables with full column definitions. Plans reference table names in passing (Plan-006: `session_events`, `session_snapshots`; Plan-011: `diff_artifacts`, `branch_contexts`; Plan-012: `approval_requests`, `remembered_approval_rules`) but never define structure. Must produce at minimum: (1) local SQLite schema for session events, run state, queue items, runtime bindings, projections, worktree state, approval records, and artifact manifests; (2) shared Postgres schema for session directory, invites, memberships, and presence. Must also specify migration strategy for local SQLite across daemon upgrades and shared Postgres schema versioning.
- Exit Criteria: SQLite and Postgres schemas exist as migration files or schema documents with table definitions, column types, indexes, and constraints. Migration strategy is documented.

### BL-004: Define API Payload Contracts

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: All specs, [Vision](./vision.md)
- Summary: Every spec names interfaces (`SessionCreate`, `InviteAccept`, `OrchestrationRunCreate`, `QueueItemCreate`, `ApprovalRequestCreate`, `PRPrepare`, `DiffArtifactCreate`, `ChannelCreate`, `WorkflowGateResolve`, etc.) but none define request/response payload shapes, field types, validation rules, or error responses. The plans target `packages/contracts/` as a first implementation step but have no design input for what those contracts contain. For context, Forge's `packages/contracts/` defines 20 branded entity IDs, 27 base + 42 extended orchestration event types, complete RPC schemas with typed inputs and outputs, and full provider schemas. This can be done incrementally (Spec-001 contracts first, then Spec-002, etc.) but must precede implementation of each feature.
- Exit Criteria: Typed payload definitions exist for all named interfaces across all specs. At minimum: request shape, response shape, field types with Zod schemas, and error response shapes.

### BL-005: Specify Authentication and Token Model

- Status: `todo`
- Note: Auth model decisions captured in [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md) and [updated security-architecture.md](./architecture/security-architecture.md). Implementation remains.
- Priority: `P0`
- Owner: `unassigned`
- References: [Security Architecture](./architecture/security-architecture.md), [Spec-002](./specs/002-invite-membership-and-presence.md), [Spec-008](./specs/008-control-plane-relay-and-session-join.md), [ADR-007](./decisions/007-collaboration-trust-and-permission-model.md)
- Summary: The security architecture names trust boundaries and permission layers but specifies no authentication mechanism. No OAuth, JWT, SAML, passkeys, or session tokens are named. No token format, lifetime, refresh, or revocation strategy exists. The Identity Service is a responsibility box, not a buildable component. No encryption spec exists — TLS requirements, certificate management, and E2E encryption for relay paths are unspecified. No permission matrix exists (what can an owner do that a collaborator cannot?). For context, CodexMonitor uses token auth for its remote daemon; Paseo uses Curve25519 ECDH + XSalsa20-Poly1305 encryption with zero-knowledge relay. Must specify at minimum: (1) local daemon auth — socket reachability or token?, (2) control-plane auth — OAuth? JWT? API key?, (3) relay auth — E2E encryption model, (4) invite token format, entropy, single-use vs multi-use, revocation propagation timing, (5) transport security — TLS requirements.
- Exit Criteria: Security architecture updated with concrete authentication mechanism, token model, encryption requirements, and permission matrix. Invite token security is tracked separately in BL-010.

### BL-006: Produce Cross-Plan Dependency Graph and Ownership Map

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: All plans
- Summary: No plan declares its dependencies on other plans. Known dependency chain: Plan-002 requires Plan-001's session tables; Plan-008 requires Plan-002's invite acceptance; Plan-018 requires Plan-002's presence infrastructure; Plan-004 depends on Plan-005 for capability-aware controls; Plan-020 depends on Plan-015 for persistence; Plan-016 depends on Spec-004 and the run state machine. Additionally, shared resources are claimed by multiple plans: `session_memberships` is claimed by both Plan-001 and Plan-002; the `packages/control-plane/src/presence/` package is targeted by Plans 002, 008, and 018 with no coordination. Must produce a dependency graph, assign table/package ownership to exactly one plan, and define implementation order. Suggested minimum viable order: Plan-001 -> Plan-002 -> Plan-003 -> Plans 005+006+007 (parallel) -> Plans 004+008+018 (parallel) -> Plans 009+010+012 (parallel) -> Plans 011+014+015 -> Plans 013+019+020 -> Plans 016+017.
- Exit Criteria: Cross-plan dependency graph exists as a document. Every shared table and package has exactly one owning plan. Implementation order is defined. Each plan's header updated with explicit dependency declarations.

---

## P0: Blocks Specific Critical Features

### BL-007: Add `pauseRun` and `steerRun` Driver Operations to Spec-005

- Status: `completed`
- Resolution: applyIntervention added, pause removed from flags. See ADR-011, Spec-005.
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-005](./specs/005-provider-driver-contract-and-capabilities.md), [Spec-004](./specs/004-queue-steer-pause-resume.md), [Run State Machine](./domain/run-state-machine.md)
- Summary: Resolved via `applyIntervention` as a generic dispatcher (10th driver operation). `pause` removed from capability flags (7 flags total). Pause is an orchestration-layer construct (interrupt + persist + queue resume). Steer and cancel route through `applyIntervention`. See ADR-011 and updated Spec-005.
- Exit Criteria: Every capability flag in Spec-005 has a corresponding driver operation or explicit documentation that an existing operation carries those semantics.

### BL-008: Complete Run State Machine Transition Table

- Status: `todo`
- Note: Run state machine updated to 9 states. See [updated run-state-machine.md](./domain/run-state-machine.md). Transition table completion remains.
- Priority: `P0`
- Owner: `unassigned`
- References: [Run State Machine](./domain/run-state-machine.md), [Spec-004](./specs/004-queue-steer-pause-resume.md)
- Summary: Run state machine updated to 9 states (dropped `recovering` and `interrupting`). `starting -> failed` added. Interrupt paths from `paused`, `waiting_for_approval`, and `waiting_for_input` added. Recovery is handled by startup reconciliation (no visible state). Child-run cascade behavior defined. Transition table completion remains — validate all transitions against implementation.
- Exit Criteria: Transition table includes all transitions described in edge cases. Interrupt paths from all blocking states are defined. Child-run behavior when a parent run is paused or terminated is defined.

### BL-009: Reconcile Intervention States Between Domain Model and Spec-004

- Status: `todo`
- Note: Intervention model updated to 6 states. See [updated queue-and-intervention-model.md](./domain/queue-and-intervention-model.md). Full reconciliation remains.
- Priority: `P0`
- Owner: `unassigned`
- References: [Queue and Intervention Model](./domain/queue-and-intervention-model.md), [Spec-004](./specs/004-queue-steer-pause-resume.md)
- Summary: Domain model and Spec-004 now both define 6 canonical intervention states: `requested`, `accepted`, `applied`, `rejected`, `degraded`, `expired`. Entity relationship is explicit: `InterventionRequest` (inbound command), `InterventionResult` (outcome record), `Intervention` (lifecycle entity encompassing both). Spec-004 now references domain model payload shapes and version guard semantics. Full reconciliation remains — verify field-level consistency during implementation.
- Exit Criteria: One canonical set of intervention states exists in the domain model. Spec-004 references the domain model states consistently. The relationship between `Intervention`, `InterventionRequest`, and `InterventionResult` is explicit.

### BL-010: Specify Invite Delivery Mechanism

- Status: `todo`
- Note: Invite token format specified. See [updated Spec-002](./specs/002-invite-membership-and-presence.md). Delivery mechanism specification remains.
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-002](./specs/002-invite-membership-and-presence.md), [Plan-002](./plans/002-invite-membership-and-presence.md)
- Summary: Spec-002 covers the full invite lifecycle (issued -> accepted/declined/revoked/expired) with default join mode `collaborator`, default expiry 7 days, and authentication requirement before acceptance. However, it does not specify how an invite reaches the invitee — email, shareable link, in-app notification, deep link, or other mechanism. Plan-002 step 4 says "Integrate desktop invite acceptance and participant roster surfaces" but there is no specification for the delivery path. This blocks the end-to-end invite flow. Note: this is the highest-risk feature in the product since zero reference apps (Forge, CodexMonitor, Paseo) implement multi-user invites. Must specify at least one delivery mechanism for v1 (e.g., shareable link with token). Must also specify: invite token format, entropy requirements, single-use vs multi-use, and rate limiting on invite creation.
- Exit Criteria: Spec-002 updated with at least one invite delivery mechanism. Invite token security properties defined. Rate limiting specified.

### BL-013: Resolve Sequence-Assignment Contradiction

- Status: `completed`
- Resolution: Single-authority model adopted — sequence numbers assigned by the authoritative session-visible append path at write time. See Spec-006. Plan-006 updated to match.
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md), [Plan-006](./plans/006-session-event-taxonomy-and-audit-log.md)
- Summary: Direct contradiction between spec and plan. Spec-006 "Open Questions" states: "No blocking open questions remain for v1. V1 decision: session sequence numbers are assigned by the authoritative session-visible append path at write time." Plan-006 "Risks And Blockers" states: "Session-sequence assignment across local and shared producers remains unresolved." The spec claims the question is resolved; the plan claims it is not. One document must be corrected.
- Exit Criteria: Spec-006 and Plan-006 agree on whether sequence assignment is resolved. If resolved, both say so. If unresolved, both say so and the open question is tracked.

### BL-014a: Decide Workflow V1 Scope

- Status: `completed`
- Resolution: Workflows are V1: single-agent + automated phases, all 4 gates. See Spec-017.
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-017](./specs/017-workflow-authoring-and-execution.md), [Vision](./vision.md)
- Summary: Must decide whether workflows are v1 or post-v1. This decision gates BL-014b. If post-v1, Spec-017 is adequate as a directional document. If v1, Spec-017 needs substantial expansion (see BL-014b).
- Exit Criteria: Documented v1 scope decision for workflows.

---

## P1: Blocks Specific Features

### BL-016: Specify Owner Elevation, Last-Owner Departure, and Concurrent Membership Conflicts

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Participant and Membership Model](./domain/participant-and-membership-model.md), [Spec-002](./specs/002-invite-membership-and-presence.md)
- Summary: The participant model states `owner` is a bootstrap/elevation role, not a normal invite join mode. Three unresolved areas: (1) How is a second owner created? How does elevation from collaborator to owner work? What authorization is required? The only specified path to `owner` is session creation bootstrap. (2) What happens when the last `owner` leaves or is revoked? Is the session orphaned? Can a viewer be elevated without a new invite? What happens to active runs when a `runtime contributor`'s membership is revoked mid-run? (3) Concurrent membership conflict resolution — if two owners simultaneously revoke each other, what happens? What is the conflict resolution strategy for concurrent membership mutations?
- Exit Criteria: Spec-002 or participant model updated with owner elevation mechanism, authorization requirements, last-owner departure behavior, and concurrent mutation conflict resolution.

### BL-017: Define Session, Channel, and Participant Limits

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-001](./specs/001-shared-session-core.md), [Spec-016](./specs/016-multi-agent-channels-and-orchestration.md)
- Summary: No maximum on participants per session, channels per session, concurrent runs per session, or agents per session is defined anywhere. Spec-016 says rejection for capacity violations must be explicit but proposes no default limits. Must define at minimum: max participants per session, max channels per session, max concurrent runs per session, max agents per session, max concurrent child runs per parent. These limits affect resource allocation, UI design, and provider cost management.
- Exit Criteria: Default limits exist for all resource dimensions. Limits are documented in the relevant specs.

### BL-018: Add Handoff to Timeline Entry Types

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-013](./specs/013-live-timeline-visibility-and-reasoning-surfaces.md), [Vision](./vision.md)
- Summary: The vision lists `handoff` as a required timeline entry type. Spec-013 covers messages, run state changes, tool activity, approvals, interventions, artifacts, and child-run activity, but does not mention agent-to-agent or participant-to-agent handoffs as a discrete timeline row type. Additionally, run-state subtypes (`paused`, `resumed`, `finished`, `blocked`) are covered generically under "run state changes" but not individually enumerated as timeline row types, which could lead to inconsistent rendering.
- Exit Criteria: Spec-013 updated with `handoff` as an explicit timeline entry type. Run-state subtypes individually enumerated.

### BL-019: Specify Workspace-to-Worktree Binding State Transitions

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Repo Workspace Worktree Model](./domain/repo-workspace-worktree-model.md), [Spec-009](./specs/009-repo-attachment-and-workspace-binding.md), [Spec-010](./specs/010-worktree-lifecycle-and-execution-modes.md)
- Summary: The domain model says a workspace "must resolve to one concrete filesystem root at execution time" but the exact mapping when a workspace switches from read-only to worktree mode is not spelled out. Spec-009 shows the workspace remaining "the same session-bound concept" while the daemon provisions an isolated execution root. But: does the workspace go through `provisioning` again? Or is a new workspace entity created? The workspace state machine (`provisioning` -> `ready` -> `busy` -> `stale` -> `archived`) does not define a path for mode switching. Also missing: ephemeral clone cleanup lifecycle — Spec-010 mentions cleanup policy but defines no disposal or garbage-collection states or triggers.
- Exit Criteria: Domain model or Spec-009 updated with explicit state transitions for mode switching. Ephemeral clone disposal lifecycle defined.

### BL-020: Resolve DiffArtifact vs General Artifact Schema Relationship

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-011](./specs/011-gitflow-pr-and-diff-attribution.md), [Spec-014](./specs/014-artifacts-files-and-attachments.md), [Plan-011](./plans/011-gitflow-pr-and-diff-attribution.md), [Plan-014](./plans/014-artifacts-files-and-attachments.md)
- Summary: Plan-011 creates a `diff_artifacts` table. Plan-014 creates `artifact_manifests` and `artifact_payload_refs` tables. It is unclear whether diff artifacts are a subtype using the general artifact manifest infrastructure or a parallel schema. This affects implementation order: if they share infrastructure, Plan-014 is a dependency of Plan-011. The data architecture says artifact payloads are "stored locally or shared according to policy" but the storage mechanism (filesystem? blob store? SQLite BLOBs?) is never specified.
- Exit Criteria: Relationship between `DiffArtifact` and general artifact system is explicit. Artifact storage mechanism is specified. Implementation ordering between Plans 011 and 014 is defined.

### BL-021: Define Approval Category Canonical Enum

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-012](./specs/012-approvals-permissions-and-trust-boundaries.md), [Plan-012](./plans/012-approvals-permissions-and-trust-boundaries.md)
- Summary: Spec-012 now defines all 8 canonical approval categories: `tool_execution`, `file_write`, `network_access`, `destructive_git`, `user_input`, `plan_approval`, `mcp_elicitation`, `gate`. ADR-012 defines the Cedar policy engine for evaluation. Remaining work: verify Plan-012 references these categories and Cedar.
- Exit Criteria: Canonical approval category enum exists in Spec-012 or the domain model.

### BL-022: Add Runtime Binding to Domain Glossary

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-005](./specs/005-provider-driver-contract-and-capabilities.md), [Spec-015](./specs/015-persistence-recovery-and-replay.md), [Glossary](./domain/glossary.md)
- Summary: "Runtime binding" is used by Spec-005 (association between a driver and a canonical run) and Spec-015 (extended to include resume handles and recovery metadata) but is not defined in any domain model or the glossary. The term is critical for the persistence and recovery model.
- Exit Criteria: "Runtime binding" defined in the glossary with fields and semantics.

### BL-023: Specify Relay Protocol

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-008](./specs/008-control-plane-relay-and-session-join.md), [ADR-008](./decisions/008-default-transports-and-relay-boundaries.md), [Security Architecture](./architecture/security-architecture.md)
- Summary: Spec-008 separates join (membership action) from relay (connectivity action) and says the control plane coordinates relay but never gains execution authority. ADR-010 decided MLS (RFC 9420) for relay E2EE (rejecting NaCl box due to lack of forward secrecy). Spec-008 now includes MLS relay encryption details, KeyPackage signing, and wire format. Remaining work: full relay protocol specification including connection lifecycle, message framing, and relay negotiation payload shape. Relay sharding (25 connections per data DO) is specified in deployment-topology.md.
- Exit Criteria: Relay protocol specification exists covering encryption model, key exchange, message framing, connection lifecycle, and trust properties.

### BL-024: Specify Steer Injection Mechanics and Intervention Payloads

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-004](./specs/004-queue-steer-pause-resume.md), [Queue and Intervention Model](./domain/queue-and-intervention-model.md)
- Summary: Intervention payload shapes are now defined in the domain model as a discriminated union by type: `steer` (`targetRunId`, `expectedTurnId`, `expectedRunVersion`, `content`, `attachments?`), `interrupt` (`targetRunId`, `expectedRunVersion`, `reason?`), `cancel` (`targetRunId`, `expectedRunVersion`, `reason?`). All carry version guards. Spec-004 now references these shapes. Remaining work: steer injection mechanics at the driver interface level — how does `applyIntervention(type: "steer")` differ from `respondToRequest`? Document the boundary between intervention dispatch and interactive request handling.
- Exit Criteria: Intervention payload shapes defined for each intervention type (steer, interrupt, cancel). Steer injection mechanics documented at the driver interface level.

### BL-025: Specify Presence Heartbeat Transport and Channel Discovery

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-002](./specs/002-invite-membership-and-presence.md), [Spec-016](./specs/016-multi-agent-channels-and-orchestration.md)
- Summary: Two related gaps: (1) Presence heartbeat transport — Spec-002 defines timing (15s heartbeat, 45s reconnect grace) but not transport (WebSocket keepalive? dedicated polling endpoint? SSE?). (2) Channel naming, discovery, and listing — channels are created and used but no spec defines how participants discover or list available channels within a session. Both affect the real-time collaboration experience.
- Exit Criteria: Heartbeat transport mechanism specified. Channel listing/discovery interface defined.

### BL-026: Add Error Contracts to All Specs

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: All specs
- Summary: No spec defines error response shapes or error codes for any interface. Error contracts are needed for consistent client behavior across all surfaces (CLI, desktop, SDK). Must define at minimum: error response shape (code, message, details), canonical error codes per domain (auth errors, session errors, run errors, approval errors), and rate limiting responses. Can be done as a single cross-cutting error contract document rather than per-spec.
- Exit Criteria: Error contract document exists with canonical error shape, error codes per domain, and rate limiting response format. All specs reference or link to it.

### BL-011: Specify Channel Turn Policy, Budget Policy, and Stop Conditions

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-016](./specs/016-multi-agent-channels-and-orchestration.md), [Vision](./vision.md)
- Summary: The vision explicitly lists "turn policy", "budget policy", "stop conditions", and "moderation and approval hooks" as channel attributes for multi-user and multi-agent chat. The current specs define channels as session-local communication streams with states but specify none of these behavioral policies. For context, Forge implements ping-pong deliberation with conclusion detection, 4 channel types (guidance, deliberation, review, system), and per-role model overrides. ai-sidekicks has none of this. Must specify at minimum: (1) turn policy — how do agents/participants take turns? Round-robin, request-based, free-form, ping-pong? (2) budget policy — token limits? cost limits? turn limits per agent? (3) stop conditions — when does a multi-agent conversation end? Conclusion detection? Turn limit? (4) moderation hooks — how are approval/review gates integrated into channels? (5) Default scheduler limits — Spec-016 says rejection for capacity violations must be explicit but proposes no defaults.
- Exit Criteria: Spec-016 updated with turn policy, budget policy, stop conditions, moderation hooks, and default scheduler limits. At least one concrete policy per dimension is specified for v1.

### BL-012: Enumerate Individual Event Types Within Taxonomy

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md), [Plan-006](./plans/006-session-event-taxonomy-and-audit-log.md)
- Summary: Spec-006 names 9 event categories (session lifecycle, invite/membership, presence, channel/agent lifecycle, run lifecycle, queue/intervention, approval, repo/workspace/worktree, artifact/diff) and defines envelope fields (`eventId`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, correlation/causation). However, it does not enumerate specific event types within each category (e.g., `run.started`, `run.paused`, `approval.requested`). Implementers must derive these from domain models with no canonical list. For context, Forge defines 27 base + 42 extended orchestration event types (69 total concrete types with full payload schemas). ai-sidekicks has zero concrete event types defined. Must enumerate every event type, its payload schema, and which category it belongs to.
- Exit Criteria: Spec-006 contains a canonical enumeration of all event types within each category, with payload schemas or references to contract definitions.

### BL-014b: Expand Spec-017 Workflow Specification

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-017](./specs/017-workflow-authoring-and-execution.md), [Plan-017](./plans/017-workflow-authoring-and-execution.md)
- Summary: BL-014a is completed — workflows are V1 scope (single-agent + automated phases, all 4 gates). Spec-017 now defines V1 phase types (`single-agent`, `automated`), gate types (`auto-continue`, `quality-checks`, `human-approval`, `done`), full type hierarchy, definition/execution entity separation, and LangGraph checkpoint pattern. Remaining gaps vs Forge baseline: quality-check model (retry targets, max retries), output mode specification, discussion integration, and workflow runtime timeline with phase runs and iterations.
- Exit Criteria: Spec-017 updated with phase-type taxonomy, gate-type taxonomy with failure/retry semantics, quality-check model, output mode specification, and discussion integration. Domain model docs created for `Workflow` and `WorkflowPhase` entities.

### BL-015: Define Per-Driver Capability Matrix

- Status: `todo`
- Note: Capability flags updated to 7 (pause removed). See [ADR-011](./decisions/011-generic-intervention-dispatch.md). Matrix definition remains.
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-005](./specs/005-provider-driver-contract-and-capabilities.md), [Plan-005](./plans/005-provider-driver-contract-and-capabilities.md)
- Summary: Plan-005 builds two initial drivers (Codex and Claude) against the normalized contract but never specifies which capability flags each driver will support. The 7 flags are: `resume`, `steer`, `interactive_requests`, `mcp`, `tool_calls`, `reasoning_stream`, `model_mutation` (pause removed per ADR-011 — it is an orchestration-layer construct). Implementers building the drivers need to know the expected matrix. For context: Codex supports resume, steer (via `turn/steer`), interactive requests, MCP, tool calls; Claude supports resume (via SDK), interactive requests, MCP, tool calls, reasoning stream, model mutation. This matrix drives fallback behavior: unsupported steer -> reject or degrade to queue item.
- Exit Criteria: Spec-005 or Plan-005 includes a capability matrix showing expected `true`/`false` for each flag for each initial driver (Codex, Claude).

### BL-037: Specify Git Hosting Adapter Abstraction for PR Preparation

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-011](./specs/011-gitflow-pr-and-diff-attribution.md), [Plan-011](./plans/011-gitflow-pr-and-diff-attribution.md)
- Summary: Plan-011 non-goals exclude "Full GitHub or git-host integration breadth," but `PRPrepare` inherently requires some hosting integration — it must generate a reviewable proposal and eventually create a PR on a remote host. No adapter interface is specified for this integration. All three reference apps (Forge, CodexMonitor, Paseo) use the `gh` CLI for GitHub operations as a hard dependency. Must decide: (1) is `gh` CLI the default v1 hosting adapter? (2) should there be a `GitHostingAdapter` interface to support GitHub, GitLab, etc.? (3) what operations does the adapter expose (PR create, PR status, PR diff)?
- Exit Criteria: Git hosting adapter decision documented. If an adapter interface is chosen, it is specified in Spec-011 or a new spec. Default v1 hosting tool identified.

---

## P2: Should Resolve Before V1 Ship

### BL-027: Decide V1 Feature Scope for Reference App Capabilities

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Vision](./vision.md)
- Summary: 20 significant features shipped by reference apps have no corresponding spec, plan, or mention in ai-sidekicks documentation. A v1/v2/out-of-scope decision is needed for each. From Forge: (1) design mode — HTML artifact preview in sandboxed iframe; lets users see and iterate on generated UI without leaving the app; (2) summary generation — model-driven thread summaries; reduces context overhead for long conversations; (3) terminal multiplexing — multi-terminal per thread with subprocess detection and context attachment; lets agents and users run commands with output feeding back into the session; (4) project scripts — per-project runnable scripts with worktree auto-run; automates lint/build/test workflows; (5) context window / rate limit meters — real-time provider usage visibility; prevents surprise context exhaustion; (6) stacked git actions — atomic commit+push+PR as one operation; eliminates multi-step git workflow friction; (7) AI commit messages — model-assisted commit message and PR description generation; reduces developer toil; (8) multi-select thread operations — bulk archive/delete; needed for workspace hygiene at scale; (9) WSL integration — Windows users running Linux-based tools need seamless bridging. From CodexMonitor: (10) dictation / voice input — hands-free coding interaction and accessibility; (11) mobile/responsive support — tablet and phone layouts for monitoring on the go; (12) tray integration — background awareness without keeping the app focused; (13) prompt library — reusable parameterized prompts; reduces repetitive typing. From Paseo: (14) voice / speech — bidirectional realtime voice conversation with agents; highest-bandwidth human-agent interaction; (15) loops — iterative prompt execution with shell-command and LLM-based verification; automates repetitive improvement cycles; (16) schedules — cron/interval agent runs; enables unattended maintenance and monitoring tasks; (17) MCP agent-to-agent tools — 30 MCP tools for structured inter-agent communication without human mediation; (18) skills system — installable multi-agent orchestration methodologies; lets advanced users define reusable patterns; (19) 5+ provider support — Claude, Codex, Copilot/Pi, OpenCode, generic ACP; broadest model choice; (20) relay with E2E encryption — zero-knowledge encrypted remote access; enables secure collaboration without VPN. Items 3, 5, and 6 are commonly expected developer tool features. Items 14-18 and 20 represent significant Paseo capabilities with no ai-sidekicks equivalent.
- Exit Criteria: Each of the 20 features has a documented v1/v2/out-of-scope decision. Features scoped to v1 have specs created or existing specs updated.

### BL-028: Create Domain Models for Workflow and WorkflowPhase

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-017](./specs/017-workflow-authoring-and-execution.md)
- Summary: `Workflow` and `WorkflowPhase` are referenced in Spec-017 but no domain model document exists for either. The vision's 15-entity domain model does not include these. If workflows are v1, these entities need domain model docs with lifecycle states, invariants, and relationships comparable to the other domain models.
- Exit Criteria: Domain model docs exist for Workflow and WorkflowPhase with lifecycle states, invariants, and entity relationships.

### BL-029: Specify Control-Plane Transport Protocol

- Status: `todo`
- Note: Transport protocol decided in [ADR-014](./decisions/014-trpc-control-plane-api.md): tRPC v11 for request-response and SSE subscriptions, WebSocket (JSON-RPC 2.0) for bidirectional collaboration channels. Container-architecture.md updated.
- Priority: `P2`
- Owner: `unassigned`
- References: [Container Architecture](./architecture/container-architecture.md), [Spec-008](./specs/008-control-plane-relay-and-session-join.md), [ADR-014](./decisions/014-trpc-control-plane-api.md)
- Summary: Transport protocol decided (tRPC v11 + WebSocket). Remaining work: propagate protocol choice into Spec-008 relay negotiation details and client SDK implementation guidance.
- Exit Criteria: Control-plane transport protocol chosen and documented in architecture docs.

### BL-030: Define Deployment Scaling and HA Strategy

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Deployment Topology](./architecture/deployment-topology.md)
- Summary: Deployment topology defines 4 correct logical shapes (single-participant, collaborative hosted, collaborative self-hosted, relay-assisted) with degradation modes. However: no horizontal scaling strategy for control plane, no database replication for shared Postgres, no capacity numbers (max sessions, participants, events/second), no infrastructure requirements (CPU/memory/disk for daemon or control plane), no CI/CD or release process, no multi-region considerations, and no container/packaging strategy.
- Exit Criteria: Deployment topology updated with scaling strategy, capacity guidance, and infrastructure requirements.

### BL-031: Add Concrete Commands and Thresholds to Operations Runbooks

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: All [operations runbooks](./operations/)
- Summary: The 8 runbooks are well-structured (Purpose, Symptoms, Detection, Preconditions, Recovery Steps, Validation, Escalation, Related Docs) and cover realistic failure modes. However: (1) no concrete CLI commands or scripts are included — runbooks reference API surfaces but never include actual commands; (2) no SLOs or thresholds are defined — "presence becomes stale" lacks a definition of stale, "stuck threshold" is not quantified; (3) no on-call routing — escalation says "escalate when..." but never says to whom or through what channel.
- Exit Criteria: Each runbook includes example CLI commands. Quantified thresholds exist for detection conditions. On-call routing is specified.

### BL-032: Specify Event Compaction Policy

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md), [Spec-015](./specs/015-persistence-recovery-and-replay.md)
- Summary: Spec-006 states high-volume payloads "may be compacted" and compacted events retain audit stubs, but no compaction trigger, retention window, or compaction format is defined. Spec-015 explicitly defers snapshot compaction. Must specify: when compaction triggers, what retention window applies, how compacted events are represented, and how replay interacts with compacted regions.
- Exit Criteria: Compaction policy documented with triggers, retention, format, and replay interaction.

### BL-033: Specify Rate Limiting for All APIs

- Status: `todo`
- Note: [Spec-021](./specs/021-rate-limiting-policy.md) now exists and defines deployment-aware rate limiting (CF native hosted, rate-limiter-flexible self-hosted). Deployment-topology.md updated with rate limiting by deployment table.
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-021](./specs/021-rate-limiting-policy.md), [Deployment Topology](./architecture/deployment-topology.md), All specs
- Summary: Spec-021 defines the rate limiting framework and deployment-aware implementation strategy. Remaining work: specify concrete rate limit values for each control-plane API (invite creation, session creation, presence heartbeats, etc.).
- Exit Criteria: Rate limiting policy exists for at least the control-plane-facing APIs (invite, session, presence).

### BL-034: Specify Context Window and Usage Meters

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-013](./specs/013-live-timeline-visibility-and-reasoning-surfaces.md)
- Summary: Forge ships context-window meters (usage %, tokens, auto-compaction hints) and rate-limit displays (threshold coloring, reset timing). CodexMonitor ships a usage ring in the composer. No ai-sidekicks spec addresses these UX surfaces. These are commonly expected features in developer tools that interact with LLMs.
- Exit Criteria: Spec-013 or a new spec covers context-window and provider usage/rate-limit visibility in the timeline and composer.

### BL-035: Specify Notification Delivery for Offline/Cross-Device

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Spec-019](./specs/019-notifications-and-attention-model.md)
- Summary: Spec-019 defines the attention model (actionable vs informational, run-scoped vs session-scoped) with degradation paths. However, no notification delivery mechanism is specified for the control plane — how does an invite notification reach a user who is offline or on a different device? The spec explicitly excludes mobile push and email, but the desktop-only delivery path is not fully specified (does the control plane push to the desktop shell? does the shell poll?).
- Exit Criteria: Notification delivery mechanism specified for at least desktop-to-desktop and cross-device scenarios.

### BL-036: Specify Session Data Retention, Deletion, and GDPR Compliance

- Status: `todo`
- Note: [Spec-022](./specs/022-data-retention-and-gdpr.md) now exists and defines crypto-shredding, data export, purge states, and 90-day retention. Session model updated with `purge_requested` and `purged` states (including `closed -> purge_requested` path).
- Priority: `P2`
- Owner: `unassigned`
- References: [Session Model](./domain/session-model.md), [Spec-001](./specs/001-shared-session-core.md), [Spec-022](./specs/022-data-retention-and-gdpr.md), [Data Architecture](./architecture/data-architecture.md)
- Summary: Spec-022 defines the GDPR compliance framework including crypto-shredding, data export, and purge lifecycle. Remaining work: implement the V1 schema (pii_payload column, participant_keys table) and produce the PII data map prerequisite.
- Exit Criteria: Data retention and deletion policy documented. Session model or data architecture updated with lifecycle beyond `archived`.

---

## Item Template

Use this shape for new backlog items:

```md
### BL-0XX: Short Title

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Relevant Spec](./specs/000-spec-template.md), [Relevant Plan](./plans/000-plan-template.md)
- Summary: One or two sentences describing the deliverable or change.
- Exit Criteria: Concrete condition that makes this item complete.
```

## Maintenance Rule

If information in a backlog item becomes durable product truth, move that information into the canonical docs and keep only the remaining work here.
