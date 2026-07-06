# Spec-016: Multi-Agent Channels And Orchestration

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `016` |
| **Slug** | `multi-agent-channels-and-orchestration` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md), [Session Model](../domain/session-model.md), [Shared Session Core](../specs/001-shared-session-core.md), [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md), [Runtime Node Attach](../specs/003-runtime-node-attach.md), [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md) |
| **V1 Quality Bar** | Declared per [ADR-015](../decisions/015-v1-feature-scope-definition.md); V1-readiness review 2026-04-17 (BL-042) |
| **Implementation Plan** | [Plan-016: Multi-Agent Channels And Orchestration](../plans/016-multi-agent-channels-and-orchestration.md) |

> **Amendment (2026-07-06, capability-enhancement campaign B6 — amends the previously-`approved` spec; the header is flipped to `review` for the amendment's review window per the audit runbook's spec-amendment rule, and the campaign plan's Task 28 batch re-promotion restores `approved` after the W1.5 spec gate; dependent plans' code dispatch stays census-gated on that restoration).** This bundle lands four coordinated additions; each affected section carries the normative text in place. (1) §Budget Policies gains the three-tier "Cost Derivation And Absent-Cost Semantics" subsection — provider-emitted sanity-bounded cost, else pricing-table derivation with family-prefix fallback, else fail-closed budget-indeterminate halt with owner-gated named escapes; enforcement never branches on `costSource`. (2) §Session Goals — the per-session structured goal contract ([Spec-006 §Session Lifecycle](006-session-event-taxonomy-and-audit-log.md) binds `session.goal_updated`/`session.goal_cleared` to it, campaign B1), Codex-native / Claude-emulated per the parity triad. (3) §Provider-Native Subagents — in-session subagents under the **single-supervisor invariant** ([Spec-012 §Required Behavior](012-approvals-permissions-and-trust-boundaries.md)'s provider-supervisor command-policy deny is the enforcement backstop, campaign B20) with budget roll-up, approval flow-through, and timeline normalization. (4) §Resolved Questions gains the realtime/voice V1-scope reservation behind the R8 gate. The three-budget table and the §Stop Conditions closed set (D-016-8) are unchanged.

## Purpose

Define how multiple agents collaborate inside a session and how their channels and run relationships are represented.

## Scope

This spec covers channel creation, parent-child run linkage, cross-agent collaboration, and background helper activity — including session goals, cost derivation for budget enforcement, and the orchestration-level governance of provider-native in-session subagents (campaign B6).

## Non-Goals

- Workflow authoring syntax
- Defining provider-native subagent APIs — the `subagentPolicy` and driver-op shapes are [Spec-005](005-provider-driver-contract-and-capabilities.md)'s; this spec governs only their orchestration use (§Provider-Native Subagents, campaign B6)
- Notification policy

## Domain Dependencies

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [ADR-011: Generic Intervention Dispatch](../decisions/011-generic-intervention-dispatch.md)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)

## Required Behavior

- A session must support multiple active agents at once.
- Agents may collaborate through one or more channels inside the same session.
- Cross-agent communication must use canonical channel publication, artifact references, approvals, or persisted run linkage. V1 must not depend on a separate direct run-to-run messaging primitive.
- Parent-child run relationships must be durable and auditable.
- Internal helper runs must remain distinguishable from user-visible agents while still appearing in canonical history.
- Per-agent model, driver, and runtime-node selection must be allowed within one session.
- Orchestration must remain valid even when a driver has no native subagent concept.

## Default Behavior

- Default collaboration mode is explicit: new child runs are created only by user request or workflow definition.
- Child-run output defaults to publishing a summarized row into the parent session timeline, with expandable detail.
- New collaboration channels default to inheriting session membership unless later restricted by policy.
- V1 delegation defaults to one parent-child layer. A child run is not allowed to create another child run under the canonical first-release contract.
- Concurrent child runs are allowed, but admission remains subject to explicit runtime scheduler limits rather than unbounded fan-out.

## Fallback Behavior

