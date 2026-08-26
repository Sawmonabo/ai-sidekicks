# Spec-030: Sidekick Definitions And Peer Invocation

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `030` |
| **Slug** | `sidekick-definitions-and-peer-invocation` |
| **Date** | `2026-08-26` |
| **Author(s)** | `Sawmon Abo` |
| **Depends On** | [Spec-005](005-provider-driver-contract-and-capabilities.md), [Spec-006](006-session-event-taxonomy-and-audit-log.md), [Spec-012](012-approvals-permissions-and-trust-boundaries.md), [Spec-016](016-multi-agent-channels-and-orchestration.md), [Spec-028](028-mcp-server-configuration-and-governance.md), [Spec-029](029-provider-accounts-and-credential-homes.md); [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md) |
| **Implementation Plan** | [Plan-030](../plans/030-sidekick-definitions-and-peer-invocation.md) |

## Purpose

A sidekick is configured once and used many times. Today the only way to put one into a session is to describe it inline on every `agent.attach` call, so the configuration a user tuned — provider, model, effort, instructions, the tools it may reach, the account that pays for it — exists nowhere except inside whichever session it was typed into. This spec defines the **sidekick definition**: a node-local, named, durable record of that configuration, and the rules by which a session attaches an agent _by reference_ to one.

It also defines **peer invocation** — the two daemon-served tools by which a running sidekick asks or delegates to another sidekick. Peer invocation is the reason the definition registry must exist rather than merely being convenient: a sidekick naming the peer it wants needs a stable, node-local thing to name.

## Scope

- The `sidekick_definitions` registry: its fields, its identity model, its uniqueness rules, and its node-local lifetime.
- Attach-by-reference: how `agent.attach` resolves a definition, what it records, what it refuses, and why the resulting agent is a snapshot rather than a live reference.
- Peer invocation: the `ask_sidekick` and `delegate_to_sidekick` tools, their targeting rules, their per-session enablement, their authorization, and their cost and causation consequences.
- The editing surfaces the desktop and CLI clients present for definitions.

## Non-Goals

- **No new orchestration primitive.** A peer invocation creates an ordinary orchestration-admitted child run. Every `Spec-016 §Scheduler Limits` admission rule, every link type, and every refusal code applies unchanged; this spec adds no run kind, no link type, and no scheduler rule.
- **No new approval category.** Peer invocation is authorized as a **named operation action** rather than through the approval pipeline — the `Spec-012 §Implementation Notes` alternative to a category-mediated decision — so that spec's approval-category enum is unchanged and no `ApprovalCategory` value is added. An invocation still lands as an ordinary `tool_activity` row. The nine-member category enum of `Spec-012 §Required Behavior` is unchanged.
- **No cross-node targeting.** A definition and a peer-invocation target are node-local. Cross-node dispatch remains `Spec-024`'s; a target resolving to a non-local node refuses under the existing `orchestration.node_not_local`.
- **No definition sharing or sync.** Definitions live on the node that owns them and are never relayed, published to the control plane, or carried in a session join. Two nodes that both hold a definition named `reviewer` hold two unrelated records.
- **No workflow replacement.** A workflow phase remains the surface for multi-step authored orchestration (`Spec-017`). A sidekick definition configures _one_ sidekick; it declares no sequence, no gate, and no dependency edge.
- **No structured report-back channel beyond the tool result.** `ask_sidekick` returns the peer's answer as the tool result and `delegate_to_sidekick` returns the delegated run's identity; neither mints a side channel by which a child pushes structured state into its parent.

## Domain Dependencies

- [Agent, Channel And Run Model](../domain/agent-channel-and-run-model.md) — the agent lifecycle a resolved definition instantiates, and the parent/child run relationship a peer invocation creates.
- [Session Model](../domain/session-model.md) — sessions are the scope at which peer invocation is enabled.
- [Glossary](../domain/glossary.md) — _sidekick_, _agent_, _run_, _session_.

## Architectural Dependencies

