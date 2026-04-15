# Spec-008: Control-Plane Relay And Session Join

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `008` |
| **Slug** | `control-plane-relay-and-session-join` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [System Context](../architecture/system-context.md), [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md), [Security Architecture](../architecture/security-architecture.md), [Shared Session Core](../specs/001-shared-session-core.md), [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md) |
| **Implementation Plan** | [Plan-008: Control Plane Relay And Session Join](../plans/008-control-plane-relay-and-session-join.md) |

## Purpose

Define how participants authenticate, join shared sessions, and use relay-assisted connectivity without moving execution into the control plane.

## Scope

This spec covers session join, relay negotiation, presence attachment, and remote coordination boundaries.

## Non-Goals

- Local IPC details
- Full runtime-node attach handshake
- Provider transport internals

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

## Architectural Dependencies

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [Deployment Topology](../architecture/deployment-topology.md)

## Required Behavior

- Shared session join must require authenticated membership verification.
- A participant must be able to join a live session before attaching any runtime node.
- The control plane must provide session directory, invite resolution, presence registration, and relay coordination.
- Relay coordination must not grant the control plane arbitrary execution authority over participant nodes.
- A participant changing between direct and relay connectivity must remain attached to the same session identity when membership is still valid.
- The control plane must track presence for both participants and runtime nodes, even when relay is not currently in use.

## Default Behavior

- Session join defaults to direct control-plane API and event-stream attachment.
- Relay is used only when required by topology or reachability constraints.
- The control plane returns session metadata, membership state, and live replay cursors as part of successful join.

## Fallback Behavior

- If the control plane is unavailable, existing `local-only` sessions remain usable on their local nodes, but new shared-session join and invite actions must fail explicitly.
- If relay setup fails, the join remains valid but remote live connectivity may remain degraded until an alternate path succeeds.
- If a client switches connectivity path while within the reconnect grace window, the same participant presence should be re-associated rather than duplicated when possible.

## Interfaces And Contracts

- `SessionJoin` must require authenticated identity and valid membership or invite acceptance.
- `RelayNegotiation` must return only the information needed to establish remote session connectivity.
- `PresenceRegister` must exist independently of runtime-node attach.
- `SessionResumeAfterReconnect` must accept a prior participant or client identity handle where applicable.

## State And Data Implications

- Control-plane join emits membership and presence events into session history.
- Relay negotiation state may be ephemeral, but successful join and presence changes must be durably represented.
- Control-plane metadata must not become the local source of truth for run execution state.

## Example Flows

- `Example: A participant accepts an invite, authenticates to the control plane, joins a live session, and reads the existing timeline before deciding whether to attach a runtime node.`
- `Example: A participant loses direct connectivity and falls back to relay coordination while remaining in the same session and retaining the same membership.`

## Implementation Notes

- Join and relay should be separate sub-protocols. Joining a session is a membership action; relay is a connectivity action.
- Control-plane session join responses should be small and replay-oriented, not giant state dumps.
- Presence should be resilient to brief network path flips.

## Pitfalls To Avoid

- Treating relay connectivity as proof of execution authority
- Binding session identity to a specific transport path
- Making runtime-node attach a prerequisite for reading or discussing in a session

## Acceptance Criteria

- [ ] A participant can authenticate and join a live session without restarting active runs.
- [ ] Switching between direct and relay connectivity does not create a second session identity.
- [ ] Control-plane services never become the execution authority for local repo and tool actions.

## ADR Triggers

- If relay boundaries, trust assumptions, or default transport choices change materially, create or update `../decisions/008-default-transports-and-relay-boundaries.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: direct control-plane connectivity is required for admin and join-establishment flows. Relay is a secondary connectivity path for session participation after direct control-plane join succeeds.

## References

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [Deployment Topology](../architecture/deployment-topology.md)
