# Spec-017: Notifications And Attention Model

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `017` |
| **Slug** | `notifications-and-attention-model` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Live Timeline Visibility And Reasoning Surfaces](../specs/011-live-timeline-visibility-and-reasoning-surfaces.md), [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md), [Observability Architecture](../architecture/observability-architecture.md) |
| **Implementation Plan** | [Plan-017: Notifications And Attention Model](../plans/017-notifications-and-attention-model.md) |

## Purpose

Define how the product turns session and run state into attention surfaces and notifications.

## Scope

This spec covers in-app attention state, desktop notifications, cross-device notification delivery, and notification degradation paths.

## Non-Goals

- Mobile push implementation specifics
- Marketing or email campaigns
- Full operator paging policy

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [User And Device Model](../domain/user-and-device-model.md)

## Architectural Dependencies

- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Required Behavior

- The system must surface attention-worthy session and run states even when the user is not actively watching the timeline.
- Attention triggers must include at least:
  - pending approval or required input
  - run completion
  - run failure
  - an agent naming the user in a channel (a mention is agent-authored; there is no other person to raise one)
- Notification emission must be derived from canonical session or run state, not from client heuristics alone.
- Users must be able to distinguish passive informational notifications from actionable blocking attention.
- The attention model must support both run-scoped attention and session-scoped aggregate attention derived from canonical state.
- Attention is counted from the projection and never recomputed by a client. Only unresolved actionable moments count; an entry leaves the counted group the moment its moment resolves; and informational moments — a run that finished, a run that failed — are listed and never counted.
- There is one count, not several. The figure the in-app bell carries and the figure on the application icon are the same read of the same projection, so the two can never disagree, and the bell is the only badge the console draws on screen.
- Every attention moment carries an identity of its own, so a later state for the same subject replaces what was already posted for it instead of standing a second notice beside it.
- Losing the connection to the local daemon is not attention. It raises no entry, no count, and no notification, because nothing is waiting on a person to decide; it is a health reading instead ([Spec-018 §Required Behavior](018-observability-and-failure-recovery.md#required-behavior)).

## Default Behavior

- Pending approval or required input is actionable attention by default.
- Run completion is informational attention by default.
- When the desktop app is unfocused, actionable attention defaults to OS notification plus in-app badge.
- When the app is focused, attention defaults to in-app surfaces first.
- Run-scoped attention defaults to the fine-grained source projection, while session-scoped attention defaults to an aggregate of unresolved run-scoped and session-native signals.
- Two preferences govern the console's notification surfaces and both default to on: showing a count on the application icon, and notifying outside the application — the second posting only while the app is not in front.
- Those two are the whole of the preference surface. There is no per-kind switch, no per-session or per-channel mute, and nothing that makes a sound. Nothing outside the two silences a notification or the count — no environment variable, no hidden flag, no stored daemon preference — so a preference left on always means a notification would arrive, and the preference page never renders the daemon's own stored preference records as further switches.

## Fallback Behavior

- If OS notifications are unavailable or denied, the system must still show in-app badges and attention summaries: the two preference switches still draw, the preference page says in place that the operating system is refusing, and the bell and the in-app count keep working.
- If notification delivery is delayed, the session attention projection must still reflect outstanding actionable items.
- If a user has muted notifications globally, critical approval-request attention may still surface while informational events remain muted (per-session and per-channel mute is deferred per §Resolved Questions and V1 Scope Decisions; narrowed 2026-09-01 to match that section — the desktop console offers a global mute only).

## Interfaces And Contracts

- `AttentionProjectionRead` must expose current actionable and informational attention state at both run and session scope. It is the one read behind the bell's count, the bell's list, and the count on the application icon, and the shell posts and withdraws the operating-system notification from that same read rather than from a channel of its own.
- Every item in the projection names the moment it speaks for with a stable id — the subject and the state it is in — so a replacement notification replaces its predecessor instead of accumulating beside it.
- `NotificationPreferenceRead` and `NotificationPreferenceUpdate` must support per-surface preferences; the two the console holds are the count on the application icon and notifying outside the application, and the preference page reads and writes nothing else.
- `NotificationEmit` must reference the underlying canonical event or state trigger.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Attention state is a derived projection from canonical events.
- Session-scoped attention is an aggregate projection over run-scoped and session-native triggers.
- Notification preferences require durable user-level storage.
- Notification delivery attempts may be ephemeral, but actionable attention state must remain durable until resolved.

## Notification Delivery

### The Console's Attention Surfaces

- **The bell and its list.** The bell toggles the notifications list and reads as expanded while the list is open. The list opens in the same track the all-sessions list uses, in flow and never over the screen, and the two are never open together: opening one closes the other. The list holds a `Waiting on you` group with its count over the waiting entries, then an `Earlier` group over what finished or failed since it was last read. An entry is one line — a state dot, the title, the state word (`Waiting on you` · `Finished` · `Failed`), and how long ago it happened — newest first inside each group, and the whole line is the control: a session entry switches the screen to that session, a workflow-run entry opens that run, and neither closes the list. Opening the list puts focus on its first entry and closing it returns focus to the bell. Waiting entries pin above the rest and are the only counted ones. An entry carries no menu of its own, and nothing about a notification is ever said inside a session.
- **The application icon.** The icon carries the same figure the bell carries — the dock icon on macOS and Linux, a number drawn onto the taskbar icon on Windows — from the same projection read, counting only what is waiting on the person right now, and absent at zero rather than showing a zero.
- **A session row is not a notification.** A row's status dot is that session's own state, and the control that opens the all-sessions list carries no mark of its own. A session that finished while the person was away draws its done dot filled until they open it and hollow from the moment they do, from the one seen-or-unseen fact the projection keeps, so the row and the list can never disagree.

### Desktop-to-Desktop Delivery

- **Primary path**: the control plane pushes notifications to connected clients via the existing SSE subscription (tRPC subscription, per [ADR-014](../decisions/014-trpc-control-plane-api.md)).
- **Desktop shell**: receives SSE events and surfaces them as OS-native notifications using the Electron Notification API. Outside the application that notification is the only other channel, and it is posted only while the app is not in front, whichever screen is showing. It names the subject and its state and never what was said; clicking it opens that subject; it is withdrawn when its moment resolves; and it carries the stable id of the moment it speaks for, so a subject that moves from waiting to finished while nobody is looking replaces its own notice in place rather than standing a second one beside it. It carries the application's own name and icon on every platform that can post one, and where a platform cannot post one at all the preference page says so in place, exactly as it does of a refusal.
- **CLI**: receives SSE events and prints notification content to stderr.
- **Notification filtering**: only events matching the user's notification preferences (from the `notification_preferences` table, see [shared Postgres schema](../architecture/schemas/shared-postgres-schema.md)) are delivered. Events that do not match are silently dropped at the control plane before emission.
- **Moments that land together are posted once**: the daemon, which already computes the count, merges the moments that resolve within a moment of each other by the subject they belong to, so one session is named once and two different sessions still each get their own notice. The in-app list keeps every line.

### Cross-Device Delivery

- **V1**: notifications are delivered only to currently-connected devices via SSE. If no device is connected, notifications are queued in the control plane.
- **Reconnect catch-up**: on next device connect, queued notifications are delivered as a batch via the SSE catch-up mechanism (replay from last cursor).
- **V2 (deferred)**: email digest for extended offline (>24h without connection). Push notifications via FCM/APNs for mobile clients.
- **Queue retention**: undelivered notifications are retained for 7 days, then expired and permanently deleted.
- **No webhook delivery in V1**: external integrations use the SSE subscription directly rather than a separate webhook endpoint.

## Example Flows

- Example: A run reaches `waiting_for_approval` while the app is unfocused. The user receives a desktop notification and the session shows a blocking attention badge until the approval is resolved.
- Example: Two runs in one session require action at the same time. Each run exposes its own actionable attention state, and the session aggregate stays actionable until both are resolved.

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

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: notification preferences are global in the first release. Per-session notification preferences are deferred.
- V1 decision: attention state exists at both run scope and session scope in v1. Run scope is the fine-grained source of truth for execution-related attention, and session scope is the aggregate used for navigation and notification surfaces.

## References

- [Live Timeline Visibility And Reasoning Surfaces](../specs/011-live-timeline-visibility-and-reasoning-surfaces.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
