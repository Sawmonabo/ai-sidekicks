# Plan-024: Cross-Node Dispatch And Approval

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `024` |
| **Slug** | `cross-node-dispatch-and-approval` |
| **Date** | `2026-04-26` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-022: Cross-Node Dispatch And Approval](../specs/022-cross-node-dispatch-and-approval.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-007](../decisions/007-device-trust-and-permission-model.md), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) |
| **Dependencies** | [Plan-002](./002-runtime-node-attach.md) (runtime-node roster and capability declarations), [Plan-005](./005-session-event-taxonomy-and-audit-log.md) (`dispatch.*` event taxonomy and JCS/BLAKE3 integrity primitives), [Plan-028](./028-remote-control.md) (pairwise encrypted relay channel and the self-host relay deploy surface), [Plan-010](./010-approvals-permissions-and-trust-boundaries.md) (Cedar policy and approval categories), [Plan-013](./013-persistence-recovery-and-replay.md) (local replay/recovery substrate), [Plan-014](./014-multi-agent-channels-and-orchestration.md) (the T2.7 idle-reaper seam — Plan-024 registers `runHasPendingCrossNodeDispatch` into it; the seam-fill edge, satisfied once Plan-014 lands), [Plan-016](./016-identity-and-user-state.md) (user identity keys), [Plan-021](./021-desktop-shell-and-renderer.md) (target-owner approval UI) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Implement the V1 cross-node dispatch protocol so one of the user's daemons can request execution on a daemon running on another of the user's machines only through verified caller identity, target-node-owner approval, dual-signed audit records, and bounded shared coordination metadata.

## Scope

This plan covers the caller-side dispatch client, target-side dispatch intake and approval service, coordination-row writes, local ApprovalRecord persistence, dispatch result delivery, replay-safe event emission, and approval UI integration for Spec-022.

## Non-Goals

- Cross-node shared artifact replication beyond the result payload of a single dispatch; that is V1 scope, owned by Plan-012's relay legs ([Spec-012 §Cross-Node Artifact Relay](../specs/012-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)), not this plan.
- MLS group-encrypted relay upgrade; V1 uses pairwise X25519 + XChaCha20-Poly1305 via Plan-028 / ADR-010.
- Long-lived delegated approval roles. V1 approval is target-node-owner scoped.
- Replacing own-node scheduling. Own-node execution stays on the Plan-003 / Plan-004 path.

## Preconditions