- [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) — the `sidekick.*` wire surface, the `SessionCallbackTool` registry the two tools are registered into, and the `AgentAttachRequest` member that carries a definition reference.
- [local-sqlite-schema.md](../architecture/schemas/local-sqlite-schema.md) — the `sidekick_definitions` table.
- [Spec-006](./006-session-event-taxonomy-and-audit-log.md) — the event taxonomy this spec mints exactly one type into, `session.peer_invocation_set` in the existing `session_lifecycle` category. Nothing on the definition plane emits; the single type carries the per-session peer-invocation opt-in, which is session state rather than node-local configuration and therefore has no home outside the event log.
- [error-contracts.md](../architecture/contracts/error-contracts.md) — the refusal vocabulary, which this spec extends by exactly one namespace: the five-code `sidekick.*` set covering the definition plane. The **peer-invocation path mints no code at all** — every invocation refusal, authorization denial included, rides the callback-tool result's own `denied` / `failed` arms so it reaches the asking model as a tool result rather than a transport error. Every other namespace is consumed unchanged.
- [security-architecture.md](../architecture/security-architecture.md) — the participant role matrix that bounds who may manage definitions.
- [ADR-001](../decisions/001-session-is-the-primary-domain-object.md) — a definition is session-independent configuration; the session remains the primary object and a definition never owns one.
- [ADR-012](../decisions/012-cedar-approval-policy-engine.md) — the policy engine the two named actions register against.

## Preconditions

