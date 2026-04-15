# Plan-012: Approvals Permissions And Trust Boundaries

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `012` |
| **Slug** | `approvals-permissions-and-trust-boundaries` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-012: Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| **Required ADRs** | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md) |

## Goal

Implement the canonical approval, remembered-grant, and permission-check model that keeps shared collaboration membership separate from local execution trust.

## Scope

This plan covers approval records, remembered grants, daemon-side permission checks, trust invalidation, and approval visibility projections.

## Non-Goals

- Identity-provider implementation details
- Notification routing for approval prompts
- Provider-specific permission UX beyond normalized capability requests

## Preconditions

- [x] Paired spec is approved
- [ ] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/approvals/`
- `packages/runtime-daemon/src/approvals/approval-service.ts`
- `packages/runtime-daemon/src/policy/permission-check-service.ts`
- `packages/runtime-daemon/src/policy/grant-evaluator.ts`
- `packages/control-plane/src/approvals/approval-projection-service.ts`
- `packages/client-sdk/src/approvalClient.ts`
- `apps/desktop/renderer/src/approvals/`

## Data And Storage Changes

- Add durable local `approval_requests`, `approval_resolutions`, and `remembered_approval_rules` storage plus invalidation hooks tied to runtime-node trust changes.
- Extend shared projections so authorized participants can read pending and historical approval state without inferring it from raw events alone.
- Persist the trust-evaluation inputs needed to distinguish own-node envelope trust from cross-participant or escalated sensitive actions.

## API And Transport Changes

- Add `ApprovalRequestCreate`, `ApprovalResolve`, `PermissionCheck`, and `ApprovalProjectionRead` to shared contracts and the typed client SDK.
- Normalize driver-native permission requests into canonical approval categories, scopes, and requested resources before mutation is attempted.

## Implementation Steps

1. Define canonical approval categories, scope enums, remembered-grant rules, and trust-evaluation inputs in shared contracts.
2. Implement daemon-side permission checks and approval persistence before any sensitive local action executes.
3. Implement approval projection reads and invalidation flows when membership, role, or runtime-node trust changes.
4. Add desktop approval surfaces for pending requests, historical decisions, and remembered-grant revocation.

## Parallelization Notes

- Contract work and daemon permission enforcement can proceed in parallel once approval enums and storage shape are fixed.
- Renderer approval flows should wait for projection semantics and invalidation rules to stabilize.

## Test And Verification Plan

- Permission-enforcement tests covering destructive git, out-of-boundary file writes, network access, and high-risk tool execution
- Replay and restart tests proving approval state and remembered grants survive recovery
- Trust-invalidation tests proving membership or node-trust changes revoke dependent grants before reuse
- Own-node trust tests proving normal local execution is allowed within the node envelope while escalated sensitive actions still require explicit approval

## Rollout Order

1. Land approval contracts and durable storage
2. Enforce daemon-side permission checks with per-request approvals only
3. Enable remembered grants and revocation controls once invalidation behavior is verified

## Rollback Or Fallback

- Disable remembered grants and fall back to `request_only` approvals everywhere if grant invalidation or replay behavior regresses.

## Risks And Blockers

- Organization-level policy defaults remain unresolved for the first implementation
- Provider-native permission semantics may drift unless normalization is enforced before approval records are written
- Own-node trust can be over-broadened unless envelope boundaries remain explicit in permission checks and UI copy

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
