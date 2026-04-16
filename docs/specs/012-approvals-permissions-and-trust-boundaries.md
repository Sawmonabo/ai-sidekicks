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
- The canonical approval category enum is:
  - `tool_execution` — tool call approval
  - `file_write` — out-of-boundary file writes
  - `network_access` — unrestricted network
  - `destructive_git` — force push, branch delete
  - `user_input` — freeform questions from agent
  - `plan_approval` — proposed plan review
  - `mcp_elicitation` — MCP server input
  - `gate` — workflow phase gate
- Approval requests must record requester, target scope, requested capability, and expiry where applicable.
- Approval resolution must record approver, decision, and effective scope.
- Membership in a shared session must not imply authority to execute on another participant's machine.
- `runtime contributor` role may allow a participant to attach their own runtime nodes, but it must not imply authority over another participant's node.
- A participant's own runtime node may be trusted as the default execution host for that participant within its local daemon policy envelope, but that trust must not bypass approval rules for out-of-envelope or high-risk actions.
- Driver-native permission flows must be normalized into the canonical approval model.

## Default Behavior

- Default grant scope is `request_only`.
- Session-wide remembered approval rules are `off` by default and must require explicit user opt-in.
- File and tool permissions default to the bound workspace or node trust envelope; out-of-boundary access requires explicit approval.
- Network access defaults to denied unless the active policy or approval explicitly allows it.
- A participant's own attached runtime node defaults to trusted for running work on that participant's machine inside the node's declared trust envelope, but it does not grant ambient authority to other participants and does not waive explicit approval for sensitive escalation.

## Fallback Behavior

- If a driver cannot expose granular permission requests, the daemon must enforce an equal or stricter approval boundary at the local execution layer.
- If approval state cannot be durably persisted, the sensitive action must not proceed.
- If a remembered approval rule becomes invalid because membership or node trust changed, the system must revoke it before the next use.
- If node ownership or trust provenance cannot be established confidently, the daemon must treat the node as requiring strict per-request approval for sensitive actions rather than assuming own-node trust.

## Interfaces And Contracts

- `ApprovalRequestCreate` must include category, scope, requested resource, and expiry policy.
- `ApprovalResolve` must include approver, decision, optional remembered-scope request, and audit metadata.
- `PermissionCheck` must run inside the local daemon before executing a sensitive local action.
- `ApprovalProjectionRead` must surface pending and historical approval state to participants authorized to see it.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Approval requests and resolutions must be durable and replayable.
- Remembered approval rules require explicit revocation paths and audit history.
- Changes to membership or runtime-node trust must be able to invalidate dependent approval rules.

## Example Flows

- `Example: An agent requests write permission outside the bound worktree. A participant approves the request for this run only, and the decision is recorded with explicit path scope.`
- `Example: A participant with collaborator role has chat access in a shared session but cannot approve execution on another participant's runtime node because they lack the required trust scope.`
- `Example: A participant attaches their own runtime node to a shared session and starts a run on that node. Execution is allowed within the node's default trust envelope, but a later unrestricted network request still produces an explicit approval prompt.`

## Implementation Notes

- Approval UX may present grouped requests, but canonical approval records must remain granular enough for audit.
- Remembered approval scopes should be explicit enums, not free-form client labels.
- Trust changes must propagate into approval evaluation immediately.
- Policy evaluation uses Cedar (CNCF sandbox). V1 uses YAML policy definitions. V1.1 evaluates Cedar WASM (`@cedarpolicy/cedar-wasm`) for runtime evaluation. Cedar's principal-action-resource-context model maps to: principal = participant, action = approval category, resource = target (file, tool, network, etc.), context = session state.

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
- If the system changes the approval policy evaluation engine, create or update `../decisions/012-cedar-approval-policy-engine.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: organization-level stricter policy overrides are out of scope. V1 uses product-default policy with local daemon enforcement and explicit per-request approvals.
- V1 decision: own-node trust in v1 is envelope-bound, not blanket. A participant's own runtime node is the default execution host for that participant, but sensitive actions outside the node's normal trust envelope still require explicit approval and no own-node attachment grants authority over another participant's machine.

## References

- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Security Architecture](../architecture/security-architecture.md)
- [ADR-012](../decisions/012-cedar-approval-policy-engine.md)
