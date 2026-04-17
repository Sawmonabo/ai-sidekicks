# Spec-024: Cross-Node Dispatch And Approval

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `024` |
| **Slug** | `cross-node-dispatch-and-approval` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Depends On** | [Runtime Node Model](../domain/runtime-node-model.md), [Session Model](../domain/session-model.md), [Participant And Membership Model](../domain/participant-and-membership-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Security Architecture](../architecture/security-architecture.md), [Runtime Node Attach](./003-runtime-node-attach.md), [Approvals, Permissions, and Trust Boundaries](./012-approvals-permissions-and-trust-boundaries.md) |
| **Implementation Plan** | _(none yet — BL-047 produces this spec; implementation plan follow-up filed separately)_ |

## Purpose

Define the end-to-end protocol for cross-participant runtime dispatch — the mechanism by which one participant's daemon asks another participant's daemon to execute work (run a tool, write a file, perform a network call) inside the shared session. The protocol must (a) cryptographically prove who the caller is, (b) require the target-node owner's explicit approval for each dispatch, (c) produce a tamper-evident audit record both parties can verify, and (d) preserve the principle that session membership never implies authority to execute on another participant's machine.

## Scope

This spec covers:

- The cross-node dispatch request format and the cryptographic bindings carried on it.
- Target-side authentication of the caller's identity before any policy evaluation.
- The Cedar principal-binding pattern the target node uses to evaluate the request against local approval policy.
- The dual-signed approval record format produced by a successful dispatch and the verification procedure each party must run.
- The runtime-node capability declaration flow that pre-gates what categories of work a node will accept at all.
- Cross-node failure semantics: partner detach mid-execution, caller-token expiration, clock skew, approver-unavailability.
- The scheduler's own-node-first default and the rules that trigger a cross-node hop.

## Non-Goals

- Own-node execution (covered by queue/approval behavior in [Spec-004](./004-queue-steer-pause-resume.md) and [Spec-012](./012-approvals-permissions-and-trust-boundaries.md) — no cross-node concerns apply).
- Session creation, invite redemption, or membership changes (covered by [Spec-001](./001-shared-session-core.md), [Spec-002](./002-invite-membership-and-presence.md)).
- Relay encryption protocol (covered by [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) and [Spec-008](./008-control-plane-relay-and-session-join.md)).
- Provider-driver-specific payload shapes (covered by [Spec-005](./005-provider-driver-contract-and-capabilities.md)).
- Cross-node shared artifacts and file replication (V1.1 per [ADR-015](../decisions/015-v1-feature-scope-definition.md); cross-node artifact movement within a single dispatch is in scope here only as the artifact carried on a dispatch result).

## Domain Dependencies

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [ADR-007: Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
- [ADR-012: Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md)
- [ADR-017: Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md)

## Required Behavior

### Scheduler Dispatch Rules

- The scheduler must route every dispatchable task own-node-first. A task is routed to a remote node only when (a) the owning participant's runtime-node capability set does not cover the task's declared requirements, or (b) the task is explicitly pinned to a remote participant's node by an operator-initiated action.
- A cross-node hop must always be treated as a `tool_execution`-category action in [Spec-012](./012-approvals-permissions-and-trust-boundaries.md)'s approval taxonomy, even when the underlying work (e.g., reading a file) would be lower-category on the caller's own node. The rationale is that any cross-machine execution is a distinct trust boundary crossing.
- The scheduler must never silently fall back from a specific cross-node dispatch to another participant's node on failure. If the chosen remote target declines or becomes unreachable, the scheduler must surface the failure to the caller and let the caller (human or agent) choose the next action.

### Capability Declaration And Session-Owner Gating

- Every runtime node joining a session must emit `runtime_node.capability_declared` per [Spec-003](./003-runtime-node-attach.md) with the concrete list of capabilities it will accept work for (e.g., `repo.write`, `network.egress`, `process.exec`, `shell.command`).
- Dangerous capability classes — `shell.command`, `network.egress`, `destructive_git`, `mcp_elicitation` — must additionally require session-owner approval before the declared capability becomes schedulable. The session owner's approval record (an ApprovalRecord per §Dual-Signed ApprovalRecord below, with the session owner as approver and the runtime-node owner as caller) becomes part of the node's capability state.
- A runtime node must never accept a dispatch for a capability it has not declared. A dispatch for an undeclared capability must be rejected before target-owner approval is requested.

### Cross-Node Dispatch Request

A cross-node dispatch request originates on the caller's daemon and is delivered to the target daemon via the relay's pairwise-encrypted payload channel (per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) V1 encryption). The request payload must contain:

