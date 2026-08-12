# ADR-025: Runtime-Node Control-Plane Caller Authorization

| Field | Value |
| --- | --- |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Security And Authorization` |
| **Date** | `2026-08-10` |
| **Author(s)** | `Claude` |
| **Reviewers** | `User — ratified 2026-08-10 (Option A, Reading 1; heartbeat negative = thrown 403)` |

> **Ratification record.** Authored for [BL-141](../backlog.md) and ratified by the user on 2026-08-10: **Option A** (transaction-interior, row-locked ownership-and-membership predicate) with **Reading 1** on the one point where this decision diverged from an already-ratified campaign design — every non-permitted verdict collapses into the contracted `runtimenode.permission_denied` (403), and `heartbeat`'s negative is a thrown 403 rather than a silent success-shaped no-op. The divergence and its adjudication are recorded, not erased, at §Adjudication Record — Resolved At Ratification. Enforcement lands in code under Plan-003 T3.10–T3.12; this ADR binds the design, not the shipment date.

## Context

The five `runtimenode.*` control-plane procedures — `attach`, `heartbeat`, `capabilityupdate`, `detach` (mutations) and `roster` (the control-plane-only query) — are shipped in `packages/control-plane/src/runtime-nodes/`. They are the surface through which a Local Runtime Daemon announces itself into a shared session, keeps its presence row fresh, refreshes its declared capabilities, and leaves.

[ADR-002](./002-local-execution-shared-control-plane.md) makes the daemon the execution authority and the control plane the shared-coordination authority; [ADR-007](./007-collaboration-trust-and-permission-model.md) separates membership roles from runtime-node trust from run approvals from tool grants, and its §Success Criteria states that "Membership alone never authorizes cross-node local execution". Together they mean a runtime-node attachment row is a _participant-owned_ object: it names the participant on whose behalf a specific machine joined a specific session.

That ownership relation is presently unenforced. Four of the five procedures resolve their target row by `nodeId` (plus, for `attach`, `session_id`) with no predicate tying the row to the authenticated caller, and the fifth enumerates a session's whole roster with no membership predicate at all.

## Problem Statement

How should the control plane decide that the caller of a `runtimenode.*` procedure is authorized to act on the attachment row that procedure resolves — and how should it refuse when they are not, without leaking whether the row, the session, or the membership exists?

### Trigger

[BL-141](../backlog.md) records a P1 horizontal-privilege-escalation (BOLA / IDOR) finding against the shipped code. Concretely, from the code as it stands:

- `runtime-node-router.factory.ts#createRuntimeNodeRouter` resolves a caller for `attach` **only**. Its `heartbeat`, `capabilityupdate`, `detach`, and `roster` procedures destructure `{ input }` alone and never call `deps.resolveCurrentParticipantId`. The factory's own AUTH POSTURE banner names both gaps as Tier-5-deferred.
- The one check that does exist compares the caller against **client-supplied input** (`input.participantId !== current`), not against the persisted row — precisely the pattern [OWASP API1:2023](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) calls out as insufficient: "Comparing the user ID of the current session (e.g. by extracting it from the JWT token) with the vulnerable ID parameter isn't a sufficient solution to solve Broken Object Level Authorization (BOLA)." It is also a bare `!==` against a branded UUID whose schema admits mixed case.
- `attach-service.ts#AttachService` runs **zero** `session_memberships` queries: a caller who is not a member of the session at all can attach a node into it.
- `attach-service.ts#AttachService` `detach` issues `UPDATE runtime_node_attachments SET state = … WHERE node_id = $1 AND state IN (…)` — any caller who knows a `node_id` can evict another participant's machine from a session.
- `attach-service.ts#AttachService` `updateCapabilities` selects `id, state, client_version, session_id … FOR UPDATE` and does not even _read_ `participant_id`, so no ownership comparison is possible in the shipped shape.
- `heartbeat-service.ts#HeartbeatService` `ingest` is a single unconditional `INSERT … ON CONFLICT (node_id) DO UPDATE` against `runtime_node_presence` with **no attachment lookup at all**: any `node_id`, including one that was never attached, forges a presence row and keeps a foreign node advertised as live.
- `attach-service.ts#AttachService` `readRoster` returns every `runtime_node_attachments` row for a session verbatim — including each row's `participant_id` — to any caller, its header explicitly deferring "session existence/authorization" to "the router tier's concern", where nothing implements it.

The surface is not yet reachable by untrusted traffic (control-plane PASETO validation lands with Plan-008 R1 per [ADR-010](./010-paseto-webauthn-mls-auth.md)), which is why this is a pre-exposure hardening decision rather than an incident. BL-141's §V1 Release Impact states the constraint plainly: the procedures MUST NOT be exposed to untrusted multi-participant traffic until the ownership guard is enforced.

## Decision

**We adopt a direct ownership-and-membership predicate, evaluated inside each service's own database transaction, against row state held under a row lock, in a fixed canonical lock order — Option A.** Cedar (Option B) and a pre-built Cedar seam (Option C) are rejected for this class of check, with a named revisit criterion.

The decision has eleven parts.

### D1 — The enforcement point is inside the service transaction, never a router-tier middleware

Authorization is computed from the same rows, in the same transaction, under the same locks as the mutation it authorizes. A tRPC middleware that pre-fetches the attachment row to authorize it would (a) double-fetch and (b) open a check-to-use window in which a concurrent `detach`, revocation, or membership suspension commits between the middleware's read and the service's write. This satisfies [OWASP ASVS v5.0](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x17-V8-Authorization.md) **8.3.1** ("Verify that the application enforces authorization rules at a trusted service layer") and **8.2.2** ("data-specific access is restricted to consumers with explicit permissions to specific data items to mitigate insecure direct object reference (IDOR) and broken object level authorization (BOLA)").

The router keeps exactly one job: resolve the authenticated caller and pass it down (D2).

### D2 — Caller identity flows as an explicit `callerParticipantId` service parameter

Every one of the five service methods takes `callerParticipantId: ParticipantId` as an explicit parameter. The router resolves it once via `deps.resolveCurrentParticipantId(ctx)` and forwards it; the service never reaches into a tRPC context. This keeps the services transport-agnostic (the four mutations are dual-transport per `Spec-003 §Interfaces And Contracts`), makes the guard unit-testable without an HTTP layer, and means the guard becomes production-live with **zero code change** the moment Plan-008 R1 makes `resolveCurrentParticipantId` return a PASETO-verified `sub` instead of throwing.

Caller identity is never read from the request body. Client-supplied `participantId` on `attach` is treated as an _assertion to be checked_, not as identity (D5).

### D3 — One classification helper with four verdicts

```
classifyRuntimeNodeCaller(transaction, callerParticipantId, attachmentRow)
  → "owner_active_member" | "owner_inactive_member" | "member_not_owner" | "not_visible"
```

- The **owner** sub-check compares `canonicalizeUuid(attachmentRow.participant_id) === canonicalizeUuid(callerParticipantId)` — using the already-shipped `packages/contracts/src/uuid-canonical.ts#canonicalizeUuid`, because the branded `ParticipantId` schema admits mixed case (RFC 9562 §4) while Postgres returns canonical lowercase. `membership-service.ts#MembershipService` establishes the same normalization with a bare `.toLowerCase()`; new call sites use the named helper.
- The **membership** sub-check reads the caller's own `session_memberships` row for the attachment's `session_id` and tests `state === 'active'`.
- The owner sub-check **may not short-circuit** the membership query. A participant who has been suspended or revoked from the session must not keep driving nodes into it merely because they still own the attachment row — that is the ADR-007 layering collapsing into "whoever attached first keeps authority forever".

Authorization outcome per verdict:

