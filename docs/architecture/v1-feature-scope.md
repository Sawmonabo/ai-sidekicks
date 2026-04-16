# V1 Feature Scope

## Purpose

This document records the V1/V2/out-of-scope triage for all 20 discrete features identified in the product vision and reference-app survey. It satisfies backlog item BL-027.

## Feature Triage

### V1 Features (Core Experience, Must Ship)

| # | Feature | Scope | Rationale | Governing Spec(s) |
|---|---------|-------|-----------|-------------------|
| 1 | Session creation and join | V1 | Foundational primitive; everything else depends on sessions existing. | [Spec-001](../specs/001-shared-session-core.md) |
| 2 | Mid-session invites via shareable link | V1 | Highest-value differentiator per vision; defines the product category. | [Spec-002](../specs/002-invite-membership-and-presence.md) |
| 3 | Membership roles and permissions | V1 | Required for any multi-participant session to be safe and usable. | [Spec-002](../specs/002-invite-membership-and-presence.md), [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| 4 | Runtime node attach/detach | V1 | Core mechanism for participants to contribute local compute to a session. | [Spec-003](../specs/003-runtime-node-attach.md) |
| 5 | Single-agent runs (Codex, Claude) | V1 | Minimum viable agent execution; validates the provider driver contract. | [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) |
| 6 | Queue, steer, pause, resume, interrupt | V1 | Real runtime control is a non-negotiable for agent supervision. | [Spec-004](../specs/004-queue-steer-pause-resume.md) |
| 7 | Approval gates (8 categories) | V1 | Safety boundary for agent actions; blocks unsupervised tool execution. | [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| 8 | Repo attach and workspace binding | V1 | Required for any code-editing agent workflow to function. | [Spec-009](../specs/009-repo-attachment-and-workspace-binding.md) |
| 9 | Worktree-based execution | V1 | Default execution mode per vision; prevents direct mutation of main checkout. | [Spec-010](../specs/010-worktree-lifecycle-and-execution-modes.md) |
| 10 | Session timeline with replay | V1 | Primary visibility surface; makes agent activity legible and auditable. | [Spec-013](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md), [Spec-015](../specs/015-persistence-recovery-and-replay.md) |
| 11 | Local daemon with CLI | V1 | CLI is the first client delivery track; proves the SDK and IPC contract. | [Spec-007](../specs/007-local-ipc-and-daemon-control.md) |
| 12 | Presence (online/idle/offline) | V1 | Required for collaboration to feel live; enables awareness of other participants. | [Spec-002](../specs/002-invite-membership-and-presence.md) |
| 13 | Event audit log | V1 | Event sourcing is the persistence backbone; audit log is a direct projection. | [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) |
| 14 | Artifact publication (local) | V1 | Agents must produce durable outputs (diffs, files, attachments) beyond chat. | [Spec-014](../specs/014-artifacts-files-and-attachments.md) |

### V2 Features (Designed but Deferred)

| # | Feature | Scope | Rationale | Governing Spec(s) |
|---|---------|-------|-----------|-------------------|
| 15 | Multi-agent channels and orchestration | V2 | Spec-016 written; implementation deferred because single-agent runs cover the V1 use case and multi-agent coordination adds substantial complexity. | [Spec-016](../specs/016-multi-agent-channels-and-orchestration.md) |
| 16 | Workflow authoring and execution | V2 | Spec-017 written; implementation deferred because V1 queue and approval gates cover structured execution without the full workflow engine. | [Spec-017](../specs/017-workflow-authoring-and-execution.md) |
| 17 | Shared artifacts (cross-node) | V2 | Local artifact publication ships in V1; cross-node sharing requires relay infrastructure that adds scope. | [Spec-014](../specs/014-artifacts-files-and-attachments.md) (local portion is V1) |
| 18 | Email invite delivery | V2 | V1 uses shareable link with token; email delivery adds an external service dependency with no V1 payoff. | [Spec-002](../specs/002-invite-membership-and-presence.md) |
| 19 | MLS relay E2EE | V2 | V1 ships X25519 + XChaCha20-Poly1305 fallback encryption; full MLS (RFC 9420) deferred until ts-mls matures. | [Spec-008](../specs/008-control-plane-relay-and-session-join.md) |
| 20 | Desktop GUI | V2 | CLI-first in V1 per vision build order; desktop Electron app ships as the second client after CLI proves the contract. | No dedicated spec (vision build order steps 3 and 6) |

### Supporting V1 Specs (Cross-Cutting)

The following specs provide cross-cutting infrastructure required by multiple V1 features but do not correspond to a single discrete feature above:

| Spec | Coverage |
|------|----------|
| [Spec-008](../specs/008-control-plane-relay-and-session-join.md) | Control plane relay and session join (V1 with X25519 fallback) |
| [Spec-011](../specs/011-gitflow-pr-and-diff-attribution.md) | Gitflow, PR preparation, and diff attribution |
| [Spec-018](../specs/018-identity-and-participant-state.md) | Identity and participant state |
| [Spec-019](../specs/019-notifications-and-attention-model.md) | Notifications and attention model |
| [Spec-020](../specs/020-observability-and-failure-recovery.md) | Observability and failure recovery |
| [Spec-021](../specs/021-rate-limiting-policy.md) | Rate limiting policy |
| [Spec-022](../specs/022-data-retention-and-gdpr.md) | Data retention and GDPR compliance |

---

## Spec Coverage Assessment (Task 27.2)

All 14 V1 features are covered by existing specs (Specs 001-015 and supporting specs 018-022). Both V2 features that have specs (Spec-016, Spec-017) are written and available for future implementation. No new specs are needed for V1.

## Backlog Coverage Assessment (Task 27.3)

All V1 features have corresponding implementation plans (Plans 001-015, 018-020). The existing backlog items (BL-003 through BL-037) cover all remaining design gaps and pre-implementation work. No new backlog items are needed to support the V1 feature set.

---

## References

- [Vision](../vision.md) — Signature features and build order
- [Backlog](../backlog.md) — BL-027 (this decision)
- Plans 001-020 — Implementation plans for all features
- Specs 001-022 — Feature specifications
