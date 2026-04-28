# Plan-027: Cross-Node Dispatch And Approval

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `027` |
| **Slug** | `cross-node-dispatch-and-approval` |
| **Date** | `2026-04-26` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-024: Cross-Node Dispatch And Approval](../specs/024-cross-node-dispatch-and-approval.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) |
| **Dependencies** | [Plan-003](./003-runtime-node-attach.md) (runtime-node roster and capability declarations), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (`dispatch.*` event taxonomy and JCS/BLAKE3 integrity primitives), [Plan-008](./008-control-plane-relay-and-session-join.md) (pairwise encrypted relay channel), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (Cedar policy and approval categories), [Plan-015](./015-persistence-recovery-and-replay.md) (local replay/recovery substrate), [Plan-018](./018-identity-and-participant-state.md) (participant identity keys), [Plan-023](./023-desktop-shell-and-renderer.md) (target-owner approval UI), [Plan-025](./025-self-hostable-node-relay.md) (`packages/crypto-paseto/` and self-host relay deploy surface) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the V1 cross-node dispatch protocol so one participant's daemon can request execution on another participant's daemon only through verified caller identity, target-node-owner approval, dual-signed audit records, and bounded shared coordination metadata.

## Scope

This plan covers the caller-side dispatch client, target-side dispatch intake and approval service, coordination-row writes, local ApprovalRecord persistence, dispatch result delivery, replay-safe event emission, and approval UI integration for Spec-024.

## Non-Goals

- Cross-node shared artifact replication beyond the result payload of a single dispatch; that remains V1.1 scope per ADR-015.
- MLS group-encrypted relay upgrade; V1 uses pairwise X25519 + XChaCha20-Poly1305 via Plan-008 / ADR-010.
- Long-lived delegated approval roles. V1 approval is target-node-owner scoped.
- Replacing own-node scheduling. Own-node execution stays on the Plan-004 / Plan-005 path.

## Preconditions

- [x] Paired spec is approved.
- [x] Required ADRs are accepted.
- [x] Blocking open questions are resolved or explicitly deferred.
- [ ] Plan-003 has landed runtime-node attachment, roster, and capability declaration persistence.
- [ ] Plan-006 has registered all Spec-024 `dispatch.*` event types and exposed the shared JCS canonicalization helper.
- [ ] Plan-008 has landed the pairwise encrypted relay payload channel.
- [ ] Plan-012 has landed Cedar policy evaluation and approval category enforcement.
- [ ] Plan-018 has landed participant identity-key lookup and verification surfaces.
- [ ] Plan-023 has landed the desktop preload bridge and approval modal pattern.
- [ ] Plan-025 has landed `packages/crypto-paseto/` and the relay deploy surface needed for self-host tests.

## Target Areas

- `packages/contracts/src/cross-node-dispatch.ts` — new contract file exporting dispatch request, approval, result, and verification payload types.
- `packages/runtime-daemon/src/cross-node-dispatch/` — new daemon module for caller scheduler integration, target intake, replay guard, ApprovalRecord store, and result buffering.
- `packages/runtime-daemon/src/approvals/` — additive integration with Plan-012 approval request/resolution code; no ownership transfer.
- `packages/runtime-daemon/src/runtime-node/` — consumes Plan-003 capability declarations and node state.
- `packages/runtime-daemon/src/events/` — emits Plan-006 `dispatch.*` events through the existing event writer.
- `packages/control-plane/src/cross-node-dispatch/` — new control-plane coordination-row service and relay routing adapter.
- `packages/client-sdk/src/crossNodeDispatchClient.ts` — typed SDK wrapper for caller-side and audit-verification reads.
- `apps/desktop/renderer/src/cross-node-dispatch/` — target-owner approval surface added through the Plan-023 bridge.
- `docs/architecture/contracts/api-payload-contracts.md` — extended by this plan with typed request/response shapes.
- `docs/architecture/contracts/error-contracts.md` — extended by this plan with dispatch-specific rejection reasons.

## Data And Storage Changes

- Create Local SQLite `cross_node_dispatch_approvals` in both caller and target daemons. The table stores the dual-token ApprovalRecord envelope, decision state, token JTIs, request hash, expiry, and lifecycle timestamps. It never stores unredacted action payloads.
- Create Shared Postgres `cross_node_dispatch_coordination`. This row is routing metadata only: dispatch id, session id, caller participant, target participant, target node, status, and timestamps. It never stores dispatch payloads, ApprovalRecord envelopes, PASETO tokens, or action results.
- Use a target-local replay guard keyed by `(session_id, dispatch_id)` with retention at least 10 minutes. The guard may be in-memory backed by a short-lived local cache; it is not a shared truth source.
- Append dispatch lifecycle events to each daemon's local `session_events` log per ADR-017. Shared Postgres does not own dispatch event payloads.
- Add purge/retention handling so expired denied/failed approval records remain available for audit while raw transient result buffers are bounded by `caller_token.exp + 5 minutes`.

## API And Transport Changes