| Verdict | `attach` | `heartbeat` | `capabilityupdate` | `detach` | `roster` |
| --- | --- | --- | --- | --- | --- |
| `owner_active_member` | permit | permit | permit | permit | permit (membership is the whole predicate) |
| `owner_inactive_member` | refuse | refuse | refuse | **permit** | refuse |
| `member_not_owner` | refuse (row is another participant's) | refuse | refuse | refuse | permit (roster is session-scoped, not row-scoped) |
| `not_visible` | refuse | refuse | refuse | refuse | refuse |

`owner_inactive_member` **may `detach` and nothing else.** This is not a courtesy. `idx_node_attachments_active` is a partial `UNIQUE(node_id)` scoped to the active states and is **global**, not per-session (`Plan-003 §Invariants` I-003-5). If a suspended owner could not detach, their node's active row would pin that `node_id` forever and the machine could never attach anywhere again — a permanent denial of service triggered by an ordinary membership action. The tempting alternative fix, having the membership path retire attachments, is forbidden by `Plan-003 §Invariants` I-003-3 ("`MembershipUpdate` MUST NOT trigger runtime-node detach as a side effect"). Detach is the release valve, and it is safe: it can only move the caller's _own_ row toward `offline`.

### D4 — `not_visible` maps to each procedure's own no-active-row response, never to a distinct one

This is the oracle-closing rule, and it is what makes the guard information-preserving rather than information-leaking. A caller must not be able to discriminate "this node does not exist", "this node exists but is yours", "this session does not exist", and "you are not a member" by observing different refusals.

| Procedure | Response for `not_visible` and for every non-permitted verdict |
| --- | --- |
| `detach` | the existing idempotent `null` no-op — byte-identical to detaching an already-`offline` node |
| `heartbeat` | the uniform negative (§Adjudication Record) |
| `capabilityupdate` | the uniform negative — **the overloaded 409 is split**: today `runtimenode.capabilityupdate_conflict` covers both "no active row" and the I-003-2 `registering`-cannot-be-driven-`online` state guard. The no-active-row arm moves to the uniform negative; the genuine state-guard arm keeps the 409. |
| `roster` | the uniform negative for "nonexistent session OR not an active member"; `{ nodes: [], controlHolder: … }` **only** for a session the caller can genuinely see that has no attachments |
| `attach` | the uniform negative for non-member and nonexistent-session — superseding today's silent success and today's raw FK-violation 500 |

**Accepted residual, recorded rather than closed.** `attach` still answers `runtimenode.attach_conflict` (409) when a `node_id` is actively attached somewhere the caller cannot see. That is a one-bit "this node id is attached to _some_ session" channel and it is inherent to I-003-5's global uniqueness — the constraint's whole purpose is to be observable. Its exploitability is bounded by node-id unguessability — which is a **daemon-side property**, not a schema guarantee: `NodeId` is a bounded `TEXT` column (`packages/contracts/src/node-id.ts`), so the daemon's id-minting choice is what supplies the entropy — and, once [Plan-021](../plans/021-rate-limiting-policy.md)'s Tier-6 rate-limiting surface lands, by those limits. **Revisit criterion:** if I-003-5 is ever relaxed to per-session uniqueness (multi-session node sharing, deferred per `Spec-003 §Resolved Questions and V1 Scope Decisions`), this residual disappears and the 409 should collapse into the uniform negative in the same change.

### D5 — `attach` carries two authorization axes, and the identity pre-guard is what makes the second one real

- **Axis (a) — session membership (new).** Inside the transaction, take the level-1 `sessions` lock while reading `min_client_version` (D8). Zero rows → uniform negative (this also replaces the current raw-FK-violation path with a typed refusal). Then take the caller's `session_memberships` row at level 2 and require `state = 'active'`. Only then run the upsert.
- **Axis (b) — node-identity ownership (already enforced structurally).** The shipped upsert's `ON CONFLICT … DO UPDATE … WHERE runtime_node_attachments.participant_id = EXCLUDED.participant_id` predicate plus the active partial-unique index already prevent one participant from taking over another's `node_id` row. Axis (b) needs **tests**, not new enforcement code.
- **The pre-guard that makes axis (b) trustworthy.** Axis (b) compares the _row's_ owner against `EXCLUDED.participant_id`, which comes from the request body. Without a check that the body's `participantId` is the caller, an attacker simply sets `participantId` to the victim and the upsert predicate happily matches. So before the transaction opens, `attach` refuses when `canonicalizeUuid(callerParticipantId) !== canonicalizeUuid(validated.participantId)` — a cheap, allocation-free, pre-I/O ownership-spoof guard. The router's existing self-check is retained (defence in depth at the transport tier) and canonicalized so it stops being case-sensitive.

### D6 — `heartbeat` gains a transaction and the same resolve

`ingest` stops being an unconditional presence upsert. It runs the D8 two-phase resolve, and the presence row is writable **only through an owned, active attachment**. A `node_id` with no active attachment, or with an attachment the caller does not own, gets the uniform negative and writes nothing. This closes presence forgery, which today lets any caller keep an arbitrary node advertised as `online` and thereby defeat the T3.6 staleness sweep for that node.

`heartbeat` reads no version floor, so it skips level 1 entirely — skipping a level is order-consistent and does not create an ABBA cycle.

### D7 — `roster` is a session-membership predicate folded into the read, in one statement

The roster is a **session-scoped enumeration**, not a per-row ownership check: any _active member of the session_ may enumerate the session's full node roster, because `Spec-003 §Interfaces And Contracts` requires a faithful projection (all five `state` values verbatim, both health axes, no server-side hiding) and AC2 distinguishability depends on it. Filtering rows by caller would break the spec's projection contract; the right predicate is at the session boundary.

Because the uniform negative collapses "not a member" and "no such session" (§Adjudication Record), the authorization decision needs no `sessions` row and therefore **no lock and no transaction** — one `READ COMMITTED` statement is one snapshot, so no revocation can interleave between predicate and projection. The prescribed shape drives the whole read from the caller's own membership row:

```sql
SELECT m.participant_id AS viewer,
       attachment.node_id, attachment.participant_id, attachment.state, …
FROM session_memberships m
LEFT JOIN runtime_node_attachments attachment ON attachment.session_id = m.session_id
LEFT JOIN sessions s                          ON s.id = m.session_id
LEFT JOIN runtime_node_presence presence      ON presence.node_id = attachment.node_id
WHERE m.session_id = $1 AND m.participant_id = $2 AND m.state = 'active'
```

Zero rows ⇒ not an active member, or no such session ⇒ uniform negative. One or more rows with `attachment.node_id IS NULL` ⇒ a visible session with no attachments ⇒ `{ nodes: [] }`. This is the shape [error-contracts.md §Runtime Node](../architecture/contracts/error-contracts.md#runtime-node) already ships for the sibling `runtimenode.signingkeyroster` surface ("the membership predicate and the roster read are one SQL statement — one READ COMMITTED snapshot"), generalized. It is strictly simpler than the locked transaction the campaign design prescribed, and the simplification is a _consequence_ of the ratified Reading 1 (§Adjudication Record), not independent of it.

The `readOnly` per-row derivation keeps reading `sessions.min_client_version` in the same statement, and the `controlHolder` projection joins the same statement when the Plan-024 Phase 3B lease table lands.

**Honesty note.** BL-141 exit criterion (c) asks for tests proving "an unauthorized roster enumeration is refused with a typed authorization error". Under D7 the refusal is an enumeration-scoped negative, not a per-row 403 — there is no per-row authorization on this surface to produce one. The test proves the enumeration itself is refused.

### D8 — Locking discipline: one canonical order, weakest sufficient mode, two-phase resolve for `nodeId`-keyed procedures

The lock order is the canonical one registered at [cross-plan-dependencies.md §Lock Ordering Across Shared Tables](../architecture/cross-plan-dependencies.md#lock-ordering-across-shared-tables), whose level-2 slot the Plan-006 T4.10 registration (2026-07-31) explicitly reserved for this work:

```
sessions → session_memberships → runtime_node_attachments → daemon_signing_public_keys
```

That four-level sequence is the **union across registrants**, not any single registrant's own path — a distinction worth stating because the map has moved since the reservation was recorded. Plan-006 T4.10 registered all four levels in July, but the 2026-08-11 admission-time signing-key registration decoupling deleted its `runtime_node_attachments` acquisition (no attachment row exists at admission time to read), so that registrant now instantiates levels 1, 2, and 4 — `sessions` → `session_memberships` → `daemon_signing_public_keys`. This decision's runtime-node mutators register levels 1–3. Skipping a level is order-consistent and creates no cycle, and the reserved level-2 slot is untouched by that decoupling: it is exactly the slot this decision now occupies.

`I-003-6` (new) makes it binding for Plan-003. It is a **prefix-consistent extension** of the canonical order, not a competing declaration: the runtime-node mutators occupy levels 1–3 in the same relative order, and nothing is re-ordered.

Modes, weakest that actually conflicts, grounded in [PostgreSQL Table 13.3](https://www.postgresql.org/docs/current/explicit-locking.html):

| Level | Table | Mode | Why this is the weakest sufficient mode |
| --- | --- | --- | --- |
| 1 | `sessions` | `FOR KEY SHARE` on `attach`; `FOR SHARE` where the transaction must serialize against a floor change | `FOR KEY SHARE` "blocks other transactions from performing `DELETE` or any `UPDATE` that changes the key values" — exactly the existence guarantee `attach` needs — and it is the same mode the upsert's own foreign key takes implicitly, so no lock upgrade occurs. It does **not** conflict with `FOR NO KEY UPDATE`, the mode a floor-raising `UPDATE sessions SET min_client_version = …` acquires; that is acceptable here **only because the read-only verdict is derived, never persisted** — what the attachment row stores is `client_version`, and every later verdict site (`attach`, `capabilityupdate`, and each roster row) re-derives the answer from it against the then-current floor via `attach-service.ts#AttachService`'s shared `#deriveReadOnly`. A lost floor race therefore yields one stale response field, never durable corruption. A surface that needs the floor verdict to be authoritative-at-write takes `FOR SHARE` instead (the Plan-006 T4.10 registration surface does). |
| 2 | `session_memberships` | `FOR SHARE` | An authorization **read**. `FOR SHARE` conflicts with `FOR NO KEY UPDATE` — the mode `membership-service.ts#MembershipService`'s suspend/revoke `UPDATE` takes — so a concurrent revocation cannot commit between classification and mutation. `FOR KEY SHARE` would **not** conflict and would be a silent no-op guard. `FOR UPDATE` would needlessly serialize membership. The transaction writes nothing here, so `Plan-003 §Invariants` I-003-3 holds (see D11). |
| 3 | `runtime_node_attachments` | `FOR NO KEY UPDATE` on mutator paths; `FOR SHARE` on read-only authorization | The mutators update `state` / `capabilities` / `client_version`. `state` sits only in a **partial** unique index, and PostgreSQL states that for the `FOR UPDATE`-escalation rule "partial indexes and expressional indexes are not considered" — so those updates take `FOR NO KEY UPDATE` natively, and matching that mode is sufficient. It conflicts with `detach`'s concurrent state `UPDATE`, with the other mutators, and with a Path-2 erasure `DELETE` (which takes `FOR UPDATE`). The shipped `updateCapabilities` `SELECT … FOR UPDATE` is strictly stronger and remains correct; T3.10 narrows it for uniformity. |

**Two-phase resolve** — required for `heartbeat`, `capabilityupdate`, and `detach`, which are keyed on `nodeId` alone and therefore cannot know their `session_id` before reading the attachment. Taking the attachment lock first to learn the session would invert levels 3 and 1–2 and deadlock ABBA against `attach`. So:

1. **Unlocked pre-read** by `node_id` over the active states, yielding a `(session_id, participant_id)` snapshot. This read authorizes nothing.
2. Take level 1 (`sessions`, only if the procedure needs the floor), then level 2 (`session_memberships` `FOR SHARE`), then level 3 (the attachment `FOR NO KEY UPDATE`).
3. **Re-verify** the locked row's `(session_id, participant_id)` against the step-1 snapshot. On mismatch — a concurrent detach and re-attach elsewhere — fail closed with the uniform negative. The daemon's next heartbeat re-attempts naturally; a bounded single retry is a permitted refinement, not a requirement.

Step 3 is the part that is easy to omit and fatal to omit: without it, the transaction holds locks derived from a stale snapshot and the verdict was computed against a row that no longer exists in that shape. PostgreSQL's own deadlock guidance is the other half — "the best defense against deadlocks is generally to avoid them by being certain that all applications using a database acquire locks on multiple objects in a consistent order… One should also ensure that the first lock acquired on an object in a transaction is the most restrictive mode that will be needed for that object."

### D9 — The uniform negative is `runtimenode.permission_denied` (403)

See §Adjudication Record — Resolved At Ratification. Every non-permitted verdict on `attach` / `heartbeat` / `capabilityupdate` / `roster` collapses into the already-contracted `runtimenode.permission_denied` (domain code, HTTP 403, tRPC `FORBIDDEN`), with `detach`'s idempotent `null` unchanged. No new error code is created.

### D10 — Symbol ownership for the refusal is Plan-006 T4.10's, consumed by Plan-003

`runtimenode.permission_denied` exists **as a doc row only**. `packages/contracts/src/error.ts` ships three `RUNTIME_NODE_*` codes (attach-conflict, attach-revoked, capabilityupdate-conflict) and `runtime-nodes/errors.ts` ships four `AisWireException` subclasses; neither carries a permission-denied member. Grep confirms only `MEMBERSHIP_PERMISSION_DENIED_CODE` and `INVITE_PERMISSION_DENIED_CODE` exist in code today.

`Plan-006 §Target Areas` already declares the CREATE: T4.10 "registers two typed registry-only codes — `RUNTIME_NODE_SIGNING_KEY_CONFLICT_CODE` … and `RUNTIME_NODE_PERMISSION_DENIED_CODE` (dotted `runtimenode.permission_denied`, 403)". That declaration stands; this ADR adds no ownership-map churn.

Consequently the BL-141 code leg **consumes** the symbol, and:

- If Plan-006 T4.10's contracts leg lands first, Plan-003 T3.10 imports it and adds only the `runtime-nodes/errors.ts` exception class binding.
- If BL-141 lands first, Plan-003 T3.10 creates `RUNTIME_NODE_PERMISSION_DENIED_CODE` under the `error.ts` registration seam (the same seam Plan-003 already used for its three sibling codes) and records a one-line note at `Plan-006 §Cross-Plan Amendments`; T4.10 then consumes rather than creates. **Ordering is not a hard precondition on a P1 fix** — whichever lands first creates, and the loser's plan text is trued up in that same PR.

### D11 — Invariant changes

- **I-003-3 (amended).** The invariant's "attach/detach never mutate `session_memberships`" property is preserved verbatim; the amendment states that a `FOR SHARE` **authorization read** of `session_memberships` is not a mutation and is expressly permitted. The service header comments in `attach-service.ts#AttachService` that today assert attach "never references, SELECTs FOR UPDATE, or UPDATEs that table" become false and must be rewritten in the same commit, not left to drift. The invariant's Verification clause keeps requiring the byte-unchanged-row assertion.
- **I-003-6 (new).** Every control-plane transaction touching `runtime_node_attachments` acquires locks in the canonical order of D8, in the recorded modes, with the two-phase resolve for `nodeId`-keyed procedures. Verified by a lock-ordering regression test using the logging-proxy `Querier` pattern already shipped at `packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts`.

### Thesis — Why This Option

Three properties make the direct predicate the right mechanism here, and each is a property Cedar would have to reproduce rather than provide.

**It is atomic with the mutation it authorizes.** The predicate is evaluated from rows the transaction holds locked, and the write happens before those locks are released. There is no window. Every alternative that evaluates authorization from a snapshot taken outside the transaction — a middleware pre-fetch, an external policy service, an entity store marshalled before `BEGIN` — reintroduces the check-to-use gap. This is the crux: the vulnerability class is not "we forgot to check", it is "we checked something that could change".

**The predicate is genuinely two-field.** `caller == row.participant_id AND caller's membership is active`. There is no hierarchy to traverse, no delegation, no attribute algebra, no time-of-day condition, no group nesting. Both facts are columns in tables the transaction is already reading. A policy language buys expressiveness that is not needed and costs an evaluation boundary that is actively harmful (above).

**The refusal surface is already contracted.** `error-contracts.md §Runtime Node` ships a `runtimenode.permission_denied` (403) row with an explicit no-oracle rationale and an explicit reservation of tRPC `NOT_FOUND` for a different purpose. Reusing it keeps one namespace with one refusal vocabulary, and the sibling `runtimenode.signingkeyroster` surface already demonstrates the single-statement membership-predicate shape D7 adopts.

The design-richness rule is satisfied and not violated by the simplicity: the _capability_ delivered is complete — all five procedures, both axes on `attach`, presence forgery closed, roster enumeration scoped, oracle-free refusals, lock-ordered and deadlock-free, tested with cross-owner two-account suites at three layers. Nothing is deferred. What is declined is a heavier _mechanism_, not a smaller _feature_.

### Antithesis — The Strongest Case Against

**OWASP says exactly this pattern is not enough.** API1:2023 states that comparing the session's user ID against an ID parameter "isn't a sufficient solution to solve BOLA" and "could address only a small subset of cases". A reviewer reading D3 as "compare two UUIDs" is reading a documented anti-pattern.

**Scattered predicates rot.** The most durable finding in multi-tenant security literature is that per-call-site ownership checks are forgotten. The OWASP Multi Tenant Security Cheat Sheet's §3 warns that you should "Implement authorization checks at the data access layer, not just API layer" precisely because "we cannot rely on developers remembering to add the right filter in every code path". Five hand-written predicates today become nine when Plan-027 adds cross-node dispatch, and the tenth is the one that ships unguarded — which is exactly how the current defect arose: `attach` got a check and its four siblings did not.

**Cedar is not speculative here.** [ADR-012](./012-cedar-approval-policy-engine.md) already commits the project to Cedar. Choosing a second, incompatible authorization mechanism means V1 ships two ways to express "who may do what", and the daemon-side approval policies and the control-plane row guards can drift apart with no analyzer able to see both. Cedar policies are "completely separate from your application's code", independently auditable, and the language is formally verified by automated reasoning — properties a hand-rolled `if` never has.

**And the packaging objection is now stale.** The campaign design cited `cedar-policy/cedar#1226` (the `@cedar-policy/cedar-wasm` Node-ESM `exports` gap) as a live blocker. It is **closed**, resolved by PR #1256. That leg of the rejection no longer holds.

### Synthesis — Why It Still Holds

The antithesis is right about the danger and wrong about the remedy.

**On OWASP's "not sufficient".** The warning is aimed at implementations that compare the session identity against a **client-supplied parameter** — which is precisely, and only, what the shipped `attach` router check does today, and precisely what D5's pre-guard demotes from "the check" to "a cheap early refusal". The predicate this ADR adopts compares the caller against the **persisted row's owner, read under lock**, and conjoins an independent membership-state check. That is the mechanism OWASP's own "How To Prevent" list asks for: "Use the authorization mechanism to check if the logged-in user has access to perform the requested action on the record in every function that uses an input from the client to access a record in the database." _Every function_ — which is D1's scope, all five, not the one that has it today. ASVS 8.3.3's "access to an object is based on the originating subject's permissions, not on the permissions of any intermediary" is the same instruction with the daemon named as the intermediary.

**On rot.** Rot is a real risk and it is answered structurally, not by discipline: a **single shared helper** (`classifyRuntimeNodeCaller`, D3) is the only place the verdict is computed, so a new procedure that forgets it is a procedure that never obtained a verdict at all; the **two-account IDOR suite** (T3.12) is a merge gate, satisfying OWASP's fourth prevention bullet, "Write tests to evaluate the vulnerability of the authorization mechanism. Do not deploy changes that make the tests fail."; and the **lock-ordering regression test** pins the order a new call site must join. Cedar would not have prevented the current defect either — the four unguarded procedures do not call _any_ authorization mechanism, and an unmade `isAuthorized()` call fails exactly as open as an unwritten `if`.

**On the second mechanism.** ADR-012 does not scope Cedar to all authorization; it scopes Cedar to the **nine daemon-side approval categories** — human-consent decisions about tool execution, where policy authorship by a human operator is the whole point. A control-plane row-ownership predicate is not policy in that sense: there is no operator-authored rule, no configuration surface, no expected variation. Routing it through Cedar would not unify two policy surfaces; it would put a policy engine underneath something that is not policy. The layering ADR-007 mandates is preserved by keeping them distinct, not by collapsing them.

**On #1226.** The stale citation is corrected here rather than carried forward, and the rejection does not need it. The load-bearing objection survives intact: a Cedar authorization request decides against **entity data the calling application supplies at evaluation time**, and no database lock binds the resulting `permit` to the write that follows it. A verdict computed from a snapshot taken outside the transaction is precisely the check-to-use shape D1 exists to eliminate; marshalling _locked_ rows into Cedar entities inside the transaction to avoid that is strictly more machinery to reach the same guarantee a two-field comparison already has. And the control plane has **zero** Cedar dependency today: adopting it here means shipping a resident WASM policy engine, a signature-verification path, an entity-marshalling layer, and a YAML→Cedar build step into the control plane to answer `a == b AND state = 'active'`.

**Revisit criterion (named, so this is not a permanent no).** Re-evaluate a policy engine — Cedar shared with approvals, or CASL — for this surface if and only if the predicate acquires relational or conditional structure: node→organization hierarchies, delegated operators acting for a node owner, per-capability or time-bounded attach grants, or a third principal type on this surface. Any one of those makes the predicate a policy, and a policy belongs in a policy language.

## Alternatives Considered

### Option A: Direct ownership + membership predicate, transaction-interior, row-locked (Chosen)

- **What:** D1–D11 above. One shared classification helper, four verdicts, evaluated from locked rows inside each service transaction, refusals collapsed into one contracted 403.
- **Steel man:** Atomic with the mutation, minimal new surface, reuses a shipped error contract and a shipped lock order, and delivers the complete capability now rather than a staged fraction of it.
- **Weaknesses:** Five call sites to keep honest; the verdict logic lives in TypeScript rather than in an auditable policy artifact; a security reviewer cannot diff "the policy" independently of the code.

### Option B: Cedar policy evaluation per ADR-012 (Rejected)

- **What:** Model `Participant`, `Session`, `RuntimeNodeAttachment` as Cedar entities; author `permit(principal, action, resource) when { resource.owner == principal && principal.membership == "active" }`; evaluate through the resident `@cedar-policy/cedar-wasm` engine on every `runtimenode.*` call.
- **Steel man:** One authorization mechanism across daemon approvals and control-plane rows; policies independently authorable, updatable, analyzable and auditable; Cedar is formally verified by automated reasoning; the ownership predicate is idiomatic Cedar (`when { resource.placedBy == principal }`); ADR-012 already pays the adoption cost, so the marginal cost is entity marshalling only.
- **Why rejected:** (1) **Atomicity.** A Cedar request decides against entity data the application supplies at evaluation time, and nothing binds the `permit` to the subsequent state transition — so the verdict is computed from a snapshot the write cannot pin. That is the exact defect class BL-141 is about; recovering atomicity requires marshalling _locked_ rows into entities inside the transaction, which is strictly more machinery for the same answer. (2) **Scope.** ADR-012 scopes Cedar to nine daemon-side approval categories — operator-authored consent policy — not to control-plane row ownership; this predicate has no authorship surface and no expected variation. (3) **Cost.** Zero Cedar dependency exists in the control plane today; this would introduce a WASM engine, signature verification, an entity-marshalling layer and a build-time compile step to evaluate a two-field comparison, on every heartbeat, at the 15-second cadence `Spec-003 §Required Behavior` sets, per node. (4) The `cedar#1226` packaging objection cited by the campaign design is **no longer valid** (closed via PR #1256) and is not relied on. Revisit criterion as stated in §Synthesis.

### Option C: Hybrid — predicate now, Cedar hook later (Rejected)

- **What:** Implement the predicate, but behind a `RuntimeNodeAuthorizer` interface with a Cedar-backed implementation stubbed, so the engine can be swapped in without touching call sites.
- **Steel man:** Preserves optionality at near-zero cost; makes the eventual migration a one-line dependency-injection change; the seam doubles as a test seam.
- **Why rejected:** The seam is unexercised abstraction against a dependency that does not exist in this package, and an interface designed with no second implementation in hand reliably fits the second implementation badly. Worse, the seam is a lie about atomicity: a swappable authorizer implies the verdict is computable from arguments, which is exactly what a transaction-interior, lock-holding predicate is not — the honest interface would have to take the open transaction, at which point it is not swappable for an external engine anyway. The design-richness rule asks for capability delivered now, not mechanism weight carried now; a stub delivers no capability. The named revisit criterion (§Synthesis) preserves the option at zero carrying cost.

### Option D: Router-tier tRPC middleware that loads and authorizes the row (Rejected)

- **What:** A `nodeOwnerProcedure` middleware that resolves the attachment by `nodeId`, checks ownership and membership, and attaches the row to `ctx` for the service.
- **Steel man:** The idiomatic tRPC composition pattern; impossible to forget on a new procedure once the base procedure is the default; centralizes the check in one visible place.
- **Why rejected:** It double-fetches, and — decisively — it authorizes a row read **outside** the service transaction, so a concurrent detach, revocation, or membership suspension can commit between the middleware's read and the service's write. It also cannot participate in the canonical lock order, since it has no transaction to lock in. Notably, [trpc.io/docs/server/authorization](https://trpc.io/docs/server/authorization) offers no object-ownership primitive at all — its guidance stops at an `isAuthed` authentication middleware — so this is not a framework-blessed pattern being declined, it is a hand-rolled one. The framework's real contribution is kept (context-based caller resolution, D2); the row decision stays where the lock is.

## Adjudication Record — Resolved At Ratification

**Resolved 2026-08-10 in favor of Reading 1.** This section records a divergence that was adjudicated, not one that is open. It is retained in full because the divergence is from an already-ratified document and a future reader is entitled to see what was weighed rather than only what was chosen.

`docs/superpowers/specs/2026-07-09-bl-resolution-campaign-design.md` §3.1 decision 4 (Status `approved`, 2026-07-10) prescribed a **new** `runtimenode.not_found` code, HTTP 404 / tRPC `NOT_FOUND`, as the uniform negative. Three weeks later — 2026-07-31, Plan-006 T4.10, Codex PR #274 rounds 3–4 — `error-contracts.md §Runtime Node` shipped `runtimenode.permission_denied` (403) whose row ends: "deliberately never tRPC `NOT_FOUND`, which this namespace reserves as the old-control-plane procedure-absence discovery signal".

|  | Reading 1 — adopt `permission_denied` 403 (**ratified**) | Reading 2 — honor the design's `not_found` 404 (declined) |
| --- | --- | --- |
| Namespace consistency | Uses the one refusal code the `runtimenode` namespace already contracts | Adds a second refusal vocabulary to the same namespace |
| `NOT_FOUND` reservation | Respected. The reservation is namespace-wide, and the unshipped daemon heartbeat sender is exactly the client that would need to tell "your control plane is too old, retry with backoff" apart from "stop, you do not own this node" — opposite reactions to one wire code | Violated in text. Narrowly survivable in practice: the T4.10 registrar calls only `runtimenode.signingkeyregister` over a single-procedure caller, so no _shipped_ retry loop breaks today |
| Campaign-design decision 5 (R5) | **Honored more completely.** R5 asks for two-tier-403-over-flat-404; a full `permission_denied` collapse is that posture applied to the outer tier too | Partially honored — R5's own outer tier stays 404 |
| New contract surface | None. The doc row exists; only the code binding is new | A new code + row + exception class, on top of `permission_denied` |
| Lock cost on `roster` | None — the 403 collapse reads no `sessions` row for the decision, so one statement suffices (D7). `api-payload-contracts.md` already records this asymmetry for the sibling surface | A 404 negative must distinguish nonexistent-session, so `roster` needs the `sessions` read and a locked transaction |
| Diagnostics lost | A legitimate active member who mistypes a `node_id` sees 403 rather than 404. Non-security; recorded in §Negative | None — the 403/404 distinction survives for a legitimate member, which is this reading's one genuine advantage |
| Semantic honesty | Slight overload: "no such node" answered as "forbidden" | Slight overload in the other direction: "not yours" answered as "not found" — the more common industry convention |

**Ratified: Reading 1.** The controlling reason is that this is a _later-ruling reconciliation_, not a silent narrowing of a ratified decision: the T4.10 `NOT_FOUND` reservation postdates the campaign design by three weeks and is the shipped contract, and an ADR must not enter the corpus contradicting `error-contracts.md` as it currently stands. The campaign design's decision 4 is **superseded on this point by this ADR** and is corrected in the campaign plan's Task 2 in the same PR that lands this file; decisions 1–3 and 5–9 are adopted unchanged.

**Second call, also ratified.** Under Reading 1 `heartbeat`'s negative is a **thrown 403**, not a silent success-shaped no-op. The silent-no-op alternative leaks less and avoids a chatty error path at a 15-second per-node cadence, and it was weighed on those merits. It was declined because a daemon whose heartbeats are silently discarded has no way to learn its attachment was revoked, and silent discard would make the presence-forgery fix undetectable to an honest client — an observability loss on exactly the surface the fix exists to make observable. The cadence cost is accepted and recorded in §Consequences → Negative.

**Consequences of the ratification, recorded so no reader re-derives them.** `roster` keeps the single-statement shape of D7 (a 404 negative would have forced it back into a locked transaction); no new error code is created; the T4.10 `NOT_FOUND`-reservation sentence in `error-contracts.md §Runtime Node` stands unamended; and the `runtimenode.permission_denied` row gains the four mutating procedures plus the roster read as call sites.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `resolveCurrentParticipantId` will return a cryptographically verified participant when Plan-008 R1 lands, with no signature change. | `runtime-node-router.factory.ts#createRuntimeNodeRouter` `RuntimeNodeRouterDeps` already types it `(ctx: SessionRouterContext) => ParticipantId`; ADR-010 puts the caller's identity on the PASETO `sub`. | The guard authorizes a spoofable identity — it becomes decoration. Detection: the throwing stub is the current implementation, so the failure is loud, not silent. |
| 2 | An active `session_memberships` row is the correct authority signal for "may act in this session". | `membership-service.ts#MembershipService` uses `state === 'active'` as its own gate; ADR-007 makes membership the collaboration-authority layer. | If a second authority signal exists (e.g. an org-level grant), members could be under-authorized and non-members over-authorized. |
| 3 | `runtime_node_attachments.participant_id` is the true owner of the attachment and is never rewritten to another participant. | The shipped upsert's `WHERE runtime_node_attachments.participant_id = EXCLUDED.participant_id` predicate forbids cross-owner rewrite; I-003-5's global partial unique index forbids a parallel row. | Ownership becomes forgeable and D3's owner sub-check is meaningless. Pinned by T3.12's axis-(b) regression tests. |
| 4 | `state` is not a key column for PostgreSQL's `FOR UPDATE`-escalation rule, so mutator updates take `FOR NO KEY UPDATE`. | PostgreSQL §13.3 Explicit Locking: the escalation set is columns with "a unique index on them that can be used in a foreign key (so partial indexes and expressional indexes are not considered)"; `idx_node_attachments_active` is partial. | Level-3 mode is stronger than documented — safe direction (more conflicts, not fewer), but the "weakest sufficient" claim in D8 would be wrong. |
| 5 | A single `READ COMMITTED` statement is one snapshot, so D7's roster read cannot interleave a revocation between predicate and projection. | PostgreSQL READ COMMITTED semantics: each statement takes a new snapshot; `error-contracts.md §Runtime Node` already relies on this for `runtimenode.signingkeyroster`. | The roster could project rows for a caller revoked mid-statement. Bounded: one stale read, no write. |
| 6 | `owner_inactive_member`-may-detach does not create an escalation path. | `detach` can only move the caller's own row toward `offline`; it writes no membership and grants nothing. | A revoked participant retains a live capability. Mitigated by the narrowness — one action, own row, monotonic toward inactive. |
| 7 | Denying detach to an inactive owner would strand the node permanently. | I-003-5's `idx_node_attachments_active` is `UNIQUE(node_id)` **globally**, not per session; I-003-3 forbids the membership path from retiring attachments. | If the index were per-session, D3's `owner_inactive_member` exemption could be dropped and the model would be uniformly deny-on-inactive. |
| 8 | No `runtimenode.*` client depends on the current unauthorized behavior. | The surface is pre-exposure; `resolveCurrentParticipantId` throws in production today. | The four behavior changes (D4/D5/D6/D7) break a live consumer. Detection: the four-suite migration plus the `client-sdk` integration ripple named in §Mandated Work. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A future `runtimenode.*` procedure ships without calling `classifyRuntimeNodeCaller` | Med | High | Two-account IDOR suite has no case for it — a gap the reviewer must notice, not a failing test | Single shared helper; T3.12 suite as merge gate; the plan task text names the helper as mandatory for any new procedure |
| Two-phase resolve omits the step-3 re-verify | Med | High | Requires a concurrency test; invisible under serial testing | T3.12 carries an explicit interleaving case; the re-verify is a named acceptance step in T3.10 |
| Lock order violated by a new call site → ABBA deadlock under load | Low | Med | Postgres deadlock errors in production; the lock-ordering regression test in CI | I-003-6 plus the logging-proxy `Querier` test pattern from `memberships/__tests__/lock-ordering.test.ts` |
| `session_memberships` locked `FOR KEY SHARE` instead of `FOR SHARE` | Low | High | **None at runtime** — it is a silent no-op guard that admits a concurrent revocation | Mode recorded normatively in D8 and in `cross-plan-dependencies.md`; asserted by the lock-ordering test, which must assert the mode, not just the order |
| Refusal arms diverge and reopen an oracle (e.g. a distinct message for "no such session") | Med | Med | Manual review; message-equality assertions | T3.12 asserts byte-identical refusals across all four negative causes per procedure |
| A legitimate daemon is locked out mid-session by an over-strict membership check | Low | High | Attach/heartbeat failures for honest clients | `owner_inactive_member`-may-detach; admit-not-eject (I-003-1) is untouched — a below-floor daemon is still admitted read-only |
| Heartbeat's added transaction raises write load at 15s per node | Low | Low | Control-plane latency metrics | The transaction is three short indexed reads plus one upsert; Plan-021 rate limits bound the worst case |
| Plan-006 T4.10 and Plan-003 T3.10 both create `RUNTIME_NODE_PERMISSION_DENIED_CODE` | Med | Low | Merge conflict or duplicate export at typecheck | D10's first-lander rule with a same-PR true-up of the loser's plan text |

## Reversibility Assessment

- **Reversal cost:** Medium. The guard itself is deletable, but four behavior changes become observable contracts the moment a client depends on them (attach refusing non-members, heartbeat refusing unowned nodes, roster refusing non-members, capabilityupdate's split negative). The lock order is the expensive part: once three plans' transactions instantiate it, changing it is a coordinated multi-plan edit.
- **Blast radius:** `packages/control-plane/src/runtime-nodes/` (all four files), `packages/contracts/src/error.ts`, four control-plane test suites, `packages/client-sdk/test/runtimeNodeClient.integration.test.ts`, `Spec-003`, `Plan-003` (§Invariants + Phase 3), `Plan-008` I-008-4, `error-contracts.md`, `cross-plan-dependencies.md`.
- **Migration path:** Forward-only. The guard is additive to the wire shape — no request or response type changes; only refusal arms and previously-succeeding calls change. A rollback restores the vulnerability, so the practical path is forward fixes, not revert.
- **Point of no return:** When a shipped client (SDK or daemon) branches on the `runtimenode.permission_denied` refusal, or when a fourth plan joins the canonical lock order. Before then this is a two-way door in practice despite its Type 2 classification.

## Consequences

### Positive

- Closes the BL-141 BOLA/IDOR class on all five procedures, satisfying ASVS 8.2.2 / 8.3.1 / 8.3.3 and all four OWASP API1:2023 prevention bullets including the tests bullet.
- Closes presence forgery: `runtime_node_presence` becomes writable only through an owned active attachment, restoring the T3.6 staleness sweep's integrity.
- Refusals carry no membership, attachment-existence, or session-existence oracle.
- Authorization is atomic with mutation — no check-to-use window — and deadlock-free by a recorded, tested lock order that extends the shipped one as a prefix.
- `attach` gains a typed refusal where it previously returned a raw FK-violation 500 for an unknown session.
- No new wire types, no new dependency, no new error code (per the ratified Reading 1), and the guard goes production-live with zero further code change when Plan-008 R1 lands.

### Negative (accepted trade-offs)

- Five call sites carry an authorization obligation that a linter cannot enforce; correctness rests on the shared helper plus the merge-gating test suite.
- The verdict is TypeScript, not an independently auditable policy artifact — a real loss relative to Cedar, accepted because atomicity outranks auditability for this predicate.
- A legitimate member who mistypes a `node_id` loses the 403/404 diagnostic distinction. Non-security; the trade the no-oracle rule demands.
- `heartbeat` moves from one statement to a transaction — more control-plane work at the 15-second per-node cadence.
- Four shipped behaviors change, forcing a build-breaking migration of four control-plane suites plus a cross-package `client-sdk` ripple.
- `attach` and `detach` now read `session_memberships`, so I-003-3's header comments (which currently assert the table is never referenced) must be rewritten; the invariant's substance survives, its prose does not.

### Unknowns

- Whether cross-node dispatch (Plan-027 / Spec-024) will need a third principal type on this surface — a delegated operator acting for a node owner — which would trip the §Synthesis revisit criterion.
- Whether operators will want to author node-attach policy at all, or whether attach authority remains purely structural.
- Whether the `attach_conflict` one-bit channel proves practically exploitable under Plan-021's rate limits.

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan (§Assumptions Audit rows 1, 3, 4, 8 are pinned by T3.12 tests; row 5 by the single-statement shape)
- [x] At least one alternative was seriously considered and steel-manned (Options B, C, D)
- [x] Antithesis was reviewed by someone other than the author — user review, 2026-08-10; Option A ratified with Reading 1, and the antithesis's live leg (the stale `cedar#1226` citation) was corrected rather than carried forward
- [x] Failure modes have detection mechanisms (except the silent `FOR KEY SHARE` no-op, whose mitigation is a mode-asserting test precisely because it has no runtime detection)
- [x] Point of no return is identified and communicated to the team — identified in §Reversibility Assessment (a shipped client branching on `runtimenode.permission_denied`, or a fourth plan joining the canonical lock order) and communicated at ratification; T3.10–T3.12 carry it forward as the code-side gate

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Cross-owner mutation refused on every mutating procedure | 4 of 4 | T3.12 two-account IDOR suite at service, router, and HTTP layers | `pending` — at T3.12 merge |
| Non-member roster enumeration refused | 100% | T3.12 roster enumeration case | `pending` — at T3.12 merge |
| Refusal responses byte-identical across all negative causes per procedure | 100% | T3.12 message-equality assertions | `pending` — at T3.12 merge |
| Presence row writable only via an owned active attachment | 100% | T3.10 heartbeat forgery-rejection case | `pending` — at T3.12 merge |
| Lock order and modes match I-003-6 | 100% of transactions touching `runtime_node_attachments` | Logging-proxy `Querier` lock-ordering regression test | `pending` — at T3.12 merge |
| BL-141 exit criterion (d) — guard enforced in code | Enforced and test-exercised at all five procedures | Code review + suite | `pending` — at T3.12 merge |

**Honest scope of criterion (d).** The guard is enforced in code and exercised by tests, but production traffic stays behind the throwing `resolveCurrentParticipantId` until Plan-008 R1 lands PASETO validation. This is the maximum honest satisfaction of (d) available pre-Tier-5; it is not a claim that untrusted traffic is now safely admitted.

## Mandated Documentation And Implementation Work

### Spec-003 amendment (§Interfaces And Contracts + §Required Behavior)

Records the authorization precondition for all four mutating procedures **and** the session-scoped enumeration precondition for the roster read (BL-141 exit criterion (b)), plus the four behavior changes: `attach` now enforces session membership; `heartbeat` closes presence forgery; the roster's empty-for-unknown-session response is superseded by the uniform negative; `capabilityupdate`'s no-active-row arm splits out of the 409.

**Hard constraint on how it is written.** The 2026-08-03 projection-conformance amendment records that "Plan-003 carries ~80 `Spec-003 line NNN` coverage cites, so this spec's amendments are held to zero net line change". The BL-141 amendment must therefore extend an existing blockquote in place, not add lines. A drive-by paragraph here silently breaks roughly eighty plan cites.

**Status.** `Spec-003` and `Plan-003` were **already `review`** (2026-08-03 V1 product-vision reconciliation), so there was no fresh `approved → review` flip — the campaign design's flip language is stale on this point. The BL-141 amendment growth is folded into the scope of the targeted readiness-audit delta that restores both — the same vehicle that lands this file — rather than opening a second flip/restore cycle.

### `error-contracts.md §Runtime Node`

Extend the `runtimenode.permission_denied` row's description to name the four mutating procedures and the node-roster read as additional call sites (it currently names only the two signing-key call sites). Per D4, narrow `runtimenode.capabilityupdate_conflict` to its surviving state-guard arm in the same pass — its no-active-row arm moves to the uniform negative.

### `cross-plan-dependencies.md §Lock Ordering Across Shared Tables`

Convert the level-2 reservation note ("whose level-2 slot the BL-141 campaign design reserved") into a shipped second registrant row for the runtime-node mutators, recording the per-level modes of D8 including the `sessions` `FOR KEY SHARE` / `FOR SHARE` divergence and why it is safe. In the same pass, scope the existing registrant's unqualified "`FOR KEY SHARE` would be a silent no-op guard" claim to the floor-serialization purpose it was written about, so the two rows do not contradict each other.

### Plan-003 — three Phase-3 tasks (existing tasks run T3.0–T3.9)

- **T3.10 — classification helper + typed refusal + per-procedure negatives.** Add `classifyRuntimeNodeCaller`; extend `updateCapabilities`'s `SELECT` to include `participant_id` and narrow its `FOR UPDATE` to `FOR NO KEY UPDATE`; wire the two-phase resolve into `heartbeat` / `capabilityupdate` / `detach`; split `capabilityupdate`'s overloaded 409; bind the `runtimenode.permission_denied` exception class in `runtime-nodes/errors.ts` (creating `RUNTIME_NODE_PERMISSION_DENIED_CODE` in `packages/contracts/src/error.ts` only if Plan-006 T4.10 has not landed it — D10); rewrite the I-003-3 header comments in `attach-service.ts#AttachService` in the same commit.
- **T3.11 — `attach` membership guard + roster membership predicate.** Add `attach`'s pre-transaction identity pre-guard and its level-1/level-2 locks; canonicalize the router self-check; fold the membership predicate into `readRoster`'s single statement per D7.
- **T3.12 — two-account IDOR suite + axis-(b) regressions + lock-ordering block.** Cross-owner cases at service, router, and HTTP layers for all five procedures; oracle-equality assertions; the concurrency case that fails without the step-3 re-verify; `attach` axis-(b) ownership-spoof regressions; a lock-ordering block asserting order **and mode**.

### Plan-003 §Invariants

- **I-003-3 (amended)** per D11.
- **I-003-6 (new)** per D11 — the canonical lock order, modes, and two-phase resolve.

### Plan-008

Amend `Plan-008 §I-008-4 — PASETO v4 validation on every Tier-5 endpoint` (verified present; the Tier-5 decomposition of I-008-2) to name the five `runtimenode.*` procedures in its gated-endpoint list, so the verified identity D2 depends on is contractually required rather than incidentally supplied.

### Suite migration (build-breaking)

`packages/control-plane/src/runtime-nodes/__tests__/attach-service.test.ts`, `heartbeat-service.test.ts`, `runtime-node-router.test.ts`, and `packages/control-plane/src/server/__tests__/host-runtime-node.test.ts`, plus the cross-package ripple into `packages/client-sdk/test/runtimeNodeClient.integration.test.ts`. Every one of these constructs calls that currently succeed without a caller; the four service methods' new required `callerParticipantId` parameter breaks them at compile time, which is the desired failure mode.

**Note on `createCaller`.** `TRPCError.code` and `.cause` are visible through `createCaller`, but `shape.data.aisError` only materializes over the HTTP handler via the shared `errorFormatter` in `sessions/trpc.ts`. Router-tier tests must assert on `code`/`cause`; the `aisError` projection is asserted at the HTTP layer.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| OWASP API Security Top 10 — API1:2023 Broken Object Level Authorization | Primary (standard) | "Use the authorization mechanism to check if the logged-in user has access to perform the requested action on the record **in every function** that uses an input from the client to access a record in the database"; "Write tests to evaluate the vulnerability of the authorization mechanism. Do not deploy changes that make the tests fail"; and the explicit warning that comparing the session user ID with an ID parameter "isn't a sufficient solution" — the anti-pattern the shipped router check instantiates | https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/ |
| OWASP ASVS v5.0 — V8 Authorization | Primary (standard) | 8.2.2 object-level restriction to mitigate IDOR/BOLA; 8.2.3 field-level (BOPLA); 8.3.1 enforcement "at a trusted service layer"; 8.3.3 decisions based on "the originating subject's permissions, not on the permissions of any intermediary or service acting on their behalf" | https://github.com/OWASP/ASVS/blob/master/5.0/en/0x17-V8-Authorization.md |
| OWASP Multi Tenant Security Cheat Sheet | Primary (standard) | §1: "Get tenant from verified JWT claims — NOT from headers"; §3: "Implement authorization checks at the data access layer, not just API layer" and "Always validate that requested resources belong to the current tenant" | https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html |
| PostgreSQL 18 documentation §13.3 Explicit Locking | Primary (vendor doc) | Table 13.3 conflict matrix: `FOR SHARE` conflicts with `FOR NO KEY UPDATE` and `FOR UPDATE`; `FOR KEY SHARE` conflicts only with `FOR UPDATE`. A non-key `UPDATE` takes `FOR NO KEY UPDATE`; FK-referenced rows take `FOR KEY SHARE`; the `FOR UPDATE`-escalation column set excludes partial indexes. Deadlock guidance: consistent order, and "the first lock acquired on an object in a transaction is the most restrictive mode that will be needed for that object" | https://www.postgresql.org/docs/current/explicit-locking.html |
| tRPC v11 — Authorization | Primary (framework doc) | Guidance stops at context-based caller resolution plus an `isAuthed` authentication middleware; the framework offers **no** object-ownership or per-resource authorization primitive, so an ownership middleware would be hand-rolled, not framework-blessed | https://trpc.io/docs/server/authorization |
| `cedar-policy/cedar` issue #1226 | Primary (issue tracker) | `@cedar-policy/cedar-wasm` `./nodejs` subpath lacked an `import` condition, breaking ESM import on Node 20. Opened 2024-09-24, **CLOSED**, resolved by PR #1256 — the campaign design's citation of this as a live blocker is **stale** and is not relied on by this ADR | https://github.com/cedar-policy/cedar/issues/1226 |
| Cedar Policy Language Reference — Authorization | Primary (vendor doc) | A Cedar authorization request is principal / action / resource / context, evaluated against policies **and entity data that the calling application supplies at evaluation time** — the authorizer "look[s] up … in the provided entities data". Establishes both that Cedar _can_ express this predicate and that the facts it decides on are a caller-supplied snapshot, with nothing binding the resulting `permit` to the write that follows | https://docs.cedarpolicy.com/auth/authorization.html |
| `docs/superpowers/specs/2026-07-09-bl-resolution-campaign-design.md` §3.1, §4.A | Repo (approved design) | The ratified content contract for this ADR: decisions 1–9, the three Plan-003 tasks, the invariant changes, and the suite-migration list. This ADR adopts 1–3 and 5–9 unchanged and **supersedes decision 4's negative shape**, ratified 2026-08-10 (§Adjudication Record); the campaign plan's Task 2 is corrected in the same PR | `docs/superpowers/specs/2026-07-09-bl-resolution-campaign-design.md` |
| `error-contracts.md §Runtime Node` | Repo (canonical contract) | Ships `runtimenode.permission_denied` (403) with a no-oracle rationale and reserves tRPC `NOT_FOUND` namespace-wide as the pre-upgrade procedure-absence signal; records the single-statement membership-predicate pattern D7 generalizes | [error-contracts.md §Runtime Node](../architecture/contracts/error-contracts.md#runtime-node) |
| `cross-plan-dependencies.md §Lock Ordering Across Shared Tables` | Repo (canonical map) | Registers the canonical `sessions` → `session_memberships` → `runtime_node_attachments` → `daemon_signing_public_keys` order — the union across registrants, each of which may skip a level it does not need — with weakest-sufficient modes, and reserves the level-2 slot for this work | [cross-plan-dependencies.md §Lock Ordering Across Shared Tables](../architecture/cross-plan-dependencies.md#lock-ordering-across-shared-tables) |
| `membership-service.ts#MembershipService` | Repo (shipped code) | The precedent lock discipline: resolve target's `session_id` pre-lock, lock `sessions`, **re-read the full row under the lock**, resolve the actor's membership post-lock, gate, then mutate — the shape D8's two-phase resolve mirrors | `packages/control-plane/src/memberships/membership-service.ts` |

### Related ADRs

- [ADR-002: Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [ADR-007: Collaboration Trust And Permission Model](./007-collaboration-trust-and-permission-model.md) — the layering this decision operates inside; no layer is added, removed, or re-scoped
- [ADR-010: PASETO WebAuthn MLS Auth](./010-paseto-webauthn-mls-auth.md) — supplies the verified caller identity D2 forwards
- [ADR-012: Cedar Approval Policy Engine](./012-cedar-approval-policy-engine.md) — scoped to the nine daemon-side approval categories; this decision does not extend it to control-plane row ownership
- [ADR-017: Shared Event Sourcing Scope](./017-shared-event-sourcing-scope.md) — the control plane authors no durable event, so no authorization-decision event is emitted
- [ADR-018: Cross Version Compatibility](./018-cross-version-compatibility.md) — I-003-1 admit-not-eject is untouched; a below-floor daemon is still admitted read-only

### Related Specs And Plans

- [Spec-003: Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Plan-003: Runtime Node Attach](../plans/003-runtime-node-attach.md)
- [Plan-006: Session Event Taxonomy And Audit Log](../plans/006-session-event-taxonomy-and-audit-log.md) — T4.10, the declared creator of `RUNTIME_NODE_PERMISSION_DENIED_CODE`
- [Plan-008: Control Plane Relay And Session Join](../plans/008-control-plane-relay-and-session-join.md) — I-008-4 amendment

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-08-10 | Drafted | Initial draft for BL-141. Adopts campaign-design decisions 1–9; diverges on decision 4's negative shape (`runtimenode.permission_denied` 403 in place of a new `runtimenode.not_found` 404) per §Adjudication Record — Resolved At Ratification, and corrects the design's stale `cedar#1226` citation (closed 2024, resolved by PR #1256) without relying on it. Status stays `proposed` pending user ratification. |
| 2026-08-10 | Ratified — `proposed → accepted` | User ratified **Option A** with **Reading 1**, including the second call (`heartbeat`'s negative is a thrown 403, not a silent no-op). §Open Adjudication For Ratification is rewritten as §Adjudication Record — Resolved At Ratification, preserving the comparison table as the record of what was weighed. Consequential same-PR edits, landed 2026-08-12: `error-contracts.md §Runtime Node` (`permission_denied` call sites extended; `capabilityupdate_conflict` narrowed to its surviving state-guard arm per D4), `cross-plan-dependencies.md §Lock Ordering Across Shared Tables` (level-2 reservation converted to a shipped registrant row per D8, and the existing row's `FOR KEY SHARE` no-op claim scoped to its floor-serialization purpose), `Spec-003` (§Required Behavior authorization precondition, zero net lines), `Plan-003` (T3.10–T3.12, I-003-3 amended, I-003-6 new), `Plan-008` (I-008-4's gated-endpoint list names the five `runtimenode.*` procedures — landed **in this same vehicle**, with Plan-008 flip-and-restored `approved` in the same swap, superseding the draft's bilateral-handoff plan, which assumed a Plan-008 restore vehicle that landed 2026-08-11 without this leg), and the campaign plan's Task 2 (decision-4 premise superseded). Both Pre-Implementation Checklist boxes resolved. D8's attribution of the four-level lock order was repaired in the same pass: the order is the union across registrants, and Plan-006 T4.10's own path lost its `runtime_node_attachments` level to the 2026-08-11 admission-time registration decoupling. Code enforcement is **not** in this PR — BL-141 stays open until T3.10–T3.12 ship. |
