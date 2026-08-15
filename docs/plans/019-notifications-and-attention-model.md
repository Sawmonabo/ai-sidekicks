# Plan-019: Notifications And Attention Model

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `019` |
| **Slug** | `notifications-and-attention-model` |
| **Date** | `2026-04-14` (Tier-8 readiness audit 2026-08-10) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-019: Notifications And Attention Model](../specs/019-notifications-and-attention-model.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-014](../decisions/014-trpc-control-plane-api.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) (added by the Tier-8 audit — load-bearing for §Data And Storage Changes' no-event-payload rule, CP-019-1, and D-019-1's runs-are-daemon-local ground), [ADR-018](../decisions/018-cross-version-compatibility.md) (added by the PR #318 review round — D-019-4's additive optional `runId` and the `NotificationEmitParams` widening rest on its published-shape compatibility rules) |
| **Dependencies** | [Plan-013](./013-live-timeline-visibility-and-reasoning-surfaces.md) (timeline visibility), [Plan-008](./008-control-plane-relay-and-session-join.md) (SSE catch-up cursor replay — `Spec-019 §Notification Delivery` routes reconnect catch-up for queued notifications through the Spec-008 EventSource `Last-Event-ID` resumption, so undelivered notifications re-deliver rather than re-derive), [Plan-022](./022-data-retention-and-gdpr.md) (participant-purge shred fan-out for the Plan-019-owned Postgres tables per CP-019-1 ⇄ CP-022-6), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (constructor-injected `DaemonCredentialProvider` credential seam — the CP-006-13 shape T3.1's `attention.notificationEmit` publisher authenticates through) — the Plan-008 and Plan-022 edges added by the Tier-8 audit (NS-20), the Plan-006 edge by its PR #318 review round, all mirroring the §3 dependency-graph rows |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement derived attention projections and desktop notification delivery that keep actionable session state visible even when the user is not watching the timeline.

## Scope

This plan covers attention projections, notification preferences, OS-notification delivery hooks, and degraded paths when notifications are unavailable.

## Non-Goals

- Mobile push delivery
- Marketing or email campaigns
- Full operator paging systems

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-8 audit (2026-08-10, PR #318): six findings adjudicated. Four record EXISTING relationships and add no contract surface — this box (019-F1), the §Implementation Phase Sequence with three phases and per-phase `#### Tasks` (019-F2), the [ADR-014](../decisions/014-trpc-control-plane-api.md) Required-ADRs row that the SSE-subscription delivery path in `Spec-019 §Desktop-to-Desktop Delivery` already depended on (019-F4), and §Invariants I-019-1..4 grounding the four properties §Test And Verification Plan already tested for (019-F5). **Two are new scope.** 019-F3: the durable control-plane `notification_queue` table (§Data And Storage Changes, D-019-1) that `Spec-019 §Cross-Device Delivery` assumes and no plan owned — verified against the corpus rather than assumed, because the alternative reading was that Plan-008 already provides it: Plan-008 owns `session_directory`, `relay_connections`, and `relay_seen_ephemeral_keys` and no durable stream; `Spec-008 §Required Behavior` states that the control plane stores no session events per [ADR-017](../decisions/017-shared-event-sourcing-scope.md); and the resumption Spec-008 does define is the EventSource `Last-Event-ID` header (`Spec-008 §Control-Plane Transport Protocol`), which is transport-level and has no durable backing store to replay from. There is therefore no existing substrate to ride, and the queue is Plan-019-owned. 019-F6: the aggregate-carrier derivation rule (§API And Transport Changes, D-019-2), stated over the existing `AttentionItem` shape. A new table plus the widened CP-019-1 shred reciprocal IS new contract surface, so the plan flipped `approved → review` on 2026-08-10 and this audit's targeted coverage of exactly that growth restores it `approved` in the same swap — flip-and-restore-in-one-swap, the NS-51 / NS-53 precedent. Companion amendments: shared-postgres-schema.md (a new §Notification Queue (Plan-019) section plus the invariant-(1) enumeration it extends), Plan-022 CP-022-6 (the `REFERENCES participants(id)` closure count moves twelve → thirteen). **PR #318 review round (2026-08-11): two further new-scope items beyond the audit's six findings** — D-019-3 (the [Attention Method-Name Registry](../architecture/contracts/api-payload-contracts.md#attention-method-name-registry-tier-8-plan-019) with the daemon-called `attention.notificationEmit` carrier and the T3.1/T3.2 emission ownership re-split) and D-019-4 (the `scope`/`runId` request-narrowing rule) — audited in the same swap under the same targeted coverage (the Plan-006 PR #278 self-audit shape), so the new-scope set this swap covers is D-019-1 through D-019-4 and no second flip loop opens.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/attention/`
- `packages/control-plane/src/notification-preferences/notification-preference-service.ts`
- `packages/runtime-daemon/src/attention/attention-projector.ts`
- `packages/runtime-daemon/src/attention/notification-emit-service.ts`
- `packages/runtime-daemon/src/ipc/handlers/` (the `attention.*` namespace handler files — the §2 IPC-row registration)
- `packages/client-sdk/src/attentionClient.ts`
- `apps/desktop/src/main/notifications/`
- `apps/desktop/src/renderer/src/attention/`

## Data And Storage Changes

- Add durable user-level `notification_preferences` storage and replay-derived attention projections keyed to canonical session or run state.
- **Add the Plan-019-owned durable `notification_queue` control-plane table** ([Shared Postgres Schema §Notification Queue (Plan-019)](../architecture/schemas/shared-postgres-schema.md#notification-queue-plan-019)) — one row per notification owed to a participant with no connected device, read back as a batch on that participant's next connect in `queue_sequence` order from the last delivered position, and purged 7 days after it was queued. **This bullet supersedes the plan's prior "keep delivery-attempt metadata ephemeral where possible" sentence** (D-019-1). `Spec-019 §Cross-Device Delivery` requires the control plane to queue notifications when no device is connected, to replay them from the last cursor on reconnect, and to retain the undelivered ones for 7 days before permanent deletion — three requirements no ephemeral store satisfies across a control-plane restart. What remains ephemeral is what the spec still leaves ephemeral: a delivery to a currently-connected device is pushed and recorded nowhere, and only the offline case reaches the queue. Outstanding actionable attention stays durable until resolved either way, because it lives in the replay-derived attention projection rather than in this queue — losing the whole queue costs missed notifications, never attention state (I-019-2).
- The queue holds derived notification-rendering fields plus a **reference** to the canonical triggering event, never an event payload, so it is compatible with the shared-schema invariants [ADR-017](../decisions/017-shared-event-sourcing-scope.md) imposes on every control-plane table addition; that compatibility check is recorded in the schema section above rather than asserted here.
- Maintain both run-scoped attention projections and session-scoped aggregate attention projections so client surfaces do not reconstruct aggregate state ad hoc.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-019 PRs and downstream extensions. Any change that would weaken or remove one requires a coordinated cross-plan amendment (see [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md)). Each grounds the property the §Test And Verification Plan bullets below already tested for; the Tier-8 audit gave them ids so a task's `Verifies invariant:` field can resolve to an entry rather than to prose.

- **I-019-1 — Attention state is derived from canonical session and run state, never from client heuristics.** Every attention item and every emitted notification traces to a canonical event or canonical run/session state; a transient client observation never mints attention, and a client that has observed nothing derives the same state on replay as one that watched the whole session. **Grounds in:** `Spec-019 §Required Behavior` ("Notification emission must be derived from canonical session or run state, not from client heuristics alone"), `Spec-019 §State And Data Implications` ("Attention state is a derived projection from canonical events"), `Spec-019 §Pitfalls To Avoid` ("Basing notifications only on transient client events"). **Why load-bearing:** it is what makes attention reproducible across devices and reconnects — the property the `notification_queue` catch-up path and the desktop surfaces both assume.
- **I-019-2 — Notification-delivery failure never removes in-app attention state.** A dropped SSE push, an OS notification the platform denies or suppresses, and a `notification_queue` row that expires unread are all delivery-layer outcomes; none of them clears, resolves, or hides the underlying attention item, which resolves only when the state that produced it resolves. **Grounds in:** `Spec-019 §Fallback Behavior` ("If notification delivery is delayed, the session attention projection must still reflect outstanding actionable items"; "If OS notifications are unavailable or denied, the system must still show in-app badges and attention summaries"), `Spec-019 §Acceptance Criteria` AC-2 ("Notification loss does not remove in-app attention state"). **Why load-bearing:** it is the reason the queue may be treated as a best-effort delivery buffer with a 7-day purge — losing it costs missed notifications, never attention state.
- **I-019-3 — Muting suppresses informational attention only; approval-required actionable attention still surfaces.** A participant's mute settings filter informational notifications at emit time, but neither the preference filter nor any client surface may suppress, downgrade, or hide actionable approval-required attention. **Grounds in:** `Spec-019 §Fallback Behavior` ("If a participant has muted a session or channel, critical approval-request attention may still surface while informational events remain muted"), `Spec-019 §Implementation Notes` ("suppression must not erase actual blocking session state"), `Spec-019 §Pitfalls To Avoid` ("Letting muted informational noise hide blocking approval state"). **Why load-bearing:** the mute filter runs at the control plane before a row is written or pushed, so a filter defect here is silent — nothing downstream can recover an attention item that was never emitted.
- **I-019-4 — Session-scoped aggregate attention stays actionable until every contributing actionable item resolves, and clients read it from the canonical projection rather than recomputing it.** The aggregate is `actionable` while any unresolved run-scoped, invite, or participant-request contributor is actionable, and it is served by `AttentionProjectionRead` — no client surface derives its own aggregate from a partial local view. **Grounds in (per leg):** the aggregate-resolution leg grounds in `Spec-019 §Default Behavior` ("session-scoped attention defaults to an aggregate of unresolved run, invite, and participant-request signals") and `Spec-019 §Example Flows` (the two-concurrent-runs flow, whose session aggregate "stays actionable until both are resolved"). The single-source leg and the deterministic representative-contributor selection chain in D-019-2 are **plan-owned**: no Spec-019 clause forbids client-side reconstruction or fixes a tiebreak order — `Spec-019 §Implementation Notes` asks only that the projection be queryable without full timeline replay — so the canonical-projection prohibition and the total tiebreak are enforcement this plan designs on top of the spec's stated behavior. **Why load-bearing:** ad-hoc client aggregation is how a session badge and its run badges drift apart, and a non-total tiebreak lets two readers of one projection state disagree about which contributor an aggregate names.

## Cross-Plan Obligations

- **CP-019-1 — `notification_preferences` + `notification_queue` Path-2 crypto-shred reciprocal (⇄ [Plan-022](./022-data-retention-and-gdpr.md) CP-022-6).** On a valid participant purge (`DELETE /participants/{id}/data`), the Plan-019-owned durable `notification_preferences` rows for the purged participant are **hard-DELETEd** in [Plan-022](./022-data-retention-and-gdpr.md)'s Postgres-side shred fan-out (`Spec-022 §Path 2 — Postgres PII rows (hard DELETE)`, §Shred Fan-Out Path 2). Unlike the `session_invites` / `session_memberships` rows (anonymized to preserve referential integrity, `Spec-022 §Postgres (Control Plane) Deletion`), preferences carry no audit-trail or foreign-key obligation, so they are removed outright. **Widened 2026-08-10 (Tier-8 audit, D-019-1): the new `notification_queue` table is a second Path-2 target under this same obligation, likewise hard-DELETE.** Its `participant_id` is `NOT NULL REFERENCES participants(id)` with the default `NO ACTION`, so it joins the closure Plan-022 CP-022-6 derives from the schema — moving that closure from twelve rows to thirteen — and the purge must delete its rows **before** the `DELETE FROM participants` anchor or the parent delete fails. Hard-DELETE rather than anonymize because a queued row's `summary` is a derived, human-readable render string that can name participants and session content: severing the FK alone would leave personal data behind, and the row carries no audit obligation to preserve (the canonical event it references survives in the emitting daemon's local log per [ADR-017](../decisions/017-shared-event-sourcing-scope.md)). Reciprocal of Plan-022 CP-022-6 (encoded fix-in-place at the Tier-5 audit swap, satisfying Plan-022 I-022-19; the queue half encoded fix-in-place at this Tier-8 swap); shred-handler provider: Plan-022 (V1.1, owns the cross-store fan-out).

## API And Transport Changes

- Add `AttentionProjectionRead`, `NotificationPreferenceRead`, `NotificationPreferenceUpdate`, and `NotificationEmit` to shared contracts and the typed client SDK. Their wire strings and transport assignments are registered in the [Attention Method-Name Registry](../architecture/contracts/api-payload-contracts.md#attention-method-name-registry-tier-8-plan-019) (D-019-3): `attention.projectionRead` rides the daemon JSON-RPC transport only (the projection is daemon-local per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) — the `timeline.*` posture), `attention.preferenceRead` / `attention.preferenceUpdate` ride control-plane tRPC only (the preference store is control-plane-owned — the `runtimenode.roster` posture), and no `attention.subscribe` exists (delivery bullet below).
- Require emitted notifications to reference the underlying canonical event or derived blocking state that triggered them.
- Deliver notifications over the existing control-plane SSE subscription rather than a new endpoint, per `Spec-019 §Desktop-to-Desktop Delivery` and [ADR-014](../decisions/014-trpc-control-plane-api.md); `Spec-019 §Cross-Device Delivery` adds no webhook surface in V1.
- **Daemon→control-plane notification carrier (D-019-3).** Emission crosses the daemon boundary as `attention.notificationEmit` — a control-plane tRPC `mutation`, **daemon-called**, never a client verb (the `eventanchor.upload` shape; response `null`, the `runtimenode.leaseupdate` pattern) — because the preference filter, the connected-device push, and the `notification_queue` are control-plane-owned while the attention items that trigger emission are daemon-derived. The daemon authors only the client call (T3.1), authenticated through the constructor-injected `DaemonCredentialProvider` (the Plan-006 CP-006-13 shape, minted per attempt); the control plane authors the mutation handler, the filter invocation, and the push-or-enqueue routing (T3.2). Not a relay op: [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md)'s relay is E2E peer connectivity, not a control-plane command channel, and the derived rendering fields are exactly the content the control plane must read to filter, queue, and purge (CP-019-1).
- **Aggregate-carrier derivation rule (D-019-2).** `Spec-019 §Required Behavior` requires attention at both run scope and session scope, and the shared `AttentionItem` shape in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) carries a single `trigger`, a single `severity`, and a single `sourceEventId` — leaving it unstated which field carries an aggregate over several unresolved contributors, and where a derived item's `sourceEventId` comes from. This plan fixes the rule; it changes no field shape:
  - **Scope discriminator, not a second type.** A session-scoped aggregate is an `AttentionItem` whose `runId` is **absent**; a run-scoped item carries `runId`. There is no separate aggregate type and no aggregate-only field.
  - **`severity` carries the aggregate.** The aggregate is `actionable` if **any** unresolved contributor (run-scoped item, pending invite, or participant request) is actionable, and `informational` only when every unresolved contributor is informational — the direct reading of `Spec-019 §Default Behavior`'s "aggregate of unresolved run, invite, and participant-request signals", and the property `Spec-019 §Example Flows`'s two-concurrent-runs example illustrates. It resolves (leaves the actionable set) only when the last contributing actionable item clears (I-019-4).
  - **`trigger` and `sourceEventId` come from one deterministically selected representative contributor** — highest severity first (`actionable` before `informational`), then earliest `createdAt`, then lexicographically smallest `id`. The tiebreak chain is total, so two readers of the same projection state derive the same aggregate rather than two that differ only in which contributor they happened to visit first. Selecting a real contributor rather than synthesizing a placeholder is what keeps `sourceEventId` resolvable, so the field stays non-optional and `Spec-019 §Interfaces And Contracts`'s "`NotificationEmit` must reference the underlying canonical event or state trigger" holds for every item the projection returns.
  - **Aggregates are read-projection-only.** They are returned by `AttentionProjectionRead` and are never the subject of a `NotificationEmit`: a notification is emitted from the single canonical trigger that caused it, so no aggregate is ever emitted and no per-contributor fan-out is inferred from one. This is why the rule needs no contract-shape change — the ambiguity was in the read projection, and it is resolved there.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define attention categories, run-scope and session-scope projection shapes, notification-preference contracts, and canonical trigger references in shared packages.
2. Implement replay-derived attention projections and preference storage with global defaults plus later extension points.
3. Implement desktop notification emission and degraded fallback to in-app badges and summaries when OS delivery is unavailable.
4. Add desktop attention surfaces that distinguish actionable and informational state without depending on transient client heuristics.

## Parallelization Notes

- Preference-storage work and attention-projection work can proceed in parallel once trigger enums are fixed.
- Desktop notification hooks should wait for stable attention categories and mute-behavior semantics.

## Test And Verification Plan

Each bullet below verifies a numbered invariant from §Invariants; the trailing id is the entry a task's `Verifies invariant:` field resolves to.

- Attention-projection tests covering approvals, required input, run completion, failures, invites, and direct participant requests — each derived from canonical state, none from a transient client observation (**I-019-1**)
- Notification-fallback tests proving lost or denied OS delivery does not erase in-app attention state (**I-019-2**)
- Queue tests proving an offline participant's notifications are queued, replayed as one batch in `queue_sequence` order from the last delivered position on reconnect, and purged 7 days after queueing — and that an expired-unread row leaves the underlying attention item intact (**I-019-2**)
- Preference tests covering mute behavior without hiding critical approval-required attention (**I-019-3**)
- Projection tests proving session-scoped aggregate attention resolves only when all underlying run-scoped actionable items are cleared, and that the aggregate's representative contributor is selected deterministically under the D-019-2 tiebreak chain (**I-019-4**)

## Implementation Phase Sequence

Plan-019 implementation lands as a sequence of small PRs at Tier 8. Phase 1 fixes the attention contracts and the trigger taxonomy every later layer keys on; Phase 2 lands the durable control-plane stores (preferences plus the `notification_queue`) and the replay-derived projections; Phase 3 lands emission and the delivery surfaces, degraded paths included. Each phase carries a `**Precondition:**` line so the merge order is reviewer-checkable, followed by the machine-readable form preflight Gate 5 reads. The §Implementation Steps numbering above is the same four-step vertical, decomposed here into per-PR tasks by the Tier-8 audit (019-F2); the phases are the §Rollout Order below made dispatchable, not a different plan.

### Phase 1 — Attention Contracts And Trigger Taxonomy

**Precondition:** Tier-8 plan-readiness audit complete (PR #318); Plan-001 Phase 2 merged — the shared contracts package plus the `SessionId` / `RunId` brands these payloads reference.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8-complete" }
  - { type: plan_phase, plan: 001, phase: 2, status: merged }
```

**Goal:** `packages/contracts/src/attention/` exports the attention and notification payload schemas with the trigger and severity domains fixed; no service, storage, or delivery code lands.

#### Tasks

##### T1.1 — `attention/attention.ts`: `AttentionItem` plus the trigger and severity domains

- **Files:** `packages/contracts/src/attention/attention.ts` (new), `packages/contracts/src/attention/__tests__/attention.test.ts` (new), `packages/contracts/src/index.ts` (add re-export).
- **Step:** Author `AttentionTriggerSchema` as a `z.enum` over the six trigger values and `AttentionSeveritySchema` as a `z.enum` over `actionable` / `informational`, both transcribed from the `AttentionItem` union in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) rather than re-derived. Author `AttentionItemSchema` (`.strict()`) with `id`, `sessionId`, optional `runId`, `trigger`, `severity`, `summary`, `sourceEventId` (required — never optional), `createdAt`, optional `resolvedAt`. `runId` presence is the scope discriminator per D-019-2; do not add an aggregate-only field.
- **Test:** assert the exported trigger set equals the six-value set exactly (neither superset nor subset), re-derived from the contract doc rather than transcribed from a plan gloss; assert `.strict()` rejects unknown keys; assert an item parses with `runId` absent and with it present; assert a payload omitting `sourceEventId` is rejected.
- **Spec coverage:** Spec-019 §Required Behavior (the minimum trigger set — pending approval or input, run completion, run failure, invite receipt, mention or direct request); Spec-019 §Default Behavior (the actionable-versus-informational split)
- **Verifies invariant:** none (contract-schema definition; the derivation behavior is verified in Phase 2)

##### T1.2 — `attention/projection.ts`: `AttentionProjectionRead` run-scope and session-scope shapes

- **Files:** `packages/contracts/src/attention/projection.ts` (new), `packages/contracts/src/attention/__tests__/projection.test.ts` (new).
- **Step:** Author `AttentionProjectionReadRequestSchema` (`.strict()`: `sessionId`, optional `scope` (`"run" | "session"`), optional `runId`) matching the canonical shape in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md), with the D-019-4 cross-field rule as a Zod refinement: `scope: "run"` requires `runId` (a run-scope read without a run identifier is refused at parse, never defaulted to all runs), and `runId` is admissible only with `scope: "run"`. Omitting `scope` reads the full projection — run-scoped items plus the aggregate; `scope: "session"` narrows to the aggregate alone. Author `AttentionProjectionReadResponseSchema` returning the run-scoped items plus the session-scoped aggregate as `AttentionItem` values — the aggregate carrying no `runId`, per the D-019-2 carrier rule in §API And Transport Changes. The response is the single source of aggregate state; no field invites a client to recompute it.
- **Test:** assert the response parses with an aggregate item whose `runId` is absent alongside run-scoped items that carry one; assert a response whose "aggregate" carries a `runId` is indistinguishable from a run-scoped item by construction (documenting that item scope is read off `runId`, not a flag); assert `scope: "run"` without `runId` fails to parse; assert `runId` with `scope: "session"` and `runId` with `scope` omitted both fail to parse; assert the three admitted request forms parse — bare `sessionId`, `scope: "session"`, and `scope: "run"` with `runId`.
- **Spec coverage:** Spec-019 §Interfaces And Contracts (`AttentionProjectionRead` exposes actionable and informational state at both run and session scope); Spec-019 §Required Behavior (both run-scoped and session-scoped aggregate attention)
- **Verifies invariant:** I-019-4 (the shape half — the aggregate is returned by the projection; its resolution behavior is verified at T2.4)

##### T1.3 — `attention/preferences.ts`: `NotificationPreferenceRead` and `NotificationPreferenceUpdate`

- **Files:** `packages/contracts/src/attention/preferences.ts` (new), `packages/contracts/src/attention/__tests__/preferences.test.ts` (new).
- **Step:** Author the read and update request/response schemas over per-surface preferences keyed by `preference_key`, matching the `notification_preferences` shape in [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md). Preferences are global per participant in V1; author no session-scoping field, so the deferred per-session extension cannot be half-shipped as a dormant column.
- **Test:** assert `.strict()` rejects a `sessionId` key on either shape (the V1 global-preference decision, asserted rather than assumed); assert mute settings round-trip through the `preference_value` payload.
- **Spec coverage:** Spec-019 §Interfaces And Contracts (`NotificationPreferenceRead` / `NotificationPreferenceUpdate` support per-surface preferences); Spec-019 §Resolved Questions and V1 Scope Decisions (global preferences in V1; per-session deferred)
- **Verifies invariant:** none (contract-schema definition; mute behavior is verified at T2.2)

##### T1.4 — `attention/emit.ts`: `NotificationEmit` with a required canonical-trigger reference

- **Files:** `packages/contracts/src/attention/emit.ts` (new), `packages/contracts/src/attention/__tests__/emit.test.ts` (new).
- **Step:** Author `NotificationEmitParamsSchema` (`.strict()`: `participantId`, `sessionId`, optional `runId`, `trigger`, `severity`, `sourceEventId`, `summary`, optional `metadata`), mirroring the shape in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md). `sourceEventId` is required at the type level: it is what makes "derived from canonical state" checkable by the compiler rather than by review. `sessionId` and `severity` are likewise required (D-019-3): the control-plane ingress (T3.2) authorizes against the named session and runs the severity-first T2.2 filter off the wire body, and the queue row's `session_id` / `severity` columns are `NOT NULL` — an emission the control plane could not authorize, filter, or queue is unrepresentable.
- **Test:** assert a payload omitting `sourceEventId` fails to parse; assert an out-of-enum `trigger` fails to parse; assert a payload omitting `sessionId` or `severity` fails to parse.
- **Spec coverage:** Spec-019 §Interfaces And Contracts (`NotificationEmit` must reference the underlying canonical event or state trigger)
- **Verifies invariant:** I-019-1 (the type-level half of canonical derivation — an emission with no canonical reference is unrepresentable)

### Phase 2 — Preference And Queue Storage Plus Replay-Derived Projections

**Precondition:** Phase 1 merged; Plan-001 Phase 4 merged — the control-plane migration runner plus the `participants` and `sessions` tables both new tables reference; Plan-013 Phase 2 merged — the replay-aware projection substrate the attention projector reads canonical events through.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 019, phase: 1, status: merged }
  - { type: plan_phase, plan: 001, phase: 4, status: merged }
  - { type: plan_phase, plan: 013, phase: 2, status: merged }
```

**Goal:** both Plan-019 control-plane tables exist, preference reads and updates work with mute semantics that cannot hide actionable attention, and the run-scoped and session-scoped projections are derived from canonical events, with the attention read/preference wire surface registered on both transports (T2.6). No OS-level or renderer delivery lands.

#### Tasks

##### T2.1 — Control-plane migration: `notification_preferences` plus `notification_queue`

- **Files:** a new migration under `packages/control-plane/src/migrations/`, plus its same-commit registration in the `MIGRATIONS` array in `packages/control-plane/src/sessions/migration-runner.ts`, plus a migration-shape test.
- **Step:** Inline both `CREATE TABLE` blocks verbatim from the schema doc — [§Notification Preferences (Plan-019)](../architecture/schemas/shared-postgres-schema.md#notification-preferences-plan-019) and [§Notification Queue (Plan-019)](../architecture/schemas/shared-postgres-schema.md#notification-queue-plan-019) — including the `-- Owner:` header and every per-column comment, together with the queue's two indexes. Resolve the migration's version index against the shipped `MIGRATIONS` array at build time; do not hard-code a number ahead of the tier's other migrations.
- **Test:** assert the applied migration creates both tables with the exact column sets; that `notification_queue.attention_trigger` (the keyword-avoidance rename of the wire field `AttentionItem.trigger`) and `severity` carry their CHECK domains and reject an out-of-domain value, with the admitted domains re-derived from the contract union rather than transcribed; that `CHECK (expires_at > queued_at)` rejects a row born expired; that `idx_notification_queue_undelivered` is partial on `delivered_at IS NULL` and `idx_notification_queue_expiry` exists; and that the migration is idempotent under the runner's version anchor.
- **Spec coverage:** Spec-019 §Cross-Device Delivery (queued in the control plane when no device is connected; 7-day retention then permanent deletion); shared-postgres-schema.md §Notification Queue (the canonical DDL this migration reproduces)
- **Verifies invariant:** none (schema substrate; the behavior it carries is verified at T2.5)

##### T2.2 — `notification-preference-service.ts`: global preferences with actionable-safe mute

- **Files:** `packages/control-plane/src/notification-preferences/notification-preference-service.ts` (new) plus co-located tests.
- **Step:** Implement read and update over `notification_preferences` with global per-participant defaults, and implement the emit-time filter predicate the Phase-3 control-plane emit ingress (T3.2) calls before any push or queue write. The filter drops informational notifications a participant has muted and is structurally incapable of dropping an actionable approval-required one: the severity check precedes the preference lookup rather than being a branch inside it, so a preference-shape defect cannot suppress blocking attention.
- **Test:** assert a muted informational trigger is filtered; assert an actionable `pending_approval` trigger survives every mute configuration including a mute-all payload; assert an unknown `preference_key` neither throws nor silently widens the filter.
- **Spec coverage:** Spec-019 §Fallback Behavior (a muted session may still surface critical approval-request attention while informational events remain muted); Spec-019 §Pitfalls To Avoid (muted informational noise must not hide blocking approval state)
- **Verifies invariant:** I-019-3

##### T2.3 — `attention-projector.ts`: run-scoped projection from canonical events

- **Files:** `packages/runtime-daemon/src/attention/attention-projector.ts` (new) plus co-located tests.
- **Step:** Derive run-scoped `AttentionItem` values by replaying canonical session and run events — approvals, required input, run completion, run failure, invites, mentions and direct requests — mapping each to its trigger and default severity. The projector reads canonical state only; it accepts no client-supplied attention input, so there is no code path by which a client heuristic can mint an item.
- **Test:** one case per trigger asserting the derived item's trigger, severity, and `sourceEventId`; a replay-equivalence case asserting that projecting the same event log twice, and projecting it from cold, yield identical items; a case asserting an item resolves only when the underlying state resolves.
- **Spec coverage:** Spec-019 §State And Data Implications (attention state is a derived projection from canonical events); Spec-019 §Required Behavior (emission derived from canonical session or run state, not client heuristics alone)
- **Verifies invariant:** I-019-1

##### T2.4 — Session-scoped aggregate projection and the D-019-2 carrier rule

- **Files:** `packages/runtime-daemon/src/attention/attention-projector.ts` plus co-located tests.
- **Step:** Derive the session-scoped aggregate as an `AttentionItem` with `runId` absent, applying the derivation rule in §API And Transport Changes: severity is actionable while any unresolved contributor is actionable; `trigger` and `sourceEventId` come from the representative contributor selected by highest severity, then earliest `createdAt`, then lexicographically smallest `id`. Serve it from `AttentionProjectionRead`; expose no partial input from which a client could assemble its own.
- **Test:** the two-concurrent-runs case asserting the aggregate stays actionable until both underlying items clear; a case asserting an aggregate over informational-only contributors is informational; a determinism case asserting two projections over the same contributor set in different insertion orders select the same representative, including a tie on severity and a further tie on `createdAt`.
- **Spec coverage:** Spec-019 §Default Behavior (session-scoped attention is an aggregate of unresolved run, invite, and participant-request signals); Spec-019 §Example Flows (two runs needing action at once — the session aggregate stays actionable until both resolve)
- **Verifies invariant:** I-019-4

##### T2.5 — Queue enqueue, reconnect batch catch-up, and the 7-day expiry purge

- **Files:** `packages/control-plane/src/notification-preferences/notification-preference-service.ts` sibling queue module under `packages/control-plane/src/notification-preferences/`, plus co-located tests.
- **Step:** Implement the three queue operations the schema section specifies and nothing beyond them: enqueue on the no-connected-device path; the reconnect read selecting the participant's `delivered_at IS NULL` rows in `queue_sequence` order, pushing them as one batch and stamping `delivered_at` on exactly the rows pushed; and the purge sweep deleting every row past `expires_at`, delivered or not. Add no retry counter, backoff schedule, coalescing key, or per-device state — the spec states none, and the schema section records each omission deliberately.
- **Test:** assert an offline participant's notifications are queued and replayed as one ordered batch on reconnect, resuming after a partial batch exactly where the previous stamp stopped; assert two rows inserted in one transaction (sharing a single `now()`) still replay in a stable order, the case `queue_sequence` exists for; assert the purge deletes a row 7 days after `queued_at`; assert an expired-unread row leaves the underlying attention item untouched in the projection.
- **Spec coverage:** Spec-019 §Cross-Device Delivery (queue when no device is connected; batch delivery from the last cursor on reconnect; 7-day retention then permanent deletion)
- **Verifies invariant:** I-019-2

##### T2.6 — Attention wire registration: daemon `attention.projectionRead` handler plus the control-plane attention router

- **Files:** `packages/runtime-daemon/src/ipc/handlers/attention-projection-read.ts` (new) with its registration against the Plan-007-partial daemon `MethodRegistry`; `packages/control-plane/src/notification-preferences/attention-router.factory.ts` (new); the three-edit `host.ts` router registration the [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) `packages/control-plane/src/server/` row's router-registration carve-out specifies (merge into `t.mergeRouters`, `ControlPlaneDeps` intersection, production-placeholder construction), same-commit with the router file; plus co-located tests.
- **Step:** Land the wire surface the [Attention Method-Name Registry](../architecture/contracts/api-payload-contracts.md#attention-method-name-registry-tier-8-plan-019) assigns (D-019-3). `attention.projectionRead` registers as a daemon JSON-RPC `query` serving the T2.3/T2.4 projections — the attention projection is daemon-local per [ADR-017](../decisions/017-shared-event-sourcing-scope.md), so it rides the daemon transport only, the `timeline.*` posture — parsing `AttentionProjectionReadRequestSchema` so the D-019-4 scope/`runId` refusals fire at the wire. `attention.preferenceRead` / `attention.preferenceUpdate` register as control-plane tRPC `query` / `mutation` over the T2.2 service — the store is control-plane-owned, the `runtimenode.roster` posture — on an `attention`-namespaced router mounted per the carve-out trio. No `attention.subscribe` and no client emit verb are registered, per §API And Transport Changes and D-019-3.
- **Test:** assert `attention.projectionRead` round-trips a projection read over the daemon transport and refuses `scope: "run"` without `runId` at parse; assert the two preference procedures read and update through the T2.2 service; assert all three method strings pass the register-time `METHOD_NAME_FORMAT` guard; assert an unregistered `attention.*` string does not dispatch.
- **Spec coverage:** Spec-019 §Interfaces And Contracts (`AttentionProjectionRead` exposes actionable and informational state at both run and session scope; the preference pair supports per-surface preferences)
- **Verifies invariant:** none (transport registration; the served projection behavior is verified at T2.3–T2.4, the preference behavior at T2.2, and the SDK consumption at T3.3)

### Phase 3 — Notification Emission And Delivery Surfaces

**Precondition:** Phase 2 merged; Plan-013 Phase 4 merged — the desktop timeline rendering surface the attention badges and summaries attach to.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 019, phase: 2, status: merged }
  - { type: plan_phase, plan: 013, phase: 4, status: merged }
```

**Goal:** notifications are emitted from canonical state through the control-plane preference filter (T3.2), delivered over the existing SSE subscription to connected devices and queued otherwise, surfaced as OS notifications when the platform allows, and surfaced in-app as badges and summaries when it does not.

#### Tasks

##### T3.1 — `notification-emit-service.ts`: canonical emission published over the daemon→control-plane carrier

- **Files:** `packages/runtime-daemon/src/attention/notification-emit-service.ts` (new) plus co-located tests.
- **Step:** Emit a notification for each newly actionable or informational attention item, carrying the canonical `sourceEventId` from the item that produced it, and publish each emission to the control plane as one `attention.notificationEmit` call — the daemon-called control-plane tRPC mutation in the [Attention Method-Name Registry](../architecture/contracts/api-payload-contracts.md#attention-method-name-registry-tier-8-plan-019) (D-019-3) — authenticated through the constructor-injected `DaemonCredentialProvider` (the Plan-006 CP-006-13 shape, minted per attempt; the `eventanchor.upload` posture, so a failed publish is a retryable transport failure). The daemon authors only this client leg: the preference filter, the connected-device push, and the queue write are control-plane-owned and land at T3.2 — this service applies no preference filtering and neither reads `notification_preferences` nor writes `notification_queue`, keeping the I-019-3 filter at the control plane and the storage boundary uncrossed. Aggregates are never emitted — emission keys on a single canonical trigger, per D-019-2.
- **Test:** assert an approval-required run produces an actionable emission carrying the item's canonical `sourceEventId`, published exactly once over `attention.notificationEmit` with `sessionId`, `severity`, and (for a run-scoped item) `runId` populated from the item, independent of any client focus state (focus selects the delivery surface at T3.4); assert a muted participant's emission is still published — suppression is the control plane's (T3.2), not this service's; assert no session-scoped aggregate item is ever passed to the emit path; assert a failed publish is surfaced for retry rather than swallowed and leaves the underlying attention item present and unresolved.
- **Spec coverage:** Spec-019 §Required Behavior (notification emission must be derived from canonical session or run state, not from client heuristics alone); Spec-019 AC1
- **Verifies invariant:** I-019-1

##### T3.2 — Control-plane notification ingress: `attention.notificationEmit`, authorize-filter-route

- **Files:** `packages/control-plane/src/notification-preferences/notification-emit-ingress.ts` (new), plus the `attention.notificationEmit` row in the T2.6 `attention-router.factory.ts`, plus co-located tests.
- **Step:** Implement the `attention.notificationEmit` mutation handler — the control-plane half of the D-019-3 split. Authorize first (both predicates in the same transaction as any queue write, refusals writing nothing): the verified caller `sub` holds a live active-state `runtime_node_attachments` row for the named `sessionId`, and the recipient `participantId` holds an active `session_memberships` row for the same session — a queued `summary` is derived personal session content (CP-019-1), so a notification is never minted into a session the emitting node is not attached to nor delivered to a non-member. Then apply the T2.2 preference filter, then route: hand the rendered notification to the existing control-plane SSE subscription path when the recipient has a connected device (no new endpoint or subscribe method, per §API And Transport Changes), otherwise write the T2.5 queue row. The response is `null` (the `runtimenode.leaseupdate` / heartbeat pattern); a filtered drop also writes nothing.
- **Test:** assert a filtered informational notification is neither pushed nor queued; assert an actionable `pending_approval` notification survives every mute configuration through this ingress (the T2.2 predicate exercised at its real call site); assert a recipient with no connected device gets a queue row rather than a dropped push; assert a caller without a live attachment for the named session is refused with no row written; assert a recipient who is not an active member of the named session is refused with no row written.
- **Spec coverage:** Spec-019 §Desktop-to-Desktop Delivery (SSE push to connected clients; non-matching events dropped at the control plane before emission); Spec-019 §Cross-Device Delivery (queued in the control plane when no device is connected)
- **Verifies invariant:** I-019-2, I-019-3

##### T3.3 — `attentionClient.ts`: typed SDK surface over the projection and preferences

- **Files:** `packages/client-sdk/src/attentionClient.ts` (new) plus co-located tests.
- **Step:** Expose `AttentionProjectionRead` over the daemon JSON-RPC transport as `attention.projectionRead`, and `NotificationPreferenceRead` / `NotificationPreferenceUpdate` over control-plane tRPC as `attention.preferenceRead` / `attention.preferenceUpdate` — the method strings T2.6 registers, per the [Attention Method-Name Registry](../architecture/contracts/api-payload-contracts.md#attention-method-name-registry-tier-8-plan-019) — and consume the notification stream from the existing control-plane SSE subscription (no `attention.subscribe` exists to call, per §API And Transport Changes). The client returns the server's aggregate item as received; it computes no aggregate of its own, and exposes no helper that would let a caller build one from a partial view.
- **Test:** assert the client surfaces the aggregate item verbatim; assert a caller reading a `scope: "run"`-narrowed single-run projection cannot obtain a session aggregate from it.
- **Spec coverage:** Spec-019 §Interfaces And Contracts (the client-facing contracts exposed through the typed client SDK; `NotificationEmit` is daemon-called only per D-019-3, never a client verb)
- **Verifies invariant:** I-019-4

##### T3.4 — Desktop OS notification delivery with degraded in-app fallback

- **Files:** `apps/desktop/src/main/notifications/` (new) plus co-located tests.
- **Step:** Deliver actionable attention as an OS notification via the Electron Notification API when the app is unfocused, and in-app first when focused. When OS notifications are unavailable, denied, or fail, fall back to in-app badges and attention summaries — the fallback path must not touch attention state, so a delivery failure is observable only as an undelivered notification.
- **Test:** assert a denied OS-notification permission still produces the in-app badge and summary; assert a dropped or failed delivery leaves the attention item present and unresolved in the projection; assert focus state selects the surface without changing severity.
- **Spec coverage:** Spec-019 §Fallback Behavior (in-app badges and summaries when OS notifications are unavailable or denied; the projection still reflects outstanding actionable items when delivery is delayed); Spec-019 AC2
- **Verifies invariant:** I-019-2

##### T3.5 — Renderer attention surfaces distinguishing actionable from informational

- **Files:** `apps/desktop/src/renderer/src/attention/` (new) plus co-located tests.
- **Step:** Render run-scoped and session-scoped attention with actionable and informational states visually distinct, reading both from the canonical projection through `attentionClient`. Suppression controls adjust which notifications arrive; they never hide a blocking approval-required item from the in-app surfaces.
- **Test:** assert actionable and informational items render distinguishably; assert a session badge stays actionable while any contributing run badge is actionable and clears only with the last one; assert a muted session still shows a blocking approval-required item in-app.
- **Spec coverage:** Spec-019 §Required Behavior (users must distinguish passive informational notifications from actionable blocking attention); Spec-019 AC3
- **Verifies invariant:** I-019-3, I-019-4

## Rollout Order

1. Land attention contracts, projections, and preference storage
2. Enable in-app badges and summaries
3. Enable desktop notification delivery for actionable and informational attention

## Rollback Or Fallback

- Disable OS notification delivery and keep in-app attention projections only if platform hooks or routing regress.

## Risks And Blockers

- Per-session notification preferences remain unresolved for the first implementation (deferred per [Spec-019](../specs/019-notifications-and-attention-model.md) — V1 ships global preferences only; per-session post-V1)
- Cross-device duplicate delivery can become noisy if canonical attention state and local notification emission are not separated cleanly
- Aggregate session attention can drift if clients try to reconstruct it locally instead of consuming the canonical derived projection

## Ratified Design Decisions (Tier-8 audit)

The decisions surfaced by the Tier-8 plan-readiness audit are ratified below and folded into the plan body, per the audit runbook's resolved-decision convention.

- **D-019-1 — Plan-019 owns a new durable control-plane `notification_queue` table. Type 2.** `Spec-019 §Cross-Device Delivery` states three behaviors that require durable per-participant storage — notifications are queued in the control plane when no device is connected, they are delivered as a batch from the last cursor on the next connect, and undelivered ones are retained for 7 days before permanent deletion — but names no table, and the plan's prior §Data And Storage Changes bullet pointed the other way ("keep delivery-attempt metadata ephemeral where possible"). The audit weighed two readings. **Reading B** was that the substrate already exists and Plan-019 rides it, since the spec's catch-up sentence cites [Spec-008](../specs/008-control-plane-relay-and-session-join.md). That reading was checked against the corpus rather than assumed, and it has no substrate: Plan-008 owns `session_directory`, `relay_connections`, and `relay_seen_ephemeral_keys` — no durable notification or event stream; `Spec-008 §Required Behavior` states outright that the control plane stores no session events per [ADR-017](../decisions/017-shared-event-sourcing-scope.md); and the resumption Spec-008 actually defines is the EventSource `Last-Event-ID` header (`Spec-008 §Control-Plane Transport Protocol`), which is transport-level reconnect and has no durable backing store to replay from. **Reading A is therefore ratified:** the queue is a new Plan-019-owned table, authored in [shared-postgres-schema.md §Notification Queue (Plan-019)](../architecture/schemas/shared-postgres-schema.md#notification-queue-plan-019) hardened from the three stated behaviors **and nothing more** — no retry counter, no backoff schedule, no coalescing key, no cross-device dedup, no per-device delivery state, and no cursor table (the cursor is derived from `delivered_at` plus the monotonic `queue_sequence`). Each omission is recorded in the schema section as deliberate rather than left to be read as an oversight. Consequences: the new bullet in §Data And Storage Changes supersedes the ephemeral-metadata sentence; CP-019-1 widens to name the queue as a second Path-2 hard-DELETE target; and Plan-022 CP-022-6's schema-derived `REFERENCES participants(id)` closure moves from twelve rows to thirteen. **Type 2** because a shared control-plane table is hard to reverse once it holds rows, which is why the design was held to the spec's stated behaviors and checked against the ADR-017 invariants in the schema doc.
- **D-019-2 — The session-scoped aggregate is carried by an `AttentionItem` with no `runId`; severity aggregates, and trigger and `sourceEventId` come from a deterministically selected representative contributor. Type 1.** `Spec-019 §Required Behavior` requires attention at both run and session scope, and `Spec-019 §Default Behavior` makes the session view "an aggregate of unresolved run, invite, and participant-request signals" — but the shared `AttentionItem` shape carries exactly one `trigger`, one `severity`, and one `sourceEventId`, leaving unstated which field carries the aggregate and where a derived item's canonical reference comes from. The rule is stated in full in §API And Transport Changes. Two properties are worth naming here. First, the resolution is **contract-shape-neutral**: because the representative is a real contributor rather than a synthesized placeholder, `sourceEventId` always resolves and stays non-optional, so `Spec-019 §Interfaces And Contracts`'s canonical-reference requirement holds without widening the type — no api-payload change rides this decision beyond an explanatory annotation. Second, the severity leg is spec-grounded while the selection chain is **plan-owned**: no Spec-019 clause fixes a tiebreak order, and the total ordering (severity, then `createdAt`, then `id`) is enforcement this plan designs so that two readers of one projection state cannot disagree about which contributor an aggregate names. Aggregates are read-projection-only and are never emitted as notifications, which is what keeps the rule confined to the read path. **Type 1** — a derivation rule over an unchanged shape is reversible by restating it.
- **D-019-3 — Attention operations ride two registered transports, and notification emission crosses daemon→control-plane over the daemon-called `attention.notificationEmit` mutation. Type 1.** (PR #318 review round.) The four §API And Transport Changes contracts had schema names but no wire strings and no transport assignment, and T3.1 as audited had a runtime-daemon file applying the preference filter and writing the queue — operations `Spec-019 §Desktop-to-Desktop Delivery` places at the control plane ("dropped at the control plane before emission") and I-019-3's own grounding already required there. The resolution: the [Attention Method-Name Registry](../architecture/contracts/api-payload-contracts.md#attention-method-name-registry-tier-8-plan-019) assigns `attention.projectionRead` to the daemon JSON-RPC transport only (daemon-local projection per [ADR-017](../decisions/017-shared-event-sourcing-scope.md)), the preference pair to control-plane tRPC only (the store is the callee's), mints no `attention.subscribe` (delivery rides the existing SSE subscription, already ratified above), registers no client emit verb, and carries emission as the daemon-called `attention.notificationEmit` mutation with the ownership split T3.1/T3.2 encode: the daemon derives and publishes; the control plane authorizes, filters, and routes. `NotificationEmitParams` widens with the fields the control-plane half cannot act without — `sessionId` (authorization + queue binding), `severity` (the severity-first filter and the queue's `NOT NULL` column), optional `runId` (the queue's nullable `run_id` mirror). **Type 1** — a transport assignment and wire registration over already-ratified operations, reversible by restating before any code ships.
- **D-019-4 — `AttentionProjectionReadRequest` narrows by `scope` plus `runId`, with run scope requiring `runId` refused at parse. Type 1.** (PR #318 review round.) The canonical request carried `scope?: "run" | "session"` and no run identifier while T1.2 authored an optional `runId` and the SDK tests read one specific run — two shapes for one contract. The resolution is additive on the published shape (an optional field, compatible per [ADR-018](../decisions/018-cross-version-compatibility.md)): `runId?` joins the canonical request; `scope: "run"` **requires** `runId` (a run-scope read without a run identifier is refused at parse, never defaulted to all runs), and `runId` is admissible only with `scope: "run"` (a request cannot name a run while asking for the session aggregate or the full projection). Omitting `scope` reads the full projection — run-scoped items plus the aggregate; `scope: "session"` narrows to the aggregate alone. The rule is a schema-level Zod refinement stated in the contract comment, not service-layer convention. **Type 1** — an additive optional field plus a refusal rule, reversible by relaxing.

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

- **2026-08-10 — Tier-8 plan-readiness audit (PR #318).** Six findings adjudicated. Structural backfill: the §Preconditions audit checkbox; §Implementation Phase Sequence with three phases and per-phase `#### Tasks`, decomposed from the existing §Rollout Order and §Target Areas so every task traces to a Spec-019 criterion or a numbered invariant; the [ADR-014](../decisions/014-trpc-control-plane-api.md) Required-ADRs row the SSE delivery path already depended on; and §Invariants I-019-1..4, grounding the four properties §Test And Verification Plan already tested for and giving each bullet an id to resolve to. Scope growth: D-019-1 (the `notification_queue` table) and D-019-2 (the aggregate-carrier rule). The plan flipped `approved → review` for the growth and this audit's targeted coverage of exactly that growth restored `approved` in the same swap — flip-and-restore-in-one-swap, the NS-51 / NS-53 precedent; the terminal Status value is unchanged, so the README plan-status census does not move.
- **Residual recorded, not fixed (Spec-019 stays unedited at this swap).** `Spec-019 §Cross-Device Delivery` cites Spec-008 for an "SSE catch-up mechanism (replay from last cursor)" that Spec-008 does not define — it has no such section, states that the control plane stores no session events per [ADR-017](../decisions/017-shared-event-sourcing-scope.md), and defines only transport-level `Last-Event-ID` reconnect. The `notification_queue` authored at this swap is the actual substrate that sentence needs, so the behavior is now satisfied; what remains is a stale cross-reference in the spec's own prose. Repairing it is a Spec-019 edit and is owed as its own change.
- **2026-08-11 — PR #318 review round (Codex).** Three repairs beyond the audit's six findings, ratified as D-019-3 / D-019-4 and audited in the same swap (the Plan-006 PR #278 self-audit shape — the growth lands audited rather than opening a second flip loop). (1) Wire registration: the four attention operations had schema names but no method strings or transport assignment — the [Attention Method-Name Registry](../architecture/contracts/api-payload-contracts.md#attention-method-name-registry-tier-8-plan-019) now assigns them (daemon JSON-RPC for `attention.projectionRead`; control-plane tRPC for the preference pair; no `attention.subscribe`, no client emit verb), landed by new T2.6 with the `host.ts` registration trio. (2) Emission carrier: T3.1 as audited had a runtime-daemon file applying the preference filter and writing the queue — control-plane-owned operations per `Spec-019 §Desktop-to-Desktop Delivery` and I-019-3's own grounding. Re-split: T3.1 keeps the daemon derive-and-publish leg over the daemon-called `attention.notificationEmit` mutation (authenticated via the Plan-006 CP-006-13 `DaemonCredentialProvider` seam — the Plan-006 dependency edge now recorded in the header row and §3), new T3.2 owns the control-plane ingress (authorize, filter, push-or-enqueue); `NotificationEmitParams` widens with `sessionId` / `severity` / optional `runId`; the former T3.2–T3.4 renumber to T3.3–T3.5. (3) `AttentionProjectionReadRequest` alignment: the canonical request had `scope` and no run identifier while T1.2 authored `runId` and no `scope` — resolved additively (optional `runId` joins the canonical shape; `scope: "run"` requires it, refused at parse otherwise — D-019-4). Spec-019 is unedited by all three: each repair conforms the plan and the contract mirror to behavior the spec already states.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
