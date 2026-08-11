# Spec-013: Live Timeline Visibility And Reasoning Surfaces

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `013` |
| **Slug** | `live-timeline-visibility-and-reasoning-surfaces` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Observability Architecture](../architecture/observability-architecture.md), [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md), [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md) |
| **Implementation Plan** | [Plan-013: Live Timeline Visibility And Reasoning Surfaces](../plans/013-live-timeline-visibility-and-reasoning-surfaces.md) |

> **Amendment (2026-07-20, campaign B9 CP-004-13 consumer registration — flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule, since it changes Required Behavior, Acceptance Criteria, and Depends On; restored `approved` 2026-08-10 by the Tier-8 readiness audit (§6 node NS-20); Plan-013 flipped to `review` with it under the runbook's plan behavior-change row and was restored `approved` by that same audit, its Preconditions box re-checked).** [Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior) already mandates that rolled-back turns stay in the timeline **marked superseded by projection**, and [Spec-004 §Driver-Level Rollback Mechanics](004-queue-steer-pause-resume.md#driver-level-rollback-mechanics) that clients render the rewound history distinctly rather than dropping it. This amendment registers the timeline-surface half of that approved contract on its owning spec: the superseded-turn-rendering Required Behavior bullet (live boundary-entry rule + read/replay marker + attribution-ranked late stragglers), the `run.rolled_back` run-state subtype row, the compacted-stub composition, the provenance rule, and the acceptance criterion — consumed from Plan-004 T3.14's exported `supersededTurns(runId)` read seam (CP-004-13).

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
- Timeline rows must cover at least messages, handoffs, run state changes, tool activity, approval events, interventions, artifacts, and child-run activity.
- Background runs and child runs must be visible in the primary session experience, even when details are lazy-loaded.
- Reasoning surfaces must be normalized and policy-aware; unavailable or redacted reasoning must still produce a visible reason surface.
- Durable reasoning surfaces must be limited to normalized reasoning summaries, state transitions, tool-intent or tool-result summaries, and policy-redaction markers. Provider-native detailed reasoning is not guaranteed durable.
- Live delivery must support replay catch-up so clients can recover missing timeline state.
- **Superseded-turn rendering (campaign B9, CP-004-13 — 2026-07-20).** Rolled-back (superseded) turns remain in the timeline and MUST render distinctly from current rows — an explicit superseded treatment, never dropped and never re-rendered as current ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior) owns the supersede semantics; marks are epoch-scoped, so a re-executed turn reusing a superseded ordinal renders current). The marking reaches the surface on two legs with one outcome: `TimelineRead` and replay rows carry a projection-computed `superseded` marker (sourced from the Plan-004 supersede projection's exported `supersededTurns(runId)` read — the CP-004-13 seam), and on the live stream the accepted `run.rolled_back` boundary entry (§Timeline Entry Types) — delivered to every filtered subscription whose filter admits any of the affected run's rows (projection-resolved visibility, never the event's optional channel field) — instructs the client to apply the same treatment to that run's **already-delivered** rows whose carried run position exceeds the carried rewind cutoff (run-scoped rows expose their run identity, projection-resolved originating run position, and execution epoch as typed row fields required together — a partial attribution row fails schema validation, never a silently incomparable cached row; the session event sequence is never a run position, and the boundary entry is a typed arm of the discriminated row union the read and subscribe surfaces return: its payload is validated into the `run.rolled_back` event shape at projection, so the cutoff is never read through an untyped cast) — an idempotent rule across multi-rollback sequences (a row already superseded re-marks as a no-op), with each newly-marked row's marker being just the boundary's cutoff against the row's own exposed identity — identical to the replay-computed marker by construction, a previously-current row's first remover being that boundary, so a subscriber that joined from a bounded window after earlier rollbacks marks its cached rows without recovering epochs from reused ordinals whose delivery-order scoping needs no epoch tag, because every row delivered **after** the boundary arrives with its marker already projection-computed: a late pre-rollback straggler appends pre-marked exactly when its stamped attribution ranks it above the run's effective cutoff for its epoch — the minimum rewind cutoff among accepted rollbacks at its epoch or later in the run's lineage, since a later rollback that rewinds below an earlier retained prefix supersedes the inherited rows — and current when it ranks into the run's surviving history ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior); the CP-004-12 `sourcePosition` companion exists precisely for this ranking) — and a new-epoch row appends unmarked — so live and replay views converge on identical marking. A compacted superseded row keeps the treatment: its audit stub renders with both the compaction placeholder and the superseded marker (stub-preserved attribution — [Spec-006 §Compacted Event Format](006-session-event-taxonomy-and-audit-log.md#compacted-event-format)).

## Default Behavior

- Timeline rows default to chronological order from oldest to newest within the current view.
- Row details default to collapsed when the payload is large or high-volume.
- Child-run activity defaults to summarized rows with explicit expansion for detailed inspection.
- If provider reasoning is available and permitted, the system may render a structured reasoning surface tied to the relevant run or message row.
- Detailed provider-native reasoning defaults to ephemeral rendering or bounded diagnostic retention only when policy allows it; it is not part of the durable canonical timeline contract.

## Fallback Behavior

- If live delivery gaps occur, the client must request replay from the canonical event source.
- If detailed reasoning or tool payload is unavailable or policy-restricted, the timeline must show a placeholder row with the reason for unavailability.
- If a child-run detail fetch fails, the summary row remains visible and marked incomplete rather than disappearing.
- If detailed reasoning has been compacted or was never retained, the durable reasoning summary or policy placeholder remains the canonical visible surface.
- If a superseded row's payload has been compacted, the stub placeholder retains the superseded treatment — compaction never launders a rewound row back to current. A vacuous-attribution-era legacy stub (its position unknowable) renders the compaction placeholder alone, exempt from marking by construction — a run carrying one can never admit a rollback ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior)'s standing refusal), so no marker can ever apply to it.

## Timeline Entry Types

> These timeline entry types are projection-layer constructs derived from canonical session events (see [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)). They do not create new event types.

### `handoff`

Agent-to-agent and participant-to-agent handoffs rendered as discrete timeline rows, visually distinct from normal messages.

- **Payload**: `{fromActor: string, toActor: string, reason?: string, channelId?: ChannelId}`
- A `handoff` entry is emitted when:
  - Orchestration transfers a run between agents.
  - A participant explicitly delegates to an agent.
  - An agent spawns a child run on a different node.

### Run-State Subtypes

Run-state subtypes are rendering types that map from underlying run lifecycle events. They exist so the timeline can render distinct visual treatments without inspecting raw event payloads.

| Entry Type | Rendered As | Source Condition |
| --- | --- | --- |
| `run.paused` | Status row with pause icon | Run transitions to `paused` state |
| `run.resumed` | Status row with resume icon | Run transitions from `paused` to `running` |
| `run.blocked` | Status row with block indicator | Run enters `waiting_for_approval` or `waiting_for_input` |
| `run.unblocked` | Status row with unblock indicator | Approval or input resolves the block |
| `run.rolled_back` | Status row with rewind indicator; the run's already-delivered rows above the carried rewind cutoff take the superseded treatment (§Required Behavior) | Accepted rollback rewinds the run — the forward `run.rolled_back` event ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior)) |

## Context Window and Usage Meters

The session composer area must always display a context-window meter reflecting the current provider conversation state.

- **Fields**:
  - `usagePercent` (0-100): current context window consumption as a percentage of the provider limit.
  - `tokenCount`: combined input + output token count for the active conversation.
  - `maxTokens`: the provider's context window limit for the active model.
- **Auto-compaction hint**: when `usagePercent` exceeds 80%, the meter must display a warning suggesting conversation compaction. The warning is informational; compaction is not triggered automatically.
- **Visibility**: the context-window meter is always visible in the session composer area regardless of usage level.
- **Update mechanism**: the meter is updated via `usage.context_window_update` events from the canonical event stream (see [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)).

### Rate-Limit Display

A rate-limit indicator shows the remaining API quota for the current session.

- **Fields**:
  - `remaining`: number of requests remaining in the current rate-limit window.
  - `limit`: total requests permitted in the current window.
  - `resetAt`: ISO-8601 timestamp when the rate-limit window resets (sourced from `RateLimitResponse` headers).
- **Threshold coloring**:
  - Green: >50% remaining.
  - Yellow: 20-50% remaining.
  - Red: <20% remaining.
- **Reset timing**: when the indicator is visible, it displays a countdown to the `resetAt` time.
- **Visibility**: the rate-limit indicator is shown when remaining quota is below 50% of the limit. It is hidden when quota is healthy (above 50%).
- **Update mechanism**: rate-limit fields are extracted from response headers returned by control-plane API calls. The indicator updates on each response.

## Interfaces And Contracts

- `TimelineRead` must support bounded windows and cursor-based continuation.
- `TimelineSubscribe` must support live append plus replay recovery.
- `ReasoningSurfaceRead` must identify availability status and policy reason when content is withheld.
- `ChildRunExpand` must read detailed activity for a summarized child-run row.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Timeline rows are read projections, not canonical events themselves.
- Reasoning disclosure decisions must be traceable to policy and artifact visibility state.
- Child-run summaries and detail windows must preserve provenance to parent run and producing runtime node.
- Durable timeline reasoning rows must remain reconstructible from canonical summaries and policy markers even when detailed reasoning payloads are unavailable.
- Superseded marking is projection-derived, never stored ad hoc: provenance traces through the Plan-004 supersede projection to the accepted `run.rolled_back` boundary event (its run and carried rewind cutoff) plus the projection-derived source epoch, and survives projection rebuilds and compaction ([Spec-006 §Compacted Event Format](006-session-event-taxonomy-and-audit-log.md#compacted-event-format)).

## Example Flows

- `Example: A session timeline shows a run start, command execution, approval request, diff artifact publication, and completion, all as ordered timeline rows.`
- `Example: A background reviewer run appears as a summarized child-run row that can later be expanded to show findings.`
- `Example: A provider emits detailed reasoning during a run. The timeline stores a durable reasoning summary and policy marker, while the detailed payload remains ephemeral or subject to bounded diagnostic retention.`

## Implementation Notes

- Timeline virtualization or pagination is allowed, but it must not alter canonical ordering.
- Redacted reasoning should still be visible as an event that something was intentionally withheld.
- Live timeline and replay logic should share the same projection schema.

## Pitfalls To Avoid

- Hiding child-run work because it happened in the background
- Flattening every structured event into plain chat text
- Rendering reasoning as if it were always available and safe to show
- Dropping rewound turns from the timeline instead of rendering them superseded — the authoritative log never truncates ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior))
- Re-rendering superseded output as current after replay, a projection rebuild, or compaction — or marking a re-executed turn that reuses a superseded ordinal (marks are epoch-scoped)

## Acceptance Criteria

- [ ] A client can see live run, approval, artifact, and child-run activity in one timeline surface.
- [ ] Missing live updates can be recovered through replay without rebuilding state from free-form text.
- [ ] Reasoning surfaces clearly distinguish available, unavailable, and policy-redacted cases.
- [ ] Handoff and run-state entries render as distinct timeline rows with appropriate visual treatment.
- [ ] Rolled-back turns render with the distinct superseded treatment identically on live delivery (the `run.rolled_back` boundary entry's already-delivered-rows rule keyed on each row's exposed run position and epoch against the boundary's typed cutoff — delivered to every filtered subscription admitting the run's rows, the live marker identical to replay by construction — plus attribution-ranked late stragglers — pre-marked above the run's effective lineage-minimum cutoff for their epoch, current within the surviving history, a later rollback below an earlier retained prefix superseding the inherited rows), `TimelineRead` windows, and replay recovery; a re-executed turn reusing a superseded ordinal renders current; and a compacted superseded row composes the stub placeholder with the superseded marker.

## ADR Triggers

- If reasoning visibility or audit exposure materially changes the observability boundary, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md` or a replacement observability ADR.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: per-session verbose reasoning opt-in is out of scope. Reasoning visibility follows the canonical product or organization policy without session-level overrides.
- V1 decision: durable reasoning visibility in v1 is summary-first. Provider-native detailed reasoning may be rendered transiently or retained only as bounded non-canonical diagnostics when policy permits it.

## References

- [Observability Architecture](../architecture/observability-architecture.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
