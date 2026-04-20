# Spec-006: Session Event Taxonomy And Audit Log

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `006` |
| **Slug** | `session-event-taxonomy-and-audit-log` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Session Model](../domain/session-model.md), [Run State Machine](../domain/run-state-machine.md), [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Data Architecture](../architecture/data-architecture.md), [Observability Architecture](../architecture/observability-architecture.md) |
| **Implementation Plan** | [Plan-006: Session Event Taxonomy And Audit Log](../plans/006-session-event-taxonomy-and-audit-log.md) |

## Purpose

Define the canonical event envelope and taxonomy used for replay, audit, and live projections.

## Scope

This spec covers event categories, required event fields, ordering, replay, and audit retention requirements.

## Non-Goals

- Full UI rendering rules for the timeline
- Metrics-only observability details
- Storage engine implementation details

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Required Behavior

- Every durable session-relevant change must emit a canonical event.
- Canonical events must include at least `eventId`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, and correlation or causation metadata where applicable.
- The taxonomy must cover at least:
  - session lifecycle
  - invite and membership
  - participant and runtime-node presence
  - channel and agent lifecycle
  - run lifecycle
  - queue and intervention
  - approval requests and resolutions
  - repo, workspace, and worktree lifecycle
  - artifact and diff publication
- Events must be immutable after append.
- Replay must support reading after a known cursor and reading bounded windows.

## Default Behavior

- Canonical event metadata is retained indefinitely unless an explicit retention policy supersedes it.
- Per-session event ordering is presented as a monotonically increasing sequence in session projections.
- High-volume payloads may be compacted, but their audit stub must preserve type, actor, timestamps, and provenance.

## Fallback Behavior

- If a client detects a live-stream gap, it must rehydrate from the canonical event log starting after the last acknowledged sequence.
- If full payload data has been compacted, the system must still return an audit-visible stub rather than pretending the event never existed.
- If a producer cannot emit a canonical event immediately, the related state change must not be considered committed.

## Interfaces And Contracts

- `EventEnvelope` must be versioned.
- `EventReadAfterCursor` must return ordered events plus next replay cursor.
- `EventReadWindow` must support bounded historical windows for replay and inspection.
- `EventSubscription` must expose live append-only delivery together with replay catch-up semantics.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

### EventEnvelope Version Semantics

Full semantics of the `.version` field are specified in [ADR-018: Cross-Version Compatibility](../decisions/018-cross-version-compatibility.md). The binding contract summary:

> **Terminology note — "version stub" vs. "compaction stub":** This section uses "**version stub**" for the receiver-side artifact produced when an unknown-type event is preserved verbatim (full canonical bytes retained so the Ed25519 signature stays verifiable). This is structurally distinct from the "audit stub" form produced by §Event Compaction Policy below, which removes `payload`, `correlationId`, and `causationId` and replaces them with a `summary`. A version stub retains all canonical fields; a compaction stub does not. A version stub is only eligible for compaction once it has been re-interpreted at least once, per ADR-018 §Decision #11.