- Add `DispatchRequest` and `DispatchReceive` contracts exactly matching Spec-024's token-binding and request-body-hash requirements.
- Add `DispatchApprovalRequest` and `DispatchApprovalResolve` contracts for target-owner UI and Cedar approval integration.
- Add `DispatchResult` contract with target-side result signature and caller-side verification metadata.
- Add `ApprovalRecordVerify` helper surface for audit tools and replay verification.
- Add relay envelope routing for caller-to-target dispatch and target-to-caller result delivery over the Plan-008 pairwise encrypted payload channel.
- Add control-plane coordination operations for insert, status update, expiry sweep, and target-node lookup.

## Implementation Steps

1. Define the `cross-node-dispatch.ts` contract module with branded IDs, discriminated lifecycle states, JCS-hash helpers, Zod schemas, and error-code enums.
2. Add the Local SQLite migration for `cross_node_dispatch_approvals` and the Shared Postgres migration for `cross_node_dispatch_coordination`; update schema snapshots and migration tests.
3. Implement caller-side dispatch construction: own-node-first scheduler hook, capability target selection, `caller_token` issuance through `packages/crypto-paseto/`, JCS canonicalization, BLAKE3 `request_body_hash`, relay send, and caller-side event emission.
4. Implement target-side intake: token verification against participant identity keys, body-binding verification, replay guard, capability check, Cedar request construction, and fail-closed rejection events.
5. Integrate with Plan-012 approval resolution so owner approval produces an `approver_token`, a dual-signed ApprovalRecord envelope, local persistence, and `dispatch.approved` / `dispatch.denied` events.
6. Implement target-side execution adapter that dispatches only to declared capability handlers, aborts on caller-token expiry, emits the exact Spec-024 lifecycle, and signs results.
7. Implement caller-side result verification, result observation events, and actionable failure surfaces for denied, rejected, expired, failed, and buffered dispatches.
8. Implement detached-caller result buffering on the target daemon with the `caller_token.exp + 5 minutes` delivery window.
9. Add desktop approval UI integration under `apps/desktop/renderer/src/cross-node-dispatch/`, routed only through the Plan-023 preload bridge.
10. Add audit/export verification that recomputes request hashes and verifies both caller and approver PASETO signatures.
11. Extend API and error contract docs with final request/response/error shapes before marking implementation complete.

## Parallelization Notes

- Contract/schema work can run in parallel with desktop approval mockups because both depend only on Spec-024.
- Caller-side construction and target-side intake can run in parallel after the shared contract module lands.
- Result buffering must wait for target-side execution and caller-side result verification contracts to stabilize.
- Desktop approval UI must wait for Plan-023 bridge availability and Plan-012 approval request shapes.

## Test And Verification Plan

- Contract tests for JCS canonicalization and `request_body_hash` equality across independently ordered JSON inputs.
- PASETO verification tests covering invalid signature, wrong audience, wrong session, expired token, mismatched `req_hash`, reused `jti`, and DPoP thumbprint mismatch.
- Cedar principal-binding tests proving `principal` is always the verified `caller_token.sub`, never an untrusted request field.
- Replay-guard tests proving a duplicate `dispatch_id` is rejected before Cedar evaluation.
- Capability tests proving undeclared capabilities never create target-owner approval requests.
- Approval-record tests proving allow and deny envelopes are both dual-signed, persisted, and independently verifiable.
- Lifecycle tests for success, denied, rejected, expired during approval wait, expired during execution, failed after approval, and caller detach with result buffering.
- Scheduler tests proving same-node tasks do not emit cross-node dispatch events and a named remote dispatch never silently falls back to a third participant.
- Integration tests across two daemon instances and one relay instance with pairwise encrypted envelopes.
- Desktop UI tests proving target-owner approval text includes caller, capability, summary, expiry, and deny/approve outcomes without exposing raw tokens.

## Rollout Order

1. Land contracts and migrations behind a disabled dispatch feature flag.
2. Land target-side intake and fail-closed rejection paths before enabling caller-side send.
3. Enable dual-signed ApprovalRecord persistence and audit verification.
4. Enable approved execution and result delivery for non-dangerous test capabilities.
5. Enable dangerous capability classes only after session-owner capability approvals are wired.
6. Enable desktop approval UI and remove the feature flag for V1.

## Rollback Or Fallback

- Disable the cross-node dispatch feature flag and leave own-node scheduling active.
- Keep coordination-row expiry sweeps active during rollback so orphaned shared routing rows age out.
- Keep ApprovalRecord verification tools available; rollback must not delete already-written audit records.

## Risks And Blockers

- Clock skew beyond Spec-024's ±120s boundary can cause surprising rejections; Plan-020 NTP health checks must be visible before broad rollout.
- Desktop approval latency can exceed the default 60-second caller-token expiry if UI routing is slow; tests must cover expiry as normal behavior, not a rare error.
- Coordination rows may look authoritative to future implementers; contract docs and code comments must repeat that they are routing metadata only.
- Cross-node execution expands the trust boundary. Fail-open policy behavior, silent fallback, or missing deny persistence are release blockers.

## Done Checklist

- [ ] Code changes implemented.
- [ ] Tests added or updated.
- [ ] Verification completed.
- [ ] Related docs updated.
- [ ] Local SQLite `cross_node_dispatch_approvals` and Shared Postgres `cross_node_dispatch_coordination` schemas are present in canonical schema docs and migrations.
- [ ] Every Spec-024 acceptance criterion has a matching automated test or documented manual verification step.
