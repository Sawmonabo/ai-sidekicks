# Spec-013: Live Timeline Visibility And Reasoning Surfaces

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `013` |
| **Slug** | `live-timeline-visibility-and-reasoning-surfaces` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Observability Architecture](../architecture/observability-architecture.md), [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md), [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md), [Provider Accounts And Credential Homes](../specs/029-provider-accounts-and-credential-homes.md) |
| **Implementation Plan** | [Plan-013: Live Timeline Visibility And Reasoning Surfaces](../plans/013-live-timeline-visibility-and-reasoning-surfaces.md) |

> **Amendment (2026-07-20, campaign B9 CP-004-13 consumer registration — flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule, since it changes Required Behavior, Acceptance Criteria, and Depends On; restored `approved` 2026-08-10 by the Tier-8 readiness audit (§6 node NS-20); Plan-013 flipped to `review` with it under the runbook's plan behavior-change row and was restored `approved` by that same audit, its Preconditions box re-checked).** [Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior) already mandates that rolled-back turns stay in the timeline **marked superseded by projection**, and [Spec-004 §Driver-Level Rollback Mechanics](004-queue-steer-pause-resume.md#driver-level-rollback-mechanics) that clients render the rewound history distinctly rather than dropping it. This amendment registers the timeline-surface half of that approved contract on its owning spec: the superseded-turn-rendering Required Behavior bullet (live boundary-entry rule + read/replay marker + attribution-ranked late stragglers), the `run.rolled_back` run-state subtype row, the compacted-stub composition, the provenance rule, and the acceptance criterion — consumed from Plan-004 T3.14's exported `supersededTurns(runId)` read seam (CP-004-13).

> **Amendment (2026-08-18, provider-account plane — the account-scoped quota-display leg. Flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule, since it replaces normative display behavior in §Rate-Limit Display and adds Spec-029 to Depends On; restored `approved` in this same swap by the paired plan's targeted readiness-audit delta, which rides this diff together with the `- [x]` flip of Plan-013's born-unchecked rate-limit-carrier box — the whole amendment-class swap taken at once rather than split across diffs.)** Provider quota is an **account-plane** fact, not a session's: [Spec-029 §Provider quota is account-scoped](029-provider-accounts-and-credential-homes.md#provider-quota-is-account-scoped) keys it on `(accountId, credentialGeneration)` and carries it on the `usage.rate_limit_update` event ([Spec-006 §Usage Telemetry](006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry)), which is where a client reads it. §Rate-Limit Display previously described a control-plane-header-sourced, session-framed figure built from absolute `remaining` / `limit` counts — a shape no carrier in this corpus emits and no client surface observes, and one that would present a single node-wide meter for a node that may hold several independently-billed accounts per provider. That section is replaced here with the event-sourced, account-scoped, node-local contract the registered carrier actually supports, including the honest statement of where it diverges from the session-wide cost receipt. The heading text is unchanged, so every `Spec-013 §Rate-Limit Display` cite still resolves.

> **Amendment (2026-08-26, per-limit quota and the registry Source — the [Spec-029](029-provider-accounts-and-credential-homes.md) sign-in and health-observation reciprocal (CP-029-9), landed with its restoring targeted readiness-audit delta riding the same diff, cross-plan §6 node NS-83).** Flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule and **restores `approved` in the same diff**, the in-swap shape this spec's 2026-08-18 leg took. Three changes to §Rate-Limit Display, all consumer-side. **(1) A second sanctioned Source**: the daemon's per-account quota-window registry, carried on the provider-account read and its subscription with `source: 'probe'`, beside the existing event. It exists because the event is only available to a client that was connected when the traffic happened — a renderer opened after a restart would otherwise show nothing and be unable to tell that apart from a healthy account. **Precedence is by observation time, not by source**: newest `observedAt` per key wins and `source` breaks only exact ties, because preferring a source outright would let a stale reading mask real consumption. A stored reading also carries the generation it was observed under, and a behind-generation reading renders **stale rather than current** rather than being dropped, because a credential-home rebuild does not stop the provider-side window it describes. **(2) The display re-keys per limit**, matching the [Spec-006](006-session-event-taxonomy-and-audit-log.md) re-key this same swap lands: every consumer obligation — the drop-a-lower-reading rule included — now applies per `(providerAccountId, limitId)` and never across limits, and limit labeling becomes mandatory on the same grounds account labeling already was. **(3) The visibility rule's absence clause is widened** from a two-way reading to a four-way one: with an observer that can be silenced and homes that are not plan-limited at all, _no indicator_ now has four possible causes and only one of them is _healthy_ — a surface rendering the absence as health would misreport three. **No census move**: no wire member, event type, error code, table, or column is minted here; the producers are Spec-006's and Spec-029's.

## Purpose

Define the user-facing contract for live timeline visibility, background work surfacing, and reasoning disclosure.

## Scope

This spec covers the canonical timeline read model, child-run visibility, reasoning surfaces, and replay-aware live updates.

## Non-Goals

- Notification rules
- Artifact storage internals
- Provider-specific reasoning formats

## Domain Dependencies

- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Run State Machine](../domain/run-state-machine.md)