- [x] Paired spec is approved.
- [x] ADR-004 (SQLite local state / Postgres control plane) is accepted — the two-store split this plan's `cross_node_dispatch_approvals` + `cross_node_pending_dispatch` (local) vs `cross_node_dispatch_coordination` (shared, routing-only) tables implement.
- [x] ADR-007 is accepted — the principle that reaching a node does not imply the right to execute on it, which this plan's target-owner approval gate enforces.
- [x] ADR-010 (PASETO + WebAuthn + MLS Auth) is accepted — `v4.public` signing for `caller_token` / `approver_token` and the V1 pairwise-encrypted relay this plan rides. Note: [ADR-010 §Decision](../decisions/010-paseto-webauthn-mls-auth.md#decision) item 2 enumerates the two control-plane token classes; this plan's dispatch-scoped user-signed `v4.public` token (~60 s, `req_hash`, `aud = target_node_id`, `cnf.jkt`) is a third, session-local class specified in [Spec-022 §Cross-Node Dispatch Request](../specs/022-cross-node-dispatch-and-approval.md#cross-node-dispatch-request), not a control-plane token.
- [x] ADR-012 (Cedar Approval Policy Engine) is accepted — the policy engine this plan's target-side evaluation (Step 4) and fail-closed posture use.
- [x] ADR-015 (V1 Feature Scope Definition) is accepted — cross-node shared artifacts are V1 under Plan-012's ownership (§Non-Goals).
- [x] ADR-017 (Shared Event-Sourcing Scope) is accepted — Option B per-daemon local logs; shared Postgres holds coordination records only.
- [x] Blocking open questions are resolved or explicitly deferred.
- [ ] Plan-002 has landed runtime-node attachment, roster, and capability declaration persistence.
- [x] Plan-005 has registered all Spec-022 `dispatch.*` event types and exposed the shared JCS canonicalization helper — both legs are shipped: the `cross_node_dispatch` category and its `dispatch.*` types landed with Plan-005 Phase 1, and `packages/runtime-daemon/src/events/canonicalizer.ts` with Plan-005 Phase 2. The helper carries **three refusals, of which exactly two bind this plan** — the two below, which differ in kind — per [Plan-005 CP-005-3](./005-session-event-taxonomy-and-audit-log.md#cross-plan-obligations): (i) the **policy ceiling** — `canonicalizeJson` refuses any value nesting containers past `CANONICAL_JSON_MAX_DEPTH` (64 as Plan-005 T2.1 ships it, module-local to `canonicalizer.ts` and not an exported symbol — so this plan cannot read the bound at compile time), a stack-overflow guard on the entry point where untrusted dispatch bodies arrive; an `action_payload` sits at depth 2 inside a dispatch body, leaving 62 levels. (ii) the **RFC-mandated refusal** — `canonicalizeJson` refuses any string value or property name carrying an unpaired UTF-16 surrogate, RFC 8785 §3.2.2.2 making termination on such data a normative MUST that the pinned `canonicalize@3.0.0` does not honor on its own. (i) is checked first, so a body defective both ways reports the over-deep refusal and never the ill-formed one — a fixture built to exercise the second path must be well-nested. **The THIRD refusal binds nothing here, and the two counts must not be conflated.** Plan-005 T2.1's `assertNoToJsonOverride` refuses any value carrying a callable `toJSON` at any depth, enforcing the DETERMINISM the integrity protocol assumes rather than a policy ceiling or an RFC MUST — a third KIND. It is unsatisfiable on this plan's intake: Spec-022 bodies reach `canonicalizeJson` through `JSON.parse`, whose output can carry no function-valued member (a wire `{"toJSON":"x"}` parses to a STRING), so the refusal is unreachable from a parsed body. **This plan therefore owes NO third rejection reason** and the reciprocal obligations below stay at THREE. The one case outside that argument is a body this plan CONSTRUCTS rather than parses, which would meet a live refusal — and this plan has such a path: Step 3's caller-side construction JCS-canonicalizes a body it builds in process to derive the BLAKE3 `request_body_hash`, never having parsed it. No such value can reach the canonicalizer there, by type-level construction rather than by bypass: T1.1 declares `created_at` / `expires_at` as ISO-8601 strings and never `z.date()`, and requires `action_payload` to arrive already parsed rather than as a host object graph, with `assertNoToJsonOverride` asserting on the validated object immediately before `canonicalizeJson`. No third rejection reason is owed and the reciprocal count below stands at three. Three reciprocal obligations land on this plan: (1) the dispatch intake path MUST catch the depth refusal (a plain throw at Plan-005 T2.1) and map it to a **registered rejection reason** for an over-deep `action_payload`, never surfacing the raw throw to a remote caller; (2) it MUST likewise catch the well-formedness refusal (also a plain throw there) and map it to a **distinct** registered rejection reason, for an ill-formed `action_payload`, the pair registered as `dispatch.payload_too_deep` and `dispatch.payload_ill_formed` in [`error-contracts.md` §Cross-Node Dispatch](../architecture/contracts/error-contracts.md#cross-node-dispatch) and appended to the `dispatch.rejected` reason enumeration in [Spec-005 §Cross-Node Dispatch](../specs/005-session-event-taxonomy-and-audit-log.md#cross-node-dispatch-cross_node_dispatch) — (1) and (2) MUST NOT collapse into one reason, an over-deep payload and an ill-formed one being different client errors whose merger destroys the diagnostic; and (3) renegotiation of the **depth ceiling ONLY** — a ceiling that proves too tight for a real capability payload is **renegotiated with Plan-005 T2.1**, raising the constant being a two-way door, and forking the canonicalizer to escape it is the CP-005-3 violation the obligation exists to prevent. **(3) does not extend to (ii).** The well-formedness refusal is an RFC 8785 §3.2.2.2 normative MUST-terminate — neither renegotiable nor raisable, in either direction — so catch-and-map per (2) is this plan's only available response there.
- [ ] Plan-028 Phase 3 has landed the pairwise encrypted relay payload channel.
- [ ] Plan-010 has landed Cedar policy evaluation and approval category enforcement.
- [ ] Plan-013 has landed the local replay/recovery substrate and its single writer worker, on which this plan's restart-rebuild of open `cross_node_pending_dispatch` windows depends.
- [ ] Plan-014 has landed the T2.7 idle-reaper **consult-point scaffolding** — the injectable seam in its pre-gate constant-false posture, not yet consulting `runHasPendingCrossNodeDispatch(runId)`. The exemption leg that actually consults the predicate arms only after this plan's accessor lands (T2.7's own doc-gate), so the Plan-014 dependency is on the seam scaffolding, not on the consulting behavior — required by this plan's registration step (Step 8) only. That step ships live code; it is the cross-node consumer path it feeds that is V1-dormant behind `orchestration.node_not_local`. **Scoped to what Plan-014 declares:** its T2.7 (`packages/runtime-daemon/src/orchestration/idle-sweep.ts`) names `runHasPendingCrossNodeDispatch(runId)`, the constant-false pre-gate, the registration seam on T2.7's `Provides:` line, and the exemption-end re-arm contract. This box depends on the scaffolding, not on the seam's consulting behavior.
- [ ] Plan-016 has landed the user roster read path this plan uses to retrieve a caller's long-term public key ([Spec-022 §Target-Side Authentication And Cedar Evaluation](../specs/022-cross-node-dispatch-and-approval.md#target-side-authentication-and-cedar-evaluation) step 1). Plan-016 names no Plan-024-facing verification symbol — signature verification is performed by **this** plan over the key that read path returns; the roster-read registration is [Plan-016 CP-016-13](./016-identity-and-user-state.md#cross-plan-obligations), and the key-material read affordance is authored at Plan-016 T5.1/T5.3/T5.8 (the `user_identity_keys` store, the `UserIdentityKeyRoster` read and the daemon gateway responder); this box gates on that code landing, and rows populate only after Plan-016's client-side presenter carrier box clears. The target-local freshness cache and the `user_roster_stale` refusal ([Spec-022 §Fallback Behavior](../specs/022-cross-node-dispatch-and-approval.md#fallback-behavior)) stay this plan's to author — including that refusal code's `error-contracts.md` registration, which no corpus surface carries yet.
- [ ] Plan-021 has landed the desktop preload bridge. The target-owner approval modal is authored by **this** plan under `apps/desktop/src/renderer/src/cross-node-dispatch/` — a Plan-024-owned renderer subtree per §Target Areas — and is routed only through that bridge; Plan-021 declares no approval-modal component, so no modal pattern is owed by it.
- [ ] Plan-028 Phase 8 has landed the relay deploy surface needed for self-host tests.

## Target Areas

- `packages/contracts/src/cross-node-dispatch.ts` — new contract file exporting dispatch request, approval, result, and verification payload types.
- `packages/runtime-daemon/src/cross-node-dispatch/` — new daemon module for caller scheduler integration, target intake, replay guard, ApprovalRecord store, and result buffering.
- `packages/runtime-daemon/src/cross-node-dispatch/dispatch-liveness.ts` — caller-side pending-dispatch liveness accessor exporting `runHasPendingCrossNodeDispatch(runId)` over `cross_node_pending_dispatch`; consumed by [Plan-014](./014-multi-agent-channels-and-orchestration.md) T2.7's idle-reaper seam.
- `packages/runtime-daemon/src/approvals/` — additive integration with Plan-010 approval request/resolution code; no ownership transfer.
- `packages/runtime-daemon/src/node/` — consumes Plan-002 capability declarations and node state.
- `packages/runtime-daemon/src/events/` — emits Plan-005 `dispatch.*` events through the existing event writer.
- `packages/control-plane/src/cross-node-dispatch/` — new control-plane coordination-row service and relay routing adapter.
- `packages/client-sdk/src/crossNodeDispatchClient.ts` — typed SDK wrapper for caller-side and audit-verification reads.
- `apps/desktop/src/renderer/src/cross-node-dispatch/` — target-owner approval surface added through the Plan-021 bridge.
- `docs/architecture/contracts/api-payload-contracts.md` — extended by this plan with typed request/response shapes.
- `docs/architecture/contracts/error-contracts.md` — extended by this plan with dispatch-specific rejection reasons.

## Invariants

Load-bearing constraints every Plan-024 PR — and every downstream extension — must preserve. Weakening or removing one is a change agreed with the counterpart plans, not a local edit. Each entry names the governing clause it grounds in, or declares itself plan-owned.

- **I-024-1 — Cedar's `principal` binds exclusively to a cryptographically verified `caller_token.sub`.** No untrusted request field ever reaches Cedar as the principal, and no request-supplied identity claim is consulted at any point of the evaluation. **Grounds in.** [Spec-022 §Pitfalls To Avoid](../specs/022-cross-node-dispatch-and-approval.md#pitfalls-to-avoid) (deriving the principal from an unverified field is named as prohibited) and [Spec-022 §Target-Side Authentication And Cedar Evaluation](../specs/022-cross-node-dispatch-and-approval.md#target-side-authentication-and-cedar-evaluation), whose ordered steps make signature verification strictly precede evaluation. **Why load-bearing.** Cross-node dispatch is the one V1 path where a remote party supplies the request body wholesale; a principal read from that body converts every policy in the Cedar store into an attacker-chosen identity assertion, and the failure is silent because the policy engine returns a well-formed allow. **Verification.** T2.1.
- **I-024-2 — Intake runs its five steps strictly in order, and any failure rejects with a specific named reason.** A failure at any step emits `dispatch.rejected` carrying the reason that names which step failed; steps 1-4 (token, body binding, replay, capability) reject **synchronously in the `DispatchReceive` ack** and never emit `dispatch.received`, while a step-5 Cedar failure lands post-receipt and is relayed as a `DispatchTerminalNotice`. **Grounds in.** [Spec-022 §Target-Side Authentication And Cedar Evaluation](../specs/022-cross-node-dispatch-and-approval.md#target-side-authentication-and-cedar-evaluation) and [Spec-022 §Interfaces And Contracts](../specs/022-cross-node-dispatch-and-approval.md#interfaces-and-contracts). **Why load-bearing.** The ordering is what makes each rejection reason diagnostic rather than decorative — a capability check run before signature verification would report "undeclared capability" for a forged request, and a `dispatch.received` emitted before intake passed would make the audit log claim a validation that never happened. **Verification.** T2.1.
- **I-024-3 — `caller_token` and `approver_token` carry distinct `jti`, and the binding rides `approver_token.bound_jti` → `caller_token.jti`.** The two tokens are never the same token, and their association is never inferred from token identity, subject equality, or timing. **Grounds in.** [Spec-022 §Pitfalls To Avoid](../specs/022-cross-node-dispatch-and-approval.md#pitfalls-to-avoid). **Why load-bearing.** The dual signature is the whole audit value of the record; collapsing the two identities makes an ApprovalRecord unverifiable as evidence that two distinct parties acted, which is the one claim it exists to support. **Verification.** T4.1.
- **I-024-4 — The `approver_token` carries `req_hash` equal to the caller's.** An approver signature therefore commits to one specific request body and cannot be replayed against a substituted one. **Grounds in.** [Spec-022 §Pitfalls To Avoid](../specs/022-cross-node-dispatch-and-approval.md#pitfalls-to-avoid) and [Spec-022 §Dual-Signed ApprovalRecord](../specs/022-cross-node-dispatch-and-approval.md#dual-signed-approvalrecord). **Why load-bearing.** Without the shared hash, an approval is a signature over "yes" rather than over "yes, to this"; the substitution is invisible to every later verifier because both signatures still check out. **Verification.** T4.1, T6.3.
- **I-024-5 — Execution is bounded by `caller_token.exp` regardless of approver-token expiry.** Work still running at that deadline is aborted and `dispatch.expired` emitted; a longer-lived approver token never extends the execution window. **Grounds in.** [Spec-022 §Pitfalls To Avoid](../specs/022-cross-node-dispatch-and-approval.md#pitfalls-to-avoid) and [Spec-022 §Execution And Result Emission](../specs/022-cross-node-dispatch-and-approval.md#execution-and-result-emission). **Why load-bearing.** The caller's expiry is the only bound the caller controls; letting the approver's token govern hands the execution window to the party being asked for permission, and expiry then becomes a rare error rather than the normal termination path the tests must cover. **Verification.** T4.2, T6.1.
- **I-024-6 — A signed `deny` record is retained with the same guarantees as a signed allow.** A deny is never treated as absent, never garbage-collected ahead of an allow, and never inferred from the absence of an approval row. **Grounds in.** [Spec-022 §Pitfalls To Avoid](../specs/022-cross-node-dispatch-and-approval.md#pitfalls-to-avoid), which names "treating a deny as absent" as prohibited. **Why load-bearing.** Refusals are the audit trail's load-bearing half — a system that durably records only its approvals cannot distinguish "never asked" from "asked and refused", which is precisely the distinction an approval gate exists to create. **Verification.** T4.1, T6.3.
- **I-024-7 — The shared-Postgres `cross_node_dispatch_coordination` row is routing metadata only.** It is never consulted for approval semantics or dispatch content, and never carries payloads, ApprovalRecord envelopes, PASETO tokens, or results. Its five-valued `status` enum is deliberately coarser than the event lifecycle's five terminals. **Grounds in.** [Spec-022 §Pitfalls To Avoid](../specs/022-cross-node-dispatch-and-approval.md#pitfalls-to-avoid) and [Spec-022 §State And Data Implications](../specs/022-cross-node-dispatch-and-approval.md#state-and-data-implications) ("a routing aid, not a truth source"). **Why load-bearing.** A shared row that looks authoritative will eventually be read as authoritative; the moment approval semantics are decided from it, the trust boundary [ADR-017](../decisions/017-shared-event-sourcing-scope.md) draws around per-daemon local logs is gone, and the control plane becomes able to grant execution it never signed for. **Verification.** T1.2.
- **I-024-8 — The scheduler routes own-node-first and never silently falls back from a named cross-node target.** A dispatch naming a target user either reaches that user's node or fails visibly to the caller; it is never rerouted to a third user. **Grounds in.** [Spec-022 §Scheduler Dispatch Rules](../specs/022-cross-node-dispatch-and-approval.md#scheduler-dispatch-rules) and [Spec-022 §Pitfalls To Avoid](../specs/022-cross-node-dispatch-and-approval.md#pitfalls-to-avoid). **Why load-bearing.** Silent fallback executes a caller's action on a machine whose owner never approved it and whose capability set the caller never inspected — a trust-boundary crossing disguised as a scheduling optimization. **Verification.** T3.1.
- **I-024-9 — A runtime node never accepts a dispatch for a capability it has not declared, and the rejection precedes any approval request.** Dangerous capability classes additionally require a session-owner-signed capability approval before the target-owner gate is reached at all. **Grounds in.** [Spec-022 §Capability Declaration And Session-Owner Gating](../specs/022-cross-node-dispatch-and-approval.md#capability-declaration-and-session-owner-gating). **Why load-bearing.** Surfacing an approval prompt for an undeclared capability trains the node owner to approve things the node cannot describe, converting the human gate into a rubber stamp — so the ordering, not just the check, is the invariant. **Verification.** T2.1, T4.2.
- **I-024-10 — Policy-engine failure fails closed.** An unavailable or erroring Cedar evaluation rejects the dispatch with `policy_engine_error` and raises an ops alert; a dispatch never proceeds because policy could not be evaluated. **Grounds in.** [Spec-022 §Fallback Behavior](../specs/022-cross-node-dispatch-and-approval.md#fallback-behavior). **Why load-bearing.** Fail-open on a policy outage is indistinguishable in the log from a genuine allow, so the outage window becomes an unauditable grant of every capability the node declares. **Verification.** T2.1.
- **I-024-11 — The `cross_node_pending_dispatch` row is INSERTed before the relay send and closed in place, never deleted at close.** An observed-terminal close commits the event append and the row closure in **one** SQLite transaction; a restart rebuilds every open window from the rows alone and never resurrects a concluded one. **Grounds in.** This plan's §Data And Storage Changes and Implementation Steps 3 and 7 (plan-owned), resting on [Spec-022 §State And Data Implications](../specs/022-cross-node-dispatch-and-approval.md#state-and-data-implications). **Why load-bearing.** The row is the only crash-durable record of an in-flight dispatch; inserting after the send loses the window on a crash mid-send, and deleting at close makes a late terminal indistinguishable from a never-sent one. The single transaction is what prevents a restart from either idle-protecting a concluded dispatch to its expiry bound or destroying the recovery record before its audit event exists. **Verification.** T1.2, T3.1, T5.1.
- **I-024-12 — Ending a run's dispatch idle-exemption always leaves the originating run a fresh idle window.** The guarantee keys on exemption **end**, not row close: when `expires_at` lapses on a still-open row the predicate flips false at the deadline while the `expiry_bound` close only follows on the next sweep, so the sweep's first encounter with an overdue open row re-arms the run rather than reaping it. **Grounds in.** [Spec-022 §Cross-Node Failure Semantics](../specs/022-cross-node-dispatch-and-approval.md#cross-node-failure-semantics) and this plan's Implementation Steps 7-8 — this plan's half of the Plan-014 T2.7 seam contract (CP-024-3). **Why load-bearing.** Spec-005's dispatch base payload carries no `runId` and the observation events add none, so without an explicit re-arm the run-id-keyed idle timer can reap the originating run on a delayed conclusion or an expiry lapse — the run is killed for being idle during the exact interval it was blocked on remote work. **Verification.** T5.1, T5.2.
- **I-024-13 — The canonicalizer's two payload refusals map to two distinct registered rejection reasons and never collapse.** `dispatch.payload_too_deep` (the `CANONICAL_JSON_MAX_DEPTH` policy ceiling) and `dispatch.payload_ill_formed` (the RFC 8785 §3.2.2.2 unpaired-surrogate MUST-terminate) are separate codes, and no raw canonicalizer throw ever reaches a remote caller. **Grounds in.** [Plan-005 CP-005-3](./005-session-event-taxonomy-and-audit-log.md#cross-plan-obligations), whose obligations (1) and (2) state the requirement in MUST strength, met by [`error-contracts.md` §Cross-Node Dispatch](../architecture/contracts/error-contracts.md#cross-node-dispatch). **Why load-bearing.** Merging the two destroys the diagnostic a remote caller needs to fix its own payload — the depth ceiling is renegotiable with Plan-005 T2.1 while the well-formedness refusal is an RFC MUST that is not, so a caller told only "payload rejected" cannot tell an actionable bug from a policy limit. Surfacing the raw throw instead leaks the canonicalizer's internals across the trust boundary. **Verification.** T1.1, T2.1, T6.4.

## Cross-Plan Obligations

See Cross-Plan Dependency Graph for the graph-level view.

- **CP-024-2 — CP-010-1 return-cite: the 9-category approval enum and `ApprovalRequestId` come from Plan-010.** [Plan-010 CP-010-1](./010-approvals-permissions-and-trust-boundaries.md#cross-plan-obligations) provides the canonical 9-category enum from `approval.ts` and the `ApprovalRequestId` branded id. This plan's Cedar principal-action mapping and Spec-022 dispatch envelopes import both rather than redeclaring them; the cross-node hop is always the `tool_execution` category per [Spec-022 §Scheduler Dispatch Rules](../specs/022-cross-node-dispatch-and-approval.md#scheduler-dispatch-rules). **Direction:** Consume from [Plan-010](./010-approvals-permissions-and-trust-boundaries.md) (its T1.1). **Tasks:** T1.1, T4.1.
- **CP-024-3 — `runHasPendingCrossNodeDispatch(runId)` provided to Plan-014 T2.7.** This plan's `dispatch-liveness.ts` exports the run-scoped predicate over `cross_node_pending_dispatch` (`closed_at IS NULL AND expires_at > now`) and registers it into T2.7's consult point via the injection seam that phase publishes, authoring no Plan-014 internals. The exemption-end re-arm guarantee (I-024-12) is this plan's half of the seam contract. **Direction:** Provide to [Plan-014](./014-multi-agent-channels-and-orchestration.md) (its T2.7). **Tasks:** T5.1, T5.2.

## Data And Storage Changes

- Create Local SQLite `cross_node_dispatch_approvals` in both caller and target daemons. The table stores the dual-token ApprovalRecord envelope, decision state, token JTIs, request hash, expiry, and lifecycle timestamps. It never stores unredacted action payloads.
- Create Shared Postgres `cross_node_dispatch_coordination`. This row is routing metadata only: dispatch id, session id, caller user, target user, target node, `status`, and timestamps. `status` is the five-valued enum [Spec-022 §State And Data Implications](../specs/022-cross-node-dispatch-and-approval.md#state-and-data-implications) fixes — `requested` / `approved` / `denied` / `executed` / `expired` — and the enum is deliberately coarser than the five-terminal event lifecycle (`rejected`, `failed`, and `completed` have no coordination status): it is routing state, never approval semantics (I-024-7). It never stores dispatch payloads, ApprovalRecord envelopes, PASETO tokens, or action results.
- Create caller-daemon Local SQLite `cross_node_pending_dispatch`. This caller-local liveness record backs the run-idle exemption: it is written **before** the relay send (INSERT-before-relay-write ordering) so the initiating run stays correctly idle-protected across a crash anywhere in the send path, and on send success a caller-local outbox stamps `sent_at` and appends `dispatch.sent` in one transaction (row marker and audit event all-or-nothing) — it backs the run-idle hard-skip, **not** a resend of the dispatch (the caller token and action payload are not retained here), so a dispatch lost before its relay send is bounded by `expires_at`, not silently resent; it carries `expires_at` (the `caller_token.exp` + 5-minute result-buffer clock bound — the unobserved-conclusion backstop, and part of the liveness predicate: `runHasPendingCrossNodeDispatch(runId)` holds only for an open row with `expires_at > now`) and the **originating `runId`**; and it is **closed in place** at conclusion (`closed_at` / `close_reason` stamped, never deleted at close), the terminal-observation event append and the row closure committing in one SQLite transaction (this atomicity scoped to observed-terminal closes; the `expiry_bound` sweep close and the immediate `send_failed` close of a synchronously-failed relay send append no event — no `dispatch.sent` had fired and Spec-005 registers no send-failure event, so the closed row is itself the durable record), so a restart rebuilds every open pending window from the rows alone and never resurrects a concluded window. A verified terminal observed after the row already closed (any `close_reason`) or was pruned appends its event **idempotently, event-only** — no row mutation, no reopen, no re-arm, deduped per `dispatch_id`, bounded to one expiry-sweep interval past `expires_at` (a later arrival is rejected out-of-window, no append) — so a late result or denial still lands its durable audit event without violating closed-in-place; if no `dispatch.sent` was recorded for it (`sent_at` NULL) the proven delivery appends a late-repaired `dispatch.sent` first ([Spec-022 § Cross-Node Failure Semantics](../specs/022-cross-node-dispatch-and-approval.md#cross-node-failure-semantics)). Closed rows are pruned once `expires_at` elapses (= `caller_token.exp` + the Step 9 5-minute result-buffer window); no separate audit-retention window governs this liveness table — the durable audit trail is the `dispatch.result_observed` event. The `dispatch.sent` event stays base-payload per Plan-005 — it is the audit record, not the rebuild source. It stores routing/liveness metadata only, never dispatch payloads, ApprovalRecord envelopes, PASETO tokens, or results, and its migration ships in the single shared chain, so the table is created on every daemon but only the caller role writes/reads it (empty on daemons that never originate a dispatch) — differing from `cross_node_dispatch_approvals` by row-population, not presence: approvals rows exist on both the caller and target daemons of a dispatch, a pending-dispatch row only on the originating daemon. Schema, indexes, and retention in [Local SQLite Schema § Cross-Node Dispatch Tables (Plan-024)](../architecture/schemas/local-sqlite-schema.md#cross-node-dispatch-tables-plan-024).
- Use a target-local replay guard keyed by `(session_id, dispatch_id)` with retention at least 10 minutes. The guard may be in-memory backed by a short-lived local cache; it is not a shared truth source.
- Append dispatch lifecycle events to each daemon's local `session_events` log per ADR-017. Shared Postgres does not own dispatch event payloads.
- Add purge/retention handling so expired denied/failed approval records remain available for audit while raw transient result buffers are bounded by `caller_token.exp + 5 minutes`.

## API And Transport Changes

- Add `DispatchRequest` and `DispatchReceive` contracts exactly matching Spec-022's token-binding and request-body-hash requirements.
- Add `DispatchApprovalRequest` and `DispatchApprovalResolve` contracts for target-owner UI and Cedar approval integration.
- Add `DispatchResult` contract with target-side result signature and caller-side verification metadata.
- Add `ApprovalRecordVerify` helper surface for audit tools and replay verification.
- Add relay envelope routing for caller-to-target dispatch and target-to-caller result delivery over the Plan-028 pairwise encrypted payload channel.
- Add control-plane coordination operations for insert, status update, expiry sweep, and target-node lookup.

## Implementation Steps

1. Define the `cross-node-dispatch.ts` contract module with branded IDs, discriminated lifecycle states, JCS-hash helpers, Zod schemas, and error-code enums.
2. Add the Local SQLite migrations — both ship in the single shared `applyMigrations` chain, so each table is created on every daemon — for `cross_node_dispatch_approvals` (rows written on both the caller and target daemons of a dispatch) and `cross_node_pending_dispatch` (rows written only on the originating caller daemon) plus the Shared Postgres migration for `cross_node_dispatch_coordination`; update schema snapshots and migration tests (a `cross_node_pending_dispatch` fresh-DB apply, its two partial indexes, the paired `closed_at` / `close_reason` CHECK, and the `close_reason` value enum).
3. Implement caller-side dispatch construction: own-node-first scheduler hook, capability target selection, `caller_token` issuance through `packages/crypto-paseto/`, JCS canonicalization, BLAKE3 `request_body_hash`, the `cross_node_pending_dispatch` intent-row write (before the relay send — INSERT-before-relay-write — carrying `expires_at` and the originating `runId`), relay send (on a synchronous send failure, close the intent row in place immediately with `close_reason = 'send_failed'` — the failure is caller-observed but precedes `dispatch.sent`, so no event is appended and the expiry sweep is the backstop only for a crash mid-send), and — on send success — the **caller-local outbox commit**: one local SQLite transaction stamps `sent_at` and appends `dispatch.sent` together, so the row marker and its audit event are all-or-nothing (a crash before the transaction leaves neither, after leaves both — never a half state showing delivery without the event, or the event without the marker).
4. Implement target-side intake: token verification against user identity keys, body-binding verification, replay guard, capability check, Cedar request construction, and fail-closed rejection events.
5. Integrate with Plan-010 approval resolution so owner approval produces an `approver_token`, a dual-signed ApprovalRecord envelope, local persistence, and `dispatch.approved` / `dispatch.denied` events.
6. Implement target-side execution adapter that dispatches only to declared capability handlers, aborts on caller-token expiry, emits the exact Spec-022 lifecycle, and signs results.
7. Implement caller-side result verification, result observation events, and actionable failure surfaces for denied, rejected, expired, failed, and buffered dispatches; close each dispatch's `cross_node_pending_dispatch` window **in place** when a terminal is observed while the row is still open — every terminal type does so, failure terminals included, each appending `dispatch.result_observed` with its `outcome` discriminator (`'completed' | 'failed' | 'expired' | 'rejected'`) per [Spec-005 § Cross-Node Dispatch](../specs/005-session-event-taxonomy-and-audit-log.md#cross-node-dispatch-cross_node_dispatch) (denials close via `dispatch.approval_observed`), the event append and the row closure **committing in one SQLite transaction** — this `observed_terminal` close is the only close that appends an event (a restart rebuilds from the rows alone, so a partial observation-close would either idle-protect a concluded dispatch to its expiry bound or destroy the recovery record before its audit event exists); the `expiry_bound` sweep close and the immediate `send_failed` close append nothing. A verified terminal observed **after** the row already closed (**any** `close_reason`, including an ambiguous `send_failed` whose frame in fact reached the target) or was pruned — the target's buffered-delivery bound equals the caller's `expires_at`, so skew or delivery latency can straddle the edge — instead appends its event **idempotently, event-only**: no row mutation, no reopen, no second close, no re-arm (the earlier close or the expiry lapse already re-armed the run), deduped per `dispatch_id` against the prior event (an `observed_terminal` row implies the event exists; post-prune the event log is the dedupe source). Event-only acceptance is **bounded to one expiry-sweep interval past `expires_at`**: beyond it a verified terminal is rejected **out-of-window** with a diagnostic and appends nothing (the target's buffered-delivery bound already ends at `expires_at`, so this rejects only replays or anomalies, never a legitimate delivery), and within it the event log still retains full `dispatch_id` payloads — Spec-005's compaction thresholds (50,000 events / 500 MB / 90 days, [Spec-005 § Event Compaction Policy](../specs/005-session-event-taxonomy-and-audit-log.md#event-compaction-policy)) sit orders of magnitude past it, so the dedupe source is provably sufficient with no Spec-005 change. If no `dispatch.sent` was ever recorded (`sent_at` NULL, or post-prune absent from the log), the verified observation **proves delivery**: the same transaction appends a late-repaired `dispatch.sent` immediately before the observation event — never fabricated on the no-result path, where delivery stays unknown. Per [Spec-022 § Cross-Node Failure Semantics](../specs/022-cross-node-dispatch-and-approval.md#cross-node-failure-semantics). The restart-rebuild invariant is untouched. The caller-local `expires_at` clock bound closes any unobserved window as the backstop. **Ending the run's dispatch idle-exemption must leave the originating run a fresh idle window** (exemption-end re-arm), coordinated through the T2.7 seam contract — the guarantee keys on exemption **end**, not row close: for an observed-terminal close the two coincide, but when `expires_at` lapses on a still-open row the predicate flips false at the deadline while the `expiry_bound` close only follows on the next sweep, so the sweep's first encounter with an overdue open row re-arms the run rather than reaping it (equivalently, expiry closure + re-arm precede any reap visibility). Spec-005's dispatch base payload carries no `runId` and the observation events add none, so absent an explicit re-arm the run-id-keyed T2.7 idle timer could reap the originating run on a delayed conclusion or an expiry lapse; this plan states the requirement as its half of the seam contract, authoring no Plan-014 symbols and not touching the Spec-005 payload; the consumer-side re-arm and its delayed-result test land with Plan-014's seam. Expose `runHasPendingCrossNodeDispatch(runId)` in `dispatch-liveness.ts` over the open, unexpired rows (`closed_at IS NULL AND expires_at > now`) for [Plan-014](./014-multi-agent-channels-and-orchestration.md) T2.7's idle-reaper seam.
8. Register `runHasPendingCrossNodeDispatch` into Plan-014 T2.7's idle-reaper consult point through the seam's published injection surface, authoring no Plan-014 internals, and add end-to-end idle-sweep verification: (a) an open, unexpired row naming the originating run ⇒ the sweep hard-skips that run; (b) the row closed under each `close_reason` (`observed_terminal`, `expiry_bound`, `send_failed`) ⇒ the run is reaped only after the fresh post-close idle window (the Step 7 exemption-end re-arm); (c) an overdue open row (`expires_at` elapsed, sweep not yet fired) ⇒ the predicate is false ⇒ no hard-skip, yet the run still receives its fresh post-lapse idle window before any reap — the sweep's first encounter with an overdue open row re-arms (the case-(b) outcome shape) rather than reaping, since the fresh-window guarantee keys on exemption **end**, not row close. This registration is live code — it is the consumer path (an actual cross-node dispatch) that is V1-dormant behind `orchestration.node_not_local`, not the registration itself.
9. Implement detached-caller result buffering on the target daemon with the `caller_token.exp + 5 minutes` delivery window.
10. Add desktop approval UI integration under `apps/desktop/src/renderer/src/cross-node-dispatch/`, routed only through the Plan-021 preload bridge.
11. Add audit/export verification that recomputes request hashes and verifies both caller and approver PASETO signatures.
12. Extend API and error contract docs with final request/response/error shapes before marking implementation complete.

## Parallelization Notes

- Contract/schema work can run in parallel with desktop approval mockups because both depend only on Spec-022.
- Caller-side construction and target-side intake can run in parallel after the shared contract module lands.
- Result buffering must wait for target-side execution and caller-side result verification contracts to stabilize.
- Desktop approval UI must wait for Plan-021 bridge availability and Plan-010 approval request shapes.

## Test And Verification Plan

- Contract tests for JCS canonicalization and `request_body_hash` equality across independently ordered JSON inputs.
- T1.1 determinism-guard tests: the dispatch-body schemas reject a `Date` (and any other non-string) for `created_at` / `expires_at` and accept only the ISO-8601 string rendering; `action_payload` parse-rejects a host object graph, admitting only an already-parsed JSON value; and `assertNoToJsonOverride` runs on the validated object immediately before `canonicalizeJson` on the Step 3 construction path, asserted by a negative control that feeds a `toJSON`-bearing value past the schema boundary and proves the guard **throws** rather than silently normalizing it. A `JSON.parse(JSON.stringify(...))` normalization anywhere on this path is a test failure, not a fix: `JSON.stringify` **invokes** `toJSON`, so the round-trip consumes the override silently instead of refusing it and leaves the guard permanently green and permanently blind.
- Canonicalizer-refusal mapping tests: an over-deep `action_payload` rejects as `dispatch.payload_too_deep` and an unpaired-surrogate one as `dispatch.payload_ill_formed`; a body defective both ways reports the depth refusal only, so the ill-formed fixture must be well-nested; and no raw canonicalizer throw escapes intake to a remote caller.
- PASETO verification tests covering invalid signature, wrong audience, wrong session, expired token, mismatched `req_hash`, reused `jti`, and DPoP thumbprint mismatch.
- Cedar principal-binding tests proving `principal` is always the verified `caller_token.sub`, never an untrusted request field.
- Replay-guard tests proving a duplicate `dispatch_id` is rejected before Cedar evaluation.
- Capability tests proving undeclared capabilities never create target-owner approval requests.
- Approval-record tests proving allow and deny envelopes are both dual-signed, persisted, and independently verifiable.
- Lifecycle tests for success, denied, rejected, expired during approval wait, expired during execution, failed after approval, and caller detach with result buffering.
- Scheduler tests proving same-node tasks do not emit cross-node dispatch events and a named remote dispatch never silently falls back to a third user.
- Pending-dispatch liveness tests proving `runHasPendingCrossNodeDispatch(runId)` holds only for the originating run while its `cross_node_pending_dispatch` row is open, a terminal observed while the row is open (success and failure alike) closes the window in place, whereas one observed after it already closed (any `close_reason`) or was pruned appends its event idempotently and event-only (no row mutation, deduped per `dispatch_id`) when within one expiry-sweep interval past `expires_at` — beyond that bound a verified terminal is rejected out-of-window with no append, and a proven late delivery with no recorded `dispatch.sent` triggers the late-repair append; an unobserved terminal closes it at the `expires_at` clock bound and a live-daemon lapse re-arms the originating run at exemption end; and a restart rebuilds open windows from the durable rows alone — never resurrecting a concluded window and never re-reading `dispatch.sent`.
- Integration tests across two daemon instances and one relay instance with pairwise encrypted envelopes.
- Desktop UI tests proving target-owner approval text includes caller, capability, summary, expiry, and deny/approve outcomes without exposing raw tokens.

## Implementation Phase Sequence

Six phases decompose the twelve §Implementation Steps above. Phase 1 covers Steps 1-2; Phase 2 covers Step 4; Phase 3 covers Step 3; Phase 4 covers Steps 5-6; Phase 5 covers Steps 7-8; Phase 6 covers Steps 9-12. The phase order departs from the step numbering in exactly one place, taken from §Rollout Order step 2, which requires target-side intake and its fail-closed rejection paths to land **before** caller-side send is enabled — so Step 4 (Phase 2) precedes Step 3 (Phase 3). Phase boundaries are not otherwise a one-to-one image of the §Rollout Order steps: step 3 pairs dual-signed `ApprovalRecord` persistence with audit verification, and those land in Phase 4 and Phase 6 respectively, because the verification tooling is reader-facing and does not gate the persistence it reads. Each phase carries a `**Precondition:**` line so the merge order is reviewer-checkable; the machine-readable block gates on this plan's own §Preconditions provider boxes rather than on upstream phase numbers, because the provider plans' phase decompositions are not all authored yet. Migration ordinals are written `NNNN` and resolve to the next free number in the target migration directory at implementation time, per the shared-numbering convention.

### Phase 1 — Contracts and migrations

**Precondition:** Plan-005 and Plan-010 provider boxes checked. Implementation Steps 1-2; gates every later phase, which all type against these shapes.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: precondition_box_checked, box: "Plan-005 has registered" }
  - { type: precondition_box_checked, box: "Plan-010 has landed" }
```

**Goal:** the contract module, the two Local SQLite migrations, and the Shared Postgres migration compile, migrate, and round-trip; schema snapshots and migration tests green behind a disabled dispatch feature flag.

#### Tasks

- **T1.1 — `cross-node-dispatch.ts` contract module.**
  - Files: `packages/contracts/src/cross-node-dispatch.ts` (CREATE) + `packages/contracts/src/index.ts` (EXTEND — barrel re-export per the existing convention)
  - Branded IDs, discriminated lifecycle states, JCS-hash helpers, Zod schemas, and the error-code enum for `DispatchRequest`, `DispatchReceive`, `DispatchApprovalRequest`, `DispatchApprovalResolve`, `DispatchResult`, `DispatchTerminalNotice`, and `ApprovalRecordVerify`. `created_at` / `expires_at` are declared as **ISO-8601 UTC strings, never `z.date()`**, and `action_payload` is typed as an already-parsed JSON value rather than a host object graph — the type-level construction that keeps any `toJSON` bearer away from `canonicalizeJson` at the Step 3 construction seam. The error-code enum mirrors `error-contracts.md` §Cross-Node Dispatch byte-for-byte, keeping `dispatch.payload_too_deep` and `dispatch.payload_ill_formed` as separate members. The approval category enum and `ApprovalRequestId` are **imported** from Plan-010's `approval.ts`, never redeclared (CP-024-2). `--isolatedDeclarations`-clean: explicit type annotations on every exported const, per the repo-wide `tsconfig.base.json` rule.
  - **Spec coverage:** Spec-022 §Interfaces And Contracts, Spec-022 §Cross-Node Dispatch Request
  - **Verifies invariant:** I-024-13
  - **Consumes:** the 9-category approval enum + `ApprovalRequestId` ← Plan-010 T1.1 (CP-024-2); the `dispatch.*` event type literals + `cross_node_dispatch` category ← Plan-005 Phase 1 (shipped).

- **T1.2 — Migrations for the three dispatch tables.**
  - Files: `packages/runtime-daemon/src/migrations/NNNN-cross-node-dispatch.ts` (CREATE) + `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND) + `packages/control-plane/src/migrations/` (EXTEND) + `packages/runtime-daemon/src/session/__tests__/` (EXTEND)
  - Both Local SQLite tables ship in the single shared `applyMigrations` chain, so each is created on every daemon: `cross_node_dispatch_approvals` (rows written on both the caller and target daemons of a dispatch) and `cross_node_pending_dispatch` (rows written only on the originating caller daemon). The Shared Postgres migration creates `cross_node_dispatch_coordination` with the five-valued `status` enum and routing columns only — no payload, envelope, token, or result column exists to be misused. Tests cover a `cross_node_pending_dispatch` fresh-DB apply, its two partial indexes, the paired `closed_at` / `close_reason` CHECK, and the `close_reason` value enum. Schema snapshots updated against [Local SQLite Schema §Cross-Node Dispatch Tables (Plan-024)](../architecture/schemas/local-sqlite-schema.md#cross-node-dispatch-tables-plan-024).
  - **Spec coverage:** Spec-022 §State And Data Implications
  - **Verifies invariant:** I-024-7, I-024-11
  - **Consumes:** the `migration-runner.ts` guarded-block convention ← Plan-001 (shipped).

### Phase 2 — Target-side intake and Cedar evaluation

**Precondition:** Phase 1 merged; Plan-002, Plan-014, Plan-016, and Plan-028 provider boxes checked. Implementation Step 4. Lands before Phase 3 per §Rollout Order step 2 — fail-closed rejection paths exist before any caller can send. The Plan-014 entry is a **proxy gate**: what T2.1 actually consumes from Plan-014 is the channel audience filter (CP-024-1), and §Preconditions carries no dedicated audience-filter box — the one Plan-014 box there is scoped to the T2.7 consult-point scaffolding this plan needs at Phase 5. Gating on it here over-gates (fails closed, never open) and is the honest available shape until Plan-014 declares the audience filter as its own precondition surface.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 024, phase: 1, status: merged }
  - { type: precondition_box_checked, box: "Plan-002 has landed" }
  - { type: precondition_box_checked, box: "Plan-014 has landed" }
  - { type: precondition_box_checked, box: "Plan-016 has landed" }
  - { type: precondition_box_checked, box: "Plan-028 Phase 8 has landed the relay deploy surface" }
```

**Goal:** a dispatch envelope arriving at a target daemon is validated in the specified order and either receipted or rejected with a named reason; no accepted dispatch can carry an unverified principal into Cedar.

#### Tasks

- **T2.1 — Target-side intake pipeline and Cedar request construction.**
  - Files: `packages/runtime-daemon/src/cross-node-dispatch/intake.ts` (CREATE), `packages/runtime-daemon/src/cross-node-dispatch/replay-guard.ts` (CREATE), `packages/runtime-daemon/src/cross-node-dispatch/cedar-request.ts` (CREATE)
  - The five ordered steps: token verification against the caller's long-term public key from the user roster read path; body binding (JCS canonicalization, BLAKE3, three-way comparison against `request_body_hash` and `caller_token.req_hash`); the `(session_id, dispatch_id)` replay guard with ≥ 10-minute retention; the declared-capability check including session-owner gating for dangerous classes; and Cedar request construction with `principal` bound to the **verified** `caller_token.sub` alone. Steps 1-4 reject synchronously in the `DispatchReceive` ack and emit no `dispatch.received`; a step-5 Cedar failure is relayed as a `DispatchTerminalNotice`. The two canonicalizer refusals are caught here and mapped to `dispatch.payload_too_deep` / `dispatch.payload_ill_formed` — depth checked first — so no raw throw reaches a remote caller. Policy-engine failure rejects with `policy_engine_error` and raises an ops alert. Clock-skew bounds (±120 s on `created_at`, `expires_at` already past) reject at receipt.
  - **Spec coverage:** Spec-022 §Target-Side Authentication And Cedar Evaluation, Spec-022 §Capability Declaration And Session-Owner Gating, Spec-022 §Fallback Behavior
  - **Verifies invariant:** I-024-1, I-024-2, I-024-9, I-024-10, I-024-13
  - **Consumes:** the identity key read path ← Plan-016; Cedar evaluation ← Plan-010; capability declarations ← Plan-002; `v4.public` verification ← the shipped `packages/crypto-paseto/` workspace package.

### Phase 3 — Caller-side dispatch construction and outbox

**Precondition:** Phase 2 merged; Plan-028 and Plan-013 provider boxes checked. Implementation Step 3.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 024, phase: 2, status: merged }
  - { type: precondition_box_checked, box: "Plan-028 Phase 3 has landed the pairwise encrypted relay payload channel" }
  - { type: precondition_box_checked, box: "Plan-013 has landed" }
```

**Goal:** a caller daemon can construct, sign, record, and send a dispatch such that no crash anywhere in the send path leaves the originating run wrongly reaped or the audit log wrongly silent.

#### Tasks

- **T3.1 — Caller-side construction, intent row, and outbox commit.**
  - Files: `packages/runtime-daemon/src/cross-node-dispatch/dispatch-client.ts` (CREATE), `packages/runtime-daemon/src/cross-node-dispatch/pending-dispatch-store.ts` (CREATE)
  - Own-node-first scheduler hook and capability target selection — a named cross-node target never silently falls back to a third user, and a failure surfaces to the caller. `caller_token` issuance through `packages/crypto-paseto/`, JCS canonicalization of the in-process-constructed body, and the BLAKE3 `request_body_hash`. `assertNoToJsonOverride` runs on the **validated** T1.1 object immediately before `canonicalizeJson`, keeping the Plan-005 determinism guard live and load-bearing rather than laundered. The `cross_node_pending_dispatch` intent row is INSERTed **before** the relay send, carrying `expires_at` and the originating `runId`. On a synchronous send failure the row closes in place immediately with `close_reason = 'send_failed'` and appends no event. On send success, one local SQLite transaction stamps `sent_at` and appends `dispatch.sent` together — all-or-nothing.
  - **Spec coverage:** Spec-022 §Scheduler Dispatch Rules, Spec-022 §Cross-Node Dispatch Request
  - **Verifies invariant:** I-024-8, I-024-11
  - **Consumes:** the pairwise encrypted relay payload channel ← Plan-028; the `v4.public` primitives ← the shipped `packages/crypto-paseto/` workspace package; the local replay/recovery substrate and single writer worker ← Plan-013.

### Phase 4 — Approval integration and dual-signed record

**Precondition:** Phase 2 merged; Plan-010 provider box checked. Implementation Steps 5-6.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 024, phase: 2, status: merged }
  - { type: precondition_box_checked, box: "Plan-010 has landed" }
```

**Goal:** owner approval produces a tamper-evident dual-signed envelope that any holder of both public keys can verify, and approved execution is bounded by the caller's own token.

#### Tasks

- **T4.1 — Approval resolution and dual-signed ApprovalRecord envelope.**
  - Files: `packages/runtime-daemon/src/cross-node-dispatch/approval-record.ts` (CREATE), `packages/runtime-daemon/src/approvals/` (EXTEND — additive integration with Plan-010's request/resolution code; no ownership transfer)
  - Owner approval produces an `approver_token` with a `jti` **distinct** from `caller_token.jti`, `bound_jti` set to the caller's `jti`, `req_hash` equal to the caller's, and `exp ≥ caller_token.exp`. The composite envelope persists to `cross_node_dispatch_approvals` on both daemons and emits `dispatch.approved` / `dispatch.denied`. A `decision = "deny"` record persists with the **same** guarantees as an allow — never dropped, never inferred from absence, never reinterpreted later. Cedar denials that are not requests-for-owner-approval emit `dispatch.rejected` instead and produce no signed envelope, no approver token existing on those paths.
  - **Spec coverage:** Spec-022 §Dual-Signed ApprovalRecord
  - **Verifies invariant:** I-024-3, I-024-4, I-024-6
  - **Consumes:** approval request/resolution surfaces + the `ApprovalRequestId` branded id ← Plan-010 (CP-024-2); `v4.public` signing ← the shipped `packages/crypto-paseto/` workspace package.

- **T4.2 — Target-side execution adapter and result signing.**
  - Files: `packages/runtime-daemon/src/cross-node-dispatch/execution-adapter.ts` (CREATE)
  - Dispatch only to **declared** capability handlers, with dangerous classes gated on the session-owner-signed capability approval before execution begins. Execution is bounded by `caller_token.exp` regardless of approver-token expiry: work exceeding it aborts and emits `dispatch.expired` with `reason: 'caller_token_expired'` or `'execution_deadline'`. The exact Spec-022 lifecycle is emitted — `dispatch.executed` when the handler returns, then exactly one terminal (`dispatch.completed` on the success path, `dispatch.failed` on a post-handler fault; a handler that raises before returning goes straight to `dispatch.failed` with no intermediate). Results are signed by the target-node owner for caller-side verification.
  - **Spec coverage:** Spec-022 §Execution And Result Emission
  - **Verifies invariant:** I-024-5, I-024-9
  - **Consumes:** declared capability handlers and node state ← Plan-002 via `packages/runtime-daemon/src/node/`.

### Phase 5 — Caller-side result observation and liveness registration

**Precondition:** Phases 3 and 4 merged; Plan-014 provider box checked. Implementation Steps 7-8.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 024, phase: 3, status: merged }
  - { type: plan_phase, plan: 024, phase: 4, status: merged }
  - { type: precondition_box_checked, box: "Plan-014 has landed" }
```

**Goal:** every terminal a caller observes lands its durable audit event and closes exactly one pending window, and the originating run is never reaped for being idle while it was blocked on remote work.

#### Tasks

- **T5.1 — Caller-side result verification, observation events, and in-place window close.**
  - Files: `packages/runtime-daemon/src/cross-node-dispatch/result-observer.ts` (CREATE), `packages/runtime-daemon/src/cross-node-dispatch/pending-dispatch-store.ts` (EXTEND from T3.1), `packages/runtime-daemon/src/cross-node-dispatch/dispatch-liveness.ts` (CREATE)
  - Result signature verification and actionable failure surfaces for denied, rejected, expired, failed, and buffered dispatches. A terminal observed **while the row is still open** closes that window in place — every terminal type, failure terminals included — appending `dispatch.result_observed` with its `outcome` discriminator (denials close via `dispatch.approval_observed`), the event append and the row closure committing in **one** SQLite transaction. A terminal observed after the row already closed (**any** `close_reason`) or was pruned appends its event idempotently and event-only: no row mutation, no reopen, no second close, no re-arm, deduped per `dispatch_id`, and bounded to one expiry-sweep interval past `expires_at` — beyond that bound a verified terminal is rejected out-of-window and appends nothing. A proven late delivery with no recorded `dispatch.sent` (`sent_at` NULL) appends a late-repaired `dispatch.sent` first, in the same transaction; the no-result path never fabricates one. Ending the run's dispatch idle-exemption always leaves the originating run a fresh idle window, keyed on exemption **end** rather than row close. `dispatch-liveness.ts` exports `runHasPendingCrossNodeDispatch(runId)` over open, unexpired rows (`closed_at IS NULL AND expires_at > now`).
  - **Spec coverage:** Spec-022 §Cross-Node Failure Semantics, Spec-005 §Cross-Node Dispatch (cross_node_dispatch)
  - **Verifies invariant:** I-024-11, I-024-12
  - **Consumes:** the compaction thresholds bounding the dedupe source ← Spec-005 §Event Compaction Policy (no Spec-005 change owed).

- **T5.2 — Register the liveness predicate into Plan-014 T2.7 and verify the idle sweep end to end.**
  - Files: `packages/runtime-daemon/src/cross-node-dispatch/dispatch-liveness.ts` (EXTEND from T5.1) + `packages/runtime-daemon/src/cross-node-dispatch/__tests__/idle-sweep.integration.test.ts` (CREATE)
  - Register `runHasPendingCrossNodeDispatch` into T2.7's idle-reaper consult point through its published injection surface, authoring **no** Plan-014 internals. End-to-end verification: (a) an open, unexpired row naming the originating run ⇒ the sweep hard-skips that run; (b) the row closed under each `close_reason` (`observed_terminal`, `expiry_bound`, `send_failed`) ⇒ the run is reaped only after the fresh post-close idle window; (c) an overdue open row (`expires_at` elapsed, sweep not yet fired) ⇒ the predicate is false ⇒ no hard-skip, yet the sweep's first encounter with that row re-arms rather than reaps. This registration is live code; it is the cross-node consumer path it feeds that is V1-dormant behind `orchestration.node_not_local`.
  - **Spec coverage:** Spec-022 §Cross-Node Failure Semantics
  - **Verifies invariant:** I-024-12
  - **Consumes:** the T2.7 idle-reaper consult-point scaffolding ← Plan-014 (CP-024-3).

### Phase 6 — Result buffering, desktop approval UI, audit verification, contract docs

**Precondition:** Phases 4 and 5 merged; Plan-021 provider box checked. Implementation Steps 9-12.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 024, phase: 4, status: merged }
  - { type: plan_phase, plan: 024, phase: 5, status: merged }
  - { type: precondition_box_checked, box: "Plan-021 has landed" }
```

**Goal:** a detached caller still receives its result within the bounded window, a node owner can approve or deny from the desktop without ever seeing raw tokens, any holder of both public keys can independently verify a persisted record, and the contract docs match the shipped shapes.

#### Tasks

- **T6.1 — Detached-caller result buffering on the target daemon.**
  - Files: `packages/runtime-daemon/src/cross-node-dispatch/result-buffer.ts` (CREATE)
  - Hold the result locally for delivery on caller reconnect within `caller_token.exp + 5 minutes`, appending `dispatch.result_buffered` as a post-terminal delivery annotation — not a lifecycle state, the dispatch having already terminated at `.completed`. Past the window the result persists to the target-local log only and the caller re-observes via audit export. The buffer window never extends the execution bound.
  - **Spec coverage:** Spec-022 §Execution And Result Emission
  - **Verifies invariant:** I-024-5
  - **Consumes:** the terminal lifecycle and signed results ← T4.2 (same plan).

- **T6.2 — Desktop target-owner approval surface.**
  - Files: `apps/desktop/src/renderer/src/cross-node-dispatch/` (CREATE) + `packages/client-sdk/src/crossNodeDispatchClient.ts` (CREATE)
  - The approval modal is authored **here**, routed only through the Plan-021 preload bridge — Plan-021 declares the bridge, not the component. Approval text names caller, capability, summary, and expiry, and exposes deny and approve outcomes without ever rendering raw tokens or envelope material. The typed SDK wrapper serves caller-side reads and audit verification.
  - **Spec coverage:** Spec-022 §Interfaces And Contracts
  - **Verifies invariant:** none (desktop approval surface; the record invariants bind at T4.1)
  - **Consumes:** the preload bridge ← Plan-021; approval request shapes ← Plan-010.

- **T6.3 — Audit and export verification.**
  - Files: `packages/runtime-daemon/src/cross-node-dispatch/record-verify.ts` (CREATE)
  - `ApprovalRecordVerify` recomputes the request hash from the canonical bytes and independently verifies both the caller's and the approver's `v4.public` signatures, that both tokens commit to the same `request_body_hash`, and that `approver_token.bound_jti` matches `caller_token.jti`. Deny envelopes verify by the same path as allows — a refusal is evidence, not an absence.
  - **Spec coverage:** Spec-022 §Dual-Signed ApprovalRecord
  - **Verifies invariant:** I-024-4, I-024-6
  - **Consumes:** `v4.public` verification ← the shipped `packages/crypto-paseto/` workspace package.

- **T6.4 — Contract-doc reconciliation against the shipped shapes.**
  - Files: `docs/architecture/contracts/api-payload-contracts.md` (EXTEND) + `docs/architecture/contracts/error-contracts.md` (EXTEND)
  - Extend the API payload doc with the final request/response shapes, and reconcile `error-contracts.md` §Cross-Node Dispatch against the shipped enum — the two payload codes stay distinct, keep their `data.fields`, and gain any further dispatch-specific codes the implementation surfaced. A code present in one surface and absent from the other fails this task.
  - **Spec coverage:** Spec-022 §Interfaces And Contracts
  - **Verifies invariant:** I-024-13
  - **Consumes:** the shipped contract module ← T1.1 (same plan).

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

- Clock skew beyond Spec-022's ±120s boundary can cause surprising rejections; Plan-018 NTP health checks must be visible before broad rollout.
- Desktop approval latency can exceed the default 60-second caller-token expiry if UI routing is slow; tests must cover expiry as normal behavior, not a rare error.
- Coordination rows may look authoritative to future implementers; contract docs and code comments must repeat that they are routing metadata only.
- Cross-node execution expands the trust boundary. Fail-open policy behavior, silent fallback, or missing deny persistence are release blockers.

## Done Checklist

- [ ] Code changes implemented.
- [ ] Tests added or updated.
- [ ] Verification completed.
- [ ] Related docs updated.
- [ ] Every phase in §Implementation Phase Sequence has shipped its `#### Tasks` block in full, with each task's `Files:` set landed and its `**Spec coverage:**` cites resolving against Spec-022 / Spec-005.
- [ ] Every invariant I-024-1..13 is preserved by the shipped code and verified by at least the tasks its §Invariants entry names; weakening any one of them is a change agreed with the counterpart plans, not a local edit.
- [ ] Every §Cross-Plan Obligation (CP-024-2..3) is either satisfied with a return-cite from its provider plan or explicitly staged.
- [ ] Local SQLite `cross_node_dispatch_approvals` + `cross_node_pending_dispatch` and Shared Postgres `cross_node_dispatch_coordination` schemas are present in canonical schema docs and migrations.
- [ ] Every Spec-022 acceptance criterion has a matching automated test or documented manual verification step.
