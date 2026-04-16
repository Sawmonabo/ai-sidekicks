# Spec-016: Multi-Agent Channels And Orchestration

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `016` |
| **Slug** | `multi-agent-channels-and-orchestration` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md), [Session Model](../domain/session-model.md), [Shared Session Core](../specs/001-shared-session-core.md), [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md) |
| **Implementation Plan** | [Plan-016: Multi-Agent Channels And Orchestration](../plans/016-multi-agent-channels-and-orchestration.md) |

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

## State And Data Implications

- Channel and run-link records must be durable and replayable.
- Parent-child linkage must survive recovery and replay.
- Internal helper visibility must be policy-aware but never silently omitted from audit history.

## Example Flows

- `Example: An architect agent and reviewer agent discuss a change in a design channel while an implementer agent works in a separate implementation channel inside the same session.`
- `Example: A parent run delegates a verification task to a child run on another runtime node. The session timeline shows the child run summary and links to its detailed output.`
- `Example: A child run attempts to spawn its own helper run in v1. The runtime rejects the request as unsupported nested delegation and records the refusal visibly.`

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

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: channel-level permission restrictions are deferred. New channels inherit session membership and visibility policy in the first implementation.
- V1 decision: channels are the only canonical communication boundary between agents and runs. Direct run-to-run messaging is out of scope for the first implementation.
- V1 decision: canonical nested delegation depth is one parent-child layer in v1. Deeper delegation requires a future spec revision.
- V1 decision: concurrent child runs are allowed, but v1 does not impose one product-wide numeric ceiling. Each runtime scheduler must expose bounded active-child admission behavior and explicit limit rejection.

## References

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Shared Session Core](../specs/001-shared-session-core.md)
