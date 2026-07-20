# Plan-027: Cross-Node Dispatch And Approval

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `027` |
| **Slug** | `cross-node-dispatch-and-approval` |
| **Date** | `2026-04-26` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-024: Cross-Node Dispatch And Approval](../specs/024-cross-node-dispatch-and-approval.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) |
| **Dependencies** | [Plan-003](./003-runtime-node-attach.md) (runtime-node roster and capability declarations), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (`dispatch.*` event taxonomy and JCS/BLAKE3 integrity primitives), [Plan-008](./008-control-plane-relay-and-session-join.md) (pairwise encrypted relay channel), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (Cedar policy and approval categories), [Plan-015](./015-persistence-recovery-and-replay.md) (local replay/recovery substrate), [Plan-016](./016-multi-agent-channels-and-orchestration.md) (Tier-6 T2.7 idle-reaper seam — Plan-027 registers `runHasPendingCrossNodeDispatch` into it at Tier 9; the §3 seam-fill edge, satisfied at Tier 6), [Plan-018](./018-identity-and-participant-state.md) (participant identity keys), [Plan-023](./023-desktop-shell-and-renderer.md) (target-owner approval UI), [Plan-025](./025-self-hostable-node-relay.md) (`packages/crypto-paseto/` and self-host relay deploy surface) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the V1 cross-node dispatch protocol so one participant's daemon can request execution on another participant's daemon only through verified caller identity, target-node-owner approval, dual-signed audit records, and bounded shared coordination metadata.

## Scope

This plan covers the caller-side dispatch client, target-side dispatch intake and approval service, coordination-row writes, local ApprovalRecord persistence, dispatch result delivery, replay-safe event emission, and approval UI integration for Spec-024.

## Non-Goals

- Cross-node shared artifact replication beyond the result payload of a single dispatch; that is V1 scope since the [ADR-015 amendment 2026-07-08](../decisions/015-v1-feature-scope-definition.md#amendment-2026-07-08-v11-deferred-features-3--2-cross-node-shared-artifacts-pulled-into-v1) but owned by Plan-014's relay legs ([Spec-014 §Cross-Node Artifact Relay](../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)), not this plan.
- MLS group-encrypted relay upgrade; V1 uses pairwise X25519 + XChaCha20-Poly1305 via Plan-008 / ADR-010.
- Long-lived delegated approval roles. V1 approval is target-node-owner scoped.
- Replacing own-node scheduling. Own-node execution stays on the Plan-004 / Plan-005 path.

## Preconditions

- [x] Paired spec is approved — re-checked 2026-07-18 by the campaign Task-28 / W1.5 batch spec re-promotion (supersedes the 2026-07-13 re-open note): Spec-024 returned to `approved`; its campaign amendment window closed.
- [x] Required ADRs are accepted.
- [x] Blocking open questions are resolved or explicitly deferred.
- [ ] Plan-003 has landed runtime-node attachment, roster, and capability declaration persistence.
- [ ] Plan-006 has registered all Spec-024 `dispatch.*` event types and exposed the shared JCS canonicalization helper.
- [ ] Plan-008 has landed the pairwise encrypted relay payload channel.
- [ ] Plan-012 has landed Cedar policy evaluation and approval category enforcement.
- [ ] Plan-016 has landed the T2.7 idle-reaper **consult-point scaffolding** — the injectable seam in its pre-gate constant-false posture, not yet consulting `runHasPendingCrossNodeDispatch(runId)` (Tier 6, campaign B15). The exemption leg that actually consults the predicate arms only after this plan's accessor lands (T2.7's own doc-gate), so the Tier-6 dependency is on the seam scaffolding, not on the consulting behavior — required by the liveness-registration task only, which is V1-dormant behind `orchestration.node_not_local`.
- [ ] Plan-018 has landed participant identity-key lookup and verification surfaces.
- [ ] Plan-023 has landed the desktop preload bridge and approval modal pattern.
- [ ] Plan-025 has landed `packages/crypto-paseto/` and the relay deploy surface needed for self-host tests.

## Target Areas

