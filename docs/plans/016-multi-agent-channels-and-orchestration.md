# Plan-016: Multi-Agent Channels And Orchestration

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `016` |
| **Slug** | `multi-agent-channels-and-orchestration` |
| **Date** | `2026-04-14` (Tier-6 readiness audit 2026-06-10) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-016: Multi-Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md) (added by the Tier-6 audit — orchestration admission composes with the daemon-owned queue), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-011](../decisions/011-generic-intervention-dispatch.md) (added by the Tier-6 audit — budget/idle/moderation interrupts ride the generic dispatcher; non-cascade posture), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) (added by the Tier-6 audit — channels/run_links/agents are events-canonical projections), [ADR-018](../decisions/018-cross-version-compatibility.md) (added by the Tier-6 audit — additive-only event payload evolution governs the run.queued carrier fields) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session core: SQLite substrate, projector/replay, branded ids, role model), [Plan-004](./004-queue-steer-pause-resume.md) (Tier 5 — `getRun` per CP-004-7; in-process queue admission + `run.queued` carrier per CP-004-10; intervention dispatch), [Plan-002](./002-invite-membership-and-presence.md) (shipped Tier 2 — `deriveMainChannelId` + `MAIN_CHANNEL_NAME` + `ChannelId`/`ChannelState` per CP-002-7), [Plan-003](./003-runtime-node-attach.md) (shipped Tier 3 — `runtimenode.roster` liveness feed), [Plan-005](./005-provider-driver-contract-and-capabilities.md) (Tier 4 — `usage_telemetry` driver events; driver-key validity for agent personas; normalized delegation), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (Tier 4 — event registration seam, `EventLogService.append` durability gate, `EventCategory` incl. `channel_arbitration`), [Plan-007](./007-local-ipc-and-daemon-control.md)-partial (Tier 1 — `MethodRegistry` + SDK `JsonRpcClient`; registration gated on BL-142 + BL-143), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (Tier-6 sibling — `PermissionCheckService.check({category: 'gate'})` per CP-012-4; within-tier ordering: the moderation task lands after Plan-012 Phase 2), [Plan-023](./023-desktop-shell-and-renderer.md)-partial (Tier 1 — renderer substrate + `window.sidekicks` bridge stub; live IPC at Tier 8); [Spec-024](../specs/024-cross-node-dispatch-and-approval.md)/Plan-027 (criterion edge — cross-node `targetNodeId` is V1-deferred behind `orchestration.node_not_local` per D-016-9) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement session-scoped channels, the V1 agent identity surface, parent-child run linkage, and provider-agnostic orchestration semantics — turn policies, budgets, stop conditions, moderation hooks, and scheduler limits as a hard V1 quality gate — for concurrent multi-agent collaboration.

## Scope

This plan covers channel creation and lifecycle, the agent attach/detach/config surface, orchestration run creation with full admission enforcement (depth, active-child, scheduler limits, budget, turn policy), durable run-link projection, internal-helper visibility, budget accounting with warning/interrupt thresholds, idle and turn-limit stop conditions, moderation gates, round-robin arbitration with partition pause, and desktop surfaces for concurrent agent work.

## Non-Goals

