# Plan-027: Agent Definitions And Peer Invocation

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `027` |
| **Slug** | `agent-definitions-and-peer-invocation` |
| **Date** | `2026-08-26` |
| **Author(s)** | `Sawmon Abo` |
| **Spec** | [Spec-027](../specs/027-agent-definitions-and-peer-invocation.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md) |
| **Dependencies** | [Plan-014](./014-multi-agent-channels-and-orchestration.md) (agents, run links, orchestration admission), [Plan-026](./026-provider-accounts-and-credential-homes.md) (provider accounts), [Plan-010](./010-approvals-permissions-and-trust-boundaries.md) (Cedar named-operation actions and the turn-scoped effective principal), [Plan-005](./005-session-event-taxonomy-and-audit-log.md) (the `session.peer_invocation_set` type registration), [Plan-004](./004-provider-driver-contract-and-capabilities.md) (callback-tool host), [Plan-021](./021-desktop-shell-and-renderer.md) (renderer mount), [Plan-006](./006-local-ipc-and-daemon-control.md) (CLI base command) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Deliver the node-local agent-definition registry, the resolution a run performs under a definition, and the one daemon-owned tool server that bridges an agent to a lead on either provider — so a user configures an agent once and reuses it, and a running agent can reach a named peer whichever provider that peer is bound to.

## Scope

The `agent_definitions` table and its migration; the five definition-plane `agent.*` operations; the definition store and its case-insensitive uniqueness enforcement; the fail-closed resolver; the run-start integration that consumes it; the bridge's six `SessionCallbackTool` registrations, their session-scoped enablement, and their invocation handler; the CLI command surface; and the desktop library and editor handed to the shell's mount point.

## Non-Goals

