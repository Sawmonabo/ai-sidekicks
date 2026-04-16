# Backlog Archive

Completed backlog items from the implementation readiness phase. Retained for traceability — BL-XXX IDs are referenced by the reference library and implementation plans.

## Completed: 2026-04-15

| BL | Title | Deliverable | Phase |
|-----|-------|-------------|-------|
| BL-001 | Accept all 8 ADRs | ADR-001 through ADR-008 accepted | Pre-phase |
| BL-002 | Choose IPC wire format | ADR-009 (JSON-RPC 2.0) | Pre-phase |
| BL-007 | Add intervention driver operations | ADR-011, Spec-005 (`applyIntervention`) | Pre-phase |
| BL-013 | Resolve sequence-assignment contradiction | Spec-006 (single-authority model) | Pre-phase |
| BL-014a | Decide workflow V1 scope | Spec-017 (single-agent + automated phases, all 4 gates) | Pre-phase |
| BL-006 | Cross-plan dependency graph | `docs/architecture/cross-plan-dependencies.md` | Phase 1 |
| BL-003 | Database schemas | `docs/architecture/schemas/local-sqlite-schema.md`, `shared-postgres-schema.md` | Phase 1 |
| BL-004 | API payload contracts | `docs/architecture/contracts/api-payload-contracts.md` | Phase 1 |
| BL-005 | Auth implementation spec | `docs/architecture/security-architecture.md` (5 sections added) | Phase 1 |
| BL-008 | Run state machine transition table | `docs/domain/run-state-machine.md` (30-row table, child-run cascade) | Phase 2 |
| BL-009 | Intervention model reconciliation | `docs/domain/queue-and-intervention-model.md` (transition table, field consistency) | Phase 2 |
| BL-010 | Invite delivery mechanism | `docs/specs/002-invite-membership-and-presence.md` (shareable link, token security, rate limits) | Phase 2 |
| BL-012 | Enumerate event types | `docs/specs/006-session-event-taxonomy-and-audit-log.md` (76 types) | Phase 3 |
| BL-026 | Error contracts | `docs/architecture/contracts/error-contracts.md` + 22 spec updates | Phase 3 |
| BL-022 | Runtime binding glossary | `docs/domain/glossary.md` (RuntimeBinding entry) | Phase 3 |
| BL-024 | Steer injection mechanics | `docs/specs/004-queue-steer-pause-resume.md` (driver-level steer) | Phase 3 |
| BL-025 | Presence heartbeat + channel discovery | `docs/specs/002-invite-membership-and-presence.md` (heartbeat transport, ChannelList) | Phase 3 |
| BL-015 | Per-driver capability matrix | `docs/specs/005-provider-driver-contract-and-capabilities.md` (Codex/Claude matrix) | Phase 3 |
| BL-016 | Owner elevation + membership conflicts | `docs/domain/participant-and-membership-model.md`, Spec-002 | Phase 3 |
| BL-017 | Session/channel/participant limits | `docs/specs/001-shared-session-core.md` (6 resource limits) | Phase 3 |
| BL-018 | Handoff timeline entry type | `docs/specs/013-live-timeline-visibility-and-reasoning-surfaces.md` | Phase 3 |
| BL-019 | Workspace-to-worktree transitions | `docs/specs/009-repo-attachment-and-workspace-binding.md` | Phase 3 |
| BL-020 | DiffArtifact vs general artifact | `docs/specs/011-gitflow-pr-and-diff-attribution.md` (subtype, CAS storage) | Phase 3 |
| BL-021 | Approval category enum | `docs/specs/012-approvals-permissions-and-trust-boundaries.md` (8 categories verified) | Phase 3 |
| BL-023 | Relay protocol | `docs/specs/008-control-plane-relay-and-session-join.md` (MLS, connection lifecycle) | Phase 3 |
| BL-011 | Channel turn/budget/stop policies | `docs/specs/016-multi-agent-channels-and-orchestration.md` | Phase 3 |
| BL-014b | Expand workflow spec | `docs/specs/017-workflow-authoring-and-execution.md` (phase/gate taxonomy) | Phase 3 |
| BL-037 | Git hosting adapter | `docs/specs/011-gitflow-pr-and-diff-attribution.md` (gh CLI, GitHostingAdapter) | Phase 3 |
| BL-027 | V1 feature scope | `docs/architecture/v1-feature-scope.md` (14 V1, 6 V2) | Phase 4 |
| BL-028 | Workflow domain models | `docs/domain/workflow-model.md`, `workflow-phase-model.md` | Phase 4 |
| BL-029 | Control-plane transport | `docs/specs/008-control-plane-relay-and-session-join.md` (tRPC + WebSocket) | Phase 4 |
| BL-030 | Deployment scaling + HA | `docs/architecture/deployment-topology.md` (6 sections) | Phase 4 |
| BL-031 | Operations runbook commands | 8 runbook files (CLI, SLOs, on-call routing) | Phase 4 |
| BL-032 | Event compaction policy | `docs/specs/006-session-event-taxonomy-and-audit-log.md` (triggers, retention, audit stubs) | Phase 4 |
| BL-033 | Rate limit values | `docs/specs/021-rate-limiting-policy.md` (10 endpoints, 3 tiers) | Phase 4 |
| BL-034 | Context window + usage meters | `docs/specs/013-live-timeline-visibility-and-reasoning-surfaces.md` | Phase 4 |
| BL-035 | Notification delivery | `docs/specs/019-notifications-and-attention-model.md` (desktop SSE, cross-device) | Phase 4 |
| BL-036 | GDPR schema | `docs/specs/022-data-retention-and-gdpr.md` (PII map, crypto-shredding) | Phase 4 |

## Crosscheck Summary

| Review | Checks | Fixes |
|--------|--------|-------|
| Phase 1 | 92 | 15 (table names in dep graph) |
| Phase 2 | 24 | 1 (invite lifecycle states) |
| Phase 3 | 29 | 0 |
| Phase 4 | 25 | 2 (Spec-015 xref, rate limits) |
| Full-corpus | 85 | 0 |
| **Total** | **259** | **18** |
