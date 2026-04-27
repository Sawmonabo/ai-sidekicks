# Spec-016: Multi-Agent Channels And Orchestration

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**              | `approved`                                                                                                                                                                                                                                                                                                                                                                                             |
| **NNN**                 | `016`                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Slug**                | `multi-agent-channels-and-orchestration`                                                                                                                                                                                                                                                                                                                                                               |
| **Date**                | `2026-04-14`                                                                                                                                                                                                                                                                                                                                                                                           |
| **Author(s)**           | `Codex`                                                                                                                                                                                                                                                                                                                                                                                                |
| **Depends On**          | [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md), [Session Model](../domain/session-model.md), [Shared Session Core](../specs/001-shared-session-core.md), [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md), [Runtime Node Attach](../specs/003-runtime-node-attach.md), [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md) |
| **V1 Quality Bar**      | Declared per [ADR-015](../decisions/015-v1-feature-scope-definition.md); V1-readiness review 2026-04-17 (BL-042)                                                                                                                                                                                                                                                                                       |
| **Implementation Plan** | [Plan-016: Multi-Agent Channels And Orchestration](../plans/016-multi-agent-channels-and-orchestration.md)                                                                                                                                                                                                                                                                                             |

## Purpose

Define how multiple agents collaborate inside a session and how their channels and run relationships are represented.

## Scope

This spec covers channel creation, parent-child run linkage, cross-agent collaboration, and background helper activity.

## Non-Goals

- Workflow authoring syntax
- Provider-native subagent APIs
- Notification policy

## Domain Dependencies

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [ADR-011: Generic Intervention Dispatch](../decisions/011-generic-intervention-dispatch.md)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)

## Required Behavior

- A session must support multiple active agents at once.
- Agents may collaborate through one or more channels inside the same session.
- Cross-agent communication must use canonical channel publication, artifact references, approvals, or persisted run linkage. V1 must not depend on a separate direct run-to-run messaging primitive.
- Parent-child run relationships must be durable and auditable.
- Internal helper runs must remain distinguishable from user-visible agents while still appearing in canonical history.
- Per-agent model, driver, and runtime-node selection must be allowed within one session.
- Orchestration must remain valid even when a driver has no native subagent concept.

## Default Behavior

- Default collaboration mode is explicit: new child runs are created only by user request or workflow definition.
- Child-run output defaults to publishing a summarized row into the parent session timeline, with expandable detail.
- New collaboration channels default to inheriting session membership unless later restricted by policy.
- V1 delegation defaults to one parent-child layer. A child run is not allowed to create another child run under the canonical first-release contract.
- Concurrent child runs are allowed, but admission remains subject to explicit runtime scheduler limits rather than unbounded fan-out.

## Fallback Behavior

- If a driver does not support native subagent creation, the runtime must model delegated work as separate runs with explicit linkage and channel context.
- If child-run detail loading fails, the summary row remains available and marked incomplete.
- If channel-specific delivery is unavailable, output falls back to the session's default visible channel with preserved provenance.
- If child-run creation would exceed the supported delegation depth, the runtime must reject the request with explicit limit detail and must not create hidden background work.
- If child-run creation would exceed the active-child scheduler limit, the runtime must reject the request with explicit capacity detail rather than silently dropping or auto-spawning overflow work.

## Interfaces And Contracts

- `ChannelCreate` must create a session-scoped communication surface.
- `OrchestrationRunCreate` must allow parent linkage, target agent, target node, and target channel.
- `OrchestrationRunCreate` failure must surface explicit limit or policy rejection when depth or active-child bounds are exceeded.
- `ChildRunLinkRead` must expose parent-child relationships.
- `InternalRunFlag` must distinguish internal helper work from user-facing agents.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Channel and run-link records must be durable and replayable.
- Parent-child linkage must survive recovery and replay.
- Internal helper visibility must be policy-aware but never silently omitted from audit history.

## Example Flows

- `Example: An architect agent and reviewer agent discuss a change in a design channel while an implementer agent works in a separate implementation channel inside the same session.`
- `Example: A parent run delegates a verification task to a child run on another runtime node. The session timeline shows the child run summary and links to its detailed output.`
- `Example: A child run attempts to spawn its own helper run in v1. The runtime rejects the request as unsupported nested delegation and records the refusal visibly.`

## Turn Policies

| Policy          | Behavior                                      | Default       |
| --------------- | --------------------------------------------- | ------------- |
| `free-form`     | Any participant or agent can send at any time | Yes (default) |
| `round-robin`   | Agents take turns in a fixed order            | No            |
| `request-based` | Agents speak only when explicitly addressed   | No            |

## Budget Policies