- `packages/contracts/src/cross-node-dispatch.ts` — new contract file exporting dispatch request, approval, result, and verification payload types.
- `packages/runtime-daemon/src/cross-node-dispatch/` — new daemon module for caller scheduler integration, target intake, replay guard, ApprovalRecord store, and result buffering.
- `packages/runtime-daemon/src/cross-node-dispatch/dispatch-liveness.ts` — caller-side pending-dispatch liveness accessor exporting `runHasPendingCrossNodeDispatch(runId)` over `cross_node_pending_dispatch`; consumed by [Plan-016](./016-multi-agent-channels-and-orchestration.md) T2.7's idle-reaper seam (campaign B17). Module renamed from the campaign design's session-scoped `sessionDispatchLiveness.ts` — the predicate is run-scoped and the daemon directory is kebab-cased.
- `packages/runtime-daemon/src/approvals/` — additive integration with Plan-012 approval request/resolution code; no ownership transfer.
- `packages/runtime-daemon/src/node/` — consumes Plan-003 capability declarations and node state.
- `packages/runtime-daemon/src/events/` — emits Plan-006 `dispatch.*` events through the existing event writer.
- `packages/control-plane/src/cross-node-dispatch/` — new control-plane coordination-row service and relay routing adapter.
- `packages/client-sdk/src/crossNodeDispatchClient.ts` — typed SDK wrapper for caller-side and audit-verification reads.
- `apps/desktop/src/renderer/src/cross-node-dispatch/` — target-owner approval surface added through the Plan-023 bridge.
- `docs/architecture/contracts/api-payload-contracts.md` — extended by this plan with typed request/response shapes.
- `docs/architecture/contracts/error-contracts.md` — extended by this plan with dispatch-specific rejection reasons.

## Data And Storage Changes

