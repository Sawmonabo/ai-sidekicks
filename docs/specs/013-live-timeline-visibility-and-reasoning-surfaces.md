# Spec-013: Live Timeline Visibility And Reasoning Surfaces

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `013` |
| **Slug** | `live-timeline-visibility-and-reasoning-surfaces` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Observability Architecture](../architecture/observability-architecture.md), [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md) |
| **Implementation Plan** | `TBD` |

## Purpose

Define the user-facing contract for live timeline visibility, background work surfacing, and reasoning disclosure.

## Scope

This spec covers the canonical timeline read model, child-run visibility, reasoning surfaces, and replay-aware live updates.

## Non-Goals

- Notification rules
- Artifact storage internals
- Provider-specific reasoning formats

## Domain Dependencies

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Run State Machine](../domain/run-state-machine.md)

## Architectural Dependencies

- [Observability Architecture](../architecture/observability-architecture.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)

## Required Behavior

- The system must expose one live timeline per session or channel view built from canonical events.
- Timeline rows must cover at least messages, run state changes, tool activity, approval events, interventions, artifacts, and child-run activity.
- Background runs and child runs must be visible in the primary session experience, even when details are lazy-loaded.
- Reasoning surfaces must be normalized and policy-aware; unavailable or redacted reasoning must still produce a visible reason surface.
- Live delivery must support replay catch-up so clients can recover missing timeline state.

## Default Behavior

- Timeline rows default to chronological order from oldest to newest within the current view.
- Row details default to collapsed when the payload is large or high-volume.
- Child-run activity defaults to summarized rows with explicit expansion for detailed inspection.
- If provider reasoning is available and permitted, the system may render a structured reasoning surface tied to the relevant run or message row.

## Fallback Behavior

- If live delivery gaps occur, the client must request replay from the canonical event source.
- If detailed reasoning or tool payload is unavailable or policy-restricted, the timeline must show a placeholder row with the reason for unavailability.
- If a child-run detail fetch fails, the summary row remains visible and marked incomplete rather than disappearing.

## Interfaces And Contracts

- `TimelineRead` must support bounded windows and cursor-based continuation.
- `TimelineSubscribe` must support live append plus replay recovery.
- `ReasoningSurfaceRead` must identify availability status and policy reason when content is withheld.
- `ChildRunExpand` must read detailed activity for a summarized child-run row.

## State And Data Implications

- Timeline rows are read projections, not canonical events themselves.
- Reasoning disclosure decisions must be traceable to policy and artifact visibility state.
- Child-run summaries and detail windows must preserve provenance to parent run and producing runtime node.

## Example Flows

- `Example: A session timeline shows a run start, command execution, approval request, diff artifact publication, and completion, all as ordered timeline rows.`
- `Example: A background reviewer run appears as a summarized child-run row that can later be expanded to show findings.`

## Implementation Notes

- Timeline virtualization or pagination is allowed, but it must not alter canonical ordering.
- Redacted reasoning should still be visible as an event that something was intentionally withheld.
- Live timeline and replay logic should share the same projection schema.

## Pitfalls To Avoid

- Hiding child-run work because it happened in the background
- Flattening every structured event into plain chat text
- Rendering reasoning as if it were always available and safe to show

## Acceptance Criteria

- [ ] A client can see live run, approval, artifact, and child-run activity in one timeline surface.
- [ ] Missing live updates can be recovered through replay without rebuilding state from free-form text.
- [ ] Reasoning surfaces clearly distinguish available, unavailable, and policy-redacted cases.

## ADR Triggers

- If reasoning visibility or audit exposure materially changes the observability boundary, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md` or a replacement observability ADR.

## Open Questions

- Whether participants can opt into more verbose reasoning visibility per session without changing organization-level defaults.

## References

- [Observability Architecture](../architecture/observability-architecture.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