- **No orchestration mechanism.** Run admission, link projection, depth enforcement, scheduler limits, and budget accounting are Plan-014's and are consumed unchanged. This plan authors no admission rule.
- **No approval mechanism.** The Cedar gate, the approval pipeline, and the remembered-grant store are Plan-010's. This plan registers two named actions against them and authors no Plan-010 symbol.
- **No driver or transport work.** The callback-tool registry, its dispatch seam, and the daemon-hosted ephemeral MCP server that carries it on the Claude leg are Plan-004's and already ship. This plan registers the bridge's six verbs into that registry and authors no Plan-004 file.
- **No provider-account mechanism.** Account identity, readiness, and credential homes are Plan-026's. This plan reads its published registry surface and authors no Plan-026 file.
- **One new event type — `session.peer_invocation_set`, the opt-in's durable home — and no new error code _on the peer-invocation path_.** Nothing on the definition plane emits: every session-visible consequence of a peer invocation rides existing events, and every peer-invocation refusal rides the callback-tool result's existing `denied` / `failed` arms. The definition and resolution paths do own five registered definition-plane `agent.*` codes ([error-contracts.md §Agent Definitions](../architecture/contracts/error-contracts.md#agent-definitions)); reusing another namespace's codes for them would make the code itself a lie about which subsystem refused.

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-027 PRs and downstream extensions. Any change that would weaken or remove an invariant requires a coordinated cross-plan amendment (see cross-plan-dependencies.md).

### I-027-1 — Definition identity is opaque, immutable, and never the name

`definitionId` is daemon-minted, opaque to every caller, and stable for the life of the row including across a rename. No wire request, stored reference, or audit row keys a definition by `name`.

**Grounds in.** [Spec-027 §Required Behavior](../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) — the definition-registry identity rule.

**Why load-bearing.** `name` is the one field a user edits most and the one a peer-invocation target spells. If identity rode the name, a rename would silently repoint or orphan every stored reference, and two nodes' identically-named definitions would appear interchangeable. The opaque-immutable-id-plus-mutable-label split is the same shape `ProviderAccountId` already uses, so the two registries stay legible together.

**Verification.** T1.1 schema rows rejecting a caller-supplied `definitionId`; T2.1 rename test asserting the id is byte-identical before and after.

### I-027-2 — A run keeps the configuration it was resolved for, never a live view

Resolution copies the definition's values onto the run's own agent record when the run starts. No read path serving a running agent's configuration consults `agent_definitions`, and no foreign key binds an agent to the definition it was resolved from. Display is the one exception: a running agent's name, icon, and accent are read from the definition at the moment they are drawn.

**Grounds in.** [Spec-027 §Resolution when a run starts](../specs/027-agent-definitions-and-peer-invocation.md#resolution-when-a-run-starts) — the rule that a run keeps the configuration it was given.

**Why load-bearing.** This is the plan's central authorization property, not a caching choice. A live reference would let an edit widen a running agent's tool allowlist, execution posture, or paying account without that widening passing the Cedar check that admitted the run. It also makes the registry safe to edit under load, because nothing serving a live run reads it.

**Verification.** T3.3's isolation suite — edit and delete a definition under a live agent and assert its stored configuration is unchanged and its run unaffected; a static check that no module on the running-agent read path imports the definition store.

### I-027-3 — Resolution fails closed and never substitutes

An unresolvable provider account, model, effort level, or tool allowlist refuses the run, names what could not be resolved, and starts nothing. The four inputs are exactly the four arms of the closed `agent.resolution_refused` `reason` discriminator, so every unresolvable input has a typed refusal and none falls through untyped. The resolver never falls back to a default account, a nearest-match model, a neighbouring effort level, or a silently narrowed — or unconstrained — tool set.

**Grounds in.** [Spec-027 §Fallback Behavior](../specs/027-agent-definitions-and-peer-invocation.md#fallback-behavior).

**Why load-bearing.** Every substitution this rule forbids is a silent change to who pays, which identity acts, or what the agent costs and does. A pinned account quietly becoming "whichever account is default now" is precisely the class of change an operator pinned it to prevent.

**Verification.** T3.1 refusal rows for absent account, absent model, unsupported effort, and unrealizable tool allowlist — one per closed `reason` arm; T3.2 assertion that no agent row survives a refused resolution.

### I-027-4 — The tool allowlist has three distinguishable states and is enforced at spawn

Absent, empty, and populated allowlists are stored and transported distinguishably, and the resolved allowlist is applied at spawn. A driver that cannot realize the allowlist refuses the run rather than spawning unconstrained.

**Grounds in.** [Spec-027 §Required Behavior](../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) — the tool-allowlist state rule and the spawn-enforcement rule.

**Why load-bearing.** Collapsing absent into empty strips an agent of every tool; collapsing empty into absent hands it all of them. Both are silent. Recording an allowlist without enforcing it is worse than storing none, because the registry then reports a restriction that does not hold — a false assurance an operator will rely on.

**Verification.** T1.2 round-trip rows proving `NULL` and `'[]'` survive distinctly; T3.1 spawn-enforcement test asserting an unrealizable allowlist refuses; T3.2 observable-difference test between an absent and an empty allowlist.

### I-027-5 — Peer invocation is adjudicated per call, never gated by registry composition

The bridge's six verbs are registered at spawn unconditionally, and every invocation is adjudicated against `Action::"agent::invoke"` with the session's projected enablement flag supplied as Cedar context. A call made while the session has not enabled peer invocation — including one arriving on a leg spawned while it was enabled — is answered `denied`.

**Grounds in.** [Spec-027 §Required Behavior](../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) — the registration and enablement rules.

**Why load-bearing.** This is a correctness property, not a stylistic one. `callbackTools` rides only the session-creation and resume parameter shapes and there is no live-registry mutation seam, so a registry composed against enablement state is frozen at spawn: enabling mid-session would change nothing until the leg respawned, and — worse in the other direction — withdrawal would leave a live leg holding a capability the operator believes they revoked until its next spawn boundary. Per-call adjudication makes both directions immediate and needs no seam that does not exist. It also matches the landed `workflow_start` precedent, the corpus's only other concrete session callback tool.

**Verification.** T4.1 asserting all six verbs present in a freshly composed registry with enablement off; T4.3 asserting a call under a disabled session answers `denied`; T4.2 asserting a withdrawal mid-session causes the very next call on an already-running leg to answer `denied` with no respawn.

### I-027-6 — Peer invocation mints no orchestration primitive

A peer invocation creates its child run through the ordinary orchestration admission pipeline. This plan adds no run kind, no link type, no scheduler rule, and no depth check of its own.

**Grounds in.** [Spec-027 §Non-Goals](../specs/027-agent-definitions-and-peer-invocation.md#non-goals); [Spec-014 §Default Behavior](../specs/014-multi-agent-channels-and-orchestration.md#default-behavior) — the depth rule that consequently applies without restatement: no ceiling by default, a refusal only against a configured limit.

**Why load-bearing.** A configured depth limit, the active-child limit, the queue depth, and the budget ceiling are all enforced in one place today. A second depth check inside the peer-invocation handler would be a second source of truth that drifts from the first, and the drift would be discovered as runaway fan-out rather than as a test failure.

**Verification.** T4.3 asserting a peer invocation from inside a peer-invoked run is admitted like any other child run while no depth limit is configured, and, with one configured that the new level would pass, refused by admission under the existing `orchestration.depth_exceeded` and answered `denied`; a static check that the handler declares no limit constant.

### I-027-7 — Name uniqueness is decided once, by the database, over a stored fold key

The definition store computes the full Unicode case fold of `name` and persists it as `name_folded` on every insert and update; the unique index arbitrates that column. The store owns the folding algorithm but is not the correctness boundary — it produces the key, and the database decides uniqueness.

**Grounds in.** Plan-owned — no spec states where uniqueness is enforced, only that it holds. The storage-level placement is this plan's mechanism.

**Why load-bearing.** `name` is the handle a human picks from a list and the string a peer-invocation target spells; two definitions rendering identically in a picker are indistinguishable to the person choosing. A two-layer arrangement — full folding in the service, an ASCII `COLLATE NOCASE` index as a concurrency backstop — was specified first and does not hold, because the layer performing the real comparison is the layer that cannot be atomic: two concurrent creates of `Ärger` and `ärger` each pass the service precheck, and an ASCII index accepts both. Indexing the stored fold puts the full-Unicode comparison inside the atomic operation, which is the only place a uniqueness guarantee can live.

**Verification.** T1.2 migration test inserting an ASCII case-variant duplicate and a non-ASCII case-variant duplicate and asserting the index rejects **both**; T1.3 conformance row asserting `name_folded` is written on insert and rewritten on rename; T2.1 concurrency test issuing two non-ASCII case variants against the store simultaneously and asserting exactly one commits and the other surfaces `agent.definition_name_conflict`.

### I-027-8 — A definition stores a posture mode, never a composed posture

The table holds the execution-posture mode literal only. No `credentialPolicyRef`, `writableRoots`, or network-access member is persisted in `agent_definitions`, and the full posture is composed when the run starts, against the session's live credential policy.

**Grounds in.** [Spec-027 §Required Behavior](../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) — the posture-mode rule.

**Why load-bearing.** A composed posture carries a content-addressed reference to a credential-policy artifact that is meaningful only against the session that composed it. Persisting one lets a definition pin a policy that has since been superseded, so the next run under it would re-grant a trust decision the session had narrowed — and a stale ref can dangle outright.

**Verification.** T1.3 conformance assertion that the definition record shape carries no posture member beyond the mode literal, checked against the DDL column set.

### I-027-9 — No definition leaves the node

The daemon has no code path that relays, publishes, or transmits a definition row or any of its fields to the control plane or to a peer node.

**Grounds in.** [Spec-027 §Non-Goals](../specs/027-agent-definitions-and-peer-invocation.md#non-goals) — the node-local rule.

**Why load-bearing.** `instructions` is operator-authored free text that routinely carries repository, workflow, and organizational detail. Definitions are configuration rather than session history, so they are outside the relay's end-to-end encryption story entirely; the correct guarantee is that they never enter it.

**Verification.** T2.1 static check that no relay or control-plane client module imports the definition store, plus an assertion that no definition-plane `agent.*` payload type appears in the control-plane contract surface.

### I-027-10 — A definition's tool allowlist binds the daemon's own tools too

The resolved allowlist filters the callback-tool registry contributed to that agent exactly as it filters provider-native tools. An agent whose definition carries an empty allowlist receives none of the bridge's verbs; one naming an explicit set receives them only if that set names them.

**Grounds in.** [Spec-027 §Required Behavior](../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) — the allowlist-filters-the-registry rule; [Spec-027 §Required Behavior](../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) — the spawn-enforcement rule of I-027-4, of which this is the callback-tool half.

**Why load-bearing.** The daemon's curated tools are the easiest ones to forget when enforcing an allowlist, because they are contributed by the daemon rather than requested by the definition — and they are the most consequential to leak, since the bridge's verbs start runs. An allowlist that constrained provider-native tools while silently admitting the daemon's own would report a restriction that is not in force, which is the precise failure I-027-4 exists to forbid.

**Verification.** T4.1 rows starting a run from an empty-allowlist definition and asserting no bridge verb is contributed; from a populated allowlist naming none of them, asserting the same; from a populated allowlist naming them, asserting they appear; and from an absent allowlist, asserting the driver-default composition is unchanged.

### I-027-11 — A run the bridge starts is attributed and every wait is settled

Creation stamps the effective principal of the turn that issued the invoking tool call onto the run link, daemon-resolved and never client-supplied; a creation that cannot resolve one refuses rather than creating an unattributed run. Every terminal state of that agent settles a wait outstanding on it.

**Grounds in.** [Spec-027 §Required Behavior](../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) — the invoking-principal rule and the wait-settlement rule.

**Why load-bearing.** Two independent holes close here. A run the bridge starts has neither an intervention row nor a user who started it — the two arms `EffectivePrincipal` resolves through — so without a stamped value it has no principal at all, and chaining to the parent run cannot supply one because a run accumulates turns from several principals and recency is not a correct answer. Separately, a wait outlives the work it watches: admission succeeding does not guarantee an answer, so an agent that fails, is cancelled, or finishes silently would leave the asking model blocked on a call that never returns — the one outcome the callback-tool dispatch seam forbids.

**Verification.** T4.4 asserting the stamped principal equals the invoking turn's effective principal and differs from the parent run's initiator when the call was issued under a different principal, and that an unresolvable principal refuses creation; T4.3 settlement rows for each terminal — failed, cancelled, interrupted, and finished-without-answer — each settling the outstanding wait with that terminal, plus a race row landing the terminal between admission and subscription.

### I-027-12 — Every daemon-consumed resolved axis has a durable, non-opaque home

Each axis the daemon itself reads — posture mode, tool allowlist, instructions, and goal — is stored in a typed `agents` column, never inside the opaque `config` blob and never re-read from the definition it came from.

**Grounds in.** [Spec-027 §Resolution when a run starts](../specs/027-agent-definitions-and-peer-invocation.md#resolution-when-a-run-starts) — the rule that a run keeps the configuration it was given.

**Why load-bearing.** I-027-2 promises a run keeps what it was resolved for, and a record that cannot be read back is no such promise. `config` is documented opaque to everything outside the driver, so an axis parked there is unreadable by the two paths that need it — registry composition and prompt construction. Without typed homes, deleting the definition and restarting the daemon would leave those paths with nowhere to read the promised configuration, and the only way to reconstruct it would be the deleted row. This is the same reason `provider_account_id` was carved out of `config` rather than folded into it.

**Verification.** T3.2's durability row — start a run under a definition, delete the definition, restart, and reconstruct every axis from the `agents` row alone, with a static check that neither consuming path reads `config` for them.

## Cross-Plan Obligations

Plan-027 declares the following obligations on adjacent plans (or inherits obligations declared by them). Implementation cannot proceed (or must defer specific surfaces) without these being satisfied or explicitly staged.

### CP-027-1 — Definition reference on every run-start surface owed to [Plan-014](./014-multi-agent-channels-and-orchestration.md)

The requests that start a run under an agent are Plan-014-owned and Plan-001-owned. Resolution requires each of them to carry an additive-optional `definitionId` and to echo the effective resolved configuration on its reply; the handler calls this plan's resolver before writing the agent's row, and applies explicitly-present request members over the resolved values per field.

**Resolution.** Plan-014 carries the member, the echo, and the resolver call on the run-start path it owns. Plan-027 T3.2 supplies the resolver and its refusal vocabulary; the wire members are registered in [api-payload-contracts.md §Plan-027 — Agent Definitions And Peer Invocation](../architecture/contracts/api-payload-contracts.md#plan-027--agent-definitions-and-peer-invocation).

### CP-027-2 — Definition-editor mount owed to [Plan-021](./021-desktop-shell-and-renderer.md)

Plan-027 authors the destination's library and editor, and the session's `Sidekicks may call each other` setting, as components under the existing `apps/desktop/src/renderer/src/console/agents/` family, owning no shell, router, or navigation file. The desktop shell must mount that subtree and route to it.

**Resolution.** Plan-021 registers the reciprocal CP-021-6 and mounts the subtree at its Phase 6 renderer shell. Plan-027 T5.1 and T5.2 author the components behind that mount, following the [Plan-003](./003-queue-steer-pause-resume.md) `run-controls/` precedent where the authoring plan owns a subtree and the host plan owns the mount.

### CP-027-3 — Named Cedar actions registered in the Spec-010 enumeration

Peer invocation and definition management are authorized as the named operation actions `Action::"agent::invoke"` and `Action::"agent::manage"`, registered by extending the named-operation-action enumeration in [Spec-010 §Implementation Notes](../specs/010-approvals-permissions-and-trust-boundaries.md#implementation-notes) in place.

**Resolution.** Registered by the 2026-08-26 amendment swap that mints this plan, on the precedent set by the `workflow::cancel` / `workflow::resume` registration. [Plan-010](./010-approvals-permissions-and-trust-boundaries.md) carries no plan-side action enumeration, so no plan-side reciprocal exists and Plan-010's Status does not move — the same asymmetry that registration established.

**Why surfaced here.** The enablement act is authorized under `agent::manage` while each invocation is checked under `agent::invoke`, and the session-scoped opt-in that makes invocation automatic is read as Cedar context on the latter's check rather than stored as a grant of it. Recording both actions together is what keeps "who may turn it on" and "who may use it" separable.

### CP-027-4 — Invoking-principal stamping owed to [Plan-014](./014-multi-agent-channels-and-orchestration.md)

`run_links` is Plan-014-owned. A run the bridge starts has neither an intervention row nor a user who started it, so it resolves no effective principal under either existing arm, and chaining to the parent run cannot supply one — a run accumulates turns from several principals and recency is not a correct answer to which one issued the call. The link row therefore needs an `invoking_principal_id` column, and the creation path needs to stamp it from a value this plan supplies.

**Resolution.** Plan-014 registers the reciprocal CP-014-19, carries the column on its own `run_links` `CREATE` (Phase 2 merges before this plan's Phase 4, so no separate migration ordinal is consumed), and stamps the value its admission caller supplies. Plan-027 T4.4 resolves the invoking turn's effective principal and supplies it; a call whose principal cannot be resolved refuses before admission, so Plan-014 never has to represent an unattributed bridge link. The column is NULL for every link created by any other path.

**Why surfaced here.** The write is one-writer Plan-014, but the obligation originates entirely in this plan's feature: no other caller of that admission path has an invoking turn distinct from the run's initiator.

### CP-027-5 — Event-type registration in the Plan-005 union-registration seam

`packages/contracts/src/event.ts` is Plan-005-owned. This plan mints one event type, `session.peer_invocation_set`, so its type literal, its `SESSION_EVENT_CATEGORY_BY_TYPE` row under `session_lifecycle`, and its `SessionEventSchema` payload arm must be registered in that file.

**Resolution.** Registered through the additive union-registration seam under which each event-emitting plan appends its own variants while its payload schema stays in its own domain — the Plan-014 CP-014-3 precedent, whose T1.13 layers that plan's own delta into the same union. Plan-027 T4.2 lands the literal, the registry row, and the payload arm, gated on Plan-005 Phase 1 by an `external_plan_phase_merged` precondition so the union exists before it is widened. No Plan-005 task and no Plan-005 reciprocal is owed; the seam is one-sided by construction, as it is for every other registrant.

**Why surfaced here.** Without it this plan would add an event type to the taxonomy with no task declaring its literal, and this plan's Phase 4 would gate on a registration no plan owned.

### CP-027-6 — Named-action dispatch route in the Plan-004 callback-tool host

`packages/runtime-daemon/src/provider/callback-tool-host.ts` is Plan-004-owned, and its documented contract routes **every** callback invocation through Plan-010's evaluation seam on `approval.requestCreate`-shaped inputs. Those inputs are keyed by `ApprovalCategory`. `agent::invoke` is a named operation action that deliberately adds no `ApprovalCategory` (D-027-4), so a bridge call is **not expressible** in the input shape the host builds — the defect is not that the host would prompt, but that it cannot represent the call at all.

**Resolution.** The host gains a named-action dispatch route: a callback tool declared as named-action-authorized is adjudicated by the handler's own Cedar check and its outcome answered directly, without an `approval.requestCreate`-shaped evaluation and without minting an approval row, still landing as an ordinary `tool_activity` row. Plan-004 owns that route; this plan owns the declaration marker the bridge's verbs carry and the Cedar check in T4.3. Registered one-sided, on the CP-006-15 precedent that an obligation may ride the owning plan's surface without a reciprocal minted into it — Plan-004 may register its own reciprocal in a later swap without this obligation changing. **That registering swap also owes a quantifier narrowing on two sites, named here because otherwise it has no owner:** [Spec-004 §Scope](../specs/004-provider-driver-contract-and-capabilities.md#scope) states that _every_ callback invocation flows through the daemon's approval pipeline, and `Plan-004` T3.15 leg 3 states that the host routes _every_ invocation through Plan-010's evaluation seam. Both universals are true today — no named-action route exists yet — and both narrow by one clause when the route lands. Deliberately not narrowed here: nothing in this plan ships until the box below is checked, so flipping Spec-004/Plan-004 for a contract neither doc yet implements would move two Statuses ahead of the change they describe.

**Why surfaced here.** Without the route, an enabled session's bridge verbs reach a host that can neither authorize nor represent them, and the fail-closed backstop answers `denied` — the feature would ship inert while every doc claimed it worked.

### CP-027-7 — Durable resolved-configuration columns owed to [Plan-014](./014-multi-agent-channels-and-orchestration.md)

`agents` is Plan-014-owned. Four resolved axes the daemon reads — `execution_posture_mode`, `tool_allowlist`, `instructions`, `goal` — have no typed column today, and `config` cannot host them: it is documented opaque to everything outside the driver, while these are read by registry composition, prompt construction, and the spawn gate.

**Resolution.** Four additive-nullable columns land on Plan-014's own `CREATE`, the same shape and the same argument as the `provider_account_id` carve-out that plan already carries. Plan-014's own T2.1 `agent-service.ts` insert stamps the four columns from the resolution T3.2 supplies, and the record that lands the agent in the log carries them, so the projection stays replay-complete. That division is load-bearing rather than ceremonial: T3.2's Ownership note forbids it from editing any Plan-014-owned file, and the `agents` insert lives in one, so without this obligation the columns would have **no writer at all**. Because the axes are settled when the run starts (`agent.configUpdate` carries no such member), the durable record of that start is their sole carrier and `agent.config_updated` needs no growth. No table census moves.

**Why surfaced here.** I-027-2's keep-what-you-were-given guarantee and I-027-12 both rest on these columns existing.

### CP-027-8 — Session-read projection of the enablement flag owed to Plan-006-partial

`packages/runtime-daemon/src/ipc/handlers/session-read.ts` is Plan-006-partial-owned. The enablement flag's durable home is the event log, and the five definition-plane `agent.*` operations expose only the **mutating** one, so a renderer reopening a session has no read path to the current value short of replaying and folding raw events client-side — which is the live-fold this plan's own read model exists to avoid.

**Resolution.** `SessionReadResponse` carries the projected flag as an additive-optional member — declared in the shipped, Plan-001-owned `packages/contracts/src/session.ts`, where the member MUST be added to **both** the interface and `SessionReadResponseSchema`: that schema is `.strict()`, so an interface-only edit would typecheck and then reject the very field at parse — populated by a **sanctioned field-population edit** inside the Plan-006-partial-owned handler — not ownership — exactly the class of Plan-005 T4.3's `timelineCursors.earliest` line in that same file. No sixth definition-plane verb is minted, so that five-pair census does not move.

**Why surfaced here.** T5.2's `Sidekicks may call each other` setting reads the current flag when it opens a session; without this member it would have no contract to read it from.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [ ] **Named-action callback dispatch route registered (CP-027-6)** — born unchecked 2026-08-26 at the round-2 review fold. Holds **T4.1 and T4.3 directly** and, transitively, the whole of Phase 5, which gates on `plan_phase 4 status: merged` and so cannot dispatch while two Phase-4 tasks are held. T1.x–T3.x and the remaining Phase-4 tasks (T4.2, T4.4) dispatch on tier order and their phase gates. Stated with the transitive set spelled out because a reader scheduling off a bare "only" would mis-plan the Phase-5 work. The Plan-004 callback-tool host builds `approval.requestCreate`-shaped evaluation inputs keyed by `ApprovalCategory`, and `agent::invoke` deliberately has none (D-027-4), so a peer-invocation call cannot be represented in that input shape — not a prompting nuisance but an unrepresentable call. Checked when Plan-004 registers the named-action route CP-027-6 describes, in its own swap. Deliberately a box rather than a machine-checkable `external_plan_phase_merged` gate: the blocker is a contract Plan-004 has not yet authored, not a phase awaiting merge.
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — first-time targeted readiness audit taken 2026-08-26 riding the same diff that mints this plan, the in-swap shape the [Plan-026](./026-provider-accounts-and-credential-homes.md) mint established. The audit walked all four gates over the five phases and sixteen tasks authored here, the twelve invariants, and the eight cross-plan obligations. Quantifiers re-derived by counting at the round-2 review fold, which folded nine findings into this plan and its contracts: the task count is unmoved at sixteen because the client-SDK task moved phase (T5.3 → T2.4) rather than being added, while invariants moved eleven → twelve (I-027-12) and obligations five → eight (CP-027-6/7/8). It mints **one** born-unchecked box, below. Code dispatch rides tier order (Tier 5, ordered last within the tier behind Plans 010 / 014 / 026) and the per-phase gates below.

<!-- Cite durable forms per AGENTS.md §Docs: `path#exportedSymbol` for code,
     `Spec-NNN §Heading` for specs/plans/ADRs; raw :NNN only for frozen/archive content. -->

## Target Areas

- `packages/contracts/src/agent-definition.ts` (NEW) — the definition record, the five definition-plane `agent.*` request/response pairs, and the two peer-invocation tool argument schemas.
- `packages/runtime-daemon/src/agents/` (NEW directory, Plan-027-owned): `invoking-principal.ts`, `definition-store.ts`, `definition-resolver.ts`, `run-start-resolution.ts`, `handlers.ts`, `bridge-tools.ts`, `peer-invocation-handler.ts`, `errors.ts`.
- `packages/runtime-daemon/src/migrations/` (EXTEND) — the `agent_definitions` migration and its runner registration.
- `apps/cli/src/commands/agent-definition-*.ts` (NEW) — the CLI definition commands, each extending the shared base command class per CP-006-15.
- `packages/client-sdk/src/` (EXTEND) — `agentClient.ts` (NEW), the typed client for the five definition-plane `agent.*` pairs, plus one barrel export line in the Plan-001-owned `index.ts`.
- `packages/contracts/src/session.ts` (EXTEND, Plan-001-owned) — the additive-optional `peerInvocationEnabled` member on `SessionReadResponse` and its key on the `.strict()` `SessionReadResponseSchema` (T4.2, CP-027-8). A sanctioned additive-member edit, not ownership.
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND) — the definition-plane `agent.*` handler files (T2.2), plus the single `peerInvocationEnabled` population line in the Plan-006-partial-owned `session-read.ts` under CP-027-8 (T4.2) — a **sanctioned field-population edit, not ownership**, the same class as Plan-005 T4.3's `timelineCursors.earliest` line in that same file.
- `apps/desktop/src/renderer/src/console/agents/` (EXTEND) — the destination's own family, handed to Plan-021's mount under CP-027-2:
  - `index.ts` (EXTEND) — the family door: the definition-list read that the session composer's own list and the workflow node's chooser consume, the page-body root, and the route helpers.
  - `agents.css` (EXTEND) — the family's own stylesheet.
  - `library/` (NEW) — `AgentLibrary.tsx`, `AgentCard.tsx`, `library-filters.ts`, `library-view.ts` (the read, delete and duplicate state machine). The saved-definitions page at `console/agents/definitions/` moves here.
  - `editor/` (NEW) — `AgentEditor.tsx`, `InstructionsField.tsx`, `GoalField.tsx`, `PostureModeField.tsx`, `ToolAllowlistPicker.tsx`, `ProviderBindings.tsx`, `IconField.tsx`, `TryItPanel.tsx`.

  The page body is a lazy chunk root and the editor is a second lazy chunk: the renderer's initial import graph is gated at **450 kB gzip over code** (`renderer-initial-bundle`, `apps/desktop/test/console/budget/budgets.json`) and neither surface sits on a launch path.

  `console/agents/sidekick-definitions-section.ts` and `apps/desktop/src/renderer/src/console/sidekicks-settings-page.ts` are deleted, and the `sidekicks` id leaves `apps/desktop/src/renderer/src/console/settings/settings-sections.ts`, because the destination replaces that settings page rather than sitting beside it. The dependent axis chain and the axis combobox (`console/agents/dependent-axis-chain.ts`, `console/agents/AxisCombobox.tsx`) are **reused** by the editor's binding chain, never forked. The family's folder and file names say agent; the destination a person sees is Sidekicks, at `#/sidekicks`.

## Data And Storage Changes

- One new local SQLite table, `agent_definitions`, owned by this plan and defined byte-for-byte in [local-sqlite-schema.md §Agent Definition Tables (Plan-027)](../architecture/schemas/local-sqlite-schema.md#agent-definition-tables-plan-027). It is the registry the daemon serves over the definition files it watches in the three origins ([Spec-027 §State And Data Implications](../specs/027-agent-definitions-and-peer-invocation.md#state-and-data-implications)): one row per definition, restating what a file this product wrote already holds and additionally holding what a provider's own file cannot carry, attached to that file by its name and location. It carries the definition's identity, its **bindings** — the default binding and its overrides together, in one non-null JSON column rather than four provider columns or a child table, the same inline treatment `tool_allowlist` on this table already gets — its nullable `icon` and `accent_hue`, its posture mode, its instructions and goal, its tool allowlist, its turn cap, and its timestamps, plus a unique index over the stored `name_folded` fold key. The table has not shipped, so it is created in this shape rather than created and migrated, and no migration ordinal is spent on the bindings column.
- **No foreign key** binds a binding's provider account to `provider_accounts`. See D-027-1 — the row must survive its account's removal so resolution can refuse legibly; a binding pinning a removed account is the `account_unavailable` arm, not a cascade.
- **No foreign key** binds any agent to the definition it was resolved from, because I-027-2 makes the agent independent of it after resolution.
- One added column on Plan-014's `run_links`, `invoking_principal_id` (CP-027-4 ⇄ CP-014-19) — authored on Plan-014's own `CREATE` because Plan-014 Phase 2 merges before this plan's Phase 4, so it consumes no migration ordinal of its own.
- `agent_definitions` carries `name_folded`, the stored full-Unicode case fold that the uniqueness index arbitrates (I-027-7).
- `agents` gains four resolved-at-run-start columns — `execution_posture_mode`, `tool_allowlist`, `instructions`, `goal` — on Plan-014's own `CREATE` under CP-027-7, stamped by that plan's T2.1 from the resolution T3.2 supplies and carried on the durable record of that start so the projection stays replay-complete (I-027-12; a column the log cannot rebuild would falsify `Plan-014 I-014-4`).
- **All six columns** move no table census.
- No control-plane table, no relay surface, no export surface.

## API And Transport Changes

- Five daemon JSON-RPC pairs in the `agent.*` namespace: `agent.definitionCreate`, `agent.definitionUpdate`, `agent.definitionDelete`, `agent.definitionList`, and `agent.peerInvocationSet`. There is no separate read verb — `definitionList` returns full records, matching the `providerAccount.list` shape.
- One additive-optional member and one response echo on each existing request that starts a run under an agent (CP-027-1). No verb is minted on the run-start path.
- Six `SessionCallbackTool` registrations — the bridge's `run`, `message`, `wait`, `stop`, `close` and `list` verbs — served through Plan-004's existing callback-tool dispatch seam. These are tool registrations, not wire methods: the definition plane stays at five pairs.
- One additive-optional member, `peerInvocationEnabled`, on the existing Plan-006-partial-owned `SessionReadResponse` (CP-027-8) — the read path for the projected opt-in, so no sixth definition-plane verb is minted and that plane stays at five pairs. Populated by a sanctioned field-population edit, never ownership.
- **One new event type**, `session.peer_invocation_set` in the existing `session_lifecycle` category ([Spec-005 §Session Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#session-lifecycle-session_lifecycle); registered into the taxonomy by T4.2, which lands the literal, the category row, and the payload arm), the durable home of the per-session peer-invocation opt-in — see D-027-10. Five registered definition-plane `agent.*` refusal codes on the definition and resolution paths, and none on the peer-invocation path, which rides the callback-tool result arms.

## Implementation Steps

1. Author the contract module and the migration, and pin them to one another with a conformance suite.
2. Build the definition store with storage-level case-insensitive uniqueness, then the definition-plane `agent.*` handlers behind the `agent::manage` Cedar action.
3. Ship the CLI commands over the handlers.
4. Build the fail-closed resolver, then wire it into Plan-014's run-start path and prove a running agent is unaffected by later edits to its definition.
5. Register the bridge's six verbs unconditionally — filtered only by the resolved agent's tool allowlist — adjudicate each invocation per call against the projected enablement flag, implement the bridge over Plan-014's admission pipeline and each provider's own helper surface, and prove the cost and causation consequences.
6. Author the destination's library and editor and the session's peer-calling setting, and hand them to Plan-021's mount.

## Parallelization Notes

- Phase 1's three tasks are sequential: the conformance suite exists to pin the other two together.
- Phase 2's store and handlers are sequential; the CLI commands (T2.3) can run in parallel with Phase 3 once the handlers land.
- Phase 3 and Phase 4 are sequential — peer invocation resolves its targets through the same resolver every run start uses.
- Phase 5 follows Phase 4: the library and the editor (T5.1) need only Phase 3, but the session setting (T5.2) is presentation over the enablement leg T4.2 authors, and phase gates dispatch a phase as a whole. The SDK surface sits in T2.4 rather than in Phase 5, so it lands with its first consumer, the Phase-2 CLI.

## Test And Verification Plan

- **Unit** — schema acceptance/rejection rows for every request and response pair; resolver refusal rows per unresolvable field; allowlist three-state round-trip; registry-composition rows across the four allowlist states of I-027-10, including one asserting all six bridge verbs are present with enablement off; per-call adjudication rows with and without the projected enablement flag. Also: the binding-uniqueness rule (no override repeats the default binding's driver, and no two overrides name one driver); the per-field resolution order, with the refusal where a caller names an unbound driver and supplies no model; the effort arm where the resolved model publishes no levels; the duplicate and import naming rules, including the suffix a name collision takes; the export rule that clears every provider-account reference; and the instruction-size estimate.
- **Console unit** — the library over its four read states (not loaded, refused, served empty, rows), the three allowlist renderings, and a card whose usage-count and last-used lines are absent rather than zero; the editor over each field, the unsaved-changes question, and the delete confirmation's own sentence; the destination's three addresses (the library, one definition, a new definition); and the settings registry with the retired `sidekicks` section absent from it.
- **Built shell** — one pass per state of the library and the editor in the built shell, in a hidden window, driving library → editor → save, and proving on every state: that chrome sizes derive from the current text size rather than from pixel constants (the type scale in root-relative units and every box figure beside it, while the hairlines, the corner radii and the icon boxes keep their drawn pixels); the card's field set; the three allowlist renderings; the four read states; the absent usage line; the visible `≈` on the instruction estimate; the destination's own place on the rail, with nothing of a neighbouring destination drawn on it; the editor's one link out to the skills destination; each driver's built-in tools offered in their own group in the words a person reads, where ticking one stores that driver's own spelling and moves the card's tool summary; the origin mark; the accent taken from the console's twelve-step hue wheel; the try-it panel's resolved-binding echo; and a retry resuming at the failed step with the scratch session and that echo both kept. The pass raises no runtime error.
- **Integration** — resolution end to end against a live migration; a running agent unaffected by definition edit and delete; a bridged agent started on the other provider, steered from the row and from the lead, stopped from both, and closed by the poll-interval sweep; a tool-server restart under a live session losing no handle and re-running no work; cost-receipt rows landing on the bridged agent under its own account.
- **Manual** — create a definition in the desktop editor, run it in two sessions, edit it, and confirm both running agents are unchanged. Then run that definition from the editor's try-it panel, interrupt it, and press it again: the same scratch session is reused, and it is still in the session list afterwards.
- **Adversarial-Tampering Boundary** — caller-supplied `definitionId` and timestamps rejected at intake; a `name` differing only by ASCII case or by trailing whitespace rejected at both the service and the index, and one differing only by a non-ASCII case mapping rejected at both layers as well, since the index arbitrates the stored full-Unicode `name_folded` key rather than an ASCII collation (I-027-7); a tool-allowlist payload carrying a non-string member rejected at the parser rather than at spawn; a bridge target naming a provider, a model, an account, or a node rejected before admission; a definition row hand-edited to carry a composed posture failing the T1.3 conformance suite rather than reaching the spawn path.
- **CI-Pinned Tool Versions** — verification commands name the CI-pinned toolchain (`pnpm@10.33.2`, Node `>=22.14.0` per [ADR-022](../decisions/022-v1-toolchain-selection.md)) so local drift surfaces at plan-authoring time.

## Implementation Phase Sequence

Plan-027 implementation lands as a sequence of small PRs. Each PR exercises one slice of the plan's vertical and carries a `**Precondition:**` line so the merge order is reviewer-checkable.

### Phase 1 — Contracts and migration

**Precondition:** Plan-014 Phase 1 merged; Plan-026 Phase 1 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: external_plan_phase_merged, plan: 014, phase: 1 }
  - { type: external_plan_phase_merged, plan: 026, phase: 1 }
```

**Goal:** the registry's contract surface and durable table exist, pinned to one another by a mechanical conformance suite.

#### Tasks

- **T1.1 — Agent-definition contracts.**
  - **Files:** `packages/contracts/src/agent-definition.ts` (NEW).
  - **Provides:** the `AgentDefinitionId` brand; the `AgentDefinition` record shape; the `ExecutionPostureMode` literal union — the corpus's five permission levels, `readonly` \| `ask` \| `reviewed` \| `sandboxed` \| `yolo`, nullable for "the session's own posture"; the bindings shape, one default binding plus its overrides, with the override-driver uniqueness rule asserted in the parser; the nullable `icon` and `accentHue`; the nullable turn cap; the tool-allowlist type whose absent and empty states are distinct; and the request/response pairs for create, update, delete, list, and peer-invocation-set. Strict Zod schemas with unknown-key rejection. `definitionId`, `createdAt`, and `updatedAt` are **response-only** projections — a create request carrying any of them does not parse.
  - **Consumes:** branded-id factory (Plan-001, shipped); `ProviderAccountId` (Plan-026 T1.1).
  - **Spec coverage:** Spec-027 §Interfaces And Contracts; Spec-027 §Required Behavior.
  - **Verifies invariant:** I-027-1, I-027-4, I-027-8.
  - **Tests:** schema acceptance/rejection rows per pair; unknown-key rejection; caller-supplied `definitionId` and timestamps rejected on create; the allowlist's absent and empty states parsing to distinguishable values; a posture member beyond the mode literal rejected.
- **T1.2 — Migration: `agent_definitions`.**
  - **Files:** `packages/runtime-daemon/src/migrations/0NNN-agent-definitions.ts` (CREATE — NNN = next free version per migration-runner append order at PR-open time), `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND — version-N guarded block with an in-transaction re-check, in the **same commit** as the migration file; an orphan file leaves the table absent at `no such table`).
  - **Provides:** the table byte-matching [local-sqlite-schema.md §Agent Definition Tables (Plan-027)](../architecture/schemas/local-sqlite-schema.md#agent-definition-tables-plan-027), including the `name_folded` column and the unique index over it — never a `COLLATE NOCASE` index over `name`, whose ASCII-only folding is the defect I-027-7 records — and the CHECK constraints bounding the text columns.
  - **Consumes:** Plan-001 migration-runner seam (shipped).
  - **Spec coverage:** Spec-027 §State And Data Implications.
  - **Verifies invariant:** I-027-7, I-027-4.
  - **Tests:** migration up + idempotence; **both** an ASCII case-variant and a non-ASCII case-variant duplicate name rejected by the index (the non-ASCII row is the one a `COLLATE NOCASE` index would admit, so it is the row that proves the fold key is doing the work); `NULL` and `'[]'` tool allowlists proven to round-trip distinctly; CHECK rejection rows for empty, over-long, and NUL-bearing `name`; posture-mode CHECK rejection; a row surviving deletion of the account its `provider_account_id` names.
- **T1.3 — Contract ↔ DDL conformance suite.**
  - **Files:** `packages/runtime-daemon/src/agents/__tests__/agent-definition-schema-conformance.test.ts` (NEW).
  - **Provides:** mechanical lockstep checks — the contract's posture-mode union against the DDL CHECK list; the record shape against the column set; the absence of any composed-posture member on both sides; and the `name_folded` write path, asserted present on insert and rewritten on rename, since it is a derived column no wire shape carries and therefore has no contract-side row to keep it honest.
  - **Consumes:** T1.1, T1.2.
  - **Spec coverage:** Spec-027 §State And Data Implications.
  - **Verifies invariant:** I-027-8, I-027-7.
  - **Tests:** the suite is the test — one row per pinned pair (documented-pin ≠ enforced-pin discipline).

### Phase 2 — Registry service, authorization, CLI, and client SDK

**Precondition:** Phase 1 merged; Plan-010 Phase 2 merged; Plan-006 Phase R3 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 027, phase: 1, status: merged }
  - { type: external_plan_phase_merged, plan: 010, phase: 2 }
  - { type: external_plan_phase_merged, plan: 006, phase: R3 }
```

**Goal:** definitions can be created, listed, updated, renamed, and deleted from the CLI — through the typed client SDK that surface consumes — under Cedar authorization, with uniqueness enforced in storage.

#### Tasks

- **T2.1 — Definition store.**
  - **Files:** `packages/runtime-daemon/src/agents/definition-store.ts` (NEW), `packages/runtime-daemon/src/agents/errors.ts` (NEW).
  - **Provides:** create / update / delete / list over `agent_definitions`, minting `definitionId` daemon-side; the full-Unicode case fold written to `name_folded` on every insert and update, and the service-layer uniqueness pre-check that surfaces a legible conflict ahead of the index — the pre-check is a legibility affordance only, never the guarantee, which is the index's (I-027-7); and the typed refusal vocabulary this task raises — `agent.definition_not_found`, `agent.definition_name_conflict`, and `agent.definition_unreadable`, registered in [error-contracts.md §Agent Definitions](../architecture/contracts/error-contracts.md#agent-definitions).
  - **Consumes:** T1.1 contracts, T1.2 table.
  - **Spec coverage:** Spec-027 §Required Behavior; Spec-027 §Non-Goals.
  - **Verifies invariant:** I-027-1, I-027-7, I-027-9.
  - **Tests:** rename preserving `definitionId` byte-for-byte; case-variant create refused at the service and, with the pre-check bypassed, at the index; two non-ASCII case variants issued concurrently, asserting exactly one commits and the other surfaces `agent.definition_name_conflict` — the race an ASCII index admits; delete succeeding while agents resolved from the row are running; a static check that no relay or control-plane client module imports this store and that no definition-plane `agent.*` type appears in the control-plane contract surface.
- **T2.2 — Definition-plane `agent.*` handlers and Cedar authorization.**
  - **Files:** `packages/runtime-daemon/src/agents/handlers.ts` (NEW).
  - **Provides:** the five definition-plane JSON-RPC pairs registered in the `agent.*` namespace, each authorized under `Action::"agent::manage"` through Plan-010's published Cedar gate, and the four definition-CRUD verbs implemented over the T2.1 store. Authorization resolves two resource descriptors under the one action: node-scoped for the CRUD verbs, the named session for `agent.peerInvocationSet`. This task registers that fifth verb and authorizes it; its enablement behavior — the append and the projection — is authored by T4.2, which is where the event this plan mints is owned. A Cedar denial on any of the five verbs raises `agent.permission_denied`; an invocation-time denial never reaches this handler, arriving on the callback-tool `denied` arm from T4.3 instead.
  - **Consumes:** T2.1; Plan-010 Cedar gate (Phase 2, published) — the named-action check only, never the remembered-rule store, which cannot represent a named-operation grant (D-027-4); Plan-006 JSON-RPC handler registry.
  - **Spec coverage:** Spec-027 §Interfaces And Contracts; Spec-027 §Required Behavior.
  - **Verifies invariant:** I-027-5.
  - **Tests:** each verb refused for a principal lacking the action; a definition mutation authorized against the node-scoped resource descriptor and the enablement setter against the named session, asserting the CRUD path invents no `sessionId`; a negative check asserting no handler in this module writes a `remembered_approval_rules` row, since a named-operation action cannot be represented as one (D-027-4); the definition-plane census asserted at five pairs.
- **T2.3 — CLI definition commands.**
  - **Files:** `apps/cli/src/commands/agent-definition-list.ts`, `agent-definition-create.ts`, `agent-definition-edit.ts`, `agent-definition-delete.ts` (all NEW), `apps/cli/src/main.ts` (EXTEND — `.register()` calls only, per the Plan-023 CP-023-2 precedent).
  - **Provides:** the operator-facing definition surface over the T2.2 handlers, under the command group word a person types, `sidekick-definition` (D-027-9), each command extending the shared base command class from `apps/cli/src/base-command.ts` per CP-006-15, writing results to the injected stdout and diagnostics to the injected stderr.
  - **Consumes:** T2.2; **T2.4** — the typed client this command surface calls, which is why the SDK is authored in this phase rather than in Phase 5; Plan-006 base command class (Phase R3) and client SDK transport.
  - **Spec coverage:** Spec-027 §Scope.
  - **Verifies invariant:** none — operator surface over already-verified handlers.
  - **Tests:** one regression assertion per command that a thrown error routes to stderr with stdout byte-empty under the mapped exit code; a list rendering golden.

- **T2.4 — Client SDK surface.**
  - **Files:** `packages/client-sdk/src/agentClient.ts` (NEW), `packages/client-sdk/src/index.ts` (EXTEND — barrel export only).
  - **Provides:** typed client methods for the five definition-plane `agent.*` pairs, consumed by the CLI commands here in Phase 2 and by the desktop subtree in Phase 5. **Authored in this phase and not with the desktop surface:** its first consumer is T2.3, and Phase 5 sits behind Phases 3 and 4, so an SDK homed there would leave the Phase-2 CLI importing a client that does not yet exist or permanently bypassing the typed surface it is required to consume.
  - **Consumes:** T2.2; Plan-001 client SDK transport (shipped).
  - **Spec coverage:** Spec-027 §Interfaces And Contracts.
  - **Verifies invariant:** none — transport surface over already-verified handlers.
  - **Tests:** one round-trip per pair against a stub transport; the barrel export asserted present.
  - **Ownership note:** `packages/client-sdk/src/index.ts` is Owner=Plan-001. This task appends one export line and edits nothing else in that file.

### Phase 3 — Resolution when a run starts

**Precondition:** Phase 2 merged; Plan-014 Phase 3 merged; Plan-026 Phase 2 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 027, phase: 2, status: merged }
  - { type: external_plan_phase_merged, plan: 014, phase: 3 }
  - { type: external_plan_phase_merged, plan: 026, phase: 2 }
```

**Goal:** a run can be started by naming a definition, the daemon resolves it fail-closed, and the resulting agent is provably independent of the definition thereafter.

#### Tasks

- **T3.1 — Fail-closed definition resolver.**
  - **Files:** `packages/runtime-daemon/src/agents/definition-resolver.ts` (NEW).
  - **Provides:** resolution of a `definitionId` to a concrete agent configuration — account existence checked against Plan-026's published registry read — existence only, because Spec-026 makes the stored readiness projection advisory and I-026-3's live probe at spawn is the authoritative authentication gate — model checked against the driver's offered set, effort validated against the target model's driver-reported effort levels, posture composed from the stored mode plus the session's live credential policy, and the tool allowlist checked realizable by the resolved driver. Every unresolvable input refuses as `agent.resolution_refused` carrying the closed `reason` arm for the input that failed; nothing is substituted.
  - **Consumes:** T2.1 store; Plan-026 `providerAccount.list` registry read (published — consulted for account existence, never for readiness); Plan-004 driver capability surface (published).
  - **Spec coverage:** Spec-027 §Fallback Behavior; Spec-027 §Default Behavior.
  - **Verifies invariant:** I-027-3, I-027-4, I-027-8.
  - **Tests:** refusal rows for absent account, absent model, unsupported effort, and unrealizable allowlist — one per closed `reason` arm — each carrying the matching arm and naming the unresolved input, the allowlist row asserting **both** of its arm's naming fields (the unrealizable tools and the driver's supported set), since either alone leaves the operator unable to tell what to edit; a row proving a registered-but-unauthenticated account resolves successfully here and is refused later by the spawn gate, so the resolver never second-guesses I-026-3; a negative-control row proving the resolver fails on a known-bad account rather than passing vacuously; absent-optional rows resolving to the documented defaults.
- **T3.2 — Run-start resolution integration.**
  - **Files:** `packages/runtime-daemon/src/agents/run-start-resolution.ts` (NEW — the seam Plan-014's run-start handler calls).
  - **Provides:** the resolver call Plan-014 makes before writing the `agents` row; the per-field override of resolved values by explicitly-present request members; the effective-resolved-configuration echo; the resolved axis set handed to Plan-014's insert for stamping into its **typed** `agents` columns and onto the durable record of the start under CP-027-7 (this task supplies the values; the owning plan performs the write, since the `agents` insert is a Plan-014-owned file) — posture mode, tool allowlist, instructions, and goal, which have no durable home today and cannot take one inside `config`, that column being opaque to everything outside the driver while these four are read by registry composition, prompt construction, and the spawn gate (the `provider_account_id` carve-out precedent, taken out of `config` for exactly this reason); and the fail-closed refusal path, raising `agent.definition_not_found` for a `definitionId` naming no row and `agent.definition_unreadable` when the registry cannot be read, with nothing started and nothing partial left behind.
  - **Consumes:** T3.1; Plan-014's run-start handler (Phase 3) per CP-027-1.
  - **Spec coverage:** Spec-027 §Required Behavior.
  - **Verifies invariant:** I-027-3, I-027-12.
  - **Tests:** a run started under a definition producing matching configuration; explicit request member overriding for that field only; the echo reporting the merged result — `instructions` and `goal` included, so the caller learns the applied prompt without re-reading the registry; a refused start leaving no agent row, no partial configuration, and no run; **the durability row that makes the guarantee real** — start a run under a definition, delete the definition, restart the daemon, and assert registry composition and prompt construction still reconstruct every resolved axis from the `agents` row alone, with a static check that neither path reads `config` for them.
  - **Ownership note:** the run-start request shapes and their handlers are Owner=Plan-014. This task authors the resolution seam those handlers call; it MUST NOT edit any Plan-014-owned file.
- **T3.3 — Configuration-isolation regression suite.**
  - **Files:** `packages/runtime-daemon/src/agents/__tests__/configuration-isolation.test.ts` (NEW).
  - **Provides:** the standing proof of I-027-2 — a running agent's configuration is unaffected by any mutation of the definition it came from, including deletion.
  - **Consumes:** T3.2.
  - **Spec coverage:** Spec-027 §Required Behavior; Spec-027 §Pitfalls To Avoid.
  - **Verifies invariant:** I-027-2.
  - **Tests:** edit every mutable field under a live agent and assert its stored configuration is byte-identical; delete the definition and assert its run continues; a static import check proving no module on the running-agent read path reaches the definition store; a rename proving the displayed label changes while nothing the agent may do does.

### Phase 4 — Peer invocation

**Precondition:** Phase 3 merged; Plan-004 Phase 3 merged; Plan-014 Phase 2 merged; Plan-014 Phase 4B merged; Plan-005 Phase 1 merged. Phase 4B is gated here and not only cited by T4.4, because a phase whose task consumes the session cost receipt cannot dispatch while its own gate does not require the receipt to exist. Plan-005 Phase 1 is gated because T4.2 both registers and appends `session.peer_invocation_set`: it lands the type literal, the registry row, and the payload arm into Plan-005's `event.ts` union through the additive registration seam (CP-027-5), which requires that union to already exist.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 027, phase: 3, status: merged }
  - { type: external_plan_phase_merged, plan: 004, phase: 3 }
  - { type: external_plan_phase_merged, plan: 014, phase: 2 }
  - { type: external_plan_phase_merged, plan: 014, phase: 4B }
  - { type: external_plan_phase_merged, plan: 005, phase: 1 }
```

**Goal:** an enabled session exposes the bridge's six verbs on both providers; an invocation produces an admitted, tree-visible agent the daemon runs on its own provider, steerable and stoppable from the row and from the lead, whose cost lands where the spec says.

#### Tasks

- **T4.1 — The bridge's six verbs, their pack entry, and unconditional, allowlist-filtered registration.**
  - **Files:** `packages/runtime-daemon/src/agents/bridge-tools.ts` (NEW).
  - **Provides:** the six `SessionCallbackTool` declarations — `run`, `message`, `wait`, `stop`, `close`, `list` — each with the name, description and JSON-Schema arguments the bridge needs, accepting a target as either a saved `definitionId` or a running agent's handle; the **contract in the descriptions and in what the verbs return**, because a lead that calls them itself never loads a stand-in's instructions; `run` answering with a handle immediately and `wait` bounded by a daemon-held cap rather than by the caller's request; the per-provider exposure — on the Claude leg one pack entry per cross-provider agent whose tool list holds these verbs and nothing else, with the lead's own tool list holding none of them, and on the Codex leg the tool server's own description listing every cross-provider agent by name and description; the **identifier each cross-provider agent is exposed under**, which carries the provider running it — `sidekicks:codex-<name>` in a Claude Code session, `sidekicks:claude-<name>` in a Codex session — so two files of the same name never collide and the row a person picks inserts the identifier rather than anyone typing it; and the spawn-time registry contribution, which yields the verbs **unconditionally with respect to enablement** (the `workflow_start` shape) and applies exactly one filter: the resolved agent's tool allowlist. An empty allowlist yields none of them, a populated one yields only what it names, and an absent one leaves the driver-default composition unchanged (I-027-10). Enablement is not consulted here at all — it is a per-call Cedar context input in T4.3.
  - **Consumes:** the resolved allowlist ← T3.1; Plan-004 callback-tool registry (published, Phase 3); the Plan-004 named-action dispatch route under CP-027-6 — **the box below holds this task and T4.3 until that route is registered**, because the host as documented cannot represent a named-action invocation at all.
  - **Spec coverage:** Spec-027 §Required Behavior (the bridge, its verbs, the per-lead reach, the registration rule and the allowlist-filters-the-registry rule); Spec-027 §Default Behavior.
  - **Verifies invariant:** I-027-5, I-027-10.
  - **Tests:** all six verbs present in a registry composed for a session with enablement off; the four allowlist compositions of I-027-10 (empty → none, populated-naming-none → none, populated-naming-them → them, absent → driver default unchanged); the argument schema rejecting a target naming a provider, a model, an account, or a node; the Claude-leg composition placing the verbs on the pack entry and **not** on the lead's own tool list, with a row proving a lead told to run a cross-provider agent produces a tree row rather than calling a verb itself; the Codex-leg description listing every cross-provider agent by name with no stand-in role planted; two definitions of the same bare name on the two providers exposed under distinct provider-carrying identifiers in one session; `run` returning a handle without waiting; a caller-requested wait longer than the daemon's cap being capped; a static check that this module reads no enablement state.
- **T4.2 — Enablement lifecycle.**
  - **Files:** `packages/runtime-daemon/src/agents/peer-invocation-handler.ts` (NEW — enablement leg), `packages/contracts/src/session.ts` (EXTEND — the additive-optional `peerInvocationEnabled` member on `SessionReadResponse` **and** the matching key on the shipped `SessionReadResponseSchema`, per CP-027-8; Plan-001-owned, a sanctioned additive-member edit rather than ownership), `packages/contracts/src/event.ts` (EXTEND — the `session.peer_invocation_set` type literal, its `SESSION_EVENT_CATEGORY_BY_TYPE` row, and its `SessionEventSchema` payload arm, through the additive union-registration seam per CP-027-5).
  - **Provides:** the enablement setter behind `agent.peerInvocationSet`, which T5.2's `Sidekicks may call each other` setting calls — comprising the `Action::"agent::manage"` check against the named **session** resource, the append of `session.peer_invocation_set` (`{sessionId, enabled, actor}`, `actor` daemon-resolved from the authenticated caller and never client-supplied), and the projection of that event into the session-state flag T4.3 reads as Cedar context. The event is the durable home: no column and no table backs the flag, and replay is how a restarted daemon relearns it. The response reads the post-append projected value rather than echoing the request.
  - **Consumes:** T4.1; T2.2 method registration; Plan-005 event registry (Phase 1) for the type literal and payload schema.
  - **Spec coverage:** Spec-027 §Required Behavior (the enablement rule).
  - **Verifies invariant:** I-027-5.
  - **Tests:** enable then disable, asserting one event appended per transition with `actor` populated from the authenticated caller; a client-supplied `actor` **rejected at intake** by T1.1's strict unknown-key schema rather than accepted-and-ignored — a request cannot both fail a strict parse and reach a handler that ignores it, and the reject arm is the one that keeps the principal boundary legible, since silently dropping a smuggled principal teaches a caller the field is merely inert; the stamped `actor` still comes from the authenticated caller; the projected flag rebuilt correctly by replaying the event log alone with no local row; a withdrawal asserting the very next invocation on an already-running leg answers `denied` **without a respawn**; re-enablement restoring service on the next call; an unauthenticated or unauthorizable caller refused `agent.permission_denied` with no event appended.
- **T4.3 — The bridge handler.**
  - **Files:** `packages/runtime-daemon/src/agents/peer-invocation-handler.ts` (EXTEND — invocation leg).
  - **Provides:** target resolution (a running agent by its handle, or a definition resolved on demand through T3.2); the per-call Cedar check — `Action::"agent::invoke"` with the T4.2-projected enablement flag supplied as context, so a disabled session answers `denied` on a verb that is nonetheless present; the run the daemon starts on the target's **own** provider — a thread on the Codex leg, a process on the Claude leg — admitted through Plan-014's orchestration admission, with the definition applied there and nothing written into a provider's home; **all state held here, never in the tool-server process**, because a provider restarts that process under a live session and a handle table held in it is lost with the process, after which the next wait answers that no such handle exists and the agent's whole task is re-run and re-billed; the steer and stop paths in both directions — from the row straight onto the provider running the agent, from the lead natively (a message on the Claude leg, the message verb on the Codex leg) and, for a stop from a Claude lead, read off the lead's own stream and applied as an interrupt on the underlying thread; the close sweep, which closes any run no wait has arrived for within one poll interval and interrupts what it was doing, **measured on the gap between one wait returning and the next arriving** rather than on the age of the last wait, since one long wait would otherwise keep the clock fresh for its whole duration and mask an abandoned run entirely; the retained conversation, so a message to an agent that has already finished continues it rather than opening a second one; the normalization of both providers' output deltas into one handle-keyed stream, so a bridged agent reads word by word while its verb spellings never reach a screen; and the mapping of every outcome onto the callback-tool result arms. **Wait settlement:** the agent's run id does not exist before admission, so a subscription cannot be opened ahead of it and "subscribe before returning" would leave exactly one unobservable window — a terminal landing between the creation call and the subscription, which a live subscription never replays. The ordering is therefore **capture-cursor → admit → subscribe → replay-from-captured-cursor**: the handler reads the session's current event cursor **before** the creation call, admits, subscribes, then replays from that captured cursor forward over Plan-005's `event.readAfterCursor` read surface, settling from whichever source presents the terminal first and discarding the duplicate by `(runId, runVersion)`. The captured cursor is what makes the window closed rather than merely narrow — it predates the run's own creation, so no terminal can fall before it — and this is the same subscribe-then-replay-from-a-held-cursor discipline the relay resume path uses, consumed here rather than reinvented. Every terminal settles an outstanding wait, and no invocation is left unanswered. **Admission is evaluated synchronously inside the creation call this handler makes, before the verb returns**, so no verb ever answers with the identity of a run admission would refuse.
  - **Consumes:** T4.1, T4.2, T3.2; Plan-014 orchestration admission (Phase 2) and run-link projection; the provider-side steer, interrupt and pause operations Plan-004 owns.
  - **Spec coverage:** Spec-027 §Required Behavior; Spec-027 §Fallback Behavior.
  - **Verifies invariant:** I-027-6, I-027-5, I-027-11.
  - **Tests:** a verb run under a disabled session answered `denied` while the verb is present in the registry; an unresolvable target answered `failed` with no run created; a refused resolution surfacing its reason through `denied`; a `tool_activity` row landed per invocation; a tool-server process restarted mid-run losing no handle and re-running no work; the four settlement rows (failed, cancelled, interrupted, finished-without-answer) each settling the outstanding wait with that terminal; a race row landing the terminal between admission and subscription and asserting the call still settles; a steer from the row landing on the provider running the agent and reaching the caller on its next wait; a stop from a Claude lead read off the lead's stream and interrupting the underlying thread; the close sweep firing on the gap between waits and **not** firing while a wait is in flight, with a row proving one long wait does not postpone it; a message to a finished agent continuing the same conversation; a static check that this module declares no limit constant of its own.
- **T4.4 — Invoking-principal propagation, and cost-and-causation conformance.**
  - **Files:** `packages/runtime-daemon/src/agents/invoking-principal.ts` (NEW), `packages/runtime-daemon/src/agents/__tests__/peer-invocation-cost.test.ts` (NEW).
  - **Provides:** the producer side of the attribution rule — resolution of the invoking turn's effective principal at the moment the tool call is dispatched (the turn is already resolved when its call is issued, so this is a read of a settled fact rather than a later lookup), and its supply to Plan-014's run creation for stamping onto `run_links.invoking_principal_id` under CP-027-4. The value is daemon-resolved and never read from tool arguments; a call whose principal cannot be resolved refuses **before** admission, so no unattributed run is ever created. Plus the standing proof that a bridged agent's spend lands on its own receipt row under its own paying account, that the row of the run that reached it is unchanged, and that the causal edge is carried by the run link rather than by a receipt roll-up.
  - **Consumes:** T4.3; the turn-scoped effective principal ← Plan-010 permission-check service (read, never authored); the stamping column ← Plan-014 `run_links` (CP-027-4 ⇄ CP-014-19); Plan-014 cost receipt (Phase 4B).
  - **Spec coverage:** Spec-027 §Required Behavior (the invoking-principal rule and the cost-and-causation rules).
  - **Verifies invariant:** I-027-11.
  - **Tests:** the stamped principal equal to the invoking turn's effective principal; a steer admitted under a different principal issuing the call, asserting the stamp is that principal and **not** the parent run's initiator; an unresolvable principal refusing before admission with no run and no link row written; a smuggled principal in the tool arguments ignored; the bridged agent's `costCents` on its own run row and on its own account's row; the asking run's row byte-identical to a control run that made no invocation; both receipt partition identities still summing to the session total.

### Phase 5 — Desktop library, editor and session setting

**Precondition:** Phase 3 merged; Phase 4 merged; Plan-021 Phase 6 merged. Phase 4 is gated because T5.2 is presentation over the enablement leg T4.2 authors — the setting's stated turn-off timing is T4.2's behavior, so shipping it earlier would ship a control verified against a handler that does not yet exist.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 027, phase: 3, status: merged }
  - { type: plan_phase, plan: 027, phase: 4, status: merged }
  - { type: external_plan_phase_merged, plan: 021, phase: 6 }
```

**Goal:** a user can build, edit, and pick an agent definition from the desktop, and can turn peer invocation on and off for a session.

#### Tasks

- **T5.1 — The destination's library and editor.**
  - **Files:** `apps/desktop/src/renderer/src/console/agents/library/` and `console/agents/editor/` (both NEW — the library over the registry, the editor over one definition, and the delete confirmation), plus `console/agents/index.ts` and `console/agents/agents.css` (EXTEND — the family door and its stylesheet).
  - **Provides:** the library over the registry — create, duplicate, delete, export, import, search, the two orderings, and selecting for export — and the editor over one definition, including its try-it panel — all of it over the definition-plane `agent.*` handlers — with the tool allowlist's absent and empty states presented as visibly different choices rather than as one empty control, and the pinned-account field showing the account's readiness as an **advisory** signal, so a definition whose account would refuse at spawn under I-026-3 is legible before it is used — never as a resolution-time gate, which checks registry existence only.
  - **Consumes:** T2.2 handlers through the client SDK; Plan-021 renderer shell mount per CP-027-2.
  - **Spec coverage:** Spec-027 §The library; Spec-027 §The editor; Spec-027 §Pitfalls To Avoid.
  - **Verifies invariant:** I-027-4.
  - **Tests:** renderer tests covering the library's four read states (not loaded, refused, served empty, rows), the three allowlist states, a card whose usage-count and last-used lines are absent rather than zero, a rename preserving selection, the unsaved-changes question, a delete confirmation naming what will and will not be affected, and the try-it panel reusing one scratch session per definition and keeping it after an interrupt.
  - **Ownership note:** the shell, router, and navigation files are Owner=Plan-021. This subtree owns none of them and is reached through the mount CP-027-2 registers.
- **T5.2 — The session's peer-calling setting.**
  - **Files:** `apps/desktop/src/renderer/src/console/agents/PeerInvocationSetting.tsx` (NEW — the one row the session inspector's Sidekicks section draws).
  - **Provides:** the one-session setting over `agent.peerInvocationSet`, reading `Sidekicks may call each other` with the word `On` or `Off` beside it and starting off, drawn in the session inspector's Sidekicks section, stating that turning it on grants automatic peer invocation for the remainder of the session and that turning it off takes effect on the next invocation on every leg, including legs already running. No settings page carries it.
  - **Consumes:** T4.2 — the enablement leg this setting is presentation over, which is why Phase 5 gates on Phase 4; the `SessionReadResponse` enablement projection under CP-027-8, which is how the setting learns the current value on mount rather than folding raw events client-side; Plan-021's inspector mount per CP-027-2.
  - **Spec coverage:** Spec-027 §Enablement.
  - **Verifies invariant:** none — presentation over an already-verified handler.
  - **Tests:** the setting reflecting the current projected enablement flag on mount; the turn-off path's stated timing matching T4.2's behavior (effective on the next call, no respawn).

## Rollout Order

1. Phase 1 — contracts, migration, conformance.
2. Phase 2 — store, handlers, CLI, client SDK.
3. Phase 3 — resolver and resolution at run start.
4. Phase 4 — peer invocation.
5. Phase 5 — the desktop library, editor and session setting.

## Rollback Or Fallback

- Phases 1–3 are additive: unshipped definition-plane operations and an unused `definitionId` member leave every run-start path behaving exactly as before, so rolling back a phase never breaks a run whose axes are spelled out in full.
- Phase 4 ships inert by default: a session that has never appended `session.peer_invocation_set` projects enablement off, so the bridge's verbs are present in the registry but every invocation is refused at adjudication. Turning peer invocation off for a session is one `agent.peerInvocationSet` call, effective on the next invocation, with no code change and no respawn.
- The migration is additive and creates one table; rolling it back drops a table nothing else references, because no foreign key points at it in either direction.

## Risks And Blockers

- **Intra-tier ordering.** This plan sits at Tier 5 with Plans 010, 014, and 026, and depends on all three. Its phases carry explicit `external_plan_phase_merged` gates so the ordering is enforced mechanically rather than by tier membership alone.
- **Effort validation depends on a driver-reported set.** A driver that reports no effort levels makes every explicit effort unresolvable. The resolver treats an empty reported set as "effort not supported by this driver" and refuses an explicit effort while accepting an absent one, rather than passing an unvalidated value through.
- **Definition text is unbounded operator input.** `instructions` is the largest free-text column this plan owns; its CHECK bounds length so a pathological definition cannot make every run start slow or a spawn argument list unbuildable.
- **Peer invocation makes a run's cost depend on another account's readiness.** A target whose account has gone unauthenticated refuses at spawn under I-026-3 — not at resolution, which checks existence only — and that surfaces to the asking agent as `denied` mid-turn. That is the intended fail-closed behavior, and T4.3 pins the reason reaching the caller so it is diagnosable rather than opaque.

## Decision Log

- **D-027-1 — No foreign key from `provider_account_id` to `provider_accounts`.** `ON DELETE CASCADE` would delete a definition when its account is removed, discarding operator-authored configuration; `ON DELETE SET NULL` would silently convert a pinned account into "the provider's default account", which is exactly the substitution I-027-3 forbids; `ON DELETE RESTRICT` would make account removal fail because an unrelated definition names it. The row therefore carries an unenforced reference and resolution checks account **existence** when the run starts — never readiness, which I-026-3's live spawn probe settles — which is the only point at which the answer matters.
- **D-027-2 — A definition stores a posture mode, not a composed posture.** A composed `ExecutionPosture` carries a content-addressed `credentialPolicyRef` that is meaningful only against the session that composed it; persisting one lets a stale definition re-grant a superseded trust decision, or dangle. The mode literal is the operator's actual intent, and the session composes the rest.
- **D-027-3 — A run keeps the configuration it was resolved for, not a live reference.** The live-reference alternative reads as the more useful feature and is an authorization hole: it widens a running sidekick's authority without an authorization act. Configuration reuse is delivered when the run starts, which is where the authorization check already sits.
- **D-027-4 — Enablement is an event, not a remembered approval rule and not a table.** The remembered-grant route was specified first and is **unrepresentable**, not merely redundant: `remembered_approval_rules` closes its `category` column over the approval-pipeline categories and requires `created_from_request_id` to reference an `approval_resolutions` row, and a named-operation Cedar action traverses no approval pipeline and produces no resolution — so there is no legal row to write. A dedicated table was the next candidate and was rejected because this corpus projects no session-configuration table at all: the session goal, the closest analogue, lives in the event log and is rebuilt by replay (`session_goal_dispatch_intents` is a crash-consistency intent row, not the goal's home). The event is therefore the corpus's own answer for session-scoped mutable configuration, and it buys the audit trail for free — which matters here, because the thing being granted lets a running model start other runs.
- **D-027-5 — The bridge's verbs are registered unconditionally and adjudicated per call.** Grant-gated registration was specified first, on the reasoning that a tool a model can see is one it will plan around. It does not work: `callbackTools` rides only the session-creation and resume parameter shapes, and the corpus has no live-registry mutation seam, so a registry filtered by enablement is frozen at spawn. Enabling mid-session would then change nothing an operator could observe until the leg respawned, and withdrawal would leave a live leg holding a revoked capability until the same boundary. Per-call adjudication makes both directions take effect on the next call, needs no seam that does not exist, and matches `workflow_start` — the corpus's only other concrete session callback tool, which is likewise registered at spawn and Cedar-checked per invocation. The cost is the visible-but-refusable tool the original reasoning objected to, and it is the smaller cost.
- **D-027-6 — The tool allowlist is three-state.** `NULL` means the driver's defaults and `'[]'` means no tools. Representing "no tools" as an absent value would make the most restrictive choice unexpressible, which is the wrong direction for a security control to be lossy in.
- **D-027-7 — No depth rule is authored here.** [Spec-014 §Default Behavior](../specs/014-multi-agent-channels-and-orchestration.md#default-behavior) sets no depth ceiling by default and refuses a level only against a configured limit, and `orchestration.depth_exceeded` already carries that limit, so a nested peer invocation is admitted exactly like any other child run until such a limit is set. A second check in the handler would be a second source of truth whose drift would surface as runaway fan-out rather than as a failing test.
- **D-027-8 — Five wire pairs, with `definitionList` returning full records.** A separate read verb would duplicate the list's projection and give two surfaces that can disagree about what a definition is. This follows the `providerAccount.list` shape, which returns full rows for the same reason.
- **D-027-10 — The invoking principal is stamped on the run link, not derived later.** A peer-invoked child resolves no effective principal under either existing arm — no intervention row, no user who started it — and deriving one by chaining to the parent run is wrong rather than merely lossy, because a run accumulates turns from several principals and the newest is not necessarily the caller. The invoking turn's principal is already settled at the moment its tool call is dispatched, so stamping it there records a fact instead of reconstructing a guess, and a call that cannot resolve one refuses before admission rather than creating an unattributed run.
- **D-027-9 — The CLI group word is `sidekick-definition`.** Two shorter alternatives were considered and rejected. Bare `definition` collides with `Spec-015`'s frozen **workflow definitions**, whose command group lives in this same `apps/cli/src/commands/` directory, so `definition-*.ts` beside `workflow-*.ts` would be ambiguous at exactly the point a reader needs disambiguation. Bare `sidekick` truncates a two-word resource to one word, which both stutters as `sidekicks sidekick list` and reads as a command over _running_ session agents rather than over the saved records this plan owns — a distinction [Spec-027 §Required Behavior](../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) draws throughout, since a peer-invocation target may be either. The group word therefore names the resource in full, following the corpus's only other two-word CLI resource: [Plan-026](./026-provider-accounts-and-credential-homes.md)'s `sidekicks provider-account` group with its matching `provider-account-*.ts` files. The five wire operations sit in `agent.*`, a namespace that also carries the peer-invocation enablement pair, which is not a definition operation; the CLI group is narrower than the namespace on purpose. The everyday form is `sk sidekick-definition list`.

## Progress Log

### Notes

- **2026-08-26 — Plan minted with a first-time targeted readiness audit (PR #368).** Spec-027 and Plan-027 were authored and promoted `draft → review → approved` in one swap, the in-swap mint shape [Plan-026](./026-provider-accounts-and-credential-homes.md) established at. The audit walked all four gates over the five phases, sixteen tasks, eleven invariants, and five cross-plan obligations authored here, and minted **no** born-unchecked box: every upstream this plan consumes is a published surface (Plan-004's callback-tool host and driver capability surface, Plan-010's Cedar gate and turn-scoped effective principal, Plan-014's admission pipeline, run links, and cost receipt, Plan-026's account-readiness projection, Plan-006's base command class under the existing CP-006-15 binding), so each dependency is expressible as a phase gate rather than as a carrier hold. The three obligations that do require reciprocal registration — CP-027-1 on Plan-014's attach surface (⇄ CP-014-18), CP-027-2 on Plan-021's renderer mount (⇄ CP-021-6), and CP-027-4 on Plan-014's `run_links` invoking-principal stamp (⇄ CP-014-19) — were registered in the same swap, flipping and restoring those plans `approved` with their own in-swap deltas — part of the eight-document flip set (Spec-005, Plan-005, Spec-010, Spec-014, Plan-014, Plan-021, Spec-025, Plan-025) this swap restores. CP-027-3 extends the Spec-010 enumeration, which carries no plan-side reciprocal, and CP-027-5 rides the one-sided `event.ts` union-registration seam. Census moves re-derived from the files: local SQLite 57 → 58 (`agent_definitions`), plans 29 → 30, specs 29 → 30, and the Spec-005 event taxonomy 158 → 159 across 20 unchanged categories (one event type minted — `session.peer_invocation_set` under `session_lifecycle`, registered by T4.2 per CP-027-5); Postgres 26 unmoved, no approval category minted; five `sidekick.*` refusal codes registered in [error-contracts.md](../architecture/contracts/error-contracts.md) for the definition and attach paths, with the peer-invocation path minting none.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