- `dispatch_id` — UUIDv7 chosen by the caller; serves as idempotency key.
- `session_id` — the session this dispatch belongs to.
- `caller_participant_id` — the caller's session participant ID.
- `target_participant_id` — the target's session participant ID.
- `target_node_id` — the specific runtime node on the target side.
- `capability` — the declared capability this dispatch exercises (e.g., `repo.write`).
- `action_payload` — capability-specific work description (opaque to Spec-024; interpreted by the capability handler on the target node).
- `created_at` — ISO-8601 UTC timestamp.
- `expires_at` — absolute expiry (default: `created_at + 60s`; max: `created_at + 300s`).
- `caller_token` — a PASETO v4.public token (per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)) signed by the caller's participant identity key, carrying claims: `sub = caller_participant_id`, `aud = target_node_id`, `sid = session_id`, `jti = dispatch_id`, `iat = created_at`, `exp = expires_at`, `cnf.jkt = <DPoP thumbprint per RFC 9449>`, and the canonical BLAKE3 hash of the request body in a claim `req_hash = b3:<64-hex>`.
- `request_body_hash` — BLAKE3 hash of the canonically serialized dispatch body (all fields above except `caller_token` itself); duplicated here for envelope-level verification without token parsing.

### Target-Side Authentication And Cedar Evaluation

Target-side processing must perform these steps strictly in order; failure at any step rejects the dispatch and emits a `dispatch.rejected` event with the reason:

1. **Token verification.** Verify `caller_token` against the caller participant's known long-term public key (retrieved from the session participant roster on the target daemon). Reject on invalid signature, expired token, audience mismatch, or session-id mismatch.
2. **Body binding.** Compute BLAKE3 over the canonical serialization of the dispatch body and compare against both `request_body_hash` (envelope) and `caller_token.req_hash` (token claim). All three must match.
3. **Replay guard.** Check `dispatch_id` against the local per-session dispatch-id cache (retained for at least `2 × max(expires_at - created_at)` = 10 minutes). Reject on replay.
4. **Capability check.** Verify the target node has declared the `capability` named in the dispatch and has any required session-owner approval for dangerous capability classes.
5. **Cedar evaluation.** Build the Cedar authorization request with:
   - `principal = Participant::"<verified caller_participant_id>"` — **the principal ID is the token's `sub` claim only after the token has been cryptographically verified in step 1.** Policies must never bind `principal` to an unverified field.
   - `action = Action::"dispatch::<capability>"` — e.g., `Action::"dispatch::repo.write"`.
   - `resource = RuntimeNode::"<target_node_id>"`.
   - `context = { token_issuer: <caller identity key id>, token_audience: <target_node_id>, verified_at: <wall clock UTC of step 1 completion>, dpop_jkt: <caller_token.cnf.jkt>, session_role: <caller's session role: viewer | collaborator | runtime_contributor | owner>, action_payload_summary: <capability-handler-provided canonical summary> }` — verification metadata goes on `context`, following the pattern from [AWS Verified Permissions identity-source mapping](https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/identity-sources.html).
6. **Approval gate.** If the Cedar evaluation result is `Allow`, the dispatch proceeds directly to §Dual-Signed ApprovalRecord construction. If the result is `Deny` with a policy reason of "requires owner approval" (the default for `tool_execution` category per [Spec-012](./012-approvals-permissions-and-trust-boundaries.md)), the target daemon emits an `approval_requested` event to the target-node owner's UI and blocks until the owner resolves the approval or `expires_at` elapses.

### Dual-Signed ApprovalRecord

