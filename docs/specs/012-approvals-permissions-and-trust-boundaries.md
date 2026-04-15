# Spec-012: Approvals Permissions And Trust Boundaries

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `012` |
| **Slug** | `approvals-permissions-and-trust-boundaries` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Participant And Membership Model](../domain/participant-and-membership-model.md), [Security Architecture](../architecture/security-architecture.md) |
| **Implementation Plan** | [Plan-012: Approvals Permissions And Trust Boundaries](../plans/012-approvals-permissions-and-trust-boundaries.md) |

## Purpose

Define the approval model, permission scopes, and trust boundaries for execution in shared sessions.

## Scope

This spec covers approval requests, approval scopes, remembered grants, and the distinction between session membership and local execution trust.

## Non-Goals

- Identity-provider implementation details
- Transport protocol details
- Notification policy

## Domain Dependencies

- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

## Architectural Dependencies

- [Security Architecture](../architecture/security-architecture.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)

## Required Behavior

- The system must distinguish:
  - session membership authorization
  - runtime-node trust
  - run-level approval policy
  - tool- and resource-level permission grants
- The membership role model must distinguish at least `viewer`, `collaborator`, `runtime contributor`, and `owner`.
- Sensitive actions must require approval or prior grant according to policy. This includes at least destructive git operations, out-of-boundary file writes, unrestricted network access, and high-risk tool execution.
- Approval requests must record requester, target scope, requested capability, and expiry where applicable.
- Approval resolution must record approver, decision, and effective scope.
- Membership in a shared session must not imply authority to execute on another participant's machine.
- `runtime contributor` role may allow a participant to attach their own runtime nodes, but it must not imply authority over another participant's node.
- Driver-native permission flows must be normalized into the canonical approval model.

## Default Behavior

- Default grant scope is `request_only`.
- Session-wide remembered approval rules are `off` by default and must require explicit user opt-in.
- File and tool permissions default to the bound workspace or node trust envelope; out-of-boundary access requires explicit approval.
- Network access defaults to denied unless the active policy or approval explicitly allows it.

## Fallback Behavior

- If a driver cannot expose granular permission requests, the daemon must enforce an equal or stricter approval boundary at the local execution layer.
- If approval state cannot be durably persisted, the sensitive action must not proceed.
- If a remembered approval rule becomes invalid because membership or node trust changed, the system must revoke it before the next use.

## Interfaces And Contracts

- `ApprovalRequestCreate` must include category, scope, requested resource, and expiry policy.
- `ApprovalResolve` must include approver, decision, optional remembered-scope request, and audit metadata.
- `PermissionCheck` must run inside the local daemon before executing a sensitive local action.
- `ApprovalProjectionRead` must surface pending and historical approval state to participants authorized to see it.

## State And Data Implications

- Approval requests and resolutions must be durable and replayable.
- Remembered approval rules require explicit revocation paths and audit history.
- Changes to membership or runtime-node trust must be able to invalidate dependent approval rules.

## Example Flows

- `Example: An agent requests write permission outside the bound worktree. A participant approves the request for this run only, and the decision is recorded with explicit path scope.`
- `Example: A participant with collaborator role has chat access in a shared session but cannot approve execution on another participant's runtime node because they lack the required trust scope.`

## Implementation Notes

- Approval UX may present grouped requests, but canonical approval records must remain granular enough for audit.
- Remembered approval scopes should be explicit enums, not free-form client labels.
- Trust changes must propagate into approval evaluation immediately.

## Pitfalls To Avoid

- Treating membership as equivalent to local execution trust
- Storing remembered approvals with no revocation model
- Allowing provider-specific permission semantics to leak into canonical docs

## Acceptance Criteria

- [ ] Sensitive local actions require explicit approval or prior valid grant.
- [ ] Session membership alone cannot authorize execution on another participant's node.
- [ ] Approval records survive replay and clearly show who granted what scope.

## ADR Triggers

- If the system materially changes how collaboration trust and approval scopes work, create or update `../decisions/007-collaboration-trust-and-permission-model.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: organization-level stricter policy overrides are out of scope. V1 uses product-default policy with local daemon enforcement and explicit per-request approvals.

## References

- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Security Architecture](../architecture/security-architecture.md)
