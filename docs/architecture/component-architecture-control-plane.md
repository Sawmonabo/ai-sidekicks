# Component Architecture Control Plane

## Purpose

Define the hosted or self-hosted Collaboration Control Plane and its internal responsibilities.

## Scope

This document covers the remote services inside the Collaboration Control Plane that coordinate sessions across participants and runtime nodes.

## Context

The Collaboration Control Plane exists to share session coordination state across participants without becoming the code-execution environment.

## Responsibilities

- authenticate users and authorize session membership
- manage invites and membership changes
- track participant and runtime-node presence
- broker relay connectivity and session join
- deliver notifications and shared session metadata
- provide a durable directory for sessions and shared coordination state

## Component Boundaries

| Component                       | Responsibility                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `Identity Service`              | Authenticates users and issues identity claims used by session membership.                   |
| `Session Directory`             | Stores session metadata needed for discovery, join, and coordination.                        |
| `Invite And Membership Service` | Creates invites, accepts joins, changes roles, and revokes membership.                       |
| `Presence Service`              | Tracks participant and node presence heartbeats and disconnect grace windows.                |
| `Relay Broker`                  | Helps clients and nodes establish shared-session connectivity without taking over execution. |
| `Notification Service`          | Delivers attention, invite, and session-level notifications.                                 |
| `Shared Metadata Store`         | Persists collaboration state used across participants and nodes.                             |

## Implementation Home

- Primary implementation root: `packages/control-plane/`
- Shared contracts consumed here: `packages/contracts/`
- Shared client-facing transport types consumed here: `packages/client-sdk/`

## Data Flow

1. A client authenticates with the identity service.
2. The client requests to create, join, or invite into a session.
3. The invite and membership service updates session directory and shared metadata state.
4. The presence service receives heartbeats from clients and runtime nodes.
5. Relay setup and notification delivery occur as side services around the same session metadata.
6. Local Runtime Daemons continue to execute work and push only the coordination data needed by the control plane.

## Trust Boundaries

- The control plane is trusted for identity, membership, invite, presence, and relay coordination.
- The control plane is not trusted as the local filesystem or tool-execution authority for participant nodes.
- Relay pathways must minimize trust and exposure because they cross remote infrastructure.

## Failure Modes

- Invite delivery or acceptance fails while local session execution continues.
- Presence becomes stale because clients disconnect without clean shutdown.
- Relay setup succeeds for membership but fails to establish live runtime-node connectivity.
- Shared metadata writes conflict or lag across rapid membership changes.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

## Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Identity And Participant State](../specs/018-identity-and-participant-state.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