## Architectural Dependencies

- [Observability Architecture](../architecture/observability-architecture.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)

## Required Behavior

- The system must expose one live timeline per session or channel view built from canonical events.
- Timeline rows must cover at least messages, handoffs, run state changes, tool activity, approval events, interventions, artifacts, and child-run activity.
- Background runs and child runs must be visible in the primary session experience, even when details are lazy-loaded.
- Reasoning surfaces must be normalized and policy-aware; unavailable or redacted reasoning must still produce a visible reason surface.
- Durable reasoning surfaces must be limited to normalized reasoning summaries, state transitions, tool-intent or tool-result summaries, and policy-redaction markers. Provider-native detailed reasoning is not guaranteed durable.
- Live delivery must support replay catch-up so clients can recover missing timeline state.
- **Superseded-turn rendering (campaign B9, CP-004-13 — 2026-07-20).** Rolled-back (superseded) turns remain in the timeline and MUST render distinctly from current rows — an explicit superseded treatment, never dropped and never re-rendered as current ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior) owns the supersede semantics; marks are epoch-scoped, so a re-executed turn reusing a superseded ordinal renders current). The marking reaches the surface on two legs with one outcome: `TimelineRead` and replay rows carry a projection-computed `superseded` marker (sourced from the Plan-004 supersede projection's exported `supersededTurns(runId)` read — the CP-004-13 seam), and on the live stream the accepted `run.rolled_back` boundary entry (§Timeline Entry Types) — delivered to every filtered subscription whose filter admits any of the affected run's rows (projection-resolved visibility, never the event's optional channel field) — instructs the client to apply the same treatment to that run's **already-delivered** rows whose carried run position exceeds the carried rewind cutoff (run-scoped rows expose their run identity, projection-resolved originating run position, and execution epoch as typed row fields required together — a partial attribution row fails schema validation, never a silently incomparable cached row; the session event sequence is never a run position, and the boundary entry is a typed arm of the discriminated row union the read and subscribe surfaces return: its payload is validated into the `run.rolled_back` event shape at projection, so the cutoff is never read through an untyped cast) — an idempotent rule across multi-rollback sequences (a row already superseded re-marks as a no-op), with each newly-marked row's marker being just the boundary's cutoff against the row's own exposed identity — identical to the replay-computed marker by construction, a previously-current row's first remover being that boundary, so a subscriber that joined from a bounded window after earlier rollbacks marks its cached rows without recovering epochs from reused ordinals whose delivery-order scoping needs no epoch tag, because every row delivered **after** the boundary arrives with its marker already projection-computed: a late pre-rollback straggler appends pre-marked exactly when its stamped attribution ranks it above the run's effective cutoff for its epoch — the minimum rewind cutoff among accepted rollbacks at its epoch or later in the run's lineage, since a later rollback that rewinds below an earlier retained prefix supersedes the inherited rows — and current when it ranks into the run's surviving history ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior); the CP-004-12 `sourcePosition` companion exists precisely for this ranking) — and a new-epoch row appends unmarked — so live and replay views converge on identical marking. A compacted superseded row keeps the treatment: its audit stub renders with both the compaction placeholder and the superseded marker (stub-preserved attribution — [Spec-006 §Compacted Event Format](006-session-event-taxonomy-and-audit-log.md#compacted-event-format)).

## Default Behavior

- Timeline rows default to chronological order from oldest to newest within the current view.
- Row details default to collapsed when the payload is large or high-volume.
- Child-run activity defaults to summarized rows with explicit expansion for detailed inspection.
- If provider reasoning is available and permitted, the system may render a structured reasoning surface tied to the relevant run or message row.
- Detailed provider-native reasoning defaults to ephemeral rendering or bounded diagnostic retention only when policy allows it; it is not part of the durable canonical timeline contract.

## Fallback Behavior

- If live delivery gaps occur, the client must request replay from the canonical event source.
- If detailed reasoning or tool payload is unavailable or policy-restricted, the timeline must show a placeholder row with the reason for unavailability.
- If a child-run detail fetch fails, the summary row remains visible and marked incomplete rather than disappearing.
- If detailed reasoning has been compacted or was never retained, the durable reasoning summary or policy placeholder remains the canonical visible surface.
- If a superseded row's payload has been compacted, the stub placeholder retains the superseded treatment — compaction never launders a rewound row back to current. A vacuous-attribution-era legacy stub (its position unknowable) renders the compaction placeholder alone, exempt from marking by construction — a run carrying one can never admit a rollback ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior)'s standing refusal), so no marker can ever apply to it.

## Timeline Entry Types

> These timeline entry types are projection-layer constructs derived from canonical session events (see [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)). They do not create new event types.

### `handoff`

Agent-to-agent and participant-to-agent handoffs rendered as discrete timeline rows, visually distinct from normal messages.

- **Payload**: `{fromActor: string, toActor: string, reason?: string, channelId?: ChannelId}`
- A `handoff` entry is emitted when:
  - Orchestration transfers a run between agents.
  - A participant explicitly delegates to an agent.
  - An agent spawns a child run on a different node.

### Run-State Subtypes

Run-state subtypes are rendering types that map from underlying run lifecycle events. They exist so the timeline can render distinct visual treatments without inspecting raw event payloads.

| Entry Type | Rendered As | Source Condition |
| --- | --- | --- |
| `run.paused` | Status row with pause icon | Run transitions to `paused` state |
| `run.resumed` | Status row with resume icon | Run transitions from `paused` to `running` |
| `run.blocked` | Status row with block indicator | Run enters `waiting_for_approval` or `waiting_for_input` |
| `run.unblocked` | Status row with unblock indicator | Approval or input resolves the block |
| `run.rolled_back` | Status row with rewind indicator; the run's already-delivered rows above the carried rewind cutoff take the superseded treatment (§Required Behavior) | Accepted rollback rewinds the run — the forward `run.rolled_back` event ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior)) |

## Context Window and Usage Meters

The session composer area must always display a context-window meter reflecting the current provider conversation state.

- **Fields**:
  - `usagePercent` (0-100): current context window consumption as a percentage of the provider limit.
  - `tokenCount`: combined input + output token count for the active conversation.
  - `maxTokens`: the provider's context window limit for the active model.
- **Auto-compaction hint**: when `usagePercent` exceeds 80%, the meter must display a warning suggesting conversation compaction. The warning is informational; compaction is not triggered automatically.
- **Visibility**: the context-window meter is always visible in the session composer area regardless of usage level.
- **Update mechanism**: the meter is updated via `usage.context_window_update` events from the canonical event stream (see [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)).
- **Compaction boundary and superseded marking** (2026-08-16, the [Spec-004](004-queue-steer-pause-resume.md) rewind-hardening consumer leg — a clarification of rules already stated here, minting no new obligation and no acceptance criterion). A **provider-side** context compaction is recorded as a `usage.context_compacted` row ([Spec-006 §Usage Telemetry](006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry)) — a different thing from the daemon retention pass's `event.compacted` audit stubs that §Required Behavior's superseded-turn bullet already covers, and not something the 80% hint above ever triggers. Two consequences follow from existing rules rather than from any new one: the row is run-scoped, so it takes §Required Behavior's superseded treatment on exactly the same terms as every other run-scoped row, with no exemption; and this meter, which reflects the **current** provider conversation state, therefore stops reading a superseded compaction marker as the run's live compaction state. [Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior) additionally treats the newest current such row as a **rewind boundary** and refuses any target below it, so in V1 no accepted rewind supersedes one and the case does not arise; the consistency stated here is what keeps the two surfaces aligned wherever a driver's re-verified boundary-crossing semantics later makes it reachable.

### Rate-Limit Display

A rate-limit indicator shows the remaining provider quota **of one named provider account, for one named limit**. The figure is an account-plane fact, never a session-level or per-run one, and it must never be rendered as either.

- **Two sanctioned Sources, and no third** (amended 2026-08-26). **(a)** The `usage.rate_limit_update` event on the canonical event stream ([Spec-006 §Usage Telemetry](006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry)), emitted from real traffic. **(b)** The **newest stored reading** in the daemon's per-account quota-window registry ([Spec-029 §Per-limit provider quota](029-provider-accounts-and-credential-homes.md#per-limit-provider-quota)), carried on the provider-account read and its subscription with `source: 'probe'`. The second Source exists because the first is only available to a client that was connected when the traffic happened: a renderer opened after a reading was taken, or after a restart, would otherwise show nothing and be unable to distinguish that from a healthy account. **Precedence between them is by observation time, not by source**: newest `observedAt` per `(providerAccountId, limitId)` wins, and `source` breaks **only exact ties**. Preferring one source outright would let a stale reading mask real consumption. A stored reading additionally carries the credential generation it was observed under, and a reading whose generation is behind the account's current generation is rendered **stale rather than current** rather than dropped — a credential-home rebuild does not stop the provider-side window the reading describes ([Spec-029 §Per-limit provider quota](029-provider-accounts-and-credential-homes.md#per-limit-provider-quota)).
- **Neither Source is an HTTP response header.** The indicator is not extracted from any control-plane response header — the control plane's own rate limiting meters this product's API, which is a different quota from the provider's and must not be displayed in its place.
- **Fields** (as carried by the event, plus the account identity added by [Spec-029 §Provider quota is account-scoped](029-provider-accounts-and-credential-homes.md#provider-quota-is-account-scoped)):
  - `provider`: the provider whose quota window this reading describes.
  - `providerAccountId` and the credential generation observed with it: together the `(accountId, credentialGeneration)` account-plane key of the account the reading belongs to (see [Spec-029 §Account identity and credential generation](029-provider-accounts-and-credential-homes.md#account-identity-and-credential-generation)).
  - `limitId` (optional on the wire, defaulted on read): the provider's own identifier for **which** limit this reading describes. **This is the reading's key, together with the account** — absent means the reserved identifier `default`. It is required here because a single account may stand against several limits at once: the pinned Claude surface publishes five, of which **three share a 10080-minute window**, so a surface keyed on the window length would render one weekly limit as the operator's weekly standing and silently drop the other two, with the survivor decided by arrival order.
  - `windowMins`: the length of the provider quota window this reading describes. A **property of the reading, not part of its key** — two limits of one account may share a length.
  - `usedPercent` (0-100): the fraction of that window's quota consumed.
  - `resetsAt` (optional): ISO-8601 timestamp when the window resets, present only when the provider supplied one.
- **No absolute counts**: the carrier reports a percentage, not request or token counts. The surface must render the percentage it was given and must not synthesize a `remaining` or `limit` figure, which is not derivable from a percentage alone.
- **No run to join through**: the event carries no `runId`. Quota is consumed by an account across every run and every session that account executes, so there is no run whose row could supply the account — which is exactly why the event carries the account identity directly rather than leaving it to a join.
- **Account labeling is mandatory**: every rendered quota figure must be labeled with the account it describes, using that account's operator-chosen display label ([Spec-029 §The account registry](029-provider-accounts-and-credential-homes.md#the-account-registry)). A node may hold several accounts for one provider, and each has its own independent quota; an unlabeled or merged meter would show an operator a healthy quota while the account actually executing their run is exhausted. Readings for different accounts are never summed, averaged, or otherwise collapsed into one figure.
- **Limit labeling is mandatory on the same grounds, and readings are never collapsed across limits** (added 2026-08-26): where the provider publishes a display label for a limit it is rendered, and where it does not the limit identifier is rendered verbatim. **Every consumer obligation on this display applies per `(providerAccountId, limitId)` and never across limits** — including the drop-a-lower-reading rule, which now requires the same `limitId` as well as the same `resetsAt` before a decrease may be discarded. Two limits of one account move independently, so a comparison spanning them was never meaningful, and collapsing them would reproduce inside one account exactly the harm the account-labeling rule prevents across accounts.
- **Threshold coloring**, computed from the remaining share (`100 - usedPercent`) of the account's window:
  - Green: >50% remaining.
  - Yellow: 20-50% remaining.
  - Red: <20% remaining.
- **Reset timing**: when the indicator is visible and the reading carried a `resetsAt`, it displays a countdown to that time. A reset time is never estimated or fabricated when the provider did not supply one.
- **Visibility**: the indicator is shown for **any `(account, limit)` pair** whose remaining quota is below 50%, and hidden while that pair is healthy. An account standing against several limits may therefore show several indicators, or one, or none, independently.
- **What absence means, restated (amended 2026-08-26 — the second Source widened it, and the widening is not cosmetic).** Absence of an indicator has never been an affirmative statement that quota is healthy, and it is now less of one than before: it means no constraining reading is held for that pair, and there are **four** distinct ways for that to be true — the pair is genuinely healthy; no reading has ever been taken; the operator has **silenced the background observer** for that account ([Spec-029 §Credential-home health observation](029-provider-accounts-and-credential-homes.md#credential-home-health-observation)); or this home is **not plan-limited at all**, which the provider itself reports for API-key and third-party-inference sessions where plan limits are simply not a concept. A surface that rendered "no limits reported" as "healthy" would misreport every one of the last three. Where the daemon knows which of the four applies, the surface may say so; where it does not, it says nothing rather than guessing.
- **Update mechanism**: readings are keyed by `(providerAccountId, limitId)`, exactly as the event registers them ([Spec-006 §Usage Telemetry](006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry) — re-keyed 2026-08-18 from `(provider, windowMins)` to `(providerAccountId, windowMins)`, closing the collision **across** two registered accounts of one provider, and again 2026-08-26 to `(providerAccountId, limitId)`, closing the collision **within** one account that the previous key still admitted), so a reading is held per account and per limit rather than once per node and is updated as later readings for that same pair arrive. A reading observed under a credential generation that the account has since moved past is stale and must not be shown as the account's current quota.
- **Node-local, and deliberately not symmetric with the session cost receipt**: the quota event binds to the reserved node-scope sentinel rather than to a session, and is excluded from control-plane anchor upload and from peer history backfill ([Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring](006-session-event-taxonomy-and-audit-log.md#daemon-scope-event-binding-and-node-scope-anchoring)). A participant therefore sees quota only for accounts registered on their own node, and never for the accounts of a peer executing in the same session. This does **not** generalize to spend: the session cost receipt ([Spec-016 §Session Cost Receipt](016-multi-agent-channels-and-orchestration.md#session-cost-receipt)) is session-wide, because the usage events it folds are session-scoped and relay to peers normally. A reader must not assume the two surfaces share a reach — one meters an account on this machine, the other meters a session across every machine in it.

## Interfaces And Contracts

- `TimelineRead` must support bounded windows and cursor-based continuation.
- `TimelineSubscribe` must support live append plus replay recovery.
- `ReasoningSurfaceRead` must identify availability status and policy reason when content is withheld.
- `ChildRunExpand` must read detailed activity for a summarized child-run row.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Timeline rows are read projections, not canonical events themselves.
- Reasoning disclosure decisions must be traceable to policy and artifact visibility state.
- Child-run summaries and detail windows must preserve provenance to parent run and producing runtime node.
- Durable timeline reasoning rows must remain reconstructible from canonical summaries and policy markers even when detailed reasoning payloads are unavailable.
- Superseded marking is projection-derived, never stored ad hoc: provenance traces through the Plan-004 supersede projection to the accepted `run.rolled_back` boundary event (its run and carried rewind cutoff) plus the projection-derived source epoch, and survives projection rebuilds and compaction ([Spec-006 §Compacted Event Format](006-session-event-taxonomy-and-audit-log.md#compacted-event-format)).

## Example Flows

- `Example: A session timeline shows a run start, command execution, approval request, diff artifact publication, and completion, all as ordered timeline rows.`
- `Example: A background reviewer run appears as a summarized child-run row that can later be expanded to show findings.`
- `Example: A provider emits detailed reasoning during a run. The timeline stores a durable reasoning summary and policy marker, while the detailed payload remains ephemeral or subject to bounded diagnostic retention.`

## Implementation Notes

- Timeline virtualization or pagination is allowed, but it must not alter canonical ordering.
- Redacted reasoning should still be visible as an event that something was intentionally withheld.
- Live timeline and replay logic should share the same projection schema.

## Pitfalls To Avoid

- Hiding child-run work because it happened in the background
- Flattening every structured event into plain chat text
- Rendering reasoning as if it were always available and safe to show
- Dropping rewound turns from the timeline instead of rendering them superseded — the authoritative log never truncates ([Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior))
- Re-rendering superseded output as current after replay, a projection rebuild, or compaction — or marking a re-executed turn that reuses a superseded ordinal (marks are epoch-scoped)
- Applying that treatment optimistically — truncating, removing, or renumbering rendered rows when an edit-and-resend intervention is _admitted_ or _dispatched_ rather than when its accepted `run.rolled_back` boundary entry appends (2026-08-16, a restatement of the rule above rather than a new obligation: the boundary entry is the only thing that applies the treatment, and a composite whose conversation leg never confirms rewinds nothing at all, so an optimistic edit would drop history the run still holds — [Spec-004 §Required Behavior](004-queue-steer-pause-resume.md#required-behavior) owns the rule, and dimming the affected rows while the intervention is in flight is a permitted affordance)

## Acceptance Criteria

- [ ] A client can see live run, approval, artifact, and child-run activity in one timeline surface.
- [ ] Missing live updates can be recovered through replay without rebuilding state from free-form text.
- [ ] Reasoning surfaces clearly distinguish available, unavailable, and policy-redacted cases.
- [ ] Handoff and run-state entries render as distinct timeline rows with appropriate visual treatment.
- [ ] Rolled-back turns render with the distinct superseded treatment identically on live delivery (the `run.rolled_back` boundary entry's already-delivered-rows rule keyed on each row's exposed run position and epoch against the boundary's typed cutoff — delivered to every filtered subscription admitting the run's rows, the live marker identical to replay by construction — plus attribution-ranked late stragglers — pre-marked above the run's effective lineage-minimum cutoff for their epoch, current within the surviving history, a later rollback below an earlier retained prefix superseding the inherited rows), `TimelineRead` windows, and replay recovery; a re-executed turn reusing a superseded ordinal renders current; and a compacted superseded row composes the stub placeholder with the superseded marker.

## ADR Triggers

- If reasoning visibility or audit exposure materially changes the observability boundary, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md` or a replacement observability ADR.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: per-session verbose reasoning opt-in is out of scope. Reasoning visibility follows the canonical product or organization policy without session-level overrides.
- V1 decision: durable reasoning visibility in v1 is summary-first. Provider-native detailed reasoning may be rendered transiently or retained only as bounded non-canonical diagnostics when policy permits it.

## References

- [Observability Architecture](../architecture/observability-architecture.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Multi-Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md)
- [Provider Accounts And Credential Homes](../specs/029-provider-accounts-and-credential-homes.md)
