# Plan-019: Notifications And Attention Model

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `019` |
| **Slug** | `notifications-and-attention-model` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-019: Notifications And Attention Model](../specs/019-notifications-and-attention-model.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) |

## Goal

Implement derived attention projections and desktop notification delivery that keep actionable session state visible even when the user is not watching the timeline.

## Scope

This plan covers attention projections, notification preferences, OS-notification delivery hooks, and degraded paths when notifications are unavailable.

## Non-Goals

- Mobile push delivery
- Marketing or email campaigns
- Full operator paging systems

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/attention/`
- `packages/control-plane/src/notification-preferences/notification-preference-service.ts`
- `packages/runtime-daemon/src/attention/attention-projector.ts`
- `packages/runtime-daemon/src/attention/notification-emit-service.ts`
- `packages/client-sdk/src/attentionClient.ts`
- `apps/desktop/shell/src/notifications/`
- `apps/desktop/renderer/src/attention/`

## Data And Storage Changes

- Add durable user-level `notification_preferences` storage and replay-derived attention projections keyed to canonical session or run state.
- Keep delivery-attempt metadata ephemeral where possible while preserving outstanding actionable attention until resolved.
- Maintain both run-scoped attention projections and session-scoped aggregate attention projections so client surfaces do not reconstruct aggregate state ad hoc.

## API And Transport Changes

- Add `AttentionProjectionRead`, `NotificationPreferenceRead`, `NotificationPreferenceUpdate`, and `NotificationEmit` to shared contracts and the typed client SDK.
- Require emitted notifications to reference the underlying canonical event or derived blocking state that triggered them.

## Implementation Steps

1. Define attention categories, run-scope and session-scope projection shapes, notification-preference contracts, and canonical trigger references in shared packages.
2. Implement replay-derived attention projections and preference storage with global defaults plus later extension points.
3. Implement desktop notification emission and degraded fallback to in-app badges and summaries when OS delivery is unavailable.
4. Add desktop attention surfaces that distinguish actionable and informational state without depending on transient client heuristics.

## Parallelization Notes

- Preference-storage work and attention-projection work can proceed in parallel once trigger enums are fixed.
- Desktop notification hooks should wait for stable attention categories and mute-behavior semantics.

## Test And Verification Plan

- Attention-projection tests covering approvals, required input, run completion, failures, invites, and direct participant requests
- Notification-fallback tests proving lost or denied OS delivery does not erase in-app attention state
- Preference tests covering mute behavior without hiding critical approval-required attention
- Projection tests proving session-scoped aggregate attention resolves only when all underlying run-scoped actionable items are cleared

## Rollout Order

1. Land attention contracts, projections, and preference storage
2. Enable in-app badges and summaries
3. Enable desktop notification delivery for actionable and informational attention

## Rollback Or Fallback

- Disable OS notification delivery and keep in-app attention projections only if platform hooks or routing regress.

## Risks And Blockers

- Per-session notification preferences remain unresolved for the first implementation
- Cross-device duplicate delivery can become noisy if canonical attention state and local notification emission are not separated cleanly
- Aggregate session attention can drift if clients try to reconstruct it locally instead of consuming the canonical derived projection

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