- [x] All declared `Depends On` specs are at `approved` status
- [x] All declared `Depends On` ADRs are at `accepted` status
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Spec-status promotion gate cleared per [`docs/operations/plan-implementation-readiness-audit-runbook.md#spec-status-promotion-gate`](../operations/plan-implementation-readiness-audit-runbook.md#spec-status-promotion-gate)**

## Required Behavior

### The definition registry

- A **sidekick definition** is a node-local durable record carrying: a human `name`, an optional `description`, the provider driver key, the model id, an optional provider-account reference, an optional effort level, an optional execution-posture **mode**, `instructions` (the system-prompt text the sidekick runs under), an optional `goal`, an optional tool allowlist, and creation/update timestamps.
- Definition **identity is a daemon-minted opaque immutable `definitionId`**. `name` is a mutable human label and MUST NOT be used as an identity key on any wire request, stored reference, or audit row. Renaming a definition MUST NOT change its `definitionId`, and MUST NOT alter any agent already attached from it.
- `name` MUST be unique per node under case-insensitive comparison. Two definitions differing only in letter case are the same handle to a human reading a picker, and admitting both would make the name a target no operator can disambiguate.
- The tool allowlist has three distinguishable states and the daemon MUST NOT collapse them: **absent** means the driver's default tool set, an **empty list** means no tools at all, and a **populated list** means exactly those tools. An absent allowlist and an empty one are opposite instructions.
- A definition stores the execution-posture **mode** only — never a composed `ExecutionPosture`. The daemon composes the full posture at attach time from that mode plus the session's live credential policy. Storing a composed posture would let a definition pin a content-addressed `credentialPolicyRef` that has since been superseded, so a definition edited once could re-grant a trust decision the session has since narrowed.
- Definitions are node-local. The daemon MUST NOT relay, publish, or otherwise transmit a definition to the control plane or to a peer node.

### Attach-by-reference

- `agent.attach` MUST accept a `definitionId`. When present, the daemon resolves the definition and uses its fields as the base configuration for the agent being attached.
- Request members that are explicitly present MUST override the definition's corresponding field, per field. The response MUST echo the **effective resolved configuration** — every field as actually applied — so a caller can never be left guessing which side of the merge won.
- The attached agent is a **snapshot**. Editing or deleting a definition MUST NOT mutate, reconfigure, re-authorize, or revoke any agent already attached from it, and MUST NOT affect any run in flight. A live reference would let an edit widen an already-attached agent's tool allowlist, posture, or paying account without that widening ever passing the attach-time authorization that admitted the agent in the first place.
- Resolution MUST fail closed. A definition naming a provider account that is no longer in this node's registry MUST refuse the attach; the refusal MUST name the definition and the unresolvable account. The test is **registry membership**, a definite fact the resolver owns — deliberately not whether the account is currently usable, which is authentication state that `Spec-029`'s live spawn probe is the authority on. Refusing here on a stored readiness reading would refuse an attach the spawn gate would have admitted. The daemon MUST NOT silently fall back to the provider's default account — a pinned account that quietly becomes "whichever account is default now" is a spend and identity change the operator did not ask for.
- A refused attach MUST be zero-residue: no agent row, no partial configuration, and no run survives it.
- The tool allowlist MUST be **enforced at spawn**, not merely recorded. If the resolved driver cannot realize the allowlist, the attach MUST refuse rather than spawning the sidekick unconstrained. An allowlist that is stored and not applied is worse than no allowlist, because it reports a restriction that does not hold.
- Deleting a definition MUST NOT be blocked by the existence of agents attached from it, because those agents no longer depend on it.

### Peer invocation

- The daemon serves exactly two peer-invocation tools into a session's callback-tool registry: **`ask_sidekick`** and **`delegate_to_sidekick`**. Both are daemon-constructed and daemon-trusted, and both reach every provider through the registry defined by `Spec-005 §Required Behavior` — the Codex leg as a function-form dynamic tool, the Claude leg through the daemon-hosted ephemeral MCP server.
- Both tools target a **sidekick** — a session agent by its agent id, or a saved definition by its `definitionId`, attached on demand. A request naming a provider, a model, or an account rather than a sidekick MUST be refused. The unit a sidekick addresses is a configured collaborator, not a vendor.
- `ask_sidekick` creates a child run linked `spawn` and returns the peer's final answer as the tool result. `delegate_to_sidekick` creates a child run linked `delegate` in its own channel and returns that run's identity and channel; its outcome reaches the asking session through the ordinary timeline rather than through the tool result. Both link types are the existing ones — this spec mints none.
- Every invocation MUST be authorized under the named Cedar action `Action::"sidekick::invoke"`, MUST land as an ordinary `tool_activity` row, and MUST produce a run visible in the session timeline like any other. There is no invisible peer invocation.
- The created run is admitted through the ordinary orchestration pipeline. `Spec-016 §Default Behavior`'s one-layer nesting rule therefore applies without restatement: a sidekick reached by `ask_sidekick` cannot itself reach a third, because the run it would create is a second-level child and is refused under the existing `orchestration.depth_exceeded`.
- Refusals MUST be answered on the callback-tool result's existing arms — `denied` with the reason for an authorization or admission refusal, `failed` for an unknown target or schema-invalid arguments. No invocation is left unanswered, and no peer-invocation refusal is invented as a new error code.

### Enablement

- Both tools MUST be registered into the callback-tool registry at spawn **unconditionally**, and every invocation MUST be adjudicated against `Action::"sidekick::invoke"` at call time. A session that has not enabled peer invocation answers every call `denied`. This follows the landed `workflow_start` shape — registered at spawn, Cedar-adjudicated per invocation — and is deliberately **not** grant-gated registration: `callbackTools` rides only the session-creation and resume parameter shapes, and no live-registry mutation seam exists, so a registry filtered by enablement could not change until the leg respawned and an operator who enabled peer invocation mid-session would observe nothing. Per-call adjudication requires no such seam and makes enablement effective on the next call.
- A definition's tool allowlist MUST filter this registry as it filters any other tool source. An agent attached from a definition whose allowlist is empty receives **no** peer-invocation tools, and one naming an explicit set receives them only if that set names them. An allowlist that did not bind the daemon's own curated tools would report a restriction that is not in force.
- Enablement is an explicit act on the session, authorized under the named Cedar action `Action::"sidekick::manage"` evaluated against that session, and is recorded as the `session.peer_invocation_set` event of [Spec-006 §Session Lifecycle](006-session-event-taxonomy-and-audit-log.md#session-lifecycle-session_lifecycle). It is **not** a remembered approval rule: `remembered_approval_rules` closes its category enum over the approval-pipeline categories and requires a reference to an approval resolution, and a named-operation action produces neither, so a grant row for enablement is unrepresentable rather than merely unnecessary. Nor does it get a table: this corpus projects no session-configuration row, and session-scoped mutable configuration lives in the event log — the same shape the session goal already uses. The projected flag is a Cedar **context** input on every invocation check, which is exactly the context-is-session-state mapping of `Spec-012 §Implementation Notes`. No approval category and no table are minted for it.
- Once enabled, invocation is **automatic for the remainder of the session** — the per-call Cedar check reads the projected flag and prompts no one. The single act of enabling is the user request that `Spec-016 §Default Behavior` requires before child runs are created on a session's behalf.
- Withdrawing enablement appends the same event with the flag off. Because adjudication is per call, the withdrawal takes effect on the **very next invocation** on every live leg — there is no window in which an already-spawned leg keeps a capability the operator has revoked, and no registry rebuild is required.
- A peer-invoked child run MUST carry the **effective principal of the turn that issued the invoking tool call**, stamped daemon-side at creation on the run link. Such a run has neither an intervention row nor a participant who started it, and chaining to the parent run cannot answer the question — a run accumulates turns from potentially several principals, and recency is not a correct answer to which one called. The value is never client-supplied, and a creation that cannot resolve one MUST refuse rather than create an unattributed run.
- `ask_sidekick` waits for its peer's answer, so **every terminal state of the child MUST settle the waiting call**. A child that fails, is cancelled, or is interrupted answers `failed` naming the terminal state; a child that reaches completion without producing an answer answers `failed` rather than `completed` with empty output. The child's run id does not exist before admission, so the waiter cannot subscribe ahead of it; the waiter MUST therefore **capture the run-lifecycle stream cursor before admitting the child**, then subscribe and replay forward from that captured cursor, settling from whichever source presents the terminal first. Subscribing merely before the tool _returns_ is insufficient and MUST NOT be relied on: a live subscription opened after admission never replays the terminal that landed in between, which is the one window this ordering closes. No invocation is left unanswered.

### Cost and causation

- A peer-invoked run's spend lands on **that run's own** cost-receipt row and is paid by the **target sidekick's** provider account — an ordinary value of the receipt's existing per-account axis.
- A peer-invoked run's spend attributes, on the receipt's per-caused-by axis, to the **effective principal of the turn that made the invoking tool call** (`Spec-016 §Session Cost Receipt`) — that turn's principal is already resolved when the call is issued, so the attribution is a fact at creation time rather than a later lookup, and a subsequent steer of the asking run never retroactively re-attributes an already-created child. It is never the `system` arm, which is reserved for work no participant caused.
- The receipt MUST NOT roll a child's spend into the asking run's row. `Spec-016 §Session Cost Receipt`'s per-run partition stays run-scoped, and the causal relationship between asker and peer is carried by the existing parent/child run link, which the receipt reads and never re-folds.

## Default Behavior

- Peer invocation is **disabled** in every new session. A session that never enables it behaves exactly as a session predating this spec.
- A definition with no provider-account reference resolves to the provider's default account at attach time, and the resolved account is recorded on the agent — so a later change of default never silently re-points an already-attached sidekick.
- A definition with no effort level resolves to the driver's default. A supplied effort is validated at resolution against the target model's driver-reported effort levels, never against a corpus-wide enumeration.
- A definition with no execution-posture mode resolves to the session's default posture.
- A definition with no tool allowlist resolves to the driver's default tool set.

## Fallback Behavior

- **The registry is unreadable.** Attach-by-reference refuses; inline `agent.attach` is unaffected, so a storage fault on this table never blocks ordinary session work.
- **A definition pins a provider account that is no longer in the registry.** Resolution refuses, names the definition and the account, and creates no agent. The daemon MUST NOT fall back to the provider's default account. Account _readiness_ is deliberately **not** checked here: `Spec-029 §Node provider readiness and the sign-in handoff` makes the stored readiness projection advisory only, and the authoritative authentication check is the live probe the spawn path performs. Refusing at resolution on a stored reading would refuse a sidekick that would have started.
- **A definition's model is no longer offered by its provider.** Resolution refuses and names the model. The daemon MUST NOT substitute a nearest-match model — silently running a different model than the one a definition pins changes both behavior and price.
- **A definition's effort level is not supported by its model.** Resolution refuses and names the supported set, rather than coercing to a neighbouring level.
- **A definition's tool allowlist cannot be realized by the resolved driver.** Resolution refuses, names the unrealizable tools alongside the driver's supported set, and creates no agent. The daemon MUST NOT spawn the sidekick with a silently narrowed allowlist, and MUST NOT spawn it unconstrained — either substitution reports a restriction that is not in force.
- **A peer-invocation target names a definition that no longer exists.** The tool answers `failed` with the unresolvable target; no run is created.
- **A peer-invocation target resolves but its attach refuses.** The tool answers `denied` carrying the attach refusal's reason, so the asking sidekick learns why rather than seeing an unexplained failure.
- **The approval seam is unavailable.** The whole callback-tool registry is withheld at spawn under the existing fail-closed availability rule of `Spec-005 §Required Behavior`, and these two tools go with it — a withholding inherited from that rule rather than one this spec introduces; a stray invocation on an already-spawned leg is answered `denied`.
- **A peer-invoked child terminates without answering.** `ask_sidekick` answers `failed` naming the terminal state rather than waiting indefinitely or reporting a success the asking model would act on.

## Interfaces And Contracts

- A `sidekick.*` daemon JSON-RPC namespace carrying definition create / update / delete / list operations and the per-session peer-invocation enablement setter. Shapes and method strings are registered in [api-payload-contracts.md §Plan-030 — Sidekick Definitions And Peer Invocation](../architecture/contracts/api-payload-contracts.md#plan-030--sidekick-definitions-and-peer-invocation); every definition-plane and attach-plane refusal this spec describes is typed in [error-contracts.md §Sidekick Definitions](../architecture/contracts/error-contracts.md#sidekick-definitions), whose five codes are the closed set for those paths — an untyped or generic failure on any of them is a defect, not a fallback. Peer-invocation refusals are deliberately absent from that table: they ride the callback-tool result's `denied` / `failed` arms per §Required Behavior, and mint no code.
- A definition reference on the agent-attach request — additive-optional from the caller's side, so an inline attach is unchanged, while an attach that carries the reference need not respell the axes the definition supplies. The effective-resolved-configuration echo rides its response, and covers every field as actually applied, the system prompt and goal included.
- Two `SessionCallbackTool` registrations served through the existing callback-tool dispatch seam of `Spec-005 §Required Behavior`.
- Two named Cedar actions registered in the enumeration of `Spec-012 §Implementation Notes`.
- Exactly one new event type, and it is not on the definition plane. Definition mutation emits nothing: it is node-local configuration rather than session history, and every session-visible consequence of a peer invocation is already carried by the existing tool-activity and run-lifecycle events. The single mint is `session.peer_invocation_set`, the durable home of the per-session opt-in — session-scoped state rather than node-local configuration, and the audit record of a capability grant that lets a running model start other runs.
- A session read surfaces the peer-invocation opt-in as an **additive-optional** member on the existing session-read reply, rather than through a dedicated verb. It is a projection of the `session.peer_invocation_set` fold, never a second source of truth: absent means the responder predates the member and is rendered as **unknown**, never as disabled — defaulting an unknown capability grant to off would present an enabled session as safe. This is what lets a client reopening a session show the current state without replaying and folding raw events itself.

## State And Data Implications

- One node-local table, owned by this spec's plan, holding definitions. It is configuration, not session state: it is not events-canonical, is not replayed, and is not rebuilt from the event log.
- Attaching from a definition writes the resolved values onto the existing agent record. No foreign key binds an agent to the definition it was resolved from, because the agent does not depend on it after resolution.
- No relay, control-plane, or export impact: definitions never leave the node.
- `instructions` and `goal` are operator-authored text and are treated as ordinary node-local configuration content; they are never emitted into an event payload by definition mutation.

## Example Flows

- `Example: A user creates a definition named "reviewer" pinning a provider, a model, xhigh effort, a read-only posture mode, review instructions, and an allowlist of read-only tools. In three later sessions they attach it by reference; each session records its own resolved snapshot.`
- `Example: The user edits "reviewer" to widen its tool allowlist. The two sidekicks already attached from the previous version keep the narrower allowlist for the rest of their lives; the next attach picks up the wider one.`
- `Example: A sidekick calls ask_sidekick targeting "reviewer". Peer invocation was enabled earlier in the session, so no prompt appears. A child run is admitted linked spawn, runs under the reviewer's own account, and its answer returns as the tool result. The reviewer's spend appears on its own receipt row under its own paying account.`
- `Example: A sidekick reached through ask_sidekick calls ask_sidekick itself. The run it would create is a second-level child, so admission refuses under orchestration.depth_exceeded and the tool answers denied carrying that reason.`
- `Example: The account a definition pins is removed. The next attach from that definition refuses and names both the definition and the missing account; no agent is created and no default account is substituted.`

## Implementation Notes

- The registry is a natural home for later work this spec deliberately does not do — definition versioning, sharing across nodes, and per-definition budget ceilings are all expressible as additive columns rather than as reshapes.
- The snapshot rule makes the definition table safe to edit under load: no reader of a running agent's configuration ever consults it.
- Because enablement is an event rather than a hidden flag, the session timeline is itself the audit record of who granted the capability and when — and a capability that lets a running model start other runs is exactly the kind that should not be silently held.

## Pitfalls To Avoid

- **Do not make an attached agent a live view of its definition.** It reads as a feature ("edit once, applies everywhere") and is an authorization hole: it widens a running agent's authority without an authorization act.
- **Do not treat `name` as an identifier.** A rename must not orphan references, and two nodes' identically-named definitions are unrelated records.
- **Do not conflate an absent tool allowlist with an empty one.** One means "the driver's defaults", the other means "nothing"; collapsing them either strips a sidekick of every tool or hands it all of them.
- **Do not store a composed execution posture in a definition.** Posture carries content-addressed policy references that are meaningful only against the session that composed them.
- **Do not fall back to a default provider account when a pinned one is missing.** It converts a hard, legible refusal into a silent change of who pays and which identity acts.
- **Do not filter the peer-invocation tools out of the registry by enablement state.** It reads as the safer choice and is not: the registry is composed at spawn only, so a filtered registry cannot reflect a mid-session change, and the operator who just enabled the capability sees nothing happen. Adjudicate per call instead, and keep the refusal legible.
- **Do not add a depth rule for peer invocation.** The nesting limit already exists at admission; a second rule in a second place will drift from the first.

## Acceptance Criteria

- [ ] A definition can be created, listed, updated, renamed, and deleted; `definitionId` is stable across every update including a rename.
- [ ] Creating a second definition whose name differs only in letter case is refused, including a pair differing only in a non-ASCII case mapping, and including two such creates issued concurrently — exactly one commits.
- [ ] `agent.attach` with a `definitionId` produces an agent whose configuration matches the definition, and the response echoes the effective resolved configuration.
- [ ] `agent.attach` carrying both a `definitionId` and an explicit field applies the explicit field for that field only, and echoes the merged result.
- [ ] Editing a definition leaves an agent previously attached from it byte-for-byte unchanged in configuration, and deleting the definition leaves that agent running.
- [ ] Attaching from a definition whose pinned provider account is absent refuses, names the definition and the account, creates no agent, and does not fall back to the default account.
- [ ] Attaching from a definition whose tool allowlist the driver cannot realize refuses rather than spawning.
- [ ] A definition with an absent tool allowlist and one with an empty allowlist produce observably different spawns.
- [ ] Both peer-invocation tools are present in a session's callback-tool registry regardless of enablement state, and a call made before enablement is answered `denied`.
- [ ] An agent attached from a definition whose tool allowlist is empty receives neither peer-invocation tool.
- [ ] After enablement, a peer invocation completes with no per-call approval prompt, and still lands a `tool_activity` row and a timeline-visible run.
- [ ] `ask_sidekick` produces a child run linked `spawn` whose answer returns as the tool result; `delegate_to_sidekick` produces a child run linked `delegate` in its own channel.
- [ ] A peer invocation issued from inside a peer-invoked run is refused under the existing depth rule and answered `denied`.
- [ ] Withdrawing enablement causes the next invocation on an already-running leg to be answered `denied`, with no respawn required.
- [ ] Enabling and disabling peer invocation each append exactly one `session.peer_invocation_set` event naming the acting participant, and replaying the event log alone restores the session's current enablement state — no local row backs it.
- [ ] A peer-invoked child run carries the effective principal of the turn that issued the invoking call, and a creation that cannot resolve one refuses.
- [ ] An `ask_sidekick` call whose child fails, is cancelled, or completes without an answer is settled `failed` rather than left waiting.
- [ ] A peer-invoked run's spend appears on its own cost-receipt row under the target sidekick's paying account, and the asking run's row is unchanged.
- [ ] A peer-invoked run's spend attributes, on the per-caused-by axis, to the effective principal of the turn that issued the invoking tool call, and never to the `system` arm; steering the asking run after the child is created does not change that attribution.
- [ ] Targeting a provider or a model rather than a sidekick is refused.
- [ ] Every refusal on the definition and attach paths carries one of the five registered `sidekick.*` codes, and none surfaces as a generic or untyped failure; every peer-invocation refusal arrives on a callback-tool result arm instead, carrying no code.
- [ ] A definition whose pinned account is registered but not currently authenticated resolves, and is refused by the spawn gate rather than by the resolver.

## ADR Triggers

- Making an attached agent a live reference to its definition, or otherwise allowing a definition edit to change a running agent's authority, is an authorization-model change and requires an ADR.
- Sharing, syncing, or relaying definitions between nodes crosses this spec's node-local boundary and requires an ADR covering trust and provenance of a definition authored elsewhere.
- Allowing peer invocation beyond one nesting layer changes `Spec-016`'s canonical first-release contract and requires an ADR covering runaway-fan-out containment.
- Minting a report-back channel by which a delegated run pushes structured state into its parent adds an inter-run data path and requires an ADR.

## Open Questions

- None.

## References

- [Spec-005 — Provider Driver Contract And Capabilities](005-provider-driver-contract-and-capabilities.md) — the callback-tool registry and dispatch seam both tools are served through, and the driver-reported effort levels a definition's effort is validated against.
- [Spec-006 — Session Event Taxonomy And Audit Log](006-session-event-taxonomy-and-audit-log.md) — the tool-activity and run-lifecycle events a peer invocation lands on.
- [Spec-012 — Approvals, Permissions And Trust Boundaries](012-approvals-permissions-and-trust-boundaries.md) — the Cedar action enumeration, and the principal / action / resource / context mapping the enablement flag is read through as context.
- [Spec-016 — Multi-Agent Channels And Orchestration](016-multi-agent-channels-and-orchestration.md) — run links, scheduler limits, the nesting rule, and the session cost receipt.
- [Spec-028 — MCP Server Configuration And Governance](028-mcp-server-configuration-and-governance.md) — the governed-binding plane these daemon-hosted tools deliberately sit outside of.
- [Spec-029 — Provider Accounts And Credential Homes](029-provider-accounts-and-credential-homes.md) — the account identity a definition pins, and the spawn-time authentication gate (I-029-3) that resolution defers to rather than duplicating.
- [Plan-030 — Sidekick Definitions And Peer Invocation](../plans/030-sidekick-definitions-and-peer-invocation.md) — the implementation plan.
- [Model Context Protocol specification, revision `2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28/) ([schema.ts](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts)) — the revision the Claude leg's daemon-hosted server speaks. Two of its §Security and Trust & Safety rules are load-bearing here and are honoured rather than assumed: tool annotations "should be considered untrusted, unless obtained from a trusted server", which is why both tools are daemon-constructed and daemon-trusted and are never sourced from a governed third-party binding; and "Hosts must obtain explicit user consent before invoking any tool", which the once-per-session enablement act supplies — see §Required Behavior's enablement rules for why that act, and not a per-call prompt, is the consent MCP requires.
- MCP **elicitation** is a _client_ feature in that revision — a server-initiated request for information from the user — and is deliberately unused by these two tools: a peer invocation asks another **sidekick**, never the human, so routing it through elicitation would put a prompt in front of the user on a path this spec requires to be promptless once enabled.