Every successful cross-node dispatch produces an `ApprovalRecord`. V1 uses a composite envelope of two independent PASETO v4.public tokens because PASETO v4 has no native multi-signature and PASERK has no token-wrapping type for multi-token envelopes ([PASETO v4 spec](https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md), [PASERK README](https://github.com/paseto-standard/paserk)).

The envelope shape is:

```json
{
  "approval_record_version": "1",
  "dispatch_id": "<UUIDv7>",
  "session_id": "<session uuid>",
  "request_body_hash": "b3:<64-hex>",
  "caller_token": "<PASETO v4.public signed by caller participant>",
  "approver_token": "<PASETO v4.public signed by target-node owner>",
  "created_at": "<ISO-8601 UTC>"
}
```

The `approver_token` carries cryptographic binding to the caller's request:

- `sub = approver_participant_id` (the target-node owner).
- `aud = caller_participant_id`.
- `sid = session_id`.
- `jti = <fresh UUIDv7 distinct from dispatch_id>`.
- `bound_jti = <caller_token.jti>` — binds this approver token to the specific caller token it approves.
- `req_hash = b3:<same BLAKE3 as caller_token.req_hash>` — binds the approver's signature to the specific request body.
- `decision = "allow" | "deny"` — allow is required for execution to proceed; a deny-signed record documents explicit refusal for audit and cannot be silently reinterpreted later.
- `iat`, `exp` — approver token exp must be ≥ caller token exp.

The envelope is tamper-evident: any verifier who holds both participants' long-term public keys can independently verify (a) the caller's token signature, (b) the approver's token signature, (c) that both tokens commit to the same `request_body_hash`, and (d) that the approver's `bound_jti` matches the caller's `jti`.

### Execution And Result Emission

- On a signed `allow` ApprovalRecord, the target daemon's capability handler executes the action. Execution is bounded by `caller_token.exp`; if execution exceeds the token's expiry, the target daemon must abort the in-flight work and emit a `dispatch.expired` event.
- Per [ADR-017](../decisions/017-shared-event-sourcing-scope.md), the target daemon appends `dispatch.received`, `dispatch.approved` (or `dispatch.denied`), `dispatch.executed`, and `dispatch.completed` events to its own local `session_events` log. The caller daemon appends the complementary events (`dispatch.sent`, `dispatch.approval_observed`, `dispatch.result_observed`) to its own local log. Each daemon's log is authoritative for what that daemon observed.
- The dispatch result is delivered back to the caller via the same pairwise-encrypted relay channel with an inner signature from the target-node owner.

### Cross-Node Failure Semantics

- **Caller-token expiry before approval.** If the target-node owner has not resolved the approval by `caller_token.exp`, the target daemon must auto-deny the pending approval with reason `caller_token_expired` and emit `dispatch.denied`. A new dispatch requires a new caller token.
- **Target-owner unreachable during approval wait.** If the target-node owner's session presence transitions to `offline` while an approval is pending, the target daemon must keep the approval pending until (a) the owner returns before `caller_token.exp`, or (b) `caller_token.exp` elapses and auto-denial fires. The caller-side observes `approval_pending` until one terminal event arrives.
- **Partner detach mid-execution.** If the caller's runtime node transitions to `detached` (per [Spec-003](./003-runtime-node-attach.md)) after the dispatch was approved but before execution completes, the target daemon must continue execution to completion. The dispatch result is persisted locally on the target with a `result_buffered` event and delivered on the caller's next reconnect within `caller_token.exp + 5 minutes`. Past that window, the result is persisted to the target-local log only and the caller must re-observe via audit export rather than live delivery.
- **Clock skew at the approval boundary.** The target daemon must reject dispatches whose `created_at` is more than 120 seconds in the target's future or whose `expires_at` is already in the target's past at receipt. Daemons must use NTP-synced clocks per [Spec-020](./020-observability-and-failure-recovery.md).
- **Approver-denied.** A `decision = "deny"` approver token is persisted in the envelope and emitted as `dispatch.denied`. The caller must not retry the same `dispatch_id`; a new attempt requires a new `dispatch_id`.

## Default Behavior

- Every cross-node dispatch requires explicit target-node-owner approval for the `tool_execution` category by default. Cedar policies must not `Allow` cross-node dispatch by class rule; allow paths must name specific approver-scoped conditions (e.g., "allow if approver owns target node").
- `caller_token.exp` defaults to `created_at + 60 seconds` to bound approval-latency surface area.
- Approver tokens default to `exp = caller_token.exp + 300 seconds` to accommodate clock skew without extending caller-side authority.
- Replay-guard cache retention defaults to 10 minutes per session.

## Fallback Behavior

- If target-side Cedar evaluation encounters a policy engine error (e.g., malformed policy, evaluation timeout), the target daemon must fail closed — reject the dispatch with reason `policy_engine_error` and emit an ops alert per [Spec-020](./020-observability-and-failure-recovery.md). The dispatch must never proceed on policy-engine failure.
- If the target daemon cannot reach the session participant roster to look up the caller's long-term public key (e.g., shared Postgres unreachable), the target must fall back to the locally cached roster if available and within freshness (default: 5 minutes). Past freshness, reject with `participant_roster_stale`.
- If the approver-side UI cannot reach the target daemon (local IPC failure), the approval flow must retry the local IPC channel for the `caller_token.exp` window before auto-denying.

## Interfaces And Contracts

- `DispatchRequest(session_id, caller_token, target_node_id, capability, action_payload) -> { dispatch_id, created_at, expires_at }` — issued by caller-side scheduler.
- `DispatchReceive(envelope) -> { dispatch_id, status: "received" | "rejected", reason? }` — target-side receipt, emitted immediately after envelope validation.
- `DispatchApprovalRequest(dispatch_id, caller_participant_id, capability, action_summary) -> (surfaced in target-owner UI)` — target-side approval request surfaced to the node owner's desktop / CLI surface per [Spec-012](./012-approvals-permissions-and-trust-boundaries.md).
- `DispatchApprovalResolve(dispatch_id, decision: "allow" | "deny", approver_token) -> ApprovalRecord` — target-side approval resolution that produces the signed record.
- `DispatchResult(dispatch_id, result_payload, result_signature) -> (delivered to caller via relay)` — final result emission after execution.
- `ApprovalRecordVerify(record, caller_public_key, approver_public_key) -> { valid: boolean, reasons: [...] }` — any daemon or audit tool may run this to validate a persisted ApprovalRecord.
- Event taxonomy extensions (cataloged in [Spec-006](./006-session-event-taxonomy-and-audit-log.md)): `dispatch.sent`, `dispatch.received`, `dispatch.rejected`, `dispatch.approval_requested`, `dispatch.approved`, `dispatch.denied`, `dispatch.executed`, `dispatch.completed`, `dispatch.expired`, `dispatch.result_observed`, `runtime_node.capability_declared` (already owned by Spec-003).

See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas; see [Error Contracts](../architecture/contracts/error-contracts.md) for error response shapes.

## State And Data Implications

- Per [ADR-017](../decisions/017-shared-event-sourcing-scope.md), all dispatch events are appended to per-daemon local `session_events` logs. There is no shared dispatch event log in V1.
- The ApprovalRecord envelope is stored durably on both the caller's and the target's Local SQLite in a `cross_node_dispatch_approvals` table owned by the Plan that implements Spec-024 (not Plan-001, which does not know about cross-node dispatch; allocation will be determined at plan-authoring time per BL-055).
- Shared Postgres stores a `cross_node_dispatch_coordination` row per dispatch-id for routing and presence-aware retry, containing only: `dispatch_id`, `session_id`, `caller_participant_id`, `target_participant_id`, `status` (requested | approved | denied | executed | expired), `created_at`, `resolved_at`. No dispatch payload, no approval-record content, no action payload. The coordination row is a routing aid, not a truth source.
- Replay-guard cache is local-to-target and ephemeral (≤ 10 minutes retention).

## Example Flows

### Alice dispatches to Bob's node for `repo.write`

Alice is a session owner running a Codex agent. The agent produces a diff that needs to be applied in the shared repo checkout on Bob's machine because Bob owns the worktree the session is bound to (per [Spec-009](./009-repo-attachment-and-workspace-binding.md)).

1. **Caller-side.** Alice's scheduler identifies that the `repo.write` task cannot run on her own node (her node has no worktree for this session) and selects Bob's node as target per the session's worktree binding. Alice's daemon constructs a DispatchRequest with `capability = "repo.write"`, `action_payload = { patch: "<unified diff>", target_branch: "feature/foo" }`, `caller_token = <PASETO v4.public signed by Alice's participant key, exp = now + 60s>`, and ships it via the relay as a pairwise-encrypted payload addressed to Bob's node.
2. **Target-side intake.** Bob's daemon receives the envelope, verifies Alice's caller_token signature against her long-term public key from the target-local session roster, confirms the request_body_hash binding, checks replay-guard, verifies Bob's node has declared `repo.write`, then builds the Cedar authorization request with `principal = Participant::"<Alice's participant id>"`, `action = Action::"dispatch::repo.write"`, `resource = RuntimeNode::"<Bob's node id>"`, `context = { token_issuer, token_audience, verified_at, dpop_jkt, session_role: "owner", action_payload_summary: "apply 47-line diff to feature/foo" }`.
3. **Approval gate.** Cedar evaluates and returns `Deny` with reason "requires owner approval" because `tool_execution` is the default category. Bob's daemon emits `dispatch.approval_requested` to Bob's desktop UI: "Alice is requesting permission to apply a 47-line diff to feature/foo on your worktree. Expires in 58s."
4. **Approval resolution.** Bob clicks Approve. Bob's daemon signs an approver_token with `sub = Bob's participant id`, `bound_jti = Alice's caller_token.jti`, `req_hash = <same BLAKE3>`, `decision = "allow"`. The ApprovalRecord envelope is appended to Bob's local `cross_node_dispatch_approvals` and also mirrored back to Alice via the relay.
5. **Execution.** Bob's `repo.write` capability handler applies the diff to the worktree and emits `dispatch.executed`, then `dispatch.completed` with the resulting commit SHA.
6. **Result delivery.** Bob's daemon ships the result payload back through the relay. Alice's daemon validates the result signature, appends `dispatch.result_observed` to Alice's local log, and surfaces the commit SHA to Alice's UI.

Audit: one ApprovalRecord envelope exists, tamper-evidently binding Alice's request to Bob's approval. Bob's local log has the full dispatch lifecycle. Alice's local log has the request-send and result-observe events. Shared Postgres has one coordination row with `status = executed` and no payload.

### Alice dispatches to Carol's node; Carol denies

Same opening. At step 4, Carol clicks Deny. Carol's daemon signs an approver_token with `decision = "deny"` and a free-text `reason`. The envelope is emitted as `dispatch.denied` on Carol's side and mirrored to Alice as `dispatch.approval_observed (denied)`. Alice's scheduler does not retry the same `dispatch_id`. Alice's agent receives an actionable error: "Carol declined the dispatch. Reason: <text>." Both daemons retain the signed deny record for audit.

### Bob's node detaches mid-execution

Same opening through step 5 execution. Mid-execution (Bob's side), Alice's runtime node experiences a network drop and transitions to `detached`. Bob's execution continues to completion. Bob's daemon appends `dispatch.completed` and buffers the result. When Alice reconnects 40s later (still within `caller_token.exp + 5 minutes`), Bob's daemon delivers the buffered result via the relay. If Alice does not return within the window, the result stays in Bob's local log and Alice's future session replay includes `dispatch.result_observed (via audit export)` rather than via-live-delivery.

## Implementation Notes

- Use [AWS Verified Permissions' identity-source mapping pattern](https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/identity-sources.html) as the reference when implementing the token-sub → principal / token-claims → principal-attrs / access-token-claims → context mapping. Cedar treats all principals as equal entities; cross-participant semantics are expressed through entity attributes and context predicates, not through a dedicated feature.
- PASETO v4.public tokens are produced and verified via Paragon's reference libraries; do not attempt to implement v4.public signing from primitives. Per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), the project's PASETO dependency is the audited reference implementation.
- The dual-signed ApprovalRecord is a composite envelope, not a multi-signature token. PASETO v4 has no native multi-signature and PASERK has no token-wrapping type for nesting multiple PASETO tokens ([PASETO v4 spec](https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md), [PASERK README](https://github.com/paseto-standard/paserk)). The envelope shape specified in §Dual-Signed ApprovalRecord is the safe composition of two single-signer v4.public tokens with cryptographic binding via `bound_jti` and `req_hash`.
- The DPoP thumbprint (`cnf.jkt`) follows [RFC 9449](https://datatracker.ietf.org/doc/rfc9449/) semantics, reused inside PASETO claims for proof-of-possession. The PASETO spec does not define `cnf.jkt` natively; the claim is project-local with RFC 9449 semantics.
- **Precedent:** [Teleport Just-In-Time Access Requests](https://goteleport.com/docs/identity-governance/access-requests/) is the closest public precedent for per-request runtime approval in a cross-machine developer-tool setting — separate approvers, runtime approval not pre-baked policy, distinct `access_request.create` (T5000I) and `access_request.review` (T5002I) audit events ([Teleport Audit Events reference](https://goteleport.com/docs/reference/audit-events/)). Spec-024's request / approval / execution event split follows the same structure, with the stricter binding that the approver must be the target-node owner rather than any user with review permission.

## Pitfalls To Avoid

- Binding the Cedar `principal` to an unverified caller-id field. The principal must be set to the verified `sub` claim of a cryptographically validated PASETO token. A raw, unverified participant-id header must never reach Cedar.
- Sharing the same `jti` between caller_token and approver_token. Each token carries a distinct `jti`; the binding goes through approver_token.`bound_jti` → caller_token.`jti`, not through token identity.
- Omitting `req_hash` from the approver_token. Without `req_hash`, an approver signature could be re-used to approve a substituted request body. The approver must sign over the request body, not just the approval decision.
- Treating the shared-Postgres coordination row as a source of truth. It is a routing aid and must never be consulted for approval semantics or dispatch content.
- Silently falling back to another target node on failure. The scheduler's own-node-first rule is the default, but any specific cross-node dispatch is bound to its named target; a failure surfaces to the caller rather than re-routing to a third party.
- Extending a caller_token's authority via a long approver_token expiry. Caller authority is bounded by `caller_token.exp` regardless of approver_token expiry; execution past `caller_token.exp` must be aborted even if the approver token is still within its own expiry window.
- Treating a `deny` ApprovalRecord as absent. A signed deny is an audit artifact and must be retained with the same persistence guarantees as a signed allow.

## Acceptance Criteria

- [ ] A cross-node dispatch originating on one daemon and received by another produces a cryptographically verifiable ApprovalRecord envelope containing both caller and approver PASETO v4.public tokens with matching `request_body_hash` and correct `bound_jti` linkage.
- [ ] Target-side Cedar evaluation binds `principal` exclusively to the verified `sub` claim of the caller_token after signature verification succeeds.
- [ ] Dispatches with invalid caller_token signatures, expired caller_tokens, mismatched `request_body_hash`, or replayed `dispatch_id` values are rejected before Cedar evaluation and emit `dispatch.rejected` with a specific reason.
- [ ] Runtime nodes reject dispatches for undeclared capabilities before requesting target-owner approval.
- [ ] Dangerous capability classes (`shell.command`, `network.egress`, `destructive_git`, `mcp_elicitation`) require a session-owner-signed capability-declaration approval record before the capability becomes schedulable.
- [ ] Target-owner-denied dispatches persist the signed deny envelope and cannot be retried under the same `dispatch_id`.
- [ ] Scheduler routes same-node tasks without emitting cross-node dispatch events; cross-node hops always emit the full dispatch lifecycle.
- [ ] Caller-token expiry during pending approval auto-denies the request with reason `caller_token_expired`.
- [ ] Partner detach mid-execution does not abort remote execution; results buffer and deliver on reconnect within `caller_token.exp + 5 minutes`.
- [ ] Policy engine errors fail closed and emit an ops alert; dispatches never proceed on policy-engine failure.
- [ ] Clock skew beyond ±120s between caller and target is rejected at intake.

## ADR Triggers

- If PASETO v4 adds native multi-signature support, or if the project adopts a token format that does (e.g., Biscuit v5, JWT-with-multi-sig-extension), the composite-envelope shape in §Dual-Signed ApprovalRecord must be revisited and a new ADR created.
- If the V1.1 shared event log (per [ADR-017](../decisions/017-shared-event-sourcing-scope.md)) ships, cross-node dispatch events may gain a shared-log projection; this spec's "per-daemon log is authoritative" claim must be re-examined in that ADR.
- If a non-Cedar policy engine is adopted, the `principal = verified_caller_sub` binding pattern must be re-specified for the new engine.
- If the relay gains plaintext visibility (any deviation from [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)'s zero-knowledge model), the dispatch payload privacy guarantees must be re-examined.

## Open Questions

- Should the ApprovalRecord envelope gain a third signer when a non-owner approver acts on behalf of the owner (e.g., an elevated collaborator)? V1 scopes approval to target-node owner only; delegated approval is a V1.1 open question.
- How does this spec compose with V1.1 MLS group encryption per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)? Dispatch payloads are currently pairwise-encrypted; MLS would change the fan-out story but not the dual-signed ApprovalRecord shape.

## References

### Specs And ADRs

- [Spec-003 — Runtime Node Attach](./003-runtime-node-attach.md) — capability declaration source of truth.
- [Spec-012 — Approvals, Permissions, And Trust Boundaries](./012-approvals-permissions-and-trust-boundaries.md) — approval categories and membership-does-not-imply-execution invariant.
- [Spec-006 — Session Event Taxonomy And Audit Log](./006-session-event-taxonomy-and-audit-log.md) — canonical event names.
- [Spec-008 — Control Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md) — pairwise encryption and relay envelope semantics.
- [Spec-020 — Observability And Failure Recovery](./020-observability-and-failure-recovery.md) — NTP requirements and ops alert delivery.
- [ADR-007 — Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md).
- [ADR-010 — PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md).
- [ADR-012 — Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md).
- [ADR-017 — Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md).

### External Primary Sources

- [Cedar Policy Syntax](https://docs.cedarpolicy.com/policies/syntax-policy.html) — principal / action / resource / context expression syntax (Cedar Policy Project, undated / living document).
- [Cedar Entities Syntax](https://docs.cedarpolicy.com/auth/entities-syntax.html) — entity attribute schema (Cedar Policy Project, undated / living document).
- [AWS Verified Permissions — Identity sources and tokens](https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/identity-sources.html) — canonical pattern for mapping verified JWT `sub` to Cedar `principal`, ID-token claims to principal attributes, access-token claims to `context` (AWS, undated / living document).
- [PASETO v4 Protocol](https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md) — v4.public Sign/Verify uses a single Ed25519 key (Paragon Initiative Enterprises / PASETO Standard, undated / living document).
- [PASERK Specification](https://github.com/paseto-standard/paserk) — covers key wrapping and key identifiers; does not define token-wrapping types for multi-sig envelopes (Paragon Initiative Enterprises, undated / living document).
- [PASETO Payload Processing Implementation Guide](https://github.com/paseto-standard/paseto-spec/blob/master/docs/02-Implementation-Guide/01-Payload-Processing.md) — footer usage and cryptographic key identification patterns (Paragon Initiative Enterprises, undated / living document).
- [RFC 9449 — OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://datatracker.ietf.org/doc/rfc9449/) — `cnf.jkt` thumbprint semantics reused inside PASETO claims (IETF, September 2023).
- [Teleport Just-In-Time Access Requests](https://goteleport.com/docs/identity-governance/access-requests/) — precedent for per-request runtime approval in cross-machine developer tooling (Teleport / Gravitational, undated / living document).
- [Teleport Audit Events Reference](https://goteleport.com/docs/reference/audit-events/) — `access_request.create` (T5000I) and `access_request.review` (T5002I) event structures, referenced as the pattern for Spec-024's request/approval/execution event split (Teleport / Gravitational, undated / living document).