- Create Local SQLite `cross_node_dispatch_approvals` in both caller and target daemons. The table stores the dual-token ApprovalRecord envelope, decision state, token JTIs, request hash, expiry, and lifecycle timestamps. It never stores unredacted action payloads.
- Create Shared Postgres `cross_node_dispatch_coordination`. This row is routing metadata only: dispatch id, session id, caller participant, target participant, target node, status, and timestamps. It never stores dispatch payloads, ApprovalRecord envelopes, PASETO tokens, or action results.
- Create caller-daemon Local SQLite `cross_node_pending_dispatch` (campaign B17). This caller-local liveness record backs the run-idle exemption: it is written **before** the relay send (INSERT-before-relay-write ordering) so the initiating run stays correctly idle-protected across a crash anywhere in the send path — it backs the run-idle hard-skip, **not** a resend of the dispatch (the caller token and action payload are not retained here), so a dispatch lost before its relay send is bounded by `expires_at`, not silently resent; it carries `expires_at` (the `caller_token.exp` + 5-minute result-buffer clock bound — the unobserved-conclusion backstop, and part of the liveness predicate: `runHasPendingCrossNodeDispatch(runId)` holds only for an open row with `expires_at > now`) and the **originating `runId`**; and it is **closed in place** at conclusion (`closed_at` / `close_reason` stamped, never deleted at close), the terminal-observation event append and the row closure committing in one SQLite transaction (this atomicity scoped to observed-terminal closes; the `expiry_bound` sweep close and the immediate `send_failed` close of a synchronously-failed relay send append no event — no `dispatch.sent` had fired and Spec-006 registers no send-failure event, so the closed row is itself the durable record), so a restart rebuilds every open pending window from the rows alone and never resurrects a concluded window. Closed rows are pruned once `expires_at` elapses (= `caller_token.exp` + the Step 8 5-minute result-buffer window); no separate audit-retention window governs this liveness table — the durable audit trail is the `dispatch.result_observed` event. The `dispatch.sent` event stays base-payload per Plan-006 — it is the audit record, not the rebuild source. It stores routing/liveness metadata only, never dispatch payloads, ApprovalRecord envelopes, PASETO tokens, or results, and its migration ships in the single shared chain, so the table is created on every daemon but only the caller role writes/reads it (empty on daemons that never originate a dispatch) — differing from `cross_node_dispatch_approvals` by row-population, not presence: approvals rows exist on both the caller and target daemons of a dispatch, a pending-dispatch row only on the originating daemon. Schema, indexes, and retention in [Local SQLite Schema § Cross-Node Dispatch Tables (Plan-027)](../architecture/schemas/local-sqlite-schema.md#cross-node-dispatch-tables-plan-027).
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
2. Add the Local SQLite migrations — both ship in the single shared `applyMigrations` chain, so each table is created on every daemon — for `cross_node_dispatch_approvals` (rows written on both the caller and target daemons of a dispatch) and `cross_node_pending_dispatch` (rows written only on the originating caller daemon) plus the Shared Postgres migration for `cross_node_dispatch_coordination`; update schema snapshots and migration tests (a `cross_node_pending_dispatch` fresh-DB apply, its two partial indexes, the paired `closed_at` / `close_reason` CHECK, and the `close_reason` value enum).
3. Implement caller-side dispatch construction: own-node-first scheduler hook, capability target selection, `caller_token` issuance through `packages/crypto-paseto/`, JCS canonicalization, BLAKE3 `request_body_hash`, the `cross_node_pending_dispatch` intent-row write (before the relay send — INSERT-before-relay-write — carrying `expires_at` and the originating `runId`), relay send (on a synchronous send failure, close the intent row in place immediately with `close_reason = 'send_failed'` — the failure is caller-observed but precedes `dispatch.sent`, so no event is appended and the expiry sweep is the backstop only for a crash mid-send), and caller-side event emission.
4. Implement target-side intake: token verification against participant identity keys, body-binding verification, replay guard, capability check, Cedar request construction, and fail-closed rejection events.
5. Integrate with Plan-012 approval resolution so owner approval produces an `approver_token`, a dual-signed ApprovalRecord envelope, local persistence, and `dispatch.approved` / `dispatch.denied` events.
6. Implement target-side execution adapter that dispatches only to declared capability handlers, aborts on caller-token expiry, emits the exact Spec-024 lifecycle, and signs results.
7. Implement caller-side result verification, result observation events, and actionable failure surfaces for denied, rejected, expired, failed, and buffered dispatches; close each dispatch's `cross_node_pending_dispatch` window **in place** on the observed terminal — every observed terminal closes it, failure terminals included, each appending `dispatch.result_observed` with its `outcome` discriminator (`'completed' | 'failed' | 'expired' | 'rejected'`) per [Spec-006 § Cross-Node Dispatch](../specs/006-session-event-taxonomy-and-audit-log.md#cross-node-dispatch-cross_node_dispatch) (denials close via `dispatch.approval_observed`), the event append and the row closure **committing in one SQLite transaction** — this atomicity is scoped to terminal-_observation_ closes (`close_reason = 'observed_terminal'`), the only closes that append an event (a restart rebuilds from the rows alone, so a partial observation-close would either idle-protect a concluded dispatch to its expiry bound or destroy the recovery record before its audit event exists); the `expiry_bound` sweep close and the immediate `send_failed` close append nothing. The caller-local `expires_at` clock bound closes any unobserved window as the backstop. **Closing the window must leave the originating run a fresh idle window** (window-close re-arm), coordinated through the T2.7 seam contract: Spec-006's dispatch base payload carries no `runId` and the observation events add none, so absent an explicit re-arm the run-id-keyed T2.7 idle timer could reap the originating run on a delayed conclusion; this plan states the requirement as its half of the seam contract (authoring no Plan-016 symbols and not touching the Spec-006 payload), and the consumer-side re-arm plus its delayed-result test land with the campaign B15 bundle. Expose `runHasPendingCrossNodeDispatch(runId)` in `dispatch-liveness.ts` over the open, unexpired rows (`closed_at IS NULL AND expires_at > now`) for [Plan-016](./016-multi-agent-channels-and-orchestration.md) T2.7's idle-reaper seam.
8. Implement detached-caller result buffering on the target daemon with the `caller_token.exp + 5 minutes` delivery window.
9. Add desktop approval UI integration under `apps/desktop/src/renderer/src/cross-node-dispatch/`, routed only through the Plan-023 preload bridge.
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
- Pending-dispatch liveness tests proving `runHasPendingCrossNodeDispatch(runId)` holds only for the originating run while its `cross_node_pending_dispatch` row is open, every observed terminal (success and failure alike) closes the window in place, an unobserved terminal closes it at the `expires_at` clock bound, and a restart rebuilds open windows from the durable rows alone — never resurrecting a concluded window and never re-reading `dispatch.sent`.
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

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

**2026-07-19 — campaign B17 (pending-dispatch table + liveness predicate); Status `approved → review`.** Classified a **flip** under the Status Flip Rule (Codex round 2 on PR #223, confirmed by the team lead — supersedes the initial additive call): the bundle adds a durable table, mandatory INSERT-before-relay-write + atomic-closure plan-body behavior, and a new Plan-027→Plan-016 dependency — plan-body behavior + dependency changes, not additive. The campaign's W2.5 targeted re-audit restores `approved` (the B22/Plan-010 precedent). Landed: the caller-local `cross_node_pending_dispatch` table (§Data And Storage Changes; INSERT-before-relay-write, closed-in-place, caller-daemon only) with its `local-sqlite-schema.md` row and the cross-plan-dependencies §1 ownership entry; the `runHasPendingCrossNodeDispatch(runId)` accessor in `dispatch-liveness.ts` (§Target Areas and Implementation Steps step 7); and the P-3 Target-Areas path fix repointing the node-state consumer at Plan-003's real `src/node/` daemon directory (`src/node/node-registry.ts`; the design's stale directory name never existed — full before/after in the campaign design's P-3 row). **Module rename:** the campaign design coined `sessionDispatchLiveness.ts` under the superseded session-scoped design; renamed to `dispatch-liveness.ts` — the predicate is run-scoped (reconciled to Plan-016 T2.7's seam by campaign B7) and the daemon directory is kebab-cased (`node-registry.ts`, `control-lease.ts`, `driver-ask-normalizer.ts`); no consumer doc pinned the old name. **Shared idle-sweep seam:** Plan-016 T2.7's idle-reaper consults this cross-node dispatch predicate alongside [Plan-012](./012-approvals-permissions-and-trust-boundaries.md)'s run-level ask-expiry idle-exemption (campaign B13, authored there, lands later); the two are decoupled-but-coordinated and this bundle authors only the cross-node half — Plan-012's exemption is expiry-bounded, ending when the ask expires or resolves, so an expired ask never counts as pending blocking work. **Codex round 2 (PR #223) hardening:** the record's guarantee narrowed to idle-protection, not resend (no token / payload retained); the `expires_at > now` predicate bound, single-transaction terminal-close atomicity, and concrete `caller_token.exp` + 5-minute retention pinned; the `cross_node_pending_dispatch` migration added to Implementation Step 2; the Plan-027→Plan-016 edge propagated to the §3 diagram, the §5 Tier-9 cell, and this plan's header Dependencies + Preconditions; and the README / CLAUDE.md SQLite census re-derived 50 → 51.

**2026-07-20 — Codex round 3 (PR #223) hardening (5 findings, all corpus-verified).** (1) **Acyclicity wording** — the Plan-016 Precondition and the §3 row-2 sentence named the Tier-6 deliverable as a seam that _consults_ the predicate, reading as a Tier-6→Plan-027 cycle; reworded to name it T2.7's **consult-point scaffolding** (constant-false pre-gate posture, campaign B15), with the predicate-consulting exemption leg arming only after this plan's accessor lands (T2.7's own doc-gate). The design was already acyclic; this is wording only, no seam redesign. (2) **Relay-send-failure close** — a synchronous relay-send failure is caller-observed yet formerly held the row open to expiry (~10 min wrongful idle-protection); it now closes in place immediately under a new `close_reason = 'send_failed'` (CHECK enum + prose extended in `local-sqlite-schema.md`, Steps 3/7, and §Data). No `dispatch.sent` has fired and Spec-006 registers no send-failure event, so nothing is appended — the closed row is the durable record (Spec-006's unobserved-terminal-appends-nothing rule); the single-transaction atomicity rule is now explicitly scoped to terminal-_observation_ closes, and the expiry sweep stays the backstop for a crash mid-send. (3) **Migration reaches every daemon** — `applyMigrations` runs one unconditional chain, so "caller-daemon SQLite only" had no implementable selection rule; the table is created on every daemon and written/read only by the caller role (empty elsewhere). Retargeted the `cross_node_dispatch_approvals` contrast to row-population (approvals rows on both caller+target, pending rows only on the originating daemon) across the schema Migration line, Step 2, and §Data. (4) **README plan-status census** re-derived after this bundle's own flip — 20→19 `approved`, six→seven `review`, Plan-027 added to both list mirrors (§Build Order + §Project Status) with the flip annotation. Table census unchanged (still 51 — this round adds no table). (5) **Window-close re-arm** — Spec-006's dispatch payload carries no `runId` and the observation events add none, so T2.7's run-id-keyed idle timer could reap the originating run on a delayed conclusion; Step 7 and §3 row-2 now state, as this plan's half of the seam contract, that closing the window MUST leave the originating run a fresh idle window — the consumer-side re-arm and delayed-result test land with campaign B15, authoring no Plan-016 symbols and not touching the Spec-006 payload.

## Done Checklist

- [ ] Code changes implemented.
- [ ] Tests added or updated.
- [ ] Verification completed.
- [ ] Related docs updated.
- [ ] Local SQLite `cross_node_dispatch_approvals` + `cross_node_pending_dispatch` and Shared Postgres `cross_node_dispatch_coordination` schemas are present in canonical schema docs and migrations.
- [ ] Every Spec-024 acceptance criterion has a matching automated test or documented manual verification step.