- If a driver does not support native subagent creation, the runtime must model delegated work as separate runs with explicit linkage and channel context.
- If child-run detail loading fails, the summary row remains available and marked incomplete.
- If channel-specific delivery is unavailable, output falls back to the session's default visible channel with preserved provenance. (Tier-6 audit, A-016-18: "unavailable" = the target channel is archived at publication time, or its row is missing at projection time; "preserved provenance" = the event payload keeps the original `channelId` while the projection re-homes display to the main channel.)
- If child-run creation would exceed the supported delegation depth, the runtime must reject the request with explicit limit detail and must not create hidden background work.
- If child-run creation would exceed the active-child scheduler limit, the runtime must reject the request with explicit capacity detail rather than silently dropping or auto-spawning overflow work.

## Interfaces And Contracts

- `ChannelCreate` must create a session-scoped communication surface. Channel lifecycle mutations (`ChannelMute` / `ChannelUnmute` / `ChannelArchive`) and a daemon-native roster read (`ChannelRosterRead`, carrying per-channel config + arbitration state) complete the channel surface (Tier-6 audit, D-016-6/D-016-12).
- **Agent surface (Tier-6 audit, A-016-2):** Plan-016 owns the V1 agent identity surface satisfying §Required Behavior's per-agent model/driver/node selection — `AgentAttach` / `AgentDetach` / `AgentConfigUpdate` / `AgentList`, with the agent persona `{name, driverName, modelId, defaultNodeId?, config?}` durable via `agent.*` events ([Spec-006 §Channel and Agent Lifecycle](006-session-event-taxonomy-and-audit-log.md)). `OrchestrationRunCreate.targetAgentId` resolves against this surface; an unknown or detached agent is a typed refusal.
- `OrchestrationRunCreate` must allow parent linkage, target agent, target node, and target channel.
- `OrchestrationRunCreate` failure must surface explicit limit or policy rejection when depth or active-child bounds are exceeded.
- `ChildRunLinkRead` must expose parent-child relationships.
- `InternalRunFlag` must distinguish internal helper work from user-facing agents.
- **Link-type semantics (Tier-6 audit, D-016-17):** `spawn` — parent-initiated helper whose output returns to the parent's channel context; `delegate` — bounded task published to its own target channel; `handoff` — the parent transfers its continuation to the child and completes. The type is caller-declared (`linkType`, default `spawn`) and durable in the run linkage.
- **Budget surface (Tier-6 audit, D-016-5):** session budget/scheduler limits are readable and owner-adjustable via `OrchestrationBudgetRead` / `OrchestrationBudgetUpdate`.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas (§Plan-016 — including the typed `ChannelConfig` / `OrchestrationRunConfig` shapes that replace the former untyped config placeholders, D-016-4).
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes (§Channel / §Orchestration / §Agent).

## State And Data Implications

- Channel and run-link records must be durable and replayable.
- Parent-child linkage must survive recovery and replay.
- Internal helper visibility must be policy-aware but never silently omitted from audit history.

## Example Flows

- `Example: An architect agent and reviewer agent discuss a change in a design channel while an implementer agent works in a separate implementation channel inside the same session.`
- `Example: A parent run delegates a verification task to a child run on another runtime node. The session timeline shows the child run summary and links to its detailed output.` (Tier-6 audit, D-016-9: in V1 the "another runtime node" in this example must be **locally attached to the same daemon** — `targetNodeId` naming a non-local node is a typed `orchestration.node_not_local` refusal; cross-machine dispatch is [Spec-024](024-cross-node-dispatch-and-approval.md)/Plan-027, V1-deferred, and must never be conflated with this surface.)
- `Example: A child run attempts to spawn its own helper run in v1. The runtime rejects the request as unsupported nested delegation and records the refusal visibly.`

## Turn Policies

| Policy          | Behavior                                      | Default       |
| --------------- | --------------------------------------------- | ------------- |
| `free-form`     | Any participant or agent can send at any time | Yes (default) |
| `round-robin`   | Agents take turns in a fixed order            | No            |
| `request-based` | Agents speak only when explicitly addressed   | No            |