- **Format:** Semver string `"MAJOR.MINOR"` (no PATCH component on the wire). Integer form is not used.
- **Producer sets it:** The emitting daemon writes its own outgoing wire version at emit time. `.version` is never copied from a received event. Version stubs record their original received version in version-stub metadata, separate from `.version`.
- **Validation is two-sided:** The control plane validates at write time; receiving peers validate on parse. A receiver that cannot interpret a given `.version` MUST persist the event as a version stub rather than drop or crash.
- **Unknown MAJOR (same or higher than receiver's supported MAJOR):** Persist as version stub with full original canonical bytes; never dispatched to application handlers. The canonical row's `.version` field stays the producer's original — version-stubbing is a read-side behavior, not a rewrite. On upgrade, the upcaster chain transforms the stub to a typed event at dispatch time; the log row is never rewritten.
- **Unknown MINOR (same MAJOR, higher MINOR):** Event dispatches normally; unknown optional fields and unknown enum values within the payload are preserved verbatim for future upcasting. MINOR bumps MUST be additive-only per ADR-018.
- **MAJOR mismatch at session join:** Hard error with typed code. `VERSION_FLOOR_EXCEEDED` if client is below `session.min_client_version`; `VERSION_CEILING_EXCEEDED` if client is above the session's highest supported MAJOR. Errors carry a human-readable upgrade/downgrade path; join is rejected, client does not crash. Both codes MUST be registered in [Error Contracts](../architecture/contracts/error-contracts.md) before the first Plan-001 emitter lands.
- **Below-floor clients may READ but NOT WRITE.** A below-floor write attempt returns `VERSION_FLOOR_EXCEEDED` while the client remains joined in read-only state.
- **Immutability:** `.version` is set once at producer emit time and is part of the event's durable identity. It is never rewritten by upcasters, version-stub re-interpretation, or upgrade processes. This is load-bearing for the §Integrity Protocol hash-chain and signature invariants — the signed bytes include `.version`, so rewriting it would break all downstream verification.
- **Envelope version vs. event-type registry:** `.version` governs the envelope contract only. New event-type introductions are additive and MAY be allowed under the same envelope version if they follow the additive-only MINOR rule. V1 uses an accept-and-stub model for unknown types (each unknown type becomes a version stub on receipt); a central control-plane event-type registry is deferred to V1.1 per ADR-018 §Alternatives Considered Option C.

## Event Type Enumeration

This section enumerates every individual event type within each `EventCategory`. Each type is a string value for the `type` field of `EventEnvelope`. The payload fields listed are the category-specific fields carried inside the `payload` object; the envelope-level fields (`id`, `sessionId`, `sequence`, `occurredAt`, `category`, `actor`, `correlationId`, `causationId`, `version`) are always present and are not repeated here.

### Session Lifecycle (`session_lifecycle`)

Payload shape: `{sessionId, previousState?, newState, actor?}`

| Type | Description |
| --- | --- |
| `session.created` | A new session has been created. |
| `session.activated` | A session has moved from created to active. |
| `session.archived` | A session has been archived and is no longer active. |
| `session.reactivated` | An archived session has been returned to active state. |
| `session.closed` | A session has been permanently closed and cannot be reactivated. |
| `session.purge_requested` | A purge of session data has been requested. |
| `session.purged` | Session data has been permanently deleted. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Invite and Membership (`membership_change`)

Payload shape: `{sessionId, participantId, inviteId?, previousRole?, newRole?, actor}`

| Type | Description |
| --- | --- |
| `invite.created` | An invitation to join the session has been created. |
| `invite.accepted` | A participant has accepted a session invitation. |
| `invite.revoked` | A session invitation has been revoked before acceptance. |
| `invite.expired` | A session invitation has expired without being accepted. |
| `membership.role_changed` | A participant's role within the session has been changed. |
| `membership.suspended` | A participant's membership has been suspended. |
| `membership.revoked` | A participant's membership has been permanently revoked. |
| `membership.reactivated` | A suspended participant's membership has been restored. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Presence (`membership_change`)

Durable state-change events recorded in the canonical event log. These are distinct from ephemeral Yjs Awareness updates used for real-time cursor and typing indicators.

Payload shape: `{sessionId, participantId, deviceId, previousState?, newState}`

| Type | Description |
| --- | --- |
| `presence.online` | A participant's device has connected and is actively present. |
| `presence.idle` | A participant's device has become idle. |
| `presence.reconnecting` | A participant's device has lost connection and is attempting to reconnect. |
| `presence.offline` | A participant's device has disconnected. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Channel and Agent Lifecycle (`session_lifecycle`)

Payload shape: `{sessionId, channelId?, agentId?, actor}`

| Type | Description |
| --- | --- |
| `channel.created` | A new channel has been created within the session. |
| `channel.muted` | A channel has been muted, suppressing its output in projections. |
| `channel.archived` | A channel has been archived and is no longer active. |
| `agent.attached` | An agent has been attached to the session or a channel. |
| `agent.detached` | An agent has been detached from the session or a channel. |
| `agent.config_updated` | An agent's configuration has been updated. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Channel Arbitration (`channel_arbitration`)

Orchestration-layer visibility events for multi-agent channels whose turn-policy arbitration stalls or resumes. These are distinct from run-level `run.paused` — they describe whose turn it was when arbitration stalled, not an intentional run suspension. Registered here from [Spec-016 §Partition And Reconnect Behavior](./016-multi-agent-channels-and-orchestration.md).

Payload shape: `{sessionId, channelId, unreachableNodeId, unreachableAgentId, turnPolicy, timestamp}`

| Type | Description (When Fired) |
| --- | --- |
| `arbitration.paused` | A `round-robin` channel's next-due agent sits on a runtime node that has transitioned to `offline` per [Spec-003](./003-runtime-node-attach.md). Arbitration halts so canonical turn ordering is preserved rather than skipping ahead. |
| `arbitration.resumed` | The previously unreachable node has reconnected and canonical ordering has been restored; arbitration resumes from the stored next-due agent. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Run Lifecycle (`run_lifecycle`)

One event per state from the [Run State Machine](../domain/run-state-machine.md)'s 9 canonical states.

Payload shape: `{sessionId, runId, previousState, newState, channelId?, failureCategory?: RunFailureCategory, recoveryCondition?: 'recovery-needed', trigger?}`

| Type | Description |
| --- | --- |
| `run.queued` | A run has been created and placed in the queue. |
| `run.starting` | The runtime is preparing provider, workspace, or execution state for the run. |
| `run.running` | The run is actively executing. |
| `run.waiting_for_approval` | The run is blocked on an approval request. |
| `run.waiting_for_input` | The run is blocked on participant input or structured answers. |
| `run.paused` | The run has been intentionally suspended. |
| `run.completed` | The run finished successfully. |
| `run.interrupted` | The run ended due to an interrupt or cancel path. |
| `run.failed` | The run ended due to an unrecovered error. `failureCategory` and `recoveryCondition` provide detail. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Queue and Intervention (`interactive_request`)

#### Queue Events

Payload shape: `{sessionId, queueItemId, channelId?, state}`

| Type | Description |
| --- | --- |
| `queue_item.created` | A new item has been added to the queue. |
| `queue_item.admitted` | A queued item has been admitted to execution. |
| `queue_item.superseded` | A queued item has been replaced by a newer item. |
| `queue_item.canceled` | A queued item has been canceled before execution. |
| `queue_item.expired` | A queued item has expired without being admitted. |

#### Intervention Events

Payload shape: `{sessionId, interventionId, targetRunId, type: InterventionType, state: InterventionState, actor}`

| Type | Description |
| --- | --- |
| `intervention.requested` | An intervention against a run has been requested. |
| `intervention.accepted` | An intervention request has been accepted for application. |
| `intervention.applied` | An intervention has been successfully applied to the target run. |
| `intervention.rejected` | An intervention request has been rejected. |
| `intervention.degraded` | An intervention was applied but with degraded effect. |
| `intervention.expired` | An intervention request has expired without being applied. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Approval Flow (`approval_flow`)

Payload shape: `{sessionId, runId, approvalRequestId, category: ApprovalCategory, scope, approver?, rememberedScope?}`

| Type | Description |
| --- | --- |
| `approval.requested` | An approval request has been created for a run action. |
| `approval.approved` | An approval request has been granted. |
| `approval.rejected` | An approval request has been denied. |
| `approval.expired` | An approval request has expired without a decision. |
| `approval.remembered` | An approval decision has been remembered for future matching actions. |
| `approval.rule_revoked` | A previously remembered approval rule has been revoked. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Repo, Workspace, and Worktree Lifecycle (`session_lifecycle`)

Payload shape: `{sessionId, repoMountId?, workspaceId?, worktreeId?, state, actor?}`

| Type | Description |
| --- | --- |
| `repo.attached` | A repository has been attached to the session. |
| `repo.detached` | A repository has been detached from the session. |
| `workspace.provisioning` | A workspace is being provisioned. |
| `workspace.ready` | A workspace has finished provisioning and is ready for use. |
| `workspace.stale` | A workspace has been marked stale due to drift or inactivity. |
| `workspace.archived` | A workspace has been archived. |
| `worktree.created` | A git worktree has been created within a workspace. |
| `worktree.ready` | A git worktree has been checked out and is ready for use. |
| `worktree.dirty` | A git worktree has uncommitted changes. |
| `worktree.merged` | A git worktree's changes have been merged to the target branch. |
| `worktree.retired` | A git worktree has been retired and removed. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Artifact and Diff Publication (`artifact_publication`)

Payload shape: `{sessionId, artifactId?, runId?, diffArtifactId?, visibility?, state}`

| Type | Description |
| --- | --- |
| `artifact.published` | An artifact has been published from a run. |
| `artifact.visibility_updated` | An artifact's visibility scope has been changed. |
| `artifact.superseded` | An artifact has been superseded by a newer version. |
| `diff.created` | A diff artifact has been created representing code changes. |
| `pr.prepared` | A pull request has been prepared from a diff artifact. |
| `pr.submitted` | A pull request has been submitted to the remote repository. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Assistant Output (`assistant_output`)

Payload shape: `{sessionId, runId, channelId?, contentType?, contentLength?}`

| Type | Description |
| --- | --- |
| `assistant.message` | The assistant has emitted a message to the session timeline. |
| `assistant.thinking_update` | The assistant has emitted a reasoning or thinking update. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Tool Activity (`tool_activity`)

Payload shape: `{sessionId, runId, toolName, toolCallId?, channelId?, durationMs?}`

| Type | Description |
| --- | --- |
| `tool.invoked` | A tool has been invoked by the assistant during a run. |
| `tool.result` | A tool invocation has returned a result. |
| `tool.error` | A tool invocation has failed with an error. |
| `tool.replayed` | A tool with `idempotency_class ∈ {idempotent, compensable}` was re-executed during restart recovery per [Spec-015 §Idempotency Classes and Recovery Behavior](015-persistence-recovery-and-replay.md#idempotency-classes-and-recovery-behavior). Payload: `{sessionId, runId, commandId, idempotencyClass, dedupeKey?}`. |
| `tool.skipped_during_recovery` | A tool with `idempotency_class = 'manual_reconcile_only'` was detected in-flight during recovery and was **not** re-executed per [Spec-015 §Idempotency Classes and Recovery Behavior](015-persistence-recovery-and-replay.md#idempotency-classes-and-recovery-behavior). Payload: `{sessionId, runId, commandId, reason}`. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Cross-Node Dispatch (`cross_node_dispatch`)

Cross-participant runtime-dispatch lifecycle events produced by [Spec-024](./024-cross-node-dispatch-and-approval.md). Each dispatch crosses two daemons — the caller's and the target's — and each daemon appends the complementary events to its own local `session_events` log per [ADR-017](../decisions/017-shared-event-sourcing-scope.md); no shared Postgres event log exists for these events in V1. Payloads never carry full PASETO tokens or secret material — ApprovalRecord envelopes are referenced by `approvalRecordRef` pointing to the local `cross_node_dispatch_approvals` row, not embedded verbatim in events.

Base payload shape: `{sessionId, dispatchId, callerParticipantId, targetParticipantId, targetNodeId, capability, timestamp}`. Per-event payload extensions (on top of base):

- Pre-approval failure (`.rejected`): `+ {reason}` naming which step failed (invalid signature, expired token, body-hash mismatch, replay, undeclared capability, policy-engine error).
- Approval refusal (`.denied`): `+ {approvalRecordRef, reason?}` — signed deny envelope reference.
- Approval success (`.approved`, `.approval_observed`): `+ {approvalRecordRef}`.
- Execution success (`.executed`, `.completed`, `.result_observed`): `+ {approvalRecordRef, resultRef?}` — `resultRef` points to the local dispatch-result record; full result payload is not carried inline.
- Post-approval failure (`.failed`): `+ {approvalRecordRef, reason}`.
- Mid-flight timeout (`.expired`): `+ {reason: 'caller_token_expired' | 'execution_deadline'}`.
- Buffered delivery (`.result_buffered`): `+ {approvalRecordRef, bufferedUntil}`.
- UI-notification stage (`.approval_requested`): base only (UI surface resolves additional context via `dispatchId`).
- Intake stage (`.sent`, `.received`): base only.

Lifecycle discipline: five terminal events — `.rejected`, `.denied`, `.failed`, `.expired`, `.completed` — are the **only** events that terminate a dispatch's lifecycle. Exactly one fires per `dispatchId`. Intermediate events may fire in sequence before the terminal event. `.executed` is intermediate and fires **when the capability handler returns a result** — i.e., the handler itself completed without raising. Two valid post-`.executed` paths exist per Spec-024 §Cross-Node Failure Semantics ("capability handler fails during **or after** execution"): the normal success path `.executed` → `.completed` (result ready for emission), and the post-handler-failure path `.executed` → `.failed` (result-emission error or other post-handler runtime fault after the handler returned). A `.failed` terminal can *also* fire without a prior `.executed` — if the handler itself raises before returning, the lifecycle goes straight to `.failed` with no intermediate `.executed`. Summary of valid success-path-ancestor lifecycles: (a) handler raises → `.failed`; (b) handler returns, post-handler step fails → `.executed` → `.failed`; (c) handler returns, result ready → `.executed` → `.completed`. The `.executed` / `.completed` split exists so audit reconstruction can distinguish (b) from (c) from a lost-terminal bug case (`.executed` recorded but no subsequent terminal in the log — the inter-step emit was lost or the daemon crashed mid-sequence). Result *delivery* to the caller is tracked separately from lifecycle termination: live-delivered results produce caller-side `.result_observed` after target `.completed`; if the caller was detached at `.completed` time, the target appends `.result_buffered` (a post-terminal delivery annotation, **not** a lifecycle state) and later delivery on caller reconnect produces caller-side `.result_observed`. The `.completed` / delivery separation exists because Spec-024 §Execution And Result Emission Example Flow 3 explicitly allows the success-path lifecycle to terminate at the target *before* the caller reconnects and observes the result.

| Type | Side | Description (When Fired) |
| --- | --- | --- |
| `dispatch.sent` | caller | Caller daemon has transmitted the dispatch envelope via the relay's pairwise-encrypted channel. |
| `dispatch.received` | target | Target daemon has received the envelope and passed intake validation (token signature, RFC 8785 body-hash binding, replay guard, capability declared). Intermediate. |
| `dispatch.rejected` | target | **Terminal, pre-approval.** Target rejected the dispatch before the approval stage — invalid signature, expired token, body-hash mismatch, replay, undeclared capability, or policy-engine error. Payload `reason` names the specific failure per Spec-024 §Target-Side Authentication. |
| `dispatch.approval_requested` | target | Cedar evaluation returned "requires owner approval" and the target daemon has surfaced the approval request to the node owner's UI per Spec-024 §Approval Gate. Intermediate, not terminal — the UI resolution produces `.approved` or `.denied`. |
| `dispatch.approved` | target | Node owner approved the dispatch and the dual-signed ApprovalRecord envelope has been constructed and persisted per Spec-024 §Dual-Signed ApprovalRecord. Intermediate — execution has not yet started. |
| `dispatch.denied` | target | **Terminal, approval refusal.** The node owner clicked Deny on an approval request — Cedar evaluation had returned "requires owner approval" per Spec-024 §Approval Gate, the owner UI surfaced the request via `.approval_requested`, and the owner chose deny. The dual-signed deny ApprovalRecord is persisted as a durable audit artifact per Spec-024 §Pitfalls ("treating a deny as absent" is prohibited). Cedar denials that are *not* requests-for-owner-approval (class-rule denial, policy-engine error, undeclared capability) emit `.rejected` with a specific `reason` instead — those paths never produce a signed deny envelope because no approver token exists. |
| `dispatch.executed` | target | The capability handler returned a result (the handler itself completed without raising). **Intermediate** — the lifecycle is not terminal until `.completed` (success path, result ready for emission) or `.failed` (post-handler fault, e.g. result-emission error per Spec-024 §Cross-Node Failure Semantics) fires. Emitters must not conflate `.executed` with `.completed`. Handler-side exceptions that prevent the handler from returning do NOT produce `.executed`; those paths go straight to `.failed` with no intermediate. |
| `dispatch.completed` | target | **Terminal, success.** The target-side dispatch lifecycle succeeded — Cedar allowed the dispatch (with or without owner approval), the capability handler executed successfully, and the result is ready for emission. Exactly one per dispatch when the success path is followed. Result delivery to the caller is tracked separately via `.result_observed` (live-delivered after `.completed`) or via `.result_buffered` → later `.result_observed` when the caller was detached at completion time per Spec-024 §Execution And Result Emission Example Flow 3. |
| `dispatch.failed` | target | **Terminal, post-approval failure.** Execution failed after approval succeeded — capability-handler error, result-emission error, or post-approval runtime fault per Spec-024 §Cross-Node Failure Semantics. Distinct from `.rejected` (pre-approval) and `.expired` (token timeout). Payload `reason` names the specific failure. |
| `dispatch.expired` | target | **Terminal, mid-flight timeout.** `caller_token.exp` elapsed during approval wait or during in-flight execution; auto-denial fires (approval wait) or in-flight work is aborted (execution) per Spec-024 §Cross-Node Failure Semantics. |
| `dispatch.result_buffered` | target | **Post-terminal delivery annotation.** Fires *after* target `.completed` when the caller was detached at completion time. Result is held in target-local storage for delivery on caller reconnect within `caller_token.exp + 5 minutes`; on reconnect, delivery produces caller-side `.result_observed`. Past that window, the result remains in the target log only and the caller must re-observe via audit export. Not a lifecycle state — the dispatch already terminated at `.completed`; this event records the delivery mode per Spec-024 §Execution And Result Emission Example Flow 3. |
| `dispatch.approval_observed` | caller | Caller daemon has received the mirrored ApprovalRecord (allow or deny) back through the relay and recorded it locally. |
| `dispatch.result_observed` | caller | Caller daemon has received the dispatch result payload and appended it to the local log. Live-delivered after target `.completed`, or via buffered-delivery after target `.result_buffered`. |

**Precedent.** [Teleport Just-In-Time Access Requests](https://goteleport.com/docs/identity-governance/access-requests/) is the closest public precedent for per-request cross-machine runtime approval. Teleport registers `access_request.create` (T5000I), `access_request.review` (T5002I), `access_request.update` (T5001I), `access_request.delete` (T5003I), `access_request.search` (T5004I), and `access_request.expire` (T5005I) per [Teleport Audit Events Reference](https://goteleport.com/docs/reference/audit-events/) (accessed 2026-04-18). Teleport carries approval / denial as state transitions on `access_request.update` with an embedded `state` field; AI Sidekicks' taxonomy is more granular, emitting distinct `.approved`, `.denied`, `.failed`, and `.completed` events so a single dispatch's lifecycle can be reconstructed from event types alone without parsing transition payloads.

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Usage Telemetry (`usage_telemetry`)

Payload shape: `{sessionId, runId?, tokenCount?, inputTokens?, outputTokens?, costCents?, windowUsedTokens?, windowMaxTokens?}`

| Type | Description |
| --- | --- |
| `usage.token_count` | A token consumption snapshot has been recorded for a run. |
| `usage.cost_update` | A cost accumulation update has been recorded. |
| `usage.context_window_update` | The context window utilization has changed significantly. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Onboarding Lifecycle (`onboarding_lifecycle`)

Daemon-local first-run lifecycle events recording the resolution of the three-way deployment choice (free public relay / self-hosted / hosted SaaS) introduced by [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md) and implemented in [Spec-026](./026-first-run-onboarding.md). These events belong to the daemon's own session-independent event stream — a daemon emits them once per onboarding resolution (or reset), not per collaborative session.

Payloads must never contain secret material. SPKI pins live in `config.toml`; self-host admin tokens and hosted-SaaS scoped tokens live in the OS keystore per [Spec-023](./023-desktop-shell-and-renderer.md). Event payloads carry only the public subset surfaced by `OnboardingRead()` in Spec-026 §Interfaces And Contracts.

| Type | Description (When Fired) | Payload |
| --- | --- | --- |
| `onboarding.choice_made` | The daemon has persisted a resolved three-way choice after successful reachability validation, or via the deferred-validation fallback when the daemon cannot reach the chosen relay at onboarding time. | `{participantId, choiceId, relayUrl, migrated: boolean, deferredValidation: boolean, keystoreAvailable: boolean, timestamp}` |
| `onboarding.choice_reset` | The operator has cleared the stored onboarding choice via `sidekicks onboarding reset` or via daemon-operator-initiated reset, returning the daemon to the pre-choice state so the next first-invite re-triggers the three-way prompt. | `{participantId, previousChoiceId, reason: 'cli-reset' \| 'operator-reset', timestamp}` |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Runtime Node Lifecycle (`runtime_node_lifecycle`)

Durable state-change events recording the lifecycle of runtime nodes per [Spec-003: Runtime Node Attach](./003-runtime-node-attach.md) and daemon clock observability promoted from [Spec-015 §Reserved Events](./015-persistence-recovery-and-replay.md#reserved-events). These events belong to a distinct category from `run_lifecycle` because they describe **the node** (the daemon process and its attachment to a session), not the work a session is doing. A node can be `online` while every session on it is idle, and runs can execute on a node without changing node state.

Payload shape: `{sessionId?, nodeId, previousState?, newState, actor?}` (base). Per-event payload extensions called out inline.

| Type | Description | Payload Extension |
| --- | --- | --- |
| `runtime_node.registered` | A node has declared its identity to the session and been accepted into the roster per Spec-003 §Attach Protocol. | base + `{capabilities[], nodeVersion, platform}` |
| `runtime_node.online` | A node transitioned to `online` — reachable via the control plane and ready to accept work. | base |
| `runtime_node.degraded` | A node is still reachable but reports one or more degraded capabilities (provider driver unhealthy, workspace storage failing, etc.). Runs may still dispatch to this node, but operators should investigate before assigning new work. | base + `{degradedCapabilities[], detail}` |
| `runtime_node.offline` | A node has been unreachable for longer than the heartbeat grace window per Spec-003. Arbitration on round-robin channels halts per [Spec-016 §Partition And Reconnect Behavior](./016-multi-agent-channels-and-orchestration.md). | base + `{lastHeartbeatAt, reason ∈ ['heartbeat_lost','explicit_shutdown','network_partition']}` |
| `runtime_node.revoked` | A node's attachment has been explicitly revoked by session owner or admin. The node cannot rejoin without a fresh attach handshake. | base + `{revokedBy, reason?}` |
| `runtime_node.capability_declared` | A node declared a new capability (provider driver, tool, workspace backend) after initial registration. | base + `{capability, capabilityDetails}` |
| `runtime_node.capability_updated` | An existing capability's health or configuration changed — driver version bump, tool addition, etc. | base + `{capability, previousState, newState}` |
| `session.clock_unsynced` | NTP sync probe failed at daemon startup per [Spec-015 §NTP Sync Precondition](./015-persistence-recovery-and-replay.md#ntp-sync-precondition). Daemon continues to accept writes. Promoted from Spec-015 §Reserved Events with category corrected from `run_lifecycle` → `runtime_node_lifecycle` (the event describes daemon-host clock state, not a run's state). | `{nodeId, platform, probeCommand, probeStdout}` |
| `session.clock_corrected` | Runtime wall-clock correction exceeded the 500 ms material-skew threshold per [Spec-015 §Material-Skew Threshold](./015-persistence-recovery-and-replay.md#material-skew-threshold). Promoted from Spec-015 §Reserved Events with category corrected from `run_lifecycle` → `runtime_node_lifecycle`. | `{nodeId, wallClockDeltaMs, priorMonotonicNs, postMonotonicNs}` |

**Name preservation.** `session.clock_*` event names retain the `session.` prefix as shipped in Spec-015 at Session E1 commit `b495a5f` — renaming would be wire-breaking under [ADR-018 §Decision #3](../decisions/018-cross-version-compatibility.md) (MINOR bumps are additive-only; event-type rename is not additive). Only the `category` field moves.

**Precedent — node lifecycle vocabulary.** [Temporal Worker Deployment Versions](https://docs.temporal.io/production-deployment/worker-deployments/worker-deployment-versions) (accessed 2026-04-19) publishes a worker lifecycle with verbatim states `Inactive`, `Active`, `Draining`, `Drained` tracked via `WorkerDeploymentVersionStatus`, `DrainageStatus`, `BuildId`, `DeploymentName`, with a 60-second heartbeat default. [HashiCorp Nomad Event Stream](https://developer.hashicorp.com/nomad/api-docs/events) (accessed 2026-04-19) publishes a node-event topic set — verbatim topics `Node`, `NodeDrain`, `NodePool` — with event types `NodeRegistration`, `NodeDeregistration`, `NodeDrain`, `NodeEligibility`, and a per-driver health array `Drivers[{Detected, Healthy, HealthDescription, UpdateTime}]`. Our `runtime_node.*` taxonomy mirrors the Nomad `NodeRegistration`/`NodeDeregistration` + Temporal `Active`/`Draining`/`Drained` split rather than Kubernetes' monolithic condition array (`Ready`/`DiskPressure`/`MemoryPressure`/`PIDPressure`/`NetworkUnavailable` per [kubernetes.io/docs/reference/node/node-status](https://kubernetes.io/docs/reference/node/node-status/), accessed 2026-04-19), which collapses too many orthogonal failure modes into a single status object to support per-condition audit queries.

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Recovery Events (`recovery_events`)

Daemon-startup recovery lifecycle events producing the durable record of replay rebuild, binding restoration, and in-flight run disposition per [Spec-015 §Required Behavior](./015-persistence-recovery-and-replay.md#required-behavior). These events belong to their own category rather than `run_lifecycle` because a single recovery cycle may touch zero, one, or many runs across multiple sessions, and the category scope is **the daemon's recovery pass**, not any one run.

Payload shape: `{nodeId, recoveryId, phase, attemptNumber}` (base). Per-event payload extensions called out inline.

| Type | Description | Payload Extension |
| --- | --- | --- |
| `recovery.attempted` | A recovery attempt has started — daemon startup is proceeding through the Spec-015 sequence (projection rebuild → binding restoration → in-flight resumption). | base + `{recoveryTrigger ∈ ['startup','manual','supervisor'], priorFailureCount, startedAt}` |
| `recovery.succeeded` | Recovery completed successfully. Projections are rebuilt, bindings restored, and in-flight runs either resumed or deterministically transitioned to `failed` per Spec-015 §Fallback Behavior. | base + `{eventsReplayed, bindingsRestored, runsResumed, runsFailedDeterministically, durationMs, completedAt}` |
| `recovery.failed` | Recovery failed before completion. Daemon enters `blocked` read-only mode per Spec-015 §Fallback Behavior. The affected runs remain visible; new mutable work is refused. | base + `{failureKind ∈ ['projection_rebuild_failed','binding_restore_failed','persistence_unavailable','other'], detail, runsLeftInFlight[], durationMs}` |

**Precedent.** [Apache Kafka Streams `StateRestoreListener`](https://kafka.apache.org/documentation/streams/developer-guide/processor-api.html#state-restoration) (accessed 2026-04-19) publishes verbatim callbacks: `onRestoreStart(TopicPartition, storeName, startingOffset, endingOffset)`, `onBatchRestored`, `onRestoreEnd(TopicPartition, storeName, totalRestored)`, `onRestoreSuspended`. Our `recovery.attempted` / `recovery.succeeded` / `recovery.failed` split mirrors Kafka Streams' start/end/suspend semantics but narrows the surface to daemon-level restart (not per-partition), because AI Sidekicks' SQLite event log is single-writer per [Spec-015 §Writer Concurrency](./015-persistence-recovery-and-replay.md#writer-concurrency) and therefore has no per-partition recovery.

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Participant Lifecycle (`participant_lifecycle`)

Durable state-change events recording participant-level GDPR operations per [Spec-022 §Right to erasure](./022-data-retention-and-gdpr.md#data-retention-and-deletion-policy). These events belong to a distinct category from `membership_change` because they describe **the participant entity itself** (account-level existence and keyring state), not the participant's role in any one session. A single `participant.purged` event affects all sessions the participant touched; a `membership_change` event affects exactly one session.

Payload shape: `{participantId, actor, reason?}` (base). Per-event payload extensions called out inline.

| Type | Description | Payload Extension |
| --- | --- | --- |
| `participant.exported` | The participant's data has been exported via `GET /participants/{id}/export` per [Spec-022 §Data Export](./022-data-retention-and-gdpr.md#data-export). Required pre-requisite for `participant.purged` — export MUST be completed before key deletion since crypto-shred destroys the PII under encryption. | base + `{exportedAt, exportArtifactRef, encryptedEventCount}` |
| `participant.purge_requested` | A purge of participant data has been initiated. The request itself is durable so operator retries can reconcile against the initial state per Spec-022 §Fallback Behavior (*"the session must remain in `purge_requested` state and the failure must be logged for operator retry"*). | base + `{requestedAt, trigger ∈ ['self_service','admin_action','retention_policy']}` |
| `participant.purged` | **Replaces the prior `participant.deleted` name.** Crypto-shred is complete: the participant's encrypted PII in `session_events.pii_payload` is permanently unrecoverable (key row deleted from `participant_keys`), Postgres PII rows have been hard-deleted, and membership references have been anonymized per [Spec-022 §Right to erasure](./022-data-retention-and-gdpr.md#data-retention-and-deletion-policy). | base + `{purgedAt, affectedSessionIds[], piiPayloadsCleared}` |
| `participant.tokens_revoked_all` | All refresh tokens for the participant have been revoked (from [BL-070](../backlog.md)). Distinct from `participant.purged` because token revocation is reversible (re-issue on next sign-in) while crypto-shred is not. | base + `{revokedAt, tokenCount}` |
| `participant.device_reset` | A participant's WebAuthn credentials and identity-key device bindings have been revoked. Used when a device is lost or stolen; distinct from purge (participant remains; device binding is reset). | base + `{resetAt, revokedCredentialIds[], revokedDeviceIds[]}` |

**Name rationale (`purged` vs `deleted`).** The verb `purged` aligns with Spec-022's session state names (`purge_requested`, `purged`) where "delete" is ambiguous between the Postgres row DELETE and the SQLite crypto-shred. The participant's Postgres row *is* hard-deleted but PII in the event log is only cryptographically destroyed (key removed, ciphertext remains); `purged` carries the precise GDPR semantic — the data is irrecoverable but the audit stub (category + type + timestamp) persists. The prior `participant.deleted` name was registered in [Spec-022 §Right to erasure](./022-data-retention-and-gdpr.md#data-retention-and-deletion-policy) before this taxonomy pass; Spec-022 is updated in the same change set.

**Precedent.** GDPR Article 17 names the right verbatim as *"Right to erasure ('right to be forgotten')"* ([EUR-Lex GDPR consolidated 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj), Article 17(1), accessed 2026-04-19). [NIST SP 800-88 Rev. 2 — Guidelines for Media Sanitization](https://csrc.nist.gov/pubs/sp/800/88/r2/final) (final, Sept 26, 2025, accessed 2026-04-19) introduces *"Cryptographic Erasure (CE) that leverages encryption and key management"* as a distinct sanitization category alongside "Clear" and "Destroy" — our `participant.purged` is a CE-category operation, hence preferred over `deleted`. [EDPB CEF Report on the right of erasure (Feb 18, 2026)](https://www.edpb.europa.eu/our-work-tools/our-documents/report/cef-report-right-erasure-article-17-gdpr_en) (accessed 2026-04-19) flags anonymisation-as-substitute as a common misapplication; CE with `pii_ciphertext_digest` preserved in the signed canonical bytes avoids that pattern because the ciphertext itself is destroyed rather than hashed-then-nulled.

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Audit Integrity (`audit_integrity`)

Integrity-verification events recording the outcomes of hash-chain, Ed25519 signature, and Merkle-anchor checks per [§Integrity Protocol](#integrity-protocol) above. These events belong to a distinct category from `session_lifecycle` because they describe **the audit log's tamper-evidence state**, not a session's operational state — a single verification pass may cover events from many sessions, and a failure does not end a session but does halt replay.

**Invariant: audit-integrity events are never compacted, never shredded.** Compacting or shredding these events would defeat the integrity protocol — a verifier could not distinguish between "no failure occurred" and "the failure record was compacted." They are explicitly excluded from [§Event Compaction Policy](#event-compaction-policy) triggers and from the crypto-shred fan-out in [Spec-022 §Shred Fan-Out](./022-data-retention-and-gdpr.md#shred-fan-out).

Payload shape: `{sessionId, anchorId?, verifierNodeId}` (base). Per-event payload extensions called out inline.

| Type | Description | Payload Extension |
| --- | --- | --- |
| `audit_integrity_verified` | A read-side verifier has completed hash, signature, and anchor checks successfully over a range. Promoted from §Integrity Events with category corrected from `session_lifecycle` → `audit_integrity`. | base + `{treeSize, rootHash, fromSeq, toSeq, verifiedAt, signatureAlgorithm}` |
| `audit_integrity_failed` | A read-side verifier detected a chain break, signature failure, or anchor mismatch. Halts replay at the affected row and must be surfaced to operators. Promoted from §Integrity Events with category corrected from `session_lifecycle` → `audit_integrity`. | base + `{treeSize, expectedRootHash, observedRootHash, failureMode ∈ ['hash_mismatch','signature_mismatch','anchor_mismatch','inclusion_proof_failed','consistency_proof_failed','log_file_missing','log_file_moved'], failurePath ∈ ['inclusion','consistency','signature'], offendingSeq?, detail}` |
| `key_reuse_detected` | An observer/monitor detected an event signed by a `NodeId` whose Ed25519 public key collides with a prior rotated-out key — the rotation invariant `refuse_on_rotation` has been violated. Security-grade signal: an attacker may be replaying a compromised key, or a legitimate key-rotation bug has reused a retired public key. | `{offendingKeyFingerprint, observedPeerIds[], firstSeenAt, rotationInvariantViolated: 'refuse_on_rotation', detectorNodeId}` |

**Precedent — envelope and failure vocabulary.** [RFC 9162 — Certificate Transparency v2.0 (December 2021)](https://datatracker.ietf.org/doc/html/rfc9162) (accessed 2026-04-19) *"obsoletes RFC 6962"* and publishes the canonical envelope: `SignedTreeHeadDataV2 { LogID log_id; TreeHeadDataV2 tree_head; opaque signature<1..2^16-1>; }` (§4.10 verbatim); `TreeHeadDataV2 { uint64 timestamp; uint64 tree_size; NodeHash root_hash; Extension sth_extensions<0..2^16-1>; }` (§4.9 verbatim); `InclusionProofDataV2 { LogID log_id; uint64 tree_size; uint64 leaf_index; NodeHash inclusion_path<...>; }` (§4.11 verbatim); `ConsistencyProofDataV2 { LogID log_id; uint64 tree_size_1; uint64 tree_size_2; NodeHash consistency_path<...>; }` (§4.12 verbatim). Failure vocabulary from RFC 9162 §§2.1.3.2 and 2.1.4.2 (verbatim): *"If `leaf_index` is greater than or equal to `tree_size`, then fail the proof verification"*; *"If `sn` is 0, then stop the iteration and fail the proof verification"*; *"If `consistency_path` is an empty array, stop and fail the proof verification"*. Our `failureMode` enum ports this vocabulary and extends it with log-file-level failures (missing, moved) observed in production systems.

**Precedent — production chain + message surface.** [AWS CloudTrail Log File Integrity Validation — Digest File Structure](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-digest-file-structure.html) and [AWS CloudTrail `validate-logs` CLI](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-cli.html) (both accessed 2026-04-19) publish 15 verbatim digest-file JSON fields including `previousDigestHashValue`, `previousDigestHashAlgorithm`, `previousDigestSignature`, `digestSignatureAlgorithm`, `digestPublicKeyFingerprint`, and per-log-file `hashValue` / `hashAlgorithm`. CloudTrail's `validate-logs` CLI emits verbatim message strings including `"valid"`, `"INVALID: has been moved from its original location"`, `"INVALID: invalid format"`, `"INVALID: not found"`, `"INVALID: public key not found for fingerprint <fingerprint>"`, `"INVALID: signature verification failed"`, `"INVALID: hash value doesn't match"` — these map to our `failureMode` enum's `log_file_*` and hash/signature variants.

**Precedent — observer/monitor pattern (`key_reuse_detected`).** [Sigstore Security Model](https://docs.sigstore.dev/about/security/) (accessed 2026-04-19) states verbatim: *"users can detect any mis-issued certificates, either due to the CA acting maliciously or a compromised OIDC identity provider"*; *"Fulcio itself does not monitor the certificate transparency log; users are responsible for monitoring the log for unauthorized certificates issued to their identities"*; *"these certificates are useless unless they are published to the certificate transparency log, so such compromise can be detected."* Our `key_reuse_detected` event is the local-daemon observer-pattern equivalent: a monitor process watching the canonical event log for Ed25519 public-key collisions that violate the rotation invariant.

**Negative precedent.** [Google Cloud Audit Logs Overview](https://docs.cloud.google.com/logging/docs/audit) (Last updated 2026-04-17 UTC, accessed 2026-04-19) states verbatim: *"Log entries written by Cloud Audit Logs are immutable."* — and publishes no hash-chain, signed-log, or cryptographic integrity verification mechanism. Our `audit_integrity_*` events intentionally exceed GCP Audit Logs' model; the RFC 9162 + CloudTrail composition is the operationally-mature precedent.

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Event Maintenance (`event_maintenance`)

Daemon-level events recording operations on the event stream itself — schema migrations, compaction passes, and crypto-shred fan-out. These events belong to a distinct category from any session-scoped category because they describe **the event log as infrastructure**, not the session content it carries. One `event.compacted` event may compact thousands of prior events across multiple sessions; one `event.shredded` event spans every session a purged participant touched.

**Invariant: event-maintenance events are never compacted, never shredded.** Compacting a `schema.migrated` event would destroy the audit trail for a non-reversible schema change; shredding an `event.shredded` event would be self-referential and break the audit stub record of the shred. Like `audit_integrity` events, they are excluded from [§Event Compaction Policy](#event-compaction-policy) and from [Spec-022 §Shred Fan-Out](./022-data-retention-and-gdpr.md#shred-fan-out).

Payload shape: `{nodeId, operationId, occurredAt}` (base). Per-event payload extensions called out inline.

| Type | Description | Payload Extension |
| --- | --- | --- |
| `schema.migrated` | A schema migration has completed. Fires once per migration batch (equivalent to Flyway's `AFTER_MIGRATE_OPERATION_FINISH`), not once per SQL statement. | base + `{fromVersion, toVersion, migrationId, description, checksum, appliedBy, executionMs, success}` |
| `event.compacted` | A compaction pass has replaced full event payloads in a range with audit stubs per [§Event Compaction Policy](#event-compaction-policy). | base + `{sessionId?, fromSeq, toSeq, eventsBefore, eventsAfter, bytesReclaimed, tombstoneCount, compactionReason ∈ ['age_threshold','count_threshold','storage_threshold']}` |
| `event.shredded` | A crypto-shred operation has cleared `pii_payload` ciphertext across the affected sessions per [Spec-022 §Crypto-shredding](./022-data-retention-and-gdpr.md#crypto-shredding-sqlite-event-log). The `payload` column and `pii_ciphertext_digest` field remain; only the encrypted ciphertext bytes are zeroed. Signed canonical bytes of prior events are unaffected because `pii_ciphertext_digest` (over the ciphertext) is part of the canonical form per [§Canonical Serialization Rules](#canonical-serialization-rules) — see [Spec-022 §Signature Safety Under Shred](./022-data-retention-and-gdpr.md#signature-safety-under-shred) for the full argument. | base + `{participantId, affectedSessionIds[], piiPayloadsCleared, shredReason ∈ ['gdpr_article_17','retention_policy','admin_action']}` |

**Precedent — `schema.migrated`.** [Flyway `flyway_schema_history` table](https://documentation.red-gate.com/flyway/flyway-concepts/flyway-schema-history-table) publishes the verbatim column list `installed_rank`, `version`, `description`, `type`, `script`, `checksum`, `installed_by`, `installed_on`, `execution_time`, `success`; Flyway's `Event` callback enum (captured verbatim from [`flyway-core/src/main/java/org/flywaydb/core/api/callback/Event.java`](https://github.com/flyway/flyway/blob/main/flyway-core/src/main/java/org/flywaydb/core/api/callback/Event.java), fetched 2026-04-19) distinguishes per-migration (`AFTER_EACH_MIGRATE`) from batch-complete (`AFTER_MIGRATE_OPERATION_FINISH`). Our `schema.migrated` fires at the batch-complete boundary to match the *operation* granularity — one event per `sidekicks db migrate` invocation, not one per migration file. [Liquibase `DATABASECHANGELOG`](https://docs.liquibase.com/concepts/tracking-tables/databasechangelog-table.html) (docs version "Secure 5.1"; WebFetch 403'd on 2026-04-19, columns below confirmed via WebSearch result summary citing that URL) adds `DEPLOYMENT_ID` to group changesets from one run — our `operationId` serves the same purpose. [golang-migrate `schema_migrations`](https://github.com/golang-migrate/migrate/blob/master/database/postgres/postgres.go) (accessed 2026-04-19) carries only `(version bigint not null primary key, dirty boolean not null)` with no event emission — a deliberate counter-example showing why our field set is strictly richer.

**Precedent — `event.compacted`.** Apache Kafka's log-compaction semantics publish `tombstone` + segment-recopy vocabulary; range endpoints `fromSeq` / `toSeq` mirror RFC 9162's `tree_size_1` / `tree_size_2` from `ConsistencyProofDataV2`. No single upstream event literally named `event.compacted` — the field set is composed from Kafka's compaction terminology and our §Event Compaction Policy triggers.

**Precedent — `event.shredded`.** No primary-source event-shape precedent found for an audit event describing the shred operation itself. GDPR Article 17 prescribes the right, not an event field set. [EventStoreDB crypto-shred pattern](https://www.eventstore.com/blog/eventstoredb-crypto-shred-feature), [Conduktor Kafka-field-level-encryption shred guidance](https://docs.conduktor.io/platform/guides/complete-gdpr-compliance/), and [Axon Server data protection](https://docs.axoniq.io/axon-server-reference/v2025.1/) (all accessed 2026-04-19) describe the crypto-shred pattern but none publishes an event envelope for the operation. The field set above is composed from [Spec-022 §Crypto-shredding](./022-data-retention-and-gdpr.md#crypto-shredding-sqlite-event-log) and the crypto-shred-preservation discipline in [EDPB Guidelines 02/2025 on processing of personal data through blockchain technologies](https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2025/guidelines-022025-processing-personal-data_en) (accessed 2026-04-19), which blesses `ciphertext_digest` + off-chain-shred as an Article 17-compliant pattern.

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Policy Events (`policy_events`)

Durable state-change events recording the daemon's loading and validation of signed Cedar policy bundles per [ADR-012](../decisions/012-cedar-approval-policy-engine.md) (Cedar approval policy engine). These events belong to a distinct category from `approval_flow` because they describe **the policy infrastructure** (bundle lifecycle, validator outcomes) rather than individual approval decisions — a single bundle load may affect millions of subsequent approval decisions.

Payload shape: `{nodeId, bundleId, bundleVersion}` (base). Per-event payload extensions called out inline.

| Type | Description | Payload Extension |
| --- | --- | --- |
| `policy_bundle.loaded` | A signed Cedar policy bundle passed signature verification, hash validation, and Cedar validation, and is now the daemon's active policy source. | base + `{bundleHash, signerId, signatureAlgorithm, policyCount, schemaHash, loadedAt}` |
| `policy_bundle.rejected` | A bundle load attempt failed verification. The prior active bundle remains in force; the new bundle is not adopted. | base + `{bundleHash?, rejectionReason ∈ ['signature_invalid','hash_mismatch','version_downgrade','cedar_validation_failed'], cedarValidationErrors[]?}` |

**Precedent — envelope.** [AWS Verified Permissions CloudTrail Events](https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/monitoring-cloudtrail.html) (accessed 2026-04-19) publishes a verbatim event inventory: `CreatePolicyStore`, `ListPolicyStores`, `DeletePolicyStore`, `PutSchema`, `GetSchema`, `CreatePolicyTemplate`, `DeletePolicyTemplate`, `CreatePolicy`, `GetPolicy`, `CreateIdentitySource`, `GetIdentitySource`, `ListIdentitySources`, `DeleteIdentitySource`, `IsAuthorized`, `BatchIsAuthorized`. No VP event is literally named `policy_bundle.loaded` — VP tracks individual policies, not bundles; our bundle-scoped event is composed from VP's envelope shape plus our ADR-012 signed-bundle semantics.

**Precedent — `cedarValidationErrors[]` enum.** [Cedar Policy Validation](https://docs.cedarpolicy.com/policies/validation.html) (accessed 2026-04-19) publishes a verbatim enumeration of validator errors and warnings. Errors (8): *"Unrecognized entity types"*, *"Unrecognized actions"*, *"Action applied to unsupported principal or resource"*, *"Improper use of `in` or `==`"*, *"Unrecognized attributes"*, *"Unsafe access to optional attributes"*, *"Type mismatch in operators"*, *"Invalid entity literals of enumerated entity types"*. Warnings (4): *"Cases that always evaluate to false, and thus never apply"*, *"Mixed script strings and identifiers"*, *"Bidirectional text control characters in strings and identifiers"*, *"Unexpected characters in entity identifiers"*. Our `cedarValidationErrors[]` payload field carries these strings verbatim so bundle-rejection reasons are wire-stable across Cedar version upgrades.

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Event Type Summary

Total enumerated event types: **120**

| Category | Count | Types |
| --- | --- | --- |
| `session_lifecycle` (session) | 7 | `session.created` through `session.purged` |
| `membership_change` (invite/membership) | 8 | `invite.created` through `membership.reactivated` |
| `membership_change` (presence) | 4 | `presence.online` through `presence.offline` |
| `session_lifecycle` (channel/agent) | 6 | `channel.created` through `agent.config_updated` |
| `channel_arbitration` | 2 | `arbitration.paused`, `arbitration.resumed` |
| `run_lifecycle` | 9 | `run.queued` through `run.failed` |
| `interactive_request` (queue) | 5 | `queue_item.created` through `queue_item.expired` |
| `interactive_request` (intervention) | 6 | `intervention.requested` through `intervention.expired` |
| `approval_flow` | 6 | `approval.requested` through `approval.rule_revoked` |
| `session_lifecycle` (repo/workspace/worktree) | 11 | `repo.attached` through `worktree.retired` |
| `artifact_publication` | 6 | `artifact.published` through `pr.submitted` |
| `assistant_output` | 2 | `assistant.message`, `assistant.thinking_update` |
| `tool_activity` | 5 | `tool.invoked` through `tool.skipped_during_recovery` |
| `cross_node_dispatch` | 13 | `dispatch.sent`, `dispatch.received`, `dispatch.rejected`, `dispatch.approval_requested`, `dispatch.approved`, `dispatch.denied`, `dispatch.executed`, `dispatch.completed`, `dispatch.failed`, `dispatch.expired`, `dispatch.result_buffered`, `dispatch.approval_observed`, `dispatch.result_observed` |
| `usage_telemetry` | 3 | `usage.token_count` through `usage.context_window_update` |
| `onboarding_lifecycle` | 2 | `onboarding.choice_made`, `onboarding.choice_reset` |
| `runtime_node_lifecycle` | 9 | `runtime_node.registered` through `session.clock_corrected` |
| `recovery_events` | 3 | `recovery.attempted`, `recovery.succeeded`, `recovery.failed` |
| `participant_lifecycle` | 5 | `participant.exported` through `participant.device_reset` |
| `audit_integrity` | 3 | `audit_integrity_verified`, `audit_integrity_failed`, `key_reuse_detected` |
| `event_maintenance` | 3 | `schema.migrated`, `event.compacted`, `event.shredded` |
| `policy_events` | 2 | `policy_bundle.loaded`, `policy_bundle.rejected` |
| **Total** | **120** | Exceeds Forge's 69-type baseline by 74% |

## Integrity Protocol

Canonical events are append-only AND tamper-evident. Every `session_events` row is chained to its predecessor via a BLAKE3 hash and signed by the emitting daemon with Ed25519 over the **same** canonical byte string. On a bounded cadence, a Merkle root over contiguous ranges is anchored to the control plane's `event_log_anchors` table as metadata only — the control plane does not store event payloads, consistent with [ADR-017 Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md). Full protocol, including schema additions and verification order, is specified in [Security Architecture § Audit Log Integrity](../architecture/security-architecture.md#audit-log-integrity).

### Canonical Serialization Rules

Both the `row_hash` input and the Ed25519-signed bytes are computed over the **same** canonical form. Two honest implementations that diverge here produce incompatible hashes and signatures for identical events, so the rules below are mandatory.

- Canonicalization standard: [RFC 8785 — JSON Canonicalization Scheme (JCS)](https://datatracker.ietf.org/doc/html/rfc8785). Re-used identically from [Spec-024 Cross-Node Dispatch And Approval](024-cross-node-dispatch-and-approval.md) so the daemon runs one canonicalization rule across integrity and dispatch.
- Hash function: [BLAKE3](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf). Same digest used for Spec-024's `request_body_hash`.
- Signature scheme: [RFC 8032 §5.1 — Ed25519](https://datatracker.ietf.org/doc/html/rfc8032#section-5.1).
- Fields included, in this order: `id`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, `payload`, `correlationId`, `causationId`, `version`.
- Fields with value `null` MUST be included (so "present-but-null" and "absent" are distinguishable after serialization).
- `occurredAt` MUST be RFC 3339 UTC with millisecond precision (`YYYY-MM-DDTHH:MM:SS.sssZ`) so ordering is byte-stable.
- `pii_payload` is NOT included in the canonical form. Events whose `pii_payload` column is non-NULL MUST embed a `pii_ciphertext_digest` field in `payload` — BLAKE3 over the ciphertext bytes of `pii_payload` — so a [Spec-022](022-data-retention-and-gdpr.md) crypto-shred of `pii_payload` does not break the hash chain. The digest sits inside the canonical bytes and is never shredded; shredding clears only the ciphertext column.

Verification is the inverse: recompute `canonical_bytes(row)`, recompute `BLAKE3(prev_hash || canonical_bytes(row))`, compare to the stored `row_hash`, and verify `daemon_signature` against the canonical bytes using the `NodeId`-resolved public key from the session participant roster (see Security Architecture § Audit Log Integrity for roster lookup semantics).

### Anchoring Cadence

Anchors fire on the earlier of `ANCHOR_INTERVAL_EVENTS = 1000` events or `ANCHOR_INTERVAL_SECONDS = 300` seconds since the previous anchor. The anchor payload is `(session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at)` — metadata only — uploaded to the control plane's `event_log_anchors` table.

### Integrity Events

The `audit_integrity_verified` and `audit_integrity_failed` event types are fully enumerated under [§Audit Integrity](#audit-integrity-audit_integrity) below with category `audit_integrity`. `audit_integrity_failed` halts replay at the affected row and must be surfaced to operators. The prior interim registration under category `session_lifecycle` is superseded — integrity events describe the audit log's tamper-evidence state, not a session's operational state.

## Event Compaction Policy

Compaction reduces storage and event volume by replacing full event payloads with lightweight audit stubs. Any one of the following triggers initiates compaction:

| Trigger | Threshold | Description |
| --- | --- | --- |
| Event count | 50,000 events per session | Oldest events beyond this are compaction candidates |
| Event age | 90 days | Events older than 90 days are compaction candidates |
| Storage threshold | 500 MB per session SQLite | When session DB exceeds this, compact oldest events first |

Compaction runs as a background daemon task during idle periods. It never runs during active runs.

### Retention Windows

| Retention Class | Retained | Compacted |
| --- | --- | --- |
| Audit stubs | Indefinitely | Never — audit stubs are the compacted form |
| Full event payloads | 90 days or 50K events (whichever is more generous) | Replaced by audit stubs |
| PII payloads | Per GDPR policy (Spec-022) | Crypto-shredded independently of compaction |
| Reasoning content | 7 days (detailed) / indefinitely (summary) | Detailed reasoning compacted; durable summary retained |

### Compacted Event Format

An audit stub retains:

```
{
  id: string,           // original event ID preserved
  sessionId: SessionId,
  sequence: number,     // original sequence preserved
  occurredAt: string,   // original timestamp preserved
  category: EventCategory,
  type: string,         // original type preserved
  actor: string | null,
  compactedAt: string,  // when compaction occurred
  retentionClass: 'audit_stub',
  summary: string       // human-readable one-line summary
}
```

The full `payload`, `pii_payload`, `correlationId`, and `causationId` are removed. The `summary` field is generated at compaction time from the original payload.

### Replay Interaction with Compacted Regions

- Replay from compacted regions returns audit stubs, not full events.
- The replay cursor tracks whether a session has compacted regions.
- Projection rebuild from compacted regions uses the audit stub summary — this produces a degraded but functional timeline.
- If a projection requires full event data (e.g., to rebuild approval state), and that data has been compacted, the projection enters `degraded` state and surfaces a warning.
- Clients can detect compacted regions via the `retentionClass: 'audit_stub'` field and render them as summarized timeline segments.
- See [Spec-015](015-persistence-recovery-and-replay.md) for full replay and recovery semantics.

## State And Data Implications

- Canonical events are the source of truth for replay and audit.
- Read projections may be rebuilt from canonical events.
- Command receipts or equivalent idempotency markers are required for safe replay of side-effecting command paths.

## Example Flows

- `Example: A run starts, emits tool activity, requests approval, publishes a diff artifact, and completes. Each change becomes a canonical session event with causation and actor metadata.`
- `Example: A participant reconnects after missing events and requests replay after the last acknowledged session sequence.`

## Implementation Notes

- Keep the event taxonomy stable and additive; avoid repurposing old types with new semantics.
- Treat provider-native diagnostic events as separate from canonical business events unless they are normalized.
- Replay must be safe for both operators and user-facing timeline projections.

## Pitfalls To Avoid

- Using final assistant text as the only historical source
- Mutating or deleting canonical events in normal operation
- Leaving approval or intervention decisions out of the audit log

## Acceptance Criteria

- [ ] Every run lifecycle transition results in one or more canonical session events.
- [ ] A client can recover missed state by replaying events after its last known cursor.
- [ ] Approval, membership, and artifact changes are visible in audit history even after payload compaction.

## ADR Triggers

- If the system stops using append-only canonical events as the replay source, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: session sequence numbers are assigned by the authoritative session-visible append path at write time. Projection merge must preserve those numbers and must not invent them later.

## References

- [Run State Machine](../domain/run-state-machine.md)
- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)