| Budget Type            | Description                              | Default Limit |
| ---------------------- | ---------------------------------------- | ------------- |
| Token limit per run    | Max input+output tokens for a single run | 100,000       |
| Cost limit per session | Max estimated cost across all runs       | $10.00        |
| Turn limit per agent   | Max consecutive turns an agent can take  | 50            |

V1 budget enforcement is a hard ceiling, tightened from advisory during the 2026-04-17 V1-readiness review (Spec-016 was authored 2026-04-14, predating ADR-015's V1 quality bar declaration by three days, so the original advisory posture no longer matches the V1 gate). The daemon emits `usage_warning` events at 80% of any budget limit and issues an `interrupt` intervention via the generic dispatcher ([ADR-011](../decisions/011-generic-intervention-dispatch.md)) at 100%. Per-run and per-agent ceilings interrupt the specific offending run with `reason: budget_exhausted`. Session-level cost ceilings interrupt all active runs in the session and block further queue admission until a session admin raises the limit. Conclusion detection (agent determines task is complete) remains V2.

## Stop Conditions

| Condition          | Trigger                                                | Behavior                                       |
| ------------------ | ------------------------------------------------------ | ---------------------------------------------- |
| Turn limit reached | Agent exceeds turn limit                               | Run completes with `turn_limit` metadata       |
| Budget exhausted   | Token or cost limit exceeded                           | Run interrupted with `budget_exhausted` reason |
| Explicit stop      | User sends stop command                                | Run interrupted via cancel intervention        |
| Idle timeout       | No activity for configurable duration (default: 5 min) | Run interrupted with `idle_timeout` reason     |

Conclusion detection (agent determines task is complete) is V2.

## Intervention Propagation

Interventions use the generic dispatcher defined by [Spec-004](../specs/004-queue-steer-pause-resume.md) and [ADR-011](../decisions/011-generic-intervention-dispatch.md). Spec-016 introduces no new intervention verbs.

- A pause, interrupt, or steer applied to a parent run does not auto-cascade to its child runs. Each child run is an independent intervention target.
- Propagating an intervention across a parent/child subtree requires the caller to submit one intervention per run. This preserves Spec-004's audit property that every run-state transition corresponds to a distinct `InterventionResult` record.
- A steer applied to a parent run does not inject content into child-run conversations — child runs receive steer content only when the steer is targeted at the child run's id.
- Child runs accept pause, steer, and interrupt via the same `applyIntervention` surface as standalone runs. Driver capability semantics (Spec-004's steer degradation, for example) apply uniformly.
- If a future requirement demands subtree-wide propagation (e.g., "cancel this parent and all its descendants atomically"), that is a new ADR rather than a payload field addition, consistent with ADR-011's Type-1 reversibility stance.

## Moderation Hooks

- Pre-turn approval: before an agent's output is committed to the timeline, an approval gate can require human review.
- Post-turn review: after output is committed, a review flag marks it for human inspection (non-blocking).
- Both hooks integrate with the approval system (Plan-012): category `gate` for pre-turn, informational event for post-turn.
- V1 default: no moderation hooks enabled. Opt-in per channel.

## Scheduler Limits

| Limit                             | Default                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| Max concurrent channels executing | 5 per session                                                 |
| Max queue depth per channel       | 25 items (subject to Spec-001 per-session queue depth of 100) |
| Max pending orchestration runs    | 10 per session                                                |

## Partition And Reconnect Behavior

Multi-agent sessions span multiple runtime nodes; partition behavior inherits from [Spec-003](../specs/003-runtime-node-attach.md) and [Spec-015](../specs/015-persistence-recovery-and-replay.md). Spec-016 adds only the turn-arbitration and channel-visibility rules specific to multi-agent semantics.

- When a node loses its relay connection, the control plane marks it `offline` per Spec-003. Session membership is preserved and the node may reconnect under the same node identity.
- Child runs on the offline node continue locally if the node can still reach its provider; events buffer against the node's local audit log ([Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)) until relay catch-up via Spec-015 replay.
- Parent-channel views on connected nodes show the offline node's runs in an `unreachable` state with the last-known state preserved from the event cursor. `unreachable` is a visibility outcome, not a run-state transition — it is distinct from the run-level `paused` state defined in Spec-004.
- Turn-policy arbitration degrades by policy:
  - `free-form`: unaffected; remaining agents continue to speak.
  - `round-robin`: if the next agent is on an unreachable node, arbitration pauses the channel and emits an `arbitration.paused` event (with `arbitration.resumed` on reconnect). Arbitration must not silently skip the unreachable agent (which would let a disconnected participant miss their turn without record) and must not auto-fail-over to free-form without explicit operator action. `arbitration.paused` and `arbitration.resumed` are registered in the [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) canonical event taxonomy under the `channel_arbitration` category (BL-084, completed 2026-04-18).
  - `request-based`: unaffected on the sender side; responders on unreachable nodes do not consume their turn and the request expires per its normal timeout.
- On reconnect, buffered events catch up via Spec-015 replay and any arbitration pause resolves automatically once the canonical ordering is restored.
- Runs that cannot be resumed because provider-session state was lost transition to `failed` per Spec-015; they must not reappear as a new run.
- The control plane does not enforce cross-node consensus on turn arbitration. Local daemons own their attached runs; cross-node ordering is eventually consistent through the event log. A round-robin channel with two agents on two partitioned node-halves may briefly see divergent local views; Spec-015 replay reconciles on reconnect. Availability over consistency (AP) is the explicit trade-off for the collaboration surface.

## Implementation Notes

- Keep orchestration semantics provider-agnostic and session-scoped.
- Channel creation should be lightweight, but channel identity must remain durable enough for audit and replay.
- Internal helper runs should be discoverable without overwhelming the default UI.

## Pitfalls To Avoid

- Treating multi-agent orchestration as only a UI grouping trick
- Hiding child-run provenance
- Assuming provider-native spawn semantics are universal

## Acceptance Criteria

- [ ] A session can host multiple concurrent agents and channels.
- [ ] Parent-child run relationships remain visible after replay and reconnect.
- [ ] Delegated work remains possible even on drivers without native subagent APIs.

## ADR Triggers

- If orchestration requires a new root model beyond session, create or update `../decisions/001-session-is-the-primary-domain-object.md`.
- If intervention propagation behavior changes (e.g., auto-cascade to children becomes the default), create or update `../decisions/011-generic-intervention-dispatch.md`.
- If the V1 Multi-Agent Channels quality bar declared by ADR-015 changes (e.g., scope demotion to V1.1), create or update `../decisions/015-v1-feature-scope-definition.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: channel-level permission restrictions are deferred. New channels inherit session membership and visibility policy in the first implementation.
- V1 decision: channels are the only canonical communication boundary between agents and runs. Direct run-to-run messaging is out of scope for the first implementation.
- V1 decision: canonical nested delegation depth is one parent-child layer in v1. Deeper delegation requires a future spec revision.
- V1 decision: concurrent child runs are allowed, but v1 does not impose one product-wide numeric ceiling. Each runtime scheduler must expose bounded active-child admission behavior and explicit limit rejection.

## V1 Readiness Review (BL-042, 2026-04-17)

Review against the V1 quality bar declared by [ADR-015](../decisions/015-v1-feature-scope-definition.md) §Thesis. Findings:

- **Turn policy defaults** — `free-form` is the explicit default. Round-robin and request-based are documented alternatives with deterministic triggers. No "configurable without default" surfaces remain.
- **Budget policy defaults** — Named defaults for per-run token (100,000), per-session cost ($10.00), and per-agent turn (50) limits. V1 enforcement tightened from advisory to hard ceiling via intervention dispatch during this review. Soft warning at 80%, hard interrupt at 100%.
- **Stop conditions** — Four named conditions (turn limit, budget exhausted, explicit stop, idle timeout) with deterministic triggers. Idle timeout default is 5 minutes. Conclusion detection deferred to V2.
- **Moderation / approval hooks** — Pre-turn (category `gate`) and post-turn (informational) hooks integrate with [Plan-012](../plans/012-approvals-permissions-and-trust-boundaries.md) approval categories. Opt-in per channel is the V1 default.
- **Turn arbitration under partition** — Named partition behavior added: `round-robin` pauses arbitration when the next agent is on an unreachable node with explicit `arbitration.paused` / `arbitration.resumed` events (registration in Spec-006 is a Plan-016 precondition — tracked as BL-084); `free-form` and `request-based` degrade gracefully. Reconnect semantics align with Spec-003 node-identity continuation and Spec-015 replay. Eventually-consistent cross-node ordering is the accepted trade-off (AP over CP for the collaboration surface).
- **ADR-011 intervention dispatch** — Non-cascading propagation clarified; no new intervention verbs introduced; subtree-wide cascade would be a new ADR, not a Spec-016 edit.

Behavioral change: budget enforcement posture (advisory → hard ceiling). No blocking changes required to ADR-011, Spec-004, Spec-012, or the approval policy surface. Turn arbitration pause is an orchestration-layer visibility state distinct from run-level `paused`, consistent with Spec-004's discrimination of waiting states.

## References

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Shared Session Core](../specs/001-shared-session-core.md)
- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)
- [ADR-011: Generic Intervention Dispatch](../decisions/011-generic-intervention-dispatch.md)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)