Tier-6 audit ratifications (D-016-19): a `round-robin` channel requires a non-empty agent order in its channel config at create time (validation refusal otherwise); the fixed order is that config value, and the next-due cursor derives from the durable run-admission sequence (no separate cursor store). `request-based` is **structurally satisfied in V1**: every agent run is explicitly created (§Default Behavior — child runs only by user request or workflow definition; no agent-initiated speech exists in V1), so every agent turn already carries an explicit addresser and admission adds no check beyond `free-form`. The policy value is accepted and recorded; dedicated request-addressing primitives become meaningful only when agent-initiated communication arrives (V2, with conclusion detection). Turn-policy enforcement governs **agent** runs; human participants are never turn-blocked.

## Budget Policies

| Budget Type            | Description                              | Default Limit |
| ---------------------- | ---------------------------------------- | ------------- |
| Token limit per run    | Max input+output tokens for a single run | 100,000       |
| Cost limit per session | Max estimated cost across all runs       | $10.00        |
| Turn limit per agent   | Max consecutive turns an agent can take  | 50            |

V1 budget enforcement is a hard ceiling, tightened from advisory during the 2026-04-17 V1-readiness review (Spec-016 was authored 2026-04-14, predating ADR-015's V1 quality bar declaration by three days, so the original advisory posture no longer matches the V1 gate). The daemon emits `usage.budget_warning` events (the registered [Spec-006 §Usage Telemetry](006-session-event-taxonomy-and-audit-log.md) name for the warning this paragraph previously called `usage_warning` — Tier-6 audit, A-016-6) at 80% of any budget limit, once per (scope, budget-type) crossing — and additionally, off-threshold, on the unpriced-model condition per §Cost Derivation And Absent-Cost Semantics (campaign B6) — and issues an `interrupt` intervention via the generic dispatcher ([ADR-011](../decisions/011-generic-intervention-dispatch.md)) at 100%. Per-run token ceilings interrupt the specific offending run with `reason: budget_exhausted`; the per-agent turn limit is a stop condition, not a budget interrupt — at the limit the run **completes** with `trigger: 'turn_limit'` per §Stop Conditions (D-016-8). Session-level cost ceilings interrupt all active runs in the session and block further queue admission until the session owner raises the limit ("session admin" resolved to the session `owner` role — the only administrative role in the V1 model (`packages/contracts/src/session.ts`); raise via `OrchestrationBudgetUpdate`, owner-only — Tier-6 audit, D-016-5). Conclusion detection (agent determines task is complete) remains V2.

### Cost Derivation And Absent-Cost Semantics

Session cost enforcement resolves every usage event's cost through three tiers (campaign B6). Tier (a): provider-emitted cost is consumed whenever the CLI wire supplies it, sanity-bounded — non-negative, finite, and below a configured absurdity ceiling (the ceiling is parameterized in the owning implementation task, not fixed here); gross divergence between an emitted cost and a derivable estimate emits a diagnostic rather than silently trusting either value (known provider over-reporting precedent). Tier (b): otherwise the daemon derives cost as token counts × the local per-model-family pricing table, with family-prefix fallback for point releases; a static local table is the ecosystem-standard mechanism, and its staleness is bounded because tier (a) takes precedence whenever the wire supplies cost. Tier (c): otherwise the run is **budget-indeterminate and the daemon fails closed** — it emits `usage.budget_warning` with `reason: 'unpriced-model'` ([Spec-006 §Usage Telemetry](006-session-event-taxonomy-and-audit-log.md), campaign B1), interrupts per the enforcement paragraph above, and blocks further queue admission for the unpriced model family session-wide.

The unpriced block lifts only by explicit owner action (degrade honestly, never fail open): a pricing-table update covering the family — the universal escape — or, **on provider legs with a native hard budget cap only** (Claude `--max-budget-usd` at the pinned version), an owner-supplied hard USD bound under which runs proceed unpriced-but-USD-bounded with the unpriced status surfaced on every affected run; a capless leg (Codex at the pinned version — its `token_budget` is upstream-under-development) stays fail-closed until its pricing-table entry lands, so its named escape is the pricing-table path. A Day-0 model family therefore never silently runs unbounded and never hard-blocks without a named escape. Enforcement MUST NOT branch on `costSource`: provider-emitted and daemon-derived cost feed one ceiling with no dual trust regimes — the `costStatus`/`costSource` provenance mirrors ([Spec-006 §Usage Telemetry](006-session-event-taxonomy-and-audit-log.md)) are observability, not policy inputs. The surveyed reference runtime's fail-open zero-cost terminal is the one surveyed posture explicitly not ported. Currency (2026-07-06): the tier-(b) table seeds from the current model catalogs (Claude Sonnet 5 / Fable 5 families; Codex `gpt-5.5` / `gpt-5.4` / `gpt-5.3-codex-spark`), and the Claude per-run `--max-budget-usd` cap is wired as defense-in-depth beneath this accountant, never as the accountant. The three-budget table above and the §Stop Conditions closed set (D-016-8) are unchanged by this subsection.

## Stop Conditions

| Condition | Trigger | Behavior |
| --- | --- | --- |
| Turn limit reached | Agent exceeds turn limit | Run completes with `turn_limit` metadata |
| Budget exhausted | Token or cost limit exceeded | Run interrupted with `budget_exhausted` reason |
| Explicit stop | User sends stop command | Run interrupted via cancel intervention |
| Idle timeout | No activity for configurable duration (default: 5 min) | Run interrupted with `idle_timeout` reason |

Conclusion detection (agent determines task is complete) is V2.

Tier-6 audit definitions (D-016-8): a **turn** is one completed assistant-output cycle attributed to a (channel, agent) pair; the consecutive-turn counter resets when a different agent (or a human participant) takes an interleaving turn in the same channel. At the turn limit the run completes with `trigger: 'turn_limit'` and further same-agent admission into that channel is refused with explicit limit detail until an interleaving turn occurs or the owner raises the limit. **Activity** for the idle timeout is any appended session event whose payload carries the run's id; the idle sweep is a daemon-owned per-run timer (default 300000 ms, per-run configurable). The three system-interrupt reasons (`budget_exhausted`, `idle_timeout`, `moderation_denied`) form a closed set carried on the interrupt intervention.

## Intervention Propagation

Interventions use the generic dispatcher defined by [Spec-004](../specs/004-queue-steer-pause-resume.md) and [ADR-011](../decisions/011-generic-intervention-dispatch.md). Spec-016 introduces no new intervention verbs.

- A pause, interrupt, or steer applied to a parent run does not auto-cascade to its child runs. Each child run is an independent intervention target.
- Propagating an intervention across a parent/child subtree requires the caller to submit one intervention per run. This preserves Spec-004's audit property that every run-state transition corresponds to a distinct `InterventionResult` record.
- A steer applied to a parent run does not inject content into child-run conversations — child runs receive steer content only when the steer is targeted at the child run's id.
- Child runs accept the same run-control surface as standalone runs — steer and interrupt via `applyIntervention`, pause/resume via the orchestration-layer `run.pause` / `run.resume` verbs (Spec-004; the driver never needs to know about pause). Driver capability semantics (Spec-004's steer degradation, for example) apply uniformly.
- If a future requirement demands subtree-wide propagation (e.g., "cancel this parent and all its descendants atomically"), that is a new ADR rather than a payload field addition, consistent with ADR-011's Type-1 reversibility stance.

## Moderation Hooks

- Pre-turn approval: before an agent's output is committed to the timeline, an approval gate can require human review.
- Post-turn review: after output is committed, a review flag marks it for human inspection (non-blocking).
- Both hooks integrate with the approval system (Plan-012): category `gate` for pre-turn, informational event for post-turn.
- V1 default: no moderation hooks enabled. Opt-in per channel.

Tier-6 audit ratification (D-016-10): the pre-turn gate point is `PermissionCheckService.check({category: 'gate'})` evaluated at the turn boundary **before** the turn's `assistant_output` event is appended; pending output buffers in memory while the run blocks per the standard approval-blocking flow, a denial discards the buffered output and system-cancels the run with `reason: moderation_denied`, and an approval appends it unchanged. The post-turn informational event is the registered `moderation.review_flagged` ([Spec-006 §Approval Flow](006-session-event-taxonomy-and-audit-log.md)).

## Session Goals

- A session MAY carry one structured goal (campaign B6): `goal: { text: string }` — the structured object [Spec-006 §Session Lifecycle](006-session-event-taxonomy-and-audit-log.md) binds to `session.goal_updated.goal` (campaign B1). The single required member is `text`; extending the shape requires a spec revision, and an update without a goal is malformed rather than an implicit clear (clearing is the distinct operation).
- Set and clear are owner/member RPC operations (`SessionGoalUpdate` / `SessionGoalClear`, following this spec's `OrchestrationBudgetUpdate` naming precedent; wire shapes `SessionGoalUpdateRequest` / `SessionGoalClearRequest` + the `session.goalUpdate` / `session.goalClear` method rows live in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md), this bundle); an accepted operation emits the registered `session.goal_updated` / `session.goal_cleared` event carrying the same canonical value the RPC supplied, so RPC and durable event serialize identically. A goal change is not a run-state transition.
- Goal state derives from the event log as a projection — there is no separate goal store; the current goal is whatever the latest goal event says.
- Provider delivery (parity triad, campaign B6): the Codex leg is native (`thread/goal/*`); the Claude leg is emulated — the daemon stores the goal and injects it via system-prompt composition on turn start and resume. Delivery to a live run rides the [Spec-005](005-provider-driver-contract-and-capabilities.md) driver operations (`setSessionGoal` / `clearSessionGoal`), whose `goalText` is rendered from `goal.text`; the mechanism grade (`native | emulated`) is recorded in the Spec-005 capability matrix (`session_goals`).

## Provider-Native Subagents

- **Single-supervisor invariant (campaign B6): the daemon is the only cross-session supervisor.** A run MAY use its provider's in-session subagents (Claude `--agents` / Task tool; Codex `multi_agent` / `[agents]`) under the `subagentPolicy` the daemon passes through — the policy shape (`{enabled, maxDepth, maxConcurrent, definitions[]}`) is owned by [Spec-005](005-provider-driver-contract-and-capabilities.md) and its API Payload Contracts mirror.
- Budget roll-up: subagent usage aggregates into the run's own budgets — the §Budget Policies accountant sees it through the run's `usage` events, so subagents provide no budget escape hatch ([Spec-006 §Tool Activity](006-session-event-taxonomy-and-audit-log.md) records the same aggregation rule on `subagent.completed`, campaign B1).
- Approval flow-through: subagent tool calls flow through the same approval pipeline as the parent run's (Plan-012); a subagent introduces no separate trust surface.
- Timeline normalization: subagent lifecycle lands as the registered `tool_activity` rows `subagent.started` / `subagent.completed` (campaign B1), provider-attributed and pairing on the (`runId`, `provider`, `subagentId`) triple.
- In-session subagents execute beneath a single run and are not canonical child runs — the §Resolved Questions one-parent-child-layer delegation decision governs cross-run delegation and is unchanged by this section.
- The CLIs' own out-of-session supervisors (`claude agents` / `claude daemon`, `--bg` / `/background`, Codex cloud) stay disabled inside daemon-managed runs. This is the parity implementation of "background agents" — the daemon's orchestration layer IS the manager — not a capability rejection. Enforcement is layered: the daemon owns spawn argv and configuration and never enables those surfaces; the command-policy provider-supervisor deny applies for every effective posture ([Spec-012 §Required Behavior](012-approvals-permissions-and-trust-boundaries.md), campaign B20); and the Bash-sandbox/permission layer is the residual control against model-initiated supervisor spawns. The invariant is scoped to daemon-configured supervision.
- Concurrency: `maxConcurrent` enforces natively on the Codex leg; the Claude leg's concurrency cap is docs-silent, so the daemon monitors and emits a diagnostic on breach rather than claiming native enforcement (mechanism grades per the Spec-005 capability matrix).

## Scheduler Limits

| Limit | Default |
| --- | --- |
| Max concurrent channels executing | 5 per session |
| Max queue depth per channel | 25 items (subject to Spec-001 per-session queue depth of 100) |
| Max pending orchestration runs | 10 per session |
| Max active children per parent run | 5 (daemon default — Tier-6 audit, D-016-11; not a product-wide ceiling per §Resolved Questions: the value is session-configurable via `OrchestrationBudgetUpdate`) |

Tier-6 audit semantics (D-016-11): a channel is **executing** when ≥1 run targeting it is in `starting` / `running` / `waiting_for_input` / `waiting_for_approval`; a **pending orchestration run** is an orchestration-created run in `queued`; a child is **active** for the active-child bound when in any of those four states or `queued`. All limits are enforced at create-time admission with zero residue (no run row, no queue item survives a refusal), the refusal is a typed error with explicit limit detail, and the daemon records it durably via `orchestration.rejected` ([Spec-006 §Channel Arbitration](006-session-event-taxonomy-and-audit-log.md)). All scheduler limits live with the budget limits in the session budget surface and are owner-adjustable (D-016-5).

## Partition And Reconnect Behavior

Multi-agent sessions span multiple runtime nodes; partition behavior inherits from [Spec-003](../specs/003-runtime-node-attach.md) and [Spec-015](../specs/015-persistence-recovery-and-replay.md). Spec-016 adds only the turn-arbitration and channel-visibility rules specific to multi-agent semantics.

- When a node loses its relay connection, the control plane marks it `offline` per Spec-003. Session membership is preserved and the node may reconnect under the same node identity.
- Child runs on the offline node continue locally if the node can still reach its provider; events buffer against the node's local audit log ([Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)) until relay catch-up via Spec-015 replay.
- Parent-channel views on connected nodes show the offline node's runs in an `unreachable` state with the last-known state preserved from the event cursor. `unreachable` is a visibility outcome, not a run-state transition — it is distinct from the run-level `paused` state defined in Spec-004.
- Turn-policy arbitration degrades by policy:
  - `free-form`: unaffected; remaining agents continue to speak.
  - `round-robin`: if the next agent is on an unreachable node, arbitration pauses the channel and emits an `arbitration.paused` event (with `arbitration.resumed` on reconnect). Arbitration must not silently skip the unreachable agent (which would let a disconnected participant miss their turn without record) and must not auto-fail-over to free-form without explicit operator action. `arbitration.paused` and `arbitration.resumed` are registered in the [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) canonical event taxonomy under the `channel_arbitration` category (BL-084, completed 2026-04-18).
  - `request-based`: unaffected on the sender side; responders on unreachable nodes do not consume their turn and the request expires per its normal timeout.
- On reconnect, buffered events catch up via Spec-015 replay and any arbitration pause resolves automatically once the canonical ordering is restored.
- Runs that cannot be resumed because provider-session state was lost transition to `failed` per Spec-015; they must not reappear as a new run.
- The control plane does not enforce cross-node consensus on turn arbitration. Local daemons own their attached runs; cross-node ordering is eventually consistent through the event log. A round-robin channel with two agents on two partitioned node-halves may briefly see divergent local views; Spec-015 replay reconciles on reconnect. Availability over consistency (AP) is the explicit trade-off for the collaboration surface.

## Implementation Notes

- Keep orchestration semantics provider-agnostic and session-scoped.
- Channel creation should be lightweight, but channel identity must remain durable enough for audit and replay.
- Internal helper runs should be discoverable without overwhelming the default UI.

## Pitfalls To Avoid

- Treating multi-agent orchestration as only a UI grouping trick
- Hiding child-run provenance
- Assuming provider-native spawn semantics are universal

## Acceptance Criteria

- [ ] A session can host multiple concurrent agents and channels.
- [ ] Parent-child run relationships remain visible after replay and reconnect.
- [ ] Delegated work remains possible even on drivers without native subagent APIs.

## ADR Triggers

- If orchestration requires a new root model beyond session, create or update `../decisions/001-session-is-the-primary-domain-object.md`.
- If intervention propagation behavior changes (e.g., auto-cascade to children becomes the default), create or update `../decisions/011-generic-intervention-dispatch.md`.
- If the V1 Multi-Agent Channels quality bar declared by ADR-015 changes (e.g., scope demotion to V1.1), create or update `../decisions/015-v1-feature-scope-definition.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: channel-level permission restrictions are deferred. New channels inherit session membership and visibility policy in the first implementation.
- V1 decision: channels are the only canonical communication boundary between agents and runs. Direct run-to-run messaging is out of scope for the first implementation.
- V1 decision: canonical nested delegation depth is one parent-child layer in v1. Deeper delegation requires a future spec revision.
- V1 decision: concurrent child runs are allowed, but v1 does not impose one product-wide numeric ceiling. Each runtime scheduler must expose bounded active-child admission behavior and explicit limit rejection.
- V1 decision (campaign B6, R8): realtime/voice channels are **reserved behind the R8 capability gate** — the upstream Codex realtime feature flag is still under development, a named external gate surfaced to the owner. Spec-016 defines no channel media-type enumeration and none is invented for the reservation; no channel-model change lands until the upstream flag stabilizes. The paired event-census reservation (the reserved `realtime_*` family) is [Spec-006](006-session-event-taxonomy-and-audit-log.md)'s (campaign B1); the scope entry is V1 feature #23 per [ADR-015](../decisions/015-v1-feature-scope-definition.md).

## V1 Readiness Review (BL-042, 2026-04-17)

Review against the V1 quality bar declared by [ADR-015](../decisions/015-v1-feature-scope-definition.md) §Thesis. Findings:

- **Turn policy defaults** — `free-form` is the explicit default. Round-robin and request-based are documented alternatives with deterministic triggers. No "configurable without default" surfaces remain.
- **Budget policy defaults** — Named defaults for per-run token (100,000), per-session cost ($10.00), and per-agent turn (50) limits. V1 enforcement tightened from advisory to hard ceiling via intervention dispatch during this review. Soft warning at 80%, hard interrupt at 100%.
- **Stop conditions** — Four named conditions (turn limit, budget exhausted, explicit stop, idle timeout) with deterministic triggers. Idle timeout default is 5 minutes. Conclusion detection deferred to V2.
- **Moderation / approval hooks** — Pre-turn (category `gate`) and post-turn (informational) hooks integrate with [Plan-012](../plans/012-approvals-permissions-and-trust-boundaries.md) approval categories. Opt-in per channel is the V1 default.
- **Turn arbitration under partition** — Named partition behavior added: `round-robin` pauses arbitration when the next agent is on an unreachable node with explicit `arbitration.paused` / `arbitration.resumed` events (registration in Spec-006 is a Plan-016 precondition — tracked as BL-084); `free-form` and `request-based` degrade gracefully. Reconnect semantics align with Spec-003 node-identity continuation and Spec-015 replay. Eventually-consistent cross-node ordering is the accepted trade-off (AP over CP for the collaboration surface).
- **ADR-011 intervention dispatch** — Non-cascading propagation clarified; no new intervention verbs introduced; subtree-wide cascade would be a new ADR, not a Spec-016 edit.

Behavioral change: budget enforcement posture (advisory → hard ceiling). No blocking changes required to ADR-011, Spec-004, Spec-012, or the approval policy surface. Turn arbitration pause is an orchestration-layer visibility state distinct from run-level `paused`, consistent with Spec-004's discrimination of waiting states.

## References

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Shared Session Core](../specs/001-shared-session-core.md)
- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)
- [ADR-011: Generic Intervention Dispatch](../decisions/011-generic-intervention-dispatch.md)
- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md)