- Workflow authoring syntax (Plan-017)
- Provider-native subagent APIs beyond normalized adapters (ADR-005)
- Channel-level permission restrictions (V1-deferred per [Spec-016 §Resolved Questions](../specs/016-multi-agent-channels-and-orchestration.md))
- Cross-machine `targetNodeId` dispatch ([Spec-024](../specs/024-cross-node-dispatch-and-approval.md)/Plan-027 — D-016-9)
- Conclusion detection (V2 per Spec-016 §Stop Conditions)
- Timeline summary-row rendering (Plan-013, Tier 8 — D-016-14; this plan publishes the durable inputs only)

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [runbook](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-6 audit (2026-06-10), this rewrite: 76 findings adjudicated (A-016-1..31) ratifying D-016-1..20; four-phase `#### Tasks` structure authored; Spec-016 / Spec-006 (census 126 → 130) / Spec-023 / domain-doc / run-state-machine amendments landed in the same audit PR.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/orchestration.ts` (NEW — single contract file per D-016-1; the pre-audit `src/channels/` + `src/orchestration/` contract directories are struck)
- `packages/contracts/src/event.ts` (EXTEND — union registration for the new event payload schemas + additive `config?` on the shipped `channelCreatedPayloadSchema`)
- `packages/runtime-daemon/src/db/migrations/` (EXTEND — `channels` / `run_links` / `agents` / `session_budgets`)
- `packages/runtime-daemon/src/orchestration/` (NEW directory per [cross-plan §2](../architecture/cross-plan-dependencies.md)): `agent-service.ts`, `channel-service.ts`, `orchestration-run-service.ts`, `run-link-projector.ts`, `budget-accountant.ts`, `turn-policy-arbiter.ts`, `idle-sweep.ts`, `moderation-gate.ts`, `errors.ts`
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND — `channel.*` / `orchestration.*` / `agent.*` namespace binders)
- `packages/client-sdk/src/orchestrationClient.ts` (NEW)
- `apps/desktop/src/renderer/src/channels/` + `apps/desktop/src/renderer/src/child-runs/` (NEW renderer subtrees, pinned in [cross-plan §2](../architecture/cross-plan-dependencies.md))

## Data And Storage Changes

- `channels` (user channels only — main is synthesized per D-016-15), `run_links` (with `session_id` provenance, `link_type` CHECK, `internal_helper`, `producing_node_id`), `agents` (4-state domain lifecycle), and `session_budgets` (row-canonical limits) per [Local SQLite Schema §Channel and Orchestration Tables](../architecture/schemas/local-sqlite-schema.md).
- `channels`, `run_links`, and `agents` are events-canonical projections (ADR-017 Option B) rebuilt byte-equal on replay; `session_budgets` is row-canonical daemon configuration (the `queue_items` posture — mutated by wire method, never evented).
- Budget **accounting** has no table: the `BudgetAccountant` is an in-memory projection over `usage_telemetry` + `run.*` events, rebuilt on replay (D-016-5).
- No timeline-projection rows: this plan publishes durable events only; Plan-013 derives summary rows at Tier 8 (D-016-14 — the pre-audit "extend timeline projections" step is struck).

## API And Transport Changes

- Thirteen daemon JSON-RPC pairs per [api-payload-contracts.md §Plan-016](../architecture/contracts/api-payload-contracts.md): `channel.create` / `channel.mute` / `channel.unmute` / `channel.archive` / `channel.rosterRead`, `orchestration.runCreate` / `orchestration.childRunLinkRead` / `orchestration.budgetRead` / `orchestration.budgetUpdate`, `agent.attach` / `agent.detach` / `agent.configUpdate` / `agent.list`. Registration is gated on [BL-142](../backlog.md) (camelCase tails) and typed wire errors on [BL-143](../backlog.md).
- Twelve owned event types in the [Spec-006 registry](../specs/006-session-event-taxonomy-and-audit-log.md): `channel.created` / `channel.muted` / `channel.unmuted` / `channel.archived`, `agent.attached` / `agent.detached` / `agent.config_updated`, `arbitration.paused` / `arbitration.resumed`, `orchestration.rejected`, `usage.budget_warning`, `moderation.review_flagged`.
- The `run.queued` payload gains optional additive linkage fields `{agentId?, parentRunId?, linkType?, internalHelper?, producingNodeId?}` threaded from the in-process `OrchestrationRunLinkCarrier` (D-016-3, CP-004-10; ADR-018 additive-only).
- Error vocabulary per [error-contracts.md](../architecture/contracts/error-contracts.md) §Channel / §Orchestration / §Agent (D-016-16).

## Invariants

| ID | Invariant | Verified by |
| --- | --- | --- |
| **I-016-1** | Every Plan-016 wire/event shape is defined exactly once in `orchestration.ts` (plus `event.ts` union registration); no mirror or duplicate definitions anywhere. | T1.1, T1.2, T3.5 |
| **I-016-2** | Contract enums and DDL CHECK constraints stay in lockstep (`ChannelState`, `AgentState`, `LinkType`, `internal_helper` 0/1; `session_budgets` defaults) — a conformance suite, not a comment, enforces the pin. | T1.4 |
| **I-016-3** | Every `run_links` row carries non-null `session_id` provenance; replay and relay rebuild scope by session. | T1.3, T2.4, T2.9 |
| **I-016-4** | `channels`, `run_links`, and `agents` rebuild byte-equal from the event log alone (events-canonical; no projection consults request state). | T2.9, T3.7 |
| **I-016-5** | A peer daemon recovers the full linkage record (parent, linkType, internalHelper, producingNodeId) from relay-distributed `run.queued` events with no SQLite access. | T2.4, T2.9 |
| **I-016-6** | Depth-1 nesting: a child run can never create a child (typed `orchestration.depth_exceeded`, zero residue). | T2.3, T3.6 |
| **I-016-7** | Active-child admission is bounded by the session's `active_child_limit`; overflow is a typed refusal, never silent drop or hidden spawn. | T2.3, T3.6 |
| **I-016-8** | Every admission refusal is zero-residue (no run row, no queue item, no link row) **and** durably recorded via `orchestration.rejected`. | T2.3, T2.9 |
| **I-016-9** | Parent run state changes never auto-propagate to children ([run-state-machine.md §Child-Run Behavior](../domain/run-state-machine.md); Spec-016 §Intervention Propagation). | T2.9 |
| **I-016-10** | `internalHelper` is never dropped between its durable home and any read or render surface (carrier → `run_links.internal_helper` → `ChildRunLinkRead.internalHelper` → renderer differentiation). | T1.3, T2.4, T3.4, T4.3 |
| **I-016-11** | One main channel per session holds structurally: no `channels` row and no `channel.created` event ever exists for main; reads synthesize it via `deriveMainChannelId(sessionId)`; `channel.create` refuses the reserved name (CP-002-7, D-016-15). | T2.2, T2.9 |
| **I-016-12** | Budgets are hard ceilings: `usage.budget_warning` fires exactly once per (scope, budget-type) 80% crossing; 100% interrupts with `budget_exhausted`; a session-cost ceiling interrupts all active runs and blocks admission until the owner raises the limit. | T2.5 |
| **I-016-13** | Turn accounting is correct: consecutive counter per (channel, agent), reset on interleave; at limit the run completes with `trigger: 'turn_limit'` and same-agent admission is refused until interleave or owner raise. | T2.6 |
| **I-016-14** | A run with no appended event for its idle window is interrupted with `idle_timeout` (default 300000 ms; `OrchestrationRunConfig.idleTimeoutMs` override). | T2.7 |
| **I-016-15** | The pre-turn moderation gate resolves **before** the turn's `assistant_output` event is appended; a denial discards the buffered output and system-cancels with `moderation_denied`; hooks default off, opt-in per channel. | T2.8 |
| **I-016-16** | The SDK marshals and never derives: no client-side computation of admission outcomes, visibility, or arbitration state. | T3.4, T3.7 |
| **I-016-17** | Renderer mutations are one wire call per explicit user action (no implicit retries, no fan-out). | T4.2, T4.4 |
| **I-016-18** | Renderer differentiates-and-admits: internal helpers render de-emphasized but are never ejected; `unreachable` children are labeled, never dropped. | T4.3, T4.4 |
| **I-016-19** | Renderer renders wire values verbatim (config badges, arbitration facet, link types) — zero client derivation. | T4.1, T4.4 |
| **I-016-20** | Only a `ready` agent takes a run (`agent.not_ready` otherwise); the `agents` projection is deterministic from the log alone because `agent.*` payloads carry the daemon-resolved resulting state. | T2.1, T2.3, T2.9 |

## Cross-Plan Obligations

- **CP-016-1 — Run-state read.** Consume `getRun(runId): { version, sessionId, state }` from [Plan-004](./004-queue-steer-pause-resume.md) (reciprocal CP-004-7) for admission checks and system-intervention version guards. **Tasks:** T2.3, T2.5, T2.6, T2.7.
- **CP-016-2 — Main-channel identity.** Consume `deriveMainChannelId` + `MAIN_CHANNEL_NAME` + `ChannelId`/`ChannelState` from [Plan-002](./002-invite-membership-and-presence.md) (CP-002-7). Resolution D-016-15: the no-main-row model — Plan-002's `channels.ts` stays untouched; one-main-per-session holds structurally. **Tasks:** T1.1, T2.2.
- **CP-016-3 — Event registration.** Twelve owned event types registered in [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) (four added by this audit: `channel.unmuted`, `orchestration.rejected`, `usage.budget_warning`, `moderation.review_flagged` — census 126 → 130); payload schemas live in `orchestration.ts`, union registration EXTENDs `event.ts`; `EventCategory.channel_arbitration` arrives via Plan-006 T1.1 (Tier 4). **Direction:** register with [Plan-006](./006-session-event-taxonomy-and-audit-log.md). **Tasks:** T1.1.
- **CP-016-4 — Append path.** All emission goes through `EventLogService.append` (Plan-006), the sole durability gate; no direct `session_events` writes. **Tasks:** T2.1, T2.2, T2.3, T2.5, T2.6, T2.8.
- **CP-016-5 — Moderation gate.** Consume `PermissionCheckService.check({category: 'gate'})` + the approval-blocking flow from [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (reciprocal CP-012-4). Within-tier ordering: T2.8 lands after Plan-012 Phase 2. **Tasks:** T2.8.
- **CP-016-6 — Channel lifecycle forward.** [Plan-017](./017-workflow-authoring-and-execution.md) (Tier 8) consumes channel creation/lifecycle via wire methods + events, never daemon internals; return-cite owed at its Tier-8 audit. **Direction:** provide (forward).
- **CP-016-7 — Queue-admission seam.** Compose in-process with Plan-004's daemon queue admission: `OrchestrationRunLinkCarrier` in, minted `RunId` back, carrier threaded onto `run.queued` (reciprocal CP-004-10); the wire `run.queueCreate` never accepts the carrier; system interventions use the in-process entrypoint with NULL-for-system actor + `expectedRunVersion` reject-re-read-retry (D-016-7). **Tasks:** T2.3, T2.5, T2.7, T2.8.
- **CP-016-8 — Roster liveness.** Consume `runtimenode.roster` (Plan-003, shipped) polled at heartbeat cadence for arbitration pause/resume and child-run `visibility` projection; detection latency is bounded by the poll interval. **Tasks:** T2.4, T2.6.
- **CP-016-9 — Usage telemetry.** Consume `usage_telemetry` driver events (Plan-005, Tier 4) as BudgetAccountant input. **Tasks:** T2.5.
- **CP-016-10 — Timeline inputs forward.** Publish durable child-run events + carrier; [Plan-013](./013-live-timeline-visibility-and-reasoning-surfaces.md) (Tier 8) derives summary rows; no Plan-013 imports at Tier 6 (D-016-14). **Direction:** provide (forward).
- **CP-016-11 — Renderer bridge.** Renderer subtrees consume daemon state only via `window.sidekicks` (Plan-023-partial substrate; live bridge verification at Tier 8). **Tasks:** T4.1–T4.5.
- **CP-016-12 — Wire gates.** Registration of the camelCase-tailed strings (`channel.rosterRead`, `orchestration.runCreate` / `childRunLinkRead` / `budgetRead` / `budgetUpdate`, `agent.configUpdate`) is blocked on [BL-142](../backlog.md); typed error projection on [BL-143](../backlog.md) (both Plan-007-owned). **Tasks:** Phase 3 precondition.
- **CP-016-13 — Normalized delegation.** Drivers without native subagent primitives still support delegated work modeled as separate linked runs (Spec-016 §Fallback Behavior; ADR-005) — no Plan-016 code may assume a native spawn API. **Direction:** consume from [Plan-005](./005-provider-driver-contract-and-capabilities.md). **Tasks:** T2.3, T2.9.

## Ratified Design Decisions (Tier-6 audit, 2026-06-10)

- **D-016-1 — Single contract file.** All Plan-016 contracts live in `packages/contracts/src/orchestration.ts` (ChannelCreate included); the pre-audit `src/channels/` + `src/orchestration/` contract directories are struck; Plan-002's `channels.ts` stays untouched per its anti-leakage test.
- **D-016-2 — Method strings.** `channel` root co-extension (`create` / `mute` / `unmute` / `archive` / `rosterRead` — the first daemon-native handlers under the Plan-002-declared root) plus new `orchestration` and `agent` roots, per the [api-payload-contracts.md §Plan-016 registry](../architecture/contracts/api-payload-contracts.md). BL-142/BL-143 gate registration.
- **D-016-3 — Linkage carrier.** Run linkage rides optional additive `run.queued` payload fields (no new event type); `run_links` is a pure events-canonical projection; relay peers rebuild linkage from the event alone.
- **D-016-4 — Typed configs.** `ChannelConfig {turnPolicy?, roundRobinOrder?, moderation?}` and `OrchestrationRunConfig {tokenLimit?, idleTimeoutMs?}` replace the former `Record<string, unknown>` placeholders; DDL comments cite the types.
- **D-016-5 — Budget substrate.** `BudgetAccountant` = in-memory replay-rebuilt projection (no accumulator table); durable limits = `session_budgets` row-canonical table; `orchestration.budgetRead` / `budgetUpdate` wire surface; Spec-016's "session admin" = session `owner` role; update is owner-only.
- **D-016-6 — Roster read.** New daemon-native `channel.rosterRead` (channels rows + synthesized main + typed config + arbitration facet); Plan-002's `channel.list` daemon-as-gateway directory read is untouched; arbitration/lifecycle events are opaque re-read signals to clients.
- **D-016-7 — System interventions.** Budget/idle/moderation interrupts enter through Plan-004's in-process entrypoint below wire authz, with NULL-for-system actor and the standard `expectedRunVersion` reject-re-read-retry loop.
- **D-016-8 — Turn + idle definitions.** Turn = one completed assistant-output cycle per (channel, agent); consecutive counter resets on interleave; at-limit completes with `trigger: 'turn_limit'` (Plan-004's trigger set gains the value) + same-agent admission refusal. Activity = any appended event carrying the run's id; idle sweep is a daemon-owned per-run timer. `InterruptReason = budget_exhausted | idle_timeout | moderation_denied` (closed set).
- **D-016-9 — Single-node V1.** `targetNodeId` must be locally attached or absent; non-local → typed `orchestration.node_not_local`; cross-node dispatch is Spec-024/Plan-027 (criterion edge — never conflate the surfaces).
- **D-016-10 — Moderation mechanics.** Pre-turn gate = `PermissionCheckService.check({category: 'gate'})` before the turn's `assistant_output` append; in-memory buffering while pending; deny discards + system-cancels (`moderation_denied`); approve appends unchanged; post-turn = `moderation.review_flagged` (informational). Lands after Plan-012 Phase 2.
- **D-016-11 — Scheduler semantics.** Executing channel = ≥1 run in `starting`/`running`/`waiting_*`; pending orchestration run = orchestration-created run in `queued`; active-child default 5 (session-configurable). Create-time enforcement, zero residue, durable `orchestration.rejected` record.
- **D-016-12 — Channel lifecycle.** `active` ↔ `muted` (mute/unmute; `channel.unmuted` registered), `active`|`muted` → `archived` (terminal); admission to archived → `channel.inactive`; mute suppresses attention, not execution.
- **D-016-13 — Queue seam.** Orchestration admission pipeline (agent → depth → active-child → scheduler → budget → turn gate) then in-process Plan-004 queue admission with the typed carrier; `RunId` mints at queue insert (`state: 'queued'` in the create response); zero-residue refusals.
- **D-016-14 — Timeline seam.** Events-only producer: no timeline rows, no Plan-013 imports; Plan-013 derives summary rows at Tier 8 from the durable events + carrier.
- **D-016-15 — Main-channel model.** `channels` holds user channels only; main is projected (no row, no event — both shipped consumers' posture); reads synthesize main; `channel.create` refuses `MAIN_CHANNEL_NAME` (`channel.name_reserved`); `targetChannelId` accepts the derived main id without a row; no `is_main` column.
- **D-016-16 — Error vocabulary.** [error-contracts.md](../architecture/contracts/error-contracts.md) §Channel (3 codes) / §Orchestration (7 codes) / §Agent (2 codes); parent-not-found reuses `run.not_found`; no token collides with an event name.
- **D-016-17 — Link types.** `spawn` (helper, output to parent's channel context) / `delegate` (bounded task, own target channel) / `handoff` (parent transfers continuation and completes); caller-declared, default `spawn`, durable.
- **D-016-18 — Desktop scope.** V1 desktop ships **no** `OrchestrationRunCreate` affordance (creation via SDK/CLI now; Plan-017 workflows at Tier 8); it renders roster, lifecycle controls, linkage, and refusal records. Spec-023's pre-audit sketch interactions (participant-mute, pause-channel) are struck — no such V1 surface.
- **D-016-19 — Turn-policy state.** Derived projections only (no new table): round-robin cursor from the durable `run.queued(channelId, agentId)` sequence + config order (non-empty `roundRobinOrder` required at create); arbitration pause from `arbitration.*` events; `request-based` is structurally satisfied in V1 (every agent run is explicitly created) and adds no admission check.
- **D-016-20 — Agent lifecycle.** The contract adopts the canonical 4-state `AgentState` (`configured` / `ready` / `disabled` / `archived`) from [agent-channel-and-run-model.md §Lifecycle](../domain/agent-channel-and-run-model.md) — no parallel enum; `agent.*` event payloads carry the daemon-resolved resulting state so the projection replays deterministically; `archived` is registered but unreached by V1 wire mutations (A-016-2 integration refinement).

## Implementation Phase Sequence

### Phase 1 — Contracts + persistence

**Goal:** The single-file contract surface, event payload schemas + union registration, and the four-table migration — everything later phases import.

**Scope:** `packages/contracts/src/orchestration.ts` (NEW), `packages/contracts/src/event.ts` (EXTEND), `packages/runtime-daemon/src/db/migrations/` (EXTEND).

**Precondition:** Plan-006 Phase 1 shipped (`EventCategory.channel_arbitration` present; event registration seam live).

#### Tasks

- **T1.1 — `orchestration.ts` contract core + event payload schemas + union registration.**
  - **Files:** `packages/contracts/src/orchestration.ts` (NEW); `packages/contracts/src/event.ts` (EXTEND).
  - **Provides:** `AgentId` brand, `AgentState` (the domain 4-state enum, D-016-20), `TurnPolicy`, `LinkType`, `InterruptReason`, `ChannelConfig`, `OrchestrationRunConfig` (strict Zod schemas); payload schemas for the twelve owned event types per the [Spec-006 per-type shapes](../specs/006-session-event-taxonomy-and-audit-log.md); `event.ts` union registration for the eleven new variants + additive `config?` on the shipped `channelCreatedPayloadSchema`.
  - **Consumes:** `ChannelId` / `ChannelState` + `deriveMainChannelId` / `MAIN_CHANNEL_NAME` (Plan-002, shipped — CP-016-2); branded-id factory (Plan-001, shipped); `NodeId` (Plan-003, shipped); `RunId` (Plan-004 contracts).
  - **Spec coverage:** Spec-016 §Interfaces And Contracts (typed configs, link types, agent surface); Spec-006 §Event Type Summary (130-type census).
  - **Verifies invariant:** I-016-1, I-016-2, I-016-20.
  - **Tests:** schema acceptance/rejection rows per type; strict unknown-key rejection; round-robin-requires-order config validation; union discriminates all twelve types; `channelCreatedPayloadSchema` back-compat (config absent still parses).
- **T1.2 — Wire request/response pairs + carrier type.**
  - **Files:** `packages/contracts/src/orchestration.ts` (EXTEND from T1.1).
  - **Provides:** the thirteen request/response pairs and `OrchestrationRunLinkCarrier` exactly per [api-payload-contracts.md §Plan-016](../architecture/contracts/api-payload-contracts.md) (field-for-field parity).
  - **Consumes:** T1.1 enums/configs; `SessionId` (Plan-001).
  - **Spec coverage:** Spec-016 §Interfaces And Contracts (all interface bullets + budget surface).
  - **Verifies invariant:** I-016-1.
  - **Tests:** request validation rows (missing/invalid fields per pair); response parity assertions against the api-payload block; carrier round-trip.
- **T1.3 — Migration: `channels` / `run_links` / `agents` / `session_budgets`.**
  - **Files:** `packages/runtime-daemon/src/db/migrations/` (EXTEND — next migration number at execution time).
  - **Provides:** the four tables byte-matching [local-sqlite-schema.md §Channel and Orchestration Tables](../architecture/schemas/local-sqlite-schema.md) (CHECK constraints, indexes, defaults).
  - **Consumes:** Plan-001 migration-runner seam (shipped).
  - **Spec coverage:** Spec-016 §State And Data Implications (durable + replayable).
  - **Verifies invariant:** I-016-3, I-016-10.
  - **Tests:** migration up + idempotence; CHECK rejection rows (bad state, bad link_type, `internal_helper` ∉ {0,1}); index presence.
- **T1.4 — Contract ↔ DDL conformance suite.**
  - **Files:** `packages/runtime-daemon/src/db/__tests__/orchestration-schema-conformance.test.ts` (NEW).
  - **Provides:** mechanical lockstep checks — `ChannelState` / `AgentState` / `LinkType` contract enums vs DDL CHECK lists; `session_budgets` columns vs `OrchestrationBudgetState` fields; defaults vs the Spec-016 §Budget Policies + §Scheduler Limits tables (100000 tokens / 1000¢ / 50 turns / 5 channels / 25 depth / 10 pending / 5 children / 300000 ms).
  - **Consumes:** T1.1–T1.3.
  - **Spec coverage:** Spec-016 §Budget Policies line 101 (defaults table), §Scheduler Limits line 143 (defaults table).
  - **Verifies invariant:** I-016-2.
  - **Tests:** the suite is the test — one row per pinned pair (documented-pin ≠ enforced-pin discipline).

### Phase 2 — Daemon orchestration services

**Goal:** The full V1 behavioral surface: agent lifecycle, channel lifecycle with main-channel guards, the admission pipeline composed with Plan-004's queue, run-link projection, budgets, turn policies, idle sweep, and moderation gates.

**Scope:** `packages/runtime-daemon/src/orchestration/` (NEW directory).

**Precondition:** Phase 1 merged; Plan-004 shipped through its intervention-dispatch phase (queue admission, `getRun`, in-process entrypoint — CP-016-1/7); Plan-006 shipped (append path); Plan-003 `runtimenode.roster` live. **T2.8 only:** Plan-012 Phase 2 shipped (CP-016-5 within-tier ordering).

#### Tasks

- **T2.1 — Agent service.**
  - **Files:** `packages/runtime-daemon/src/orchestration/agent-service.ts` (NEW).
  - **Provides:** attach/detach/configUpdate/list operations; `agents` projection (projector registration); `agent.*` emission with daemon-resolved resulting state on every payload (D-016-20); `ready`-gate accessor for admission.
  - **Consumes:** T1.1 schemas; `EventLogService.append` (CP-016-4); `runtimenode.roster` for attach-time node resolution (CP-016-8).
  - **Spec coverage:** Spec-016 §Required Behavior (per-agent model/driver/node selection); Spec-016 §Interfaces And Contracts (agent surface).
  - **Verifies invariant:** I-016-20.
  - **Tests:** attach → `ready` vs `configured` (node present/absent); detach → `disabled`; re-attach → `ready`; replay rebuilds the projection byte-equal from events alone; `agent.not_found` / `agent.not_ready` refusals.
- **T2.2 — Channel service + main-channel guards.**
  - **Files:** `packages/runtime-daemon/src/orchestration/channel-service.ts` (NEW).
  - **Provides:** create (config validation incl. round-robin order; `MAIN_CHANNEL_NAME` refusal → `channel.name_reserved`); mute/unmute/archive with transition guards (archived terminal); roster projection (rows + synthesized main first + arbitration facet join); `channel.created/muted/unmuted/archived` emission.
  - **Consumes:** T1.1/T1.2; `deriveMainChannelId` (CP-016-2); `EventLogService.append` (CP-016-4).
  - **Spec coverage:** Spec-016 §Interfaces And Contracts (ChannelCreate + lifecycle + roster); Spec-016 §Turn Policies (create-time config validation).
  - **Verifies invariant:** I-016-11.
  - **Tests:** main-name refusal (exact + case variants per the shipped name normalization); no-row-no-event-for-main across create/read/replay; transition matrix (unmute from muted only; archive terminal; mutation on archived refused `channel.inactive`); roster synthesizes main with session provenance.
- **T2.3 — Orchestration-run admission pipeline.**
  - **Files:** `packages/runtime-daemon/src/orchestration/orchestration-run-service.ts` (NEW).
  - **Provides:** the ordered pipeline — agent resolution (T2.1) → depth-1 → active-child bound → scheduler limits (executing channels, queue depth, pending) → budget block (T2.5 accessor) → turn gate (T2.6 accessor) → `targetNodeId` locality (D-016-9) → channel admissibility (archived → `channel.inactive`; derived main id accepted) — then CP-004-10 in-process queue admission with `OrchestrationRunLinkCarrier`; `orchestration.rejected` emission on every refusal; zero residue.
  - **Consumes:** `getRun` (CP-016-1); Plan-004 in-process admission (CP-016-7); T2.1/T2.5/T2.6 accessors.
  - **Spec coverage:** Spec-016 §Default Behavior (explicit creation, depth-1, bounded fan-out); Spec-016 §Fallback Behavior (explicit limit/capacity detail); Spec-016 §Scheduler Limits; Spec-016 §Example Flows (refusal recorded visibly).
  - **Verifies invariant:** I-016-6, I-016-7, I-016-8, I-016-20.
  - **Tests:** each refusal code with its `data.fields` shape per [error-contracts.md §Orchestration](../architecture/contracts/error-contracts.md); zero-residue assertions (no run row, no queue item, no link row after refusal); `orchestration.rejected` payload carries the refusing reason; happy path returns `{runId, state: 'queued', parentRunId?, channelId, internalHelper}`; non-local node → `orchestration.node_not_local`; delegation works on a driver without native subagent primitives (CP-016-13).
- **T2.4 — Run-link projector + visibility.**
  - **Files:** `packages/runtime-daemon/src/orchestration/run-link-projector.ts` (NEW).
  - **Provides:** `run.queued` carrier-fields → `run_links` row projection (projector registration); `ChildRunLinkRead` backing with `visibility: reachable|unreachable` joined from the roster poll (CP-016-8); delivery-fallback provenance (payload keeps the original `channelId`; display re-homes to main — Spec-016 §Fallback Behavior, A-016-18).
  - **Consumes:** T1.3 tables; Plan-004 `run.queued` emission (CP-016-7).
  - **Spec coverage:** Spec-016 §Required Behavior (durable auditable linkage); Spec-016 §Partition And Reconnect Behavior (unreachable visibility); Spec-016 §Fallback Behavior (delivery fallback).
  - **Verifies invariant:** I-016-3, I-016-4, I-016-5, I-016-10.
  - **Tests:** projection from carrier-bearing `run.queued`; carrier-less `run.queued` projects nothing; replay rebuild byte-equal; relay-shaped rebuild (events only, no SQLite priors); visibility flips with roster state; re-homed display preserves original `channelId` in the payload.
- **T2.5 — Budget accountant + budget surface.**
  - **Files:** `packages/runtime-daemon/src/orchestration/budget-accountant.ts` (NEW).
  - **Provides:** in-memory projection over `usage_telemetry` + `run.*` (replay-rebuilt, no accumulator table — D-016-5); once-per-(scope, type) 80% `usage.budget_warning` emission; 100% interrupt via the in-process entrypoint (`budget_exhausted`, D-016-7); session-cost ceiling fan-out (interrupt all active + admission block); `session_budgets` read/update service (row materializes with spec defaults on first touch); admission-block accessor for T2.3.
  - **Consumes:** `usage_telemetry` events (CP-016-9); `getRun` + in-process intervention (CP-016-1/7); T1.3 `session_budgets`.
  - **Spec coverage:** Spec-016 §Budget Policies line 109 (80%/100% per-run/per-agent/per-session budget semantics, owner raise).
  - **Verifies invariant:** I-016-12.
  - **Tests:** warning fires exactly once per crossing (incl. across restart via replay rebuild); per-run token ceiling interrupts only the offender; session ceiling interrupts all + blocks admission; owner raise unblocks; defaults row materializes on first read.
- **T2.6 — Turn-policy arbiter.**
  - **Files:** `packages/runtime-daemon/src/orchestration/turn-policy-arbiter.ts` (NEW).
  - **Provides:** derived round-robin cursor (from the durable `run.queued(channelId, agentId)` sequence + config order — D-016-19); consecutive-turn counting with interleave reset (D-016-8); turn-limit completion (`trigger: 'turn_limit'`) + same-agent admission refusal accessor; arbitration pause/resume on next-due-agent unreachability (roster poll, CP-016-8) with `arbitration.paused` / `arbitration.resumed` emission; free-form and request-based pass-through (D-016-19).
  - **Consumes:** T2.1 agents projection; T2.2 channel configs; roster (CP-016-8); in-process completion path (CP-016-7).
  - **Spec coverage:** Spec-016 §Turn Policies (+ Tier-6 ratifications); Spec-016 §Stop Conditions (turn limit); Spec-016 §Partition And Reconnect Behavior (round-robin pause, no silent skip, no auto-failover).
  - **Verifies invariant:** I-016-13.
  - **Tests:** cursor ordering + rebuild from replay; consecutive reset on interleave (agent and human); at-limit completion carries the trigger; same-agent admission refused until interleave; pause emitted when next-due unreachable, resume on reconnect, no skip; request-based admits like free-form.
- **T2.7 — Idle sweep.**
  - **Files:** `packages/runtime-daemon/src/orchestration/idle-sweep.ts` (NEW).
  - **Provides:** per-run idle timers (default 300000 ms; `OrchestrationRunConfig.idleTimeoutMs` override) reset by any appended event carrying the run id; `idle_timeout` interrupt via the in-process entrypoint (D-016-7/8).
  - **Consumes:** event-stream subscription (CP-016-4 read side); in-process intervention (CP-016-7).
  - **Spec coverage:** Spec-016 §Stop Conditions (idle timeout + activity definition).
  - **Verifies invariant:** I-016-14.
  - **Tests:** timer resets on matching-runId event; non-matching events don't reset; fires at the configured window; interrupt carries `idle_timeout`; timers rebuild after daemon restart.
- **T2.8 — Moderation gate.** _(after Plan-012 Phase 2 — CP-016-5)_
  - **Files:** `packages/runtime-daemon/src/orchestration/moderation-gate.ts` (NEW).
  - **Provides:** pre-turn `PermissionCheckService.check({category: 'gate'})` at the turn boundary before `assistant_output` append; in-memory buffering while pending; deny → discard + system cancel (`moderation_denied`); approve → append unchanged; post-turn `moderation.review_flagged` emission when configured; per-channel opt-in from `ChannelConfig.moderation` (default off — D-016-10).
  - **Consumes:** Plan-012 check service (CP-016-5); T2.2 channel configs; in-process cancel (CP-016-7).
  - **Spec coverage:** Spec-016 §Moderation Hooks (+ D-016-10 ratification).
  - **Verifies invariant:** I-016-15.
  - **Tests:** gate precedes append (no `assistant_output` row on deny); buffered output discarded on deny + cancel reason correct; approve appends byte-identical output; default-off channels bypass the check entirely; post-turn flag references the appended event id.
- **T2.9 — Replay determinism + non-cascade conformance suite.**
  - **Files:** `packages/runtime-daemon/src/orchestration/__tests__/orchestration-replay-conformance.test.ts` (NEW).
  - **Provides:** end-to-end replay determinism (channels/agents/run_links byte-equal rebuild; relay-shaped event-only rebuild); non-cascade conformance (parent interrupted/failed/paused leaves children untouched — [run-state-machine.md §Child-Run Behavior](../domain/run-state-machine.md) as rewritten at this audit); zero-residue refusal audit (a refusal leaves only the `orchestration.rejected` event).
  - **Consumes:** T2.1–T2.8.
  - **Spec coverage:** Spec-016 §State And Data Implications; Spec-016 §Intervention Propagation; Spec-016 AC2 (line 184 — linkage survives replay/reconnect).
  - **Verifies invariant:** I-016-4, I-016-5, I-016-8, I-016-9, I-016-11, I-016-20.
  - **Tests:** the suite is the test (one section per invariant above).

### Phase 3 — Wire namespace + SDK

**Goal:** The thirteen JSON-RPC methods on the daemon registry, typed error projection, and the typed SDK client — the surface Phase 4 and the CLI consume.

**Scope:** `packages/runtime-daemon/src/ipc/handlers/`, `packages/runtime-daemon/src/orchestration/errors.ts`, `packages/client-sdk/src/orchestrationClient.ts`.

**Precondition:** Phase 2 merged; **BL-142 landed** (camelCase registration; CP-016-12); **BL-143 landed** (DaemonDomainError wire projection; CP-016-12). Verify both at dispatch time:

- [ ] [BL-142](../backlog.md) landed (registry accepts camelCase method tails)
- [ ] [BL-143](../backlog.md) landed (typed domain-error wire projection)

#### Tasks

- **T3.1 — Mutation binders.**
  - **Files:** `packages/runtime-daemon/src/ipc/handlers/` (EXTEND — per-namespace handler files per the existing convention).
  - **Provides:** `channel.create` / `channel.mute` / `channel.unmute` / `channel.archive`, `orchestration.runCreate`, `orchestration.budgetUpdate` (session-owner authz at the wire boundary — D-016-5), `agent.attach` / `agent.detach` / `agent.configUpdate` — schema-validated, delegating to Phase 2 services.
  - **Consumes:** T1.2 pairs; T2.1–T2.5 services; `MethodRegistry` (Plan-007-partial).
  - **Spec coverage:** Spec-016 §Interfaces And Contracts (mutation surface).
  - **Verifies invariant:** I-016-1.
  - **Tests:** registration acceptance; dispatch round-trips; owner-only `budgetUpdate` refusal for non-owner; malformed-request refusals.
- **T3.2 — Query binders.**
  - **Files:** `packages/runtime-daemon/src/ipc/handlers/` (EXTEND).
  - **Provides:** `channel.rosterRead`, `orchestration.childRunLinkRead`, `orchestration.budgetRead`, `agent.list`.
  - **Consumes:** T2.1/T2.2/T2.4/T2.5 read paths.
  - **Spec coverage:** Spec-016 §Interfaces And Contracts (roster, ChildRunLinkRead, budget read).
  - **Verifies invariant:** I-016-10, I-016-11.
  - **Tests:** roster includes synthesized main first + arbitration facet; links carry `internalHelper` / `producingNodeId` / `visibility`; budget read materializes defaults.
- **T3.3 — Typed domain-error classes.**
  - **Files:** `packages/runtime-daemon/src/orchestration/errors.ts` (NEW).
  - **Provides:** `DaemonDomainError` subclasses for the twelve §Channel / §Orchestration / §Agent codes with `data.fields` shapes per [error-contracts.md](../architecture/contracts/error-contracts.md).
  - **Consumes:** BL-143 base class (Plan-007).
  - **Spec coverage:** Spec-016 §Fallback Behavior (explicit limit/capacity detail).
  - **Verifies invariant:** I-016-8.
  - **Tests:** each class projects `-32000` + `data.code` + fields; never-collides assertion vs Spec-006 event names.
- **T3.4 — SDK `orchestrationClient.ts`.**
  - **Files:** `packages/client-sdk/src/orchestrationClient.ts` (NEW); `packages/client-sdk/src/index.ts` (EXTEND — barrel export).
  - **Provides:** thirteen typed methods marshaling requests verbatim and surfacing `data.code` rejections; no client-side derivation (I-016-16); does **not** duplicate Plan-002's gateway `channel.list` method.
  - **Consumes:** T1.2 pairs; `JsonRpcClient` transport (Plan-007-partial).
  - **Spec coverage:** Spec-016 §Interfaces And Contracts (typed client SDK).
  - **Verifies invariant:** I-016-16.
  - **Tests:** marshal round-trips per method; rejection surfaces the typed code; deep-equal pass-through of response fields.
- **T3.5 — Registration + dispatch test suite.**
  - **Files:** `packages/runtime-daemon/src/ipc/__tests__/` (EXTEND).
  - **Provides:** all-thirteen registration assertion against the [api-payload registry table](../architecture/contracts/api-payload-contracts.md); BL-142 camelCase acceptance rows for the six camelCase strings; namespace-collision guard (no `channel.list` shadowing — the gateway string stays Plan-002's).
  - **Consumes:** T3.1/T3.2.
  - **Spec coverage:** Spec-016 §Interfaces And Contracts (registry parity).
  - **Verifies invariant:** I-016-1.
  - **Tests:** the suite is the test.
- **T3.6 — Typed-error wire round-trips.**
  - **Files:** `packages/runtime-daemon/src/ipc/__tests__/` (EXTEND).
  - **Provides:** end-to-end wire assertions for every refusal path (depth, active-child, pending, channel limit, queue depth, turn limit, budget, node locality, `channel.inactive`, `channel.name_reserved`, `agent.not_found`, `agent.not_ready`, `run.not_found` reuse).
  - **Consumes:** T3.1–T3.4.
  - **Spec coverage:** Spec-016 §Fallback Behavior; Spec-016 AC3 (line 185 — the delegation wire surface).
  - **Verifies invariant:** I-016-6, I-016-7, I-016-8.
  - **Tests:** each code observed at the SDK boundary with `data.fields` intact.
- **T3.7 — Replay/restart + SDK integration suite.**
  - **Files:** `packages/client-sdk/src/__tests__/orchestration-integration.test.ts` (NEW).
  - **Provides:** spawned-daemon integration: create channel → attach agent → orchestrate child → read links → restart daemon → re-read (linkage + visibility survive); SDK-observed budget warning + interrupt sequence.
  - **Consumes:** T3.1–T3.4; Phase 2 services.
  - **Spec coverage:** Spec-016 AC1 (line 183 — multiple concurrent agents and channels), AC2 (line 184 — linkage survives replay and reconnect), AC3 (line 185 — delegated work without native subagent APIs).
  - **Verifies invariant:** I-016-4, I-016-5, I-016-16.
  - **Tests:** the suite is the test (spawn-based per the bin-guard testing convention).

### Phase 4 — Desktop channel + child-run surfaces

**Goal:** Renderer views over the Phase 3 wire surface — roster, channel lifecycle controls, and child-run linkage — bridge-only, mock-bridge tested.

**Scope:** `apps/desktop/src/renderer/src/channels/`, `apps/desktop/src/renderer/src/child-runs/`.

**Precondition:** Phase 3 merged; Plan-023-partial renderer substrate present (live bridge verification at Tier 8 per CP-016-11).

#### Tasks

- **T4.1 — `ChannelRosterView`.**
  - **Files:** `apps/desktop/src/renderer/src/channels/ChannelRosterView.tsx` (NEW), `apps/desktop/src/renderer/src/channels/index.ts` (NEW barrel).
  - **Provides:** roster via `channel.rosterRead` over the bridge; per-channel state + turn-policy/moderation badges + round-robin arbitration indicator (paused + unreachable agent/node) rendered wire-verbatim; channel/arbitration events consumed as opaque re-read signals (subscribe-before-read, effect-scoped cancellation, monotonic request-sequence guard, sessionId-change reset — the audited renderer postures).
  - **Consumes:** T3.4 SDK shapes (type-only contracts imports); bridge stub (CP-016-11).
  - **Spec coverage:** Spec-023 line 390 (channel roster + badges + arbitration-indicator render contract), line 393 (superseded-sketch disposition — the view binds to the finalized Spec-016 surface per D-016-18).
  - **Verifies invariant:** I-016-19.
  - **Tests:** mock-bridge render rows; re-read on signal; no derivation (badge text equals wire value); main listed first.
- **T4.2 — `ChannelCreateView` + lifecycle controls.**
  - **Files:** `apps/desktop/src/renderer/src/channels/ChannelCreateView.tsx` (NEW).
  - **Provides:** create form (name + create-time `ChannelConfig`; round-robin order entry); mute/unmute/archive controls; one wire mutation per explicit action (I-016-17); typed-error display incl. `channel.name_reserved`.
  - **Consumes:** T3.4 SDK shapes; T4.1 barrel.
  - **Spec coverage:** Spec-023 line 391 (Interactions — post-supersession set: create + mute/unmute/archive, one wire mutation per explicit action).
  - **Verifies invariant:** I-016-17.
  - **Tests:** exactly one bridge call per action; refusal renders the typed code; no retry loops.
- **T4.3 — `ChildRunLinksView`.**
  - **Files:** `apps/desktop/src/renderer/src/child-runs/ChildRunLinksView.tsx` (NEW), `apps/desktop/src/renderer/src/child-runs/index.ts` (NEW barrel).
  - **Provides:** links via `orchestration.childRunLinkRead`; `linkType` + state rendering; `internalHelper` de-emphasis (differentiate-and-admit, never eject); `visibility: unreachable` labeling with last-known state; summary-survives-detail-failure (detail-load failure marks the row incomplete, never removes it — Spec-016 §Fallback Behavior); `orchestration.rejected` refusal records surfaced. **No** run-create affordance (D-016-18).
  - **Consumes:** T3.4 SDK shapes; bridge.
  - **Spec coverage:** Spec-016 §Required Behavior (helper visibility); Spec-016 §Fallback Behavior (summary row remains); Spec-016 §Partition And Reconnect Behavior (unreachable view).
  - **Verifies invariant:** I-016-18.
  - **Tests:** helper rows present-but-de-emphasized; unreachable labeled not dropped; detail failure leaves the summary marked incomplete; zero mutation calls from this view.
- **T4.4 — Mock-bridge suites + import-boundary assertion.**
  - **Files:** `apps/desktop/src/renderer/src/channels/__tests__/`, `apps/desktop/src/renderer/src/child-runs/__tests__/` (NEW).
  - **Provides:** the T4.1–T4.3 test suites plus the source-text import-boundary assertion (no `electron`, no `node:*`, no `client-sdk` imports; type-only `contracts` imports — the audited mock-bridge convention).
  - **Consumes:** T4.1–T4.3.
  - **Spec coverage:** Spec-023 §Process Model line 75 (renderer has no direct Node.js access — all capabilities flow through the preload bridge).
  - **Verifies invariant:** I-016-17, I-016-18, I-016-19.
  - **Tests:** the suites are the test.
- **T4.5 — Tier-8 manual-verification disposition.**
  - **Files:** this plan's Progress Log (entry appended at execution).
  - **Provides:** the recorded disposition that live-bridge end-to-end verification (real daemon + real preload) is deferred to the Plan-023 remainder at Tier 8 (CP-016-11), mirroring the established renderer-phase precedent.
  - **Consumes:** T4.1–T4.4 outcomes.
  - **Spec coverage:** cross-plan-deps §5 row 1 (Plan-023 partial-deliverable carve-out — live-bridge verification lands with the Tier-8 remainder).
  - **Tests:** N/A (disposition record).

## Parallelization Notes

- T1.1 → T1.2 serialize (same file); T1.3 parallels both; T1.4 last in Phase 1.
- Within Phase 2: T2.1/T2.2 first (admission dependencies), then T2.3–T2.7 largely parallel; T2.8 is ordering-gated on Plan-012 Phase 2; T2.9 last.
- Phase 3: T3.1/T3.2/T3.3 parallel after Phase 2; T3.4 after T3.1/T3.2; suites follow.
- Phase 4: T4.1–T4.3 parallel after T3.4; T4.4 follows.

## Test And Verification Plan

Anchored to Spec-016 §Acceptance Criteria:

| # | Acceptance criterion | Verifying tasks |
| --- | --- | --- |
| AC-1 | A session can host multiple concurrent agents and channels | T2.1, T2.2, T3.7 (multi-agent multi-channel integration) |
| AC-2 | Parent-child run relationships remain visible after replay and reconnect | T2.4, T2.9, T3.7 (replay/restart + relay-shaped rebuild) |
| AC-3 | Delegated work remains possible on drivers without native subagent APIs | T2.3, T2.9 (CP-016-13 normalized-delegation paths) |

Plus invariant-anchored suites: contract↔DDL conformance (T1.4), replay determinism + non-cascade + zero-residue (T2.9), typed-error wire round-trips (T3.6), renderer posture suites (T4.4). Budget/turn/idle/moderation behavioral coverage rides the T2.5–T2.8 per-task tests — the V1 quality-gate machinery ADR-015 names.

## Rollout Order

1. Land contracts + migration + conformance (Phase 1)
2. Enable daemon orchestration services behind the admission pipeline (Phase 2)
3. Register the wire namespace + SDK after BL-142/BL-143 land (Phase 3)
4. Enable desktop channel + child-run surfaces (Phase 4)

## Rollback Or Fallback

- Collapse delegated work to the synthesized main channel while preserving explicit parent-child linkage if channel delivery regresses (Spec-016 §Fallback Behavior — provenance preserved per A-016-18).
- The orchestration namespace is daemon-local: unregistering the Phase 3 binders disables the surface without touching Plan-004's queue or Plan-002's gateway reads.

## Risks And Blockers

- **BL-142 / BL-143 (Plan-007-owned)** gate Phase 3 registration and typed wire errors — both open at audit time; Phase 3 carries explicit precondition checkboxes (CP-016-12).
- Within-tier ordering: T2.8 requires Plan-012 Phase 2 (CP-016-5); Tier-6 sequencing must respect it.
- Channel-level restriction policy remains V1-deferred (Spec-016 §Resolved Questions); membership inheritance is the V1 posture.
- Provider-native orchestration differences can leak into product semantics unless normalized at the daemon boundary (ADR-005; CP-016-13).
- Arbitration-pause and visibility detection latency is bounded by the roster poll cadence (CP-016-8) — acceptable for V1, documented at the arbiter.

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

- 2026-06-10 — Tier-6 plan-readiness audit (NS-18): full rewrite from the 4-step prose plan to the phased task DAG above. 76 findings adjudicated (A-016-1..31) ratifying D-016-1..20; agent identity surface ratified into scope (A-016-2); the V1 quality-gate machinery (budgets, turn policies, stop conditions, moderation, scheduler limits) decomposed into Phase 2 tasks; four event types registered (Spec-006 census 126 → 130); `run_links`/`channels` DDL hardened + `agents`/`session_budgets` added; non-cascade contradiction resolved in run-state-machine.md; method strings + error vocabulary ratified; Spec-016 / Spec-023 / domain-doc amendments landed in the same audit PR.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
