# Security Architecture

## Purpose

Define the system's trust boundaries, permission layers, and transport security posture.

## Scope

This document covers identity, membership authorization, node trust, approvals, capability grants, and transport boundaries.

## Context

The product combines multiple humans, multiple runtime nodes, and local code execution. Security depends on not collapsing those concerns into one flat trust model.

## Responsibilities

- authenticate users and authorize session membership
- distinguish participant trust from runtime-node trust
- govern tool, file, network, and execution permissions
- protect remote transport and relay paths
- preserve auditable approval and grant history

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Identity And Session Authorization` | Authenticates users and authorizes membership in sessions. |
| `Membership Policy Engine` | Determines session roles and participant capabilities. |
| `Runtime Capability Registry` | Tracks what each runtime node can expose and under what trust envelope. |
| `Approval Policy Engine` | Evaluates and records approval requests and resolutions. |
| `Transport Security Layer` | Protects local IPC, client-daemon, and relay/control-plane traffic. |
| `Audit Layer` | Records grants, denials, escalations, and revocations. |

## Data Flow

1. Identity claims enter through the control plane.
2. Membership policy determines whether the participant may join and what actions are allowed.
3. Runtime nodes declare capabilities and are accepted or rejected by trust policy.
4. Runs request tool, file, or network permissions when needed.
5. Approval decisions are recorded and propagated back into the run engine.

## Trust Boundaries

- Session membership does not imply local machine trust.
- Runtime-node capability declaration does not bypass approval policy.
- The relay path must be treated as less trusted than direct local transport.
- The local daemon remains the enforcement point for local execution permissions.

## Failure Modes

- An invited participant is over-trusted and gains unintended execution capability.
- Remembered approvals outlive their intended scope and create hidden privilege drift.
- Transport authentication succeeds while local authorization policy is misapplied.
- Relay or remote-path compromise exposes data that should have remained end-to-end protected.

## Related Domain Docs

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Related Specs

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

## Related ADRs

- [Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
