# Spec-019: Notifications And Attention Model

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `019` |
| **Slug** | `notifications-and-attention-model` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Live Timeline Visibility And Reasoning Surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md), [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md), [Observability Architecture](../architecture/observability-architecture.md) |
| **Implementation Plan** | [Plan-019: Notifications And Attention Model](../plans/019-notifications-and-attention-model.md) |

## Purpose

Define how the product turns session and run state into attention surfaces and notifications.

## Scope

This spec covers in-app attention state, desktop notifications, invite notifications, and notification degradation paths.

## Non-Goals

- Mobile push implementation specifics
- Marketing or email campaigns
- Full operator paging policy

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)

## Architectural Dependencies

- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Required Behavior

- The system must surface attention-worthy session and run states even when the user is not actively watching the timeline.
- Attention triggers must include at least:
  - pending approval or participant input
  - run completion
  - run failure
  - invite receipt
  - mention or direct request from another participant
- Notification emission must be derived from canonical session or run state, not from client heuristics alone.
- Users must be able to distinguish passive informational notifications from actionable blocking attention.

## Default Behavior

- Pending approval or required input is actionable attention by default.
- Run completion and invite receipt are informational attention by default.
- When the desktop app is unfocused, actionable attention defaults to OS notification plus in-app badge.
- When the app is focused, attention defaults to in-app surfaces first.

## Fallback Behavior

- If OS notifications are unavailable or denied, the system must still show in-app badges and attention summaries.
- If notification delivery is delayed, the session attention projection must still reflect outstanding actionable items.
- If a participant has muted a session or channel, critical approval-request attention may still surface while informational events remain muted.

## Interfaces And Contracts

- `AttentionProjectionRead` must expose current actionable and informational attention state.
- `NotificationPreferenceRead` and `NotificationPreferenceUpdate` must support per-surface preferences.
- `NotificationEmit` must reference the underlying canonical event or state trigger.

## State And Data Implications

- Attention state is a derived projection from canonical events.
- Notification preferences require durable user-level storage.
- Notification delivery attempts may be ephemeral, but actionable attention state must remain durable until resolved.

## Example Flows

- Example: A run reaches `waiting_for_approval` while the app is unfocused. The user receives a desktop notification and the session shows a blocking attention badge until the approval is resolved.
- Example: An owner invites another participant into a live session. The recipient receives an invite notification, and the pending invite remains visible in-app until accepted or dismissed.

## Implementation Notes

- Attention projection should be small and queryable without requiring full timeline replay in the foreground client.
- Users need suppression controls, but suppression must not erase actual blocking session state.
- Notification channels should be policy-aware and platform-aware.

## Pitfalls To Avoid

- Basing notifications only on transient client events
- Treating all notifications as equally urgent
- Letting muted informational noise hide blocking approval state

## Acceptance Criteria

- [ ] Approval-required runs generate actionable attention even when the user is not focused on the session.
- [ ] Notification loss does not remove in-app attention state.
- [ ] Informational and actionable attention are distinguishable in product behavior.

## ADR Triggers

- If attention or notification routing requires a new shared service boundary, create a new ADR before implementation.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: notification preferences are global in the first release. Per-session notification preferences are deferred.

## References

- [Live Timeline Visibility And Reasoning Surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
