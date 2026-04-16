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

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Usage Telemetry (`usage_telemetry`)

Payload shape: `{sessionId, runId?, tokenCount?, inputTokens?, outputTokens?, costCents?, windowUsedTokens?, windowMaxTokens?}`

| Type | Description |
| --- | --- |
| `usage.token_count` | A token consumption snapshot has been recorded for a run. |
| `usage.cost_update` | A cost accumulation update has been recorded. |
| `usage.context_window_update` | The context window utilization has changed significantly. |

> See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed payload definitions.

### Event Type Summary

Total enumerated event types: **76**

| Category | Count | Types |
| --- | --- | --- |
| `session_lifecycle` (session) | 7 | `session.created` through `session.purged` |
| `membership_change` (invite/membership) | 8 | `invite.created` through `membership.reactivated` |
| `membership_change` (presence) | 4 | `presence.online` through `presence.offline` |
| `session_lifecycle` (channel/agent) | 6 | `channel.created` through `agent.config_updated` |
| `run_lifecycle` | 9 | `run.queued` through `run.failed` |
| `interactive_request` (queue) | 5 | `queue_item.created` through `queue_item.expired` |
| `interactive_request` (intervention) | 6 | `intervention.requested` through `intervention.expired` |
| `approval_flow` | 6 | `approval.requested` through `approval.rule_revoked` |
| `session_lifecycle` (repo/workspace/worktree) | 11 | `repo.attached` through `worktree.retired` |
| `artifact_publication` | 6 | `artifact.published` through `pr.submitted` |
| `assistant_output` | 2 | `assistant.message`, `assistant.thinking_update` |
| `tool_activity` | 3 | `tool.invoked` through `tool.error` |
| `usage_telemetry` | 3 | `usage.token_count` through `usage.context_window_update` |
| **Total** | **76** | Exceeds Forge's 69-type baseline |

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
