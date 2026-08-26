# Plan-030: Sidekick Definitions And Peer Invocation

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `030` |
| **Slug** | `sidekick-definitions-and-peer-invocation` |
| **Date** | `2026-08-26` |
| **Author(s)** | `Sawmon Abo` |
| **Spec** | [Spec-030](../specs/030-sidekick-definitions-and-peer-invocation.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md) |
| **Dependencies** | [Plan-016](./016-multi-agent-channels-and-orchestration.md) (agents, run links, `agent.attach`), [Plan-029](./029-provider-accounts-and-credential-homes.md) (provider accounts), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (Cedar named-operation actions and the turn-scoped effective principal), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (the `session.peer_invocation_set` type registration), [Plan-005](./005-provider-driver-contract-and-capabilities.md) (callback-tool host), [Plan-023](./023-desktop-shell-and-renderer.md) (renderer mount), [Plan-007](./007-local-ipc-and-daemon-control.md) (CLI base command) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Deliver the node-local sidekick-definition registry, attach-by-reference resolution onto the existing agent surface, and the two daemon-served peer-invocation tools — so a user configures a sidekick once and reuses it, and a running sidekick can ask or delegate to a named peer.

## Scope

The `sidekick_definitions` table and its migration; the `sidekick.*` daemon JSON-RPC namespace; the definition store and its case-insensitive uniqueness enforcement; the fail-closed resolver; the `agent.attach` integration that consumes it; the two `SessionCallbackTool` registrations, their session-scoped enablement, and their invocation handler; the CLI command surface; and the desktop definition-editor subtree handed to the shell's mount point.

## Non-Goals

- **No orchestration mechanism.** Run admission, link projection, depth enforcement, scheduler limits, and budget accounting are Plan-016's and are consumed unchanged. This plan authors no admission rule.
- **No approval mechanism.** The Cedar gate, the approval pipeline, and the remembered-grant store are Plan-012's. This plan registers two named actions against them and authors no Plan-012 symbol.
- **No driver or transport work.** The callback-tool registry, its dispatch seam, and the daemon-hosted ephemeral MCP server that carries it on the Claude leg are Plan-005's and already ship. This plan registers two tools into that registry and authors no Plan-005 file.
- **No provider-account mechanism.** Account identity, readiness, and credential homes are Plan-029's. This plan reads its published registry surface and authors no Plan-029 file.
- **One new event type — `session.peer_invocation_set`, the opt-in's durable home — and no new error code _on the peer-invocation path_.** Nothing on the definition plane emits: every session-visible consequence of a peer invocation rides existing events, and every peer-invocation refusal rides the callback-tool result's existing `denied` / `failed` arms. The definition and attach paths do own five registered `sidekick.*` codes ([error-contracts.md §Sidekick Definitions](../architecture/contracts/error-contracts.md#sidekick-definitions)); reusing another namespace's codes for them would make the code itself a lie about which subsystem refused.

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-030 PRs and downstream extensions. Any change that would weaken or remove an invariant requires a coordinated cross-plan amendment (see [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md)).

### I-030-1 — Definition identity is opaque, immutable, and never the name

`definitionId` is daemon-minted, opaque to every caller, and stable for the life of the row including across a rename. No wire request, stored reference, or audit row keys a definition by `name`.

**Grounds in.** `Spec-030 §Required Behavior` — the definition-registry identity rule.

**Why load-bearing.** `name` is the one field a user edits most and the one a peer-invocation target spells. If identity rode the name, a rename would silently repoint or orphan every stored reference, and two nodes' identically-named definitions would appear interchangeable. The opaque-immutable-id-plus-mutable-label split is the same shape `ProviderAccountId` already uses, so the two registries stay legible together.

**Verification.** T1.1 schema rows rejecting a caller-supplied `definitionId`; T2.1 rename test asserting the id is byte-identical before and after.

### I-030-2 — An attached agent is a snapshot, never a live view

Resolution copies the definition's values onto the agent record at attach time. No read path serving a running or attached agent's configuration consults `sidekick_definitions`, and no foreign key binds an agent to the definition it was resolved from.

**Grounds in.** `Spec-030 §Required Behavior` — the attach-by-reference snapshot rule.

**Why load-bearing.** This is the plan's central authorization property, not a caching choice. A live reference would let an edit widen an already-attached sidekick's tool allowlist, execution posture, or paying account without that widening passing the attach-time Cedar check that admitted the agent. It also makes the registry safe to edit under load, because nothing serving a live run reads it.

**Verification.** T3.3's snapshot-isolation suite — edit and delete a definition under a live attached agent and assert the agent's stored configuration is unchanged and its run unaffected; a static check that no module under the agent read path imports the definition store.

### I-030-3 — Resolution fails closed and never substitutes

An unresolvable provider account, model, effort level, or tool allowlist refuses the attach, names what could not be resolved, and creates no agent row. The four inputs are exactly the four arms of the closed `sidekick.resolution_refused` `reason` discriminator, so every unresolvable input has a typed refusal and none falls through untyped. The resolver never falls back to a default account, a nearest-match model, a neighbouring effort level, or a silently narrowed — or unconstrained — tool set.

**Grounds in.** `Spec-030 §Fallback Behavior`.

**Why load-bearing.** Every substitution this rule forbids is a silent change to who pays, which identity acts, or what the sidekick costs and does. A pinned account quietly becoming "whichever account is default now" is precisely the class of change an operator pinned it to prevent.

**Verification.** T3.1 refusal rows for absent account, absent model, unsupported effort, and unrealizable tool allowlist — one per closed `reason` arm; T3.2 zero-residue assertion that no agent row survives a refused attach.

### I-030-4 — The tool allowlist has three distinguishable states and is enforced at spawn

Absent, empty, and populated allowlists are stored and transported distinguishably, and the resolved allowlist is applied at spawn. A driver that cannot realize the allowlist refuses the attach rather than spawning unconstrained.

**Grounds in.** `Spec-030 §Required Behavior` — the tool-allowlist state rule and the spawn-enforcement rule.

**Why load-bearing.** Collapsing absent into empty strips a sidekick of every tool; collapsing empty into absent hands it all of them. Both are silent. Recording an allowlist without enforcing it is worse than storing none, because the registry then reports a restriction that does not hold — a false assurance an operator will rely on.

**Verification.** T1.2 round-trip rows proving `NULL` and `'[]'` survive distinctly; T3.1 spawn-enforcement test asserting an unrealizable allowlist refuses; T3.2 observable-difference test between an absent and an empty allowlist.

### I-030-5 — Peer invocation is adjudicated per call, never gated by registry composition

Both tools are registered at spawn unconditionally, and every invocation is adjudicated against `Action::"sidekick::invoke"` with the session's projected enablement flag supplied as Cedar context. A call made while the session has not enabled peer invocation — including one arriving on a leg spawned while it was enabled — is answered `denied`.

**Grounds in.** `Spec-030 §Required Behavior` — the registration and enablement rules.

**Why load-bearing.** This is a correctness property, not a stylistic one. `callbackTools` rides only the session-creation and resume parameter shapes and there is no live-registry mutation seam, so a registry composed against enablement state is frozen at spawn: enabling mid-session would change nothing until the leg respawned, and — worse in the other direction — withdrawal would leave a live leg holding a capability the operator believes they revoked until its next spawn boundary. Per-call adjudication makes both directions immediate and needs no seam that does not exist. It also matches the landed `workflow_start` precedent, the corpus's only other concrete session callback tool.

**Verification.** T4.1 asserting both tools present in a freshly composed registry with enablement off; T4.3 asserting a call under a disabled session answers `denied`; T4.2 asserting a withdrawal mid-session causes the very next call on an already-running leg to answer `denied` with no respawn.

### I-030-6 — Peer invocation mints no orchestration primitive

A peer invocation creates its child run through the ordinary orchestration admission pipeline. This plan adds no run kind, no link type, no scheduler rule, and no depth check of its own.

**Grounds in.** `Spec-030 §Non-Goals`; `Spec-016 §Default Behavior` — the one-layer nesting rule that consequently applies without restatement.

**Why load-bearing.** The nesting limit, the active-child limit, the queue depth, and the budget ceiling are all enforced in one place today. A second depth check inside the peer-invocation handler would be a second source of truth that drifts from the first, and the drift would be discovered as runaway fan-out rather than as a test failure.

**Verification.** T4.3 asserting a peer invocation from inside a peer-invoked run is refused by admission under the existing `orchestration.depth_exceeded` and answered `denied`; a static check that the handler declares no limit constant.

### I-030-7 — Name uniqueness is decided once, by the database, over a stored fold key

The definition store computes the full Unicode case fold of `name` and persists it as `name_folded` on every insert and update; the unique index arbitrates that column. The store owns the folding algorithm but is not the correctness boundary — it produces the key, and the database decides uniqueness.

**Grounds in.** Plan-owned — no spec states where uniqueness is enforced, only that it holds. The storage-level placement is this plan's mechanism.

**Why load-bearing.** `name` is the handle a human picks from a list and the string a peer-invocation target spells; two definitions rendering identically in a picker are indistinguishable to the person choosing. A two-layer arrangement — full folding in the service, an ASCII `COLLATE NOCASE` index as a concurrency backstop — was specified first and does not hold, because the layer performing the real comparison is the layer that cannot be atomic: two concurrent creates of `Ärger` and `ärger` each pass the service precheck, and an ASCII index accepts both. Indexing the stored fold puts the full-Unicode comparison inside the atomic operation, which is the only place a uniqueness guarantee can live.

**Verification.** T1.2 migration test inserting an ASCII case-variant duplicate and a non-ASCII case-variant duplicate and asserting the index rejects **both**; T1.3 conformance row asserting `name_folded` is written on insert and rewritten on rename; T2.1 concurrency test issuing two non-ASCII case variants against the store simultaneously and asserting exactly one commits and the other surfaces `sidekick.definition_name_conflict`.

### I-030-8 — A definition stores a posture mode, never a composed posture

The table holds the execution-posture mode literal only. No `credentialPolicyRef`, `writableRoots`, or network-access member is persisted in `sidekick_definitions`, and the full posture is composed at attach time against the session's live credential policy.

**Grounds in.** `Spec-030 §Required Behavior` — the posture-mode rule.

**Why load-bearing.** A composed posture carries a content-addressed reference to a credential-policy artifact that is meaningful only against the session that composed it. Persisting one lets a definition pin a policy that has since been superseded, so re-attaching it would re-grant a trust decision the session had narrowed — and a stale ref can dangle outright.

**Verification.** T1.3 conformance assertion that the definition record shape carries no posture member beyond the mode literal, checked against the DDL column set.

### I-030-9 — No definition leaves the node

The daemon has no code path that relays, publishes, or transmits a definition row or any of its fields to the control plane or to a peer node.

**Grounds in.** `Spec-030 §Non-Goals` — the node-local rule.

**Why load-bearing.** `instructions` is operator-authored free text that routinely carries repository, workflow, and organizational detail. Definitions are configuration rather than session history, so they are outside the relay's end-to-end encryption story entirely; the correct guarantee is that they never enter it.

**Verification.** T2.1 static check that no relay or control-plane client module imports the definition store, plus an assertion that no `sidekick.*` payload type appears in the control-plane contract surface.

### I-030-10 — A definition's tool allowlist binds the daemon's own tools too

The resolved allowlist filters the callback-tool registry contributed to that agent exactly as it filters provider-native tools. An agent attached from a definition whose allowlist is empty receives no peer-invocation tools; one naming an explicit set receives them only if that set names them.

**Grounds in.** `Spec-030 §Required Behavior` — the allowlist-filters-the-registry rule; `Spec-030 §Required Behavior` — the spawn-enforcement rule of I-030-4, of which this is the callback-tool half.

**Why load-bearing.** The daemon's curated tools are the easiest ones to forget when enforcing an allowlist, because they are contributed by the daemon rather than requested by the definition — and they are the most consequential to leak, since `ask_sidekick` and `delegate_to_sidekick` start runs. An allowlist that constrained provider-native tools while silently admitting the daemon's own would report a restriction that is not in force, which is the precise failure I-030-4 exists to forbid.

**Verification.** T4.1 rows attaching from an empty-allowlist definition and asserting neither peer tool is contributed; from a populated allowlist naming neither tool, asserting the same; from a populated allowlist naming both, asserting both appear; and from an absent allowlist, asserting the driver-default composition is unchanged.

### I-030-11 — A peer-invoked run is attributed and its waiter is always settled

Child-run creation stamps the effective principal of the turn that issued the invoking tool call onto the run link, daemon-resolved and never client-supplied; a creation that cannot resolve one refuses rather than creating an unattributed run. Every terminal state of that child settles the waiting `ask_sidekick` call.

**Grounds in.** `Spec-030 §Required Behavior` — the invoking-principal rule and the ask-settlement rule.

**Why load-bearing.** Two independent holes close here. A peer-invoked run has neither an intervention row nor a participant who started it — the two arms `EffectivePrincipal` resolves through — so without a stamped value it has no principal at all, and chaining to the parent run cannot supply one because a run accumulates turns from several principals and recency is not a correct answer. Separately, `ask_sidekick` is the only tool in this plan that outlives its own child: admission succeeding does not guarantee an answer, so a child that fails, is cancelled, or completes silently would leave the asking model blocked on a call that never returns — the one outcome the callback-tool dispatch seam forbids.

**Verification.** T4.4 asserting the stamped principal equals the invoking turn's effective principal and differs from the parent run's initiator when a second participant issued the call, and that an unresolvable principal refuses creation; T4.3 settlement rows for each child terminal — failed, cancelled, interrupted, and completed-without-answer — each answering `failed` naming the terminal state, plus a race row landing the terminal between admission and subscription.

## Cross-Plan Obligations

Plan-030 declares the following obligations on adjacent plans (or inherits obligations declared by them). Implementation cannot proceed (or must defer specific surfaces) without these being satisfied or explicitly staged.

### CP-030-1 — Definition reference on the attach surface owed to [Plan-016](./016-multi-agent-channels-and-orchestration.md)

`AgentAttachRequest` is Plan-016-owned. Attach-by-reference requires that request to carry an additive-optional `definitionId`, and its response to echo the effective resolved configuration; the handler calls this plan's resolver before writing the `agents` row, and applies explicitly-present request members over the resolved values per field.

**Resolution.** Plan-016 registers the reciprocal CP-016-18 and carries the member, the echo, and the resolver call at T3.21, homed in a new **Phase 3B** supplement. Plan-030 T3.2 supplies the resolver and its refusal vocabulary; the wire members are registered in [api-payload-contracts.md §Plan-030 — Sidekick Definitions And Peer Invocation](../architecture/contracts/api-payload-contracts.md#plan-030--sidekick-definitions-and-peer-invocation).

### CP-030-2 — Definition-editor mount owed to [Plan-023](./023-desktop-shell-and-renderer.md)

Plan-030 authors the definition editor and the peer-invocation enablement control as a self-contained renderer subtree under `apps/desktop/src/renderer/src/sidekick-definitions/`, owning no shell, router, or navigation file. The desktop shell must mount that subtree and route to it.

**Resolution.** Plan-023 registers the reciprocal CP-023-6 and mounts the subtree at its Phase 6 renderer shell. Plan-030 T5.1 / T5.2 author the components behind that mount, following the [Plan-004](./004-queue-steer-pause-resume.md) `run-controls/` precedent where the authoring plan owns a subtree and the host plan owns the mount.

### CP-030-3 — Named Cedar actions registered in the Spec-012 enumeration

Peer invocation and definition management are authorized as the named operation actions `Action::"sidekick::invoke"` and `Action::"sidekick::manage"`, registered by extending the named-operation-action enumeration in `Spec-012 §Implementation Notes` in place.

**Resolution.** Registered by the 2026-08-26 amendment swap that mints this plan, on the precedent set by the `workflow::cancel` / `workflow::resume` registration. [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) carries no plan-side action enumeration, so no plan-side reciprocal exists and Plan-012's Status does not move — the same asymmetry that registration established.

**Why surfaced here.** The enablement act is authorized under `sidekick::manage` while each invocation is checked under `sidekick::invoke`, and the session-scoped opt-in that makes invocation automatic is read as Cedar context on the latter's check rather than stored as a grant of it. Recording both actions together is what keeps "who may turn it on" and "who may use it" separable.

### CP-030-4 — Invoking-principal stamping owed to [Plan-016](./016-multi-agent-channels-and-orchestration.md)

`run_links` is Plan-016-owned. A peer-invoked child run has neither an intervention row nor a participant who started it, so it resolves no effective principal under either existing arm, and chaining to the parent run cannot supply one — a run accumulates turns from several principals and recency is not a correct answer to which one issued the call. The link row therefore needs an `invoking_principal_id` column, and the creation path needs to stamp it from a value this plan supplies.

**Resolution.** Plan-016 registers the reciprocal CP-016-19, carries the column on its own `run_links` `CREATE` (Phase 2 merges before this plan's Phase 4, so no separate migration ordinal is consumed), and stamps the value its admission caller supplies. Plan-030 T4.4 resolves the invoking turn's effective principal and supplies it; a call whose principal cannot be resolved refuses before admission, so Plan-016 never has to represent an unattributed peer-invoked link. The column is NULL for every link created by any other path.

**Why surfaced here.** The write is one-writer Plan-016 by the §2 ownership map, but the obligation originates entirely in this plan's feature: no other caller of that admission path has an invoking turn distinct from the run's initiator.

### CP-030-5 — Event-type registration in the Plan-006 union-registration seam

`packages/contracts/src/event.ts` is Plan-006-owned. This plan mints one event type, `session.peer_invocation_set`, so its type literal, its `SESSION_EVENT_CATEGORY_BY_TYPE` row under `session_lifecycle`, and its `SessionEventSchema` payload arm must be registered in that file.

**Resolution.** Registered through the additive union-registration seam the [cross-plan-dependencies.md §2 Package Path Ownership Map](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) records, under which each event-emitting plan appends its own variants while its payload schema stays in its own domain — the Plan-016 CP-016-3 precedent, whose T1.13 layers that plan's own delta into the same union. Plan-030 T4.2 lands the literal, the registry row, and the payload arm, gated on Plan-006 Phase 1 by an `external_plan_phase_merged` precondition so the union exists before it is widened. No Plan-006 task and no Plan-006 reciprocal is owed; the seam is one-sided by construction, as it is for every other registrant.

**Why surfaced here.** Without it the taxonomy census would move to 159 with no task declaring the 159th literal, and this plan's Phase 4 would gate on a registration no plan owned.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — first-time targeted readiness audit taken 2026-08-26 (§6 node NS-86) riding the same diff that mints this plan, the in-swap shape the [Plan-029](./029-provider-accounts-and-credential-homes.md) mint established. The audit walked all four gates over the five phases and sixteen tasks authored here, the eleven invariants, and the five cross-plan obligations; it minted **no** born-unchecked box. Code dispatch rides tier order (Tier 6, ordered last within the tier behind Plans 012 / 016 / 029) and the per-phase gates below.

<!-- Cite durable forms per AGENTS.md §Durable-Cite Rule: `path#exportedSymbol` for code,
     `Spec-NNN §Heading` for specs/plans/ADRs; raw :NNN only for frozen/archive content. -->

## Target Areas

- `packages/contracts/src/sidekick-definition.ts` (NEW) — the definition record, the `sidekick.*` request/response pairs, and the two peer-invocation tool argument schemas.
- `packages/runtime-daemon/src/sidekicks/` (NEW directory per [cross-plan §2](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)): `invoking-principal.ts`, `definition-store.ts`, `definition-resolver.ts`, `attach-resolution.ts`, `handlers.ts`, `peer-invocation-tools.ts`, `peer-invocation-handler.ts`, `errors.ts`.
- `packages/runtime-daemon/src/migrations/` (EXTEND) — the `sidekick_definitions` migration and its runner registration.
- `apps/cli/src/commands/sidekick-definition-*.ts` (NEW) — the CLI definition commands, each extending the shared base command class per CP-007-15.
- `packages/client-sdk/src/` (EXTEND) — `sidekickClient.ts` (NEW), the typed client for the five `sidekick.*` pairs, plus one barrel export line in the Plan-001-owned `index.ts`.
- `apps/desktop/src/renderer/src/sidekick-definitions/` (NEW) — the editor subtree handed to Plan-023's mount under CP-030-2.

## Data And Storage Changes

- One new local SQLite table, `sidekick_definitions`, owned by this plan and defined byte-for-byte in [local-sqlite-schema.md §Sidekick Definition Tables (Plan-030)](../architecture/schemas/local-sqlite-schema.md#sidekick-definition-tables-plan-030). It carries the definition's identity, its provider/model/effort/account pins, its posture mode, its instructions and goal, its tool allowlist, and its timestamps, plus a unique index over the stored `name_folded` fold key.
- **No foreign key** binds `provider_account_id` to `provider_accounts`. See D-030-1 — the row must survive its account's removal so resolution can refuse legibly.
- **No foreign key** binds any agent to the definition it was resolved from, because I-030-2 makes the agent independent of it after resolution.
- One added column on Plan-016's `run_links`, `invoking_principal_id` (CP-030-4 ⇄ CP-016-19) — authored on Plan-016's own `CREATE` because Plan-016 Phase 2 merges before this plan's Phase 4, so it consumes no migration ordinal of its own.
- `sidekick_definitions` carries `name_folded`, the stored full-Unicode case fold that the uniqueness index arbitrates (I-030-7). Both columns move no table census.
- No control-plane table, no relay surface, no export surface.

## API And Transport Changes

- Five daemon JSON-RPC pairs under the new `sidekick` root: `sidekick.definitionCreate`, `sidekick.definitionUpdate`, `sidekick.definitionDelete`, `sidekick.definitionList`, and `sidekick.peerInvocationSet`. There is no separate read verb — `definitionList` returns full records, matching the `providerAccount.list` shape.
- One additive-optional member and one response echo on Plan-016's existing `agent.attach` pair (CP-030-1). No new `agent.*` verb.
- Two `SessionCallbackTool` registrations served through Plan-005's existing callback-tool dispatch seam. These are tool registrations, not wire methods: the `sidekick` namespace stays at five pairs.
- **One new event type**, `session.peer_invocation_set` in the existing `session_lifecycle` category ([Spec-006 §Session Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md#session-lifecycle-session_lifecycle); taxonomy census 158 → 159), the durable home of the per-session peer-invocation opt-in — see D-030-10. Five registered `sidekick.*` refusal codes on the definition and attach paths, and none on the peer-invocation path, which rides the callback-tool result arms.

## Implementation Steps

1. Author the contract module and the migration, and pin them to one another with a conformance suite.
2. Build the definition store with storage-level case-insensitive uniqueness, then the `sidekick.*` handlers behind the `sidekick::manage` Cedar action.
3. Ship the CLI commands over the handlers.
4. Build the fail-closed resolver, then wire it into Plan-016's attach path and prove snapshot isolation.
5. Register the two peer-invocation tools unconditionally — filtered only by the resolved agent's tool allowlist — adjudicate each invocation per call against the projected enablement flag, implement the invocation handler over Plan-016's admission pipeline, and prove the cost and causation consequences.
6. Author the desktop editor subtree and hand it to Plan-023's mount.

## Parallelization Notes

- Phase 1's three tasks are sequential: the conformance suite exists to pin the other two together.
- Phase 2's store and handlers are sequential; the CLI commands (T2.3) can run in parallel with Phase 3 once the handlers land.
- Phase 3 and Phase 4 are sequential — peer invocation resolves targets through the same resolver attach-by-reference uses.
- Phase 5 follows Phase 4: its editor (T5.1) and SDK surface (T5.3) need only Phase 3, but the enablement toggle (T5.2) is presentation over the enablement leg T4.2 authors, and phase gates dispatch a phase as a whole.

## Test And Verification Plan

- **Unit** — schema acceptance/rejection rows for every request and response pair; resolver refusal rows per unresolvable field; allowlist three-state round-trip; registry-composition rows across the four allowlist states of I-030-10, including one asserting both peer tools are present with enablement off; per-call adjudication rows with and without the projected enablement flag.
- **Integration** — attach-by-reference end to end against a live migration; snapshot isolation under definition edit and delete; peer invocation producing an admitted child run with the expected link type; depth refusal from inside a peer-invoked run; cost-receipt rows landing on the child under the target's account.
- **Manual** — create a definition in the desktop editor, attach it in two sessions, edit it, and confirm both attached sidekicks are unchanged.
- **Adversarial-Tampering Boundary** — caller-supplied `definitionId` and timestamps rejected at intake; a `name` differing only by ASCII case or by trailing whitespace rejected at both the service and the index, and one differing only by a non-ASCII case mapping rejected at both layers as well, since the index arbitrates the stored full-Unicode `name_folded` key rather than an ASCII collation (I-030-7); a tool-allowlist payload carrying a non-string member rejected at the parser rather than at spawn; a peer-invocation target naming a provider, a model, an account, or a node rejected before admission; a definition row hand-edited to carry a composed posture failing the T1.3 conformance suite rather than reaching the spawn path.
- **CI-Pinned Tool Versions** — verification commands name the CI-pinned toolchain (`pnpm@10.33.2`, Node `>=22.12.0` per [ADR-022](../decisions/022-v1-toolchain-selection.md)) so local drift surfaces at plan-authoring time.

## Implementation Phase Sequence

Plan-030 implementation lands as a sequence of small PRs. Each PR exercises one slice of the plan's vertical and carries a `**Precondition:**` line so the merge order is reviewer-checkable.

### Phase 1 — Contracts and migration

**Precondition:** Plan-016 Phase 1 merged; Plan-029 Phase 1 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: external_plan_phase_merged, plan: 16, phase: 1 }
  - { type: external_plan_phase_merged, plan: 29, phase: 1 }
```

**Goal:** the registry's contract surface and durable table exist, pinned to one another by a mechanical conformance suite.

#### Tasks

- **T1.1 — Sidekick-definition contracts.**
  - **Files:** `packages/contracts/src/sidekick-definition.ts` (NEW).
  - **Provides:** the `SidekickDefinitionId` brand; the `SidekickDefinition` record shape; the `ExecutionPostureMode` literal union (`trusted` \| `workspace-sandboxed` \| `readonly-sandboxed`); the tool-allowlist type whose absent and empty states are distinct; and the request/response pairs for create, update, delete, list, and peer-invocation-set. Strict Zod schemas with unknown-key rejection. `definitionId`, `createdAt`, and `updatedAt` are **response-only** projections — a create request carrying any of them does not parse.
  - **Consumes:** branded-id factory (Plan-001, shipped); `ProviderAccountId` (Plan-029 T1.1).
  - **Spec coverage:** Spec-030 §Interfaces And Contracts; Spec-030 §Required Behavior.
  - **Verifies invariant:** I-030-1, I-030-4, I-030-8.
  - **Tests:** schema acceptance/rejection rows per pair; unknown-key rejection; caller-supplied `definitionId` and timestamps rejected on create; the allowlist's absent and empty states parsing to distinguishable values; a posture member beyond the mode literal rejected.
- **T1.2 — Migration: `sidekick_definitions`.**
  - **Files:** `packages/runtime-daemon/src/migrations/0NNN-sidekick-definitions.ts` (CREATE — NNN = next free version per migration-runner append order at PR-open time), `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND — version-N guarded block with an in-transaction re-check, in the **same commit** as the migration file; an orphan file leaves the table absent at `no such table`).
  - **Provides:** the table byte-matching [local-sqlite-schema.md §Sidekick Definition Tables (Plan-030)](../architecture/schemas/local-sqlite-schema.md#sidekick-definition-tables-plan-030), including the `name_folded` column and the unique index over it — never a `COLLATE NOCASE` index over `name`, whose ASCII-only folding is the defect I-030-7 records — and the CHECK constraints bounding the text columns.
  - **Consumes:** Plan-001 migration-runner seam (shipped).
  - **Spec coverage:** Spec-030 §State And Data Implications.
  - **Verifies invariant:** I-030-7, I-030-4.
  - **Tests:** migration up + idempotence; **both** an ASCII case-variant and a non-ASCII case-variant duplicate name rejected by the index (the non-ASCII row is the one a `COLLATE NOCASE` index would admit, so it is the row that proves the fold key is doing the work); `NULL` and `'[]'` tool allowlists proven to round-trip distinctly; CHECK rejection rows for empty, over-long, and NUL-bearing `name`; posture-mode CHECK rejection; a row surviving deletion of the account its `provider_account_id` names.
- **T1.3 — Contract ↔ DDL conformance suite.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/__tests__/sidekick-definition-schema-conformance.test.ts` (NEW).
  - **Provides:** mechanical lockstep checks — the contract's posture-mode union against the DDL CHECK list; the record shape against the column set; the absence of any composed-posture member on both sides; and the `name_folded` write path, asserted present on insert and rewritten on rename, since it is a derived column no wire shape carries and therefore has no contract-side row to keep it honest.
  - **Consumes:** T1.1, T1.2.
  - **Spec coverage:** Spec-030 §State And Data Implications.
  - **Verifies invariant:** I-030-8, I-030-7.
  - **Tests:** the suite is the test — one row per pinned pair (documented-pin ≠ enforced-pin discipline).

### Phase 2 — Registry service, authorization, and CLI

**Precondition:** Phase 1 merged; Plan-012 Phase 2 merged; Plan-007 Phase R3 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 30, phase: 1, status: merged }
  - { type: external_plan_phase_merged, plan: 12, phase: 2 }
  - { type: external_plan_phase_merged, plan: 7, phase: R3 }
```

**Goal:** definitions can be created, listed, updated, renamed, and deleted from the CLI, under Cedar authorization, with uniqueness enforced in storage.

#### Tasks

- **T2.1 — Definition store.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/definition-store.ts` (NEW), `packages/runtime-daemon/src/sidekicks/errors.ts` (NEW).
  - **Provides:** create / update / delete / list over `sidekick_definitions`, minting `definitionId` daemon-side; the full-Unicode case fold written to `name_folded` on every insert and update, and the service-layer uniqueness pre-check that surfaces a legible conflict ahead of the index — the pre-check is a legibility affordance only, never the guarantee, which is the index's (I-030-7); and the typed refusal vocabulary this task raises — `sidekick.definition_not_found`, `sidekick.definition_name_conflict`, and `sidekick.definition_unreadable`, registered in [error-contracts.md §Sidekick Definitions](../architecture/contracts/error-contracts.md#sidekick-definitions).
  - **Consumes:** T1.1 contracts, T1.2 table.
  - **Spec coverage:** Spec-030 §Required Behavior; Spec-030 §Non-Goals.
  - **Verifies invariant:** I-030-1, I-030-7, I-030-9.
  - **Tests:** rename preserving `definitionId` byte-for-byte; case-variant create refused at the service and, with the pre-check bypassed, at the index; two non-ASCII case variants issued concurrently, asserting exactly one commits and the other surfaces `sidekick.definition_name_conflict` — the race an ASCII index admits; delete succeeding while agents attached from the row are running; a static check that no relay or control-plane client module imports this store and that no `sidekick.*` type appears in the control-plane contract surface.
- **T2.2 — `sidekick.*` handlers and Cedar authorization.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/handlers.ts` (NEW).
  - **Provides:** the five JSON-RPC pairs registered on the `sidekick` root, each authorized under `Action::"sidekick::manage"` through Plan-012's published Cedar gate, and the four definition-CRUD verbs implemented over the T2.1 store. Authorization resolves two resource descriptors under the one action: node-scoped for the CRUD verbs, the named session for `sidekick.peerInvocationSet`. This task registers that fifth verb and authorizes it; its enablement behavior — the append and the projection — is authored by T4.2, which is where the event this plan mints is owned. A Cedar denial on any of the five verbs raises `sidekick.permission_denied`; an invocation-time denial never reaches this handler, arriving on the callback-tool `denied` arm from T4.3 instead.
  - **Consumes:** T2.1; Plan-012 Cedar gate (Phase 2, published) — the named-action check only, never the remembered-rule store, which cannot represent a named-operation grant (D-030-4); Plan-007 JSON-RPC handler registry.
  - **Spec coverage:** Spec-030 §Interfaces And Contracts; Spec-030 §Required Behavior.
  - **Verifies invariant:** I-030-5.
  - **Tests:** each verb refused for a principal lacking the action; a definition mutation authorized against the node-scoped resource descriptor and the enablement setter against the named session, asserting the CRUD path invents no `sessionId`; a negative check asserting no handler in this module writes a `remembered_approval_rules` row, since a named-operation action cannot be represented as one (D-030-4); the namespace census asserted at five pairs.
- **T2.3 — CLI definition commands.**
  - **Files:** `apps/cli/src/commands/sidekick-definition-list.ts`, `sidekick-definition-create.ts`, `sidekick-definition-edit.ts`, `sidekick-definition-delete.ts` (all NEW), `apps/cli/src/main.ts` (EXTEND — `.register()` calls only, per the Plan-026 CP-026-2 precedent).
  - **Provides:** the operator-facing definition surface over the T2.2 handlers, each command extending the shared base command class from `apps/cli/src/base-command.ts` per CP-007-15, writing results to the injected stdout and diagnostics to the injected stderr.
  - **Consumes:** T2.2; Plan-007 base command class (Phase R3) and client SDK transport.
  - **Spec coverage:** Spec-030 §Scope.
  - **Verifies invariant:** none — operator surface over already-verified handlers.
  - **Tests:** one regression assertion per command that a thrown error routes to stderr with stdout byte-empty under the mapped exit code; a list rendering golden.

### Phase 3 — Resolution and attach-by-reference

**Precondition:** Phase 2 merged; Plan-016 Phase 3 merged; Plan-029 Phase 2 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 30, phase: 2, status: merged }
  - { type: external_plan_phase_merged, plan: 16, phase: 3 }
  - { type: external_plan_phase_merged, plan: 29, phase: 2 }
```

**Goal:** `agent.attach` accepts a definition reference, resolves it fail-closed, and produces an agent that is provably independent of the definition thereafter.

#### Tasks

- **T3.1 — Fail-closed definition resolver.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/definition-resolver.ts` (NEW).
  - **Provides:** resolution of a `definitionId` to a concrete agent configuration — account existence checked against Plan-029's published registry read — existence only, because Spec-029 makes the stored readiness projection advisory and I-029-3's live probe at spawn is the authoritative authentication gate — model checked against the driver's offered set, effort validated against the target model's driver-reported effort levels, posture composed from the stored mode plus the session's live credential policy, and the tool allowlist checked realizable by the resolved driver. Every unresolvable input refuses as `sidekick.resolution_refused` carrying the closed `reason` arm for the input that failed; nothing is substituted.
  - **Consumes:** T2.1 store; Plan-029 `providerAccount.list` registry read (published — consulted for account existence, never for readiness); Plan-005 driver capability surface (published).
  - **Spec coverage:** Spec-030 §Fallback Behavior; Spec-030 §Default Behavior.
  - **Verifies invariant:** I-030-3, I-030-4, I-030-8.
  - **Tests:** refusal rows for absent account, absent model, unsupported effort, and unrealizable allowlist — one per closed `reason` arm — each carrying the matching arm and naming the unresolved input, the allowlist row asserting **both** of its arm's naming fields (the unrealizable tools and the driver's supported set), since either alone leaves the operator unable to tell what to edit; a row proving a registered-but-unauthenticated account resolves successfully here and is refused later by the spawn gate, so the resolver never second-guesses I-029-3; a negative-control row proving the resolver fails on a known-bad account rather than passing vacuously; absent-optional rows resolving to the documented defaults.
- **T3.2 — Attach-by-reference integration.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/attach-resolution.ts` (NEW — the seam Plan-016's attach handler calls).
  - **Provides:** the resolver call Plan-016's `agent.attach` makes before writing the `agents` row; the per-field override of resolved values by explicitly-present request members; the effective-resolved-configuration echo; and the zero-residue refusal path, raising `sidekick.definition_not_found` for a `definitionId` naming no row and `sidekick.definition_unreadable` when the registry cannot be read.
  - **Consumes:** T3.1; Plan-016 `agent.attach` handler (Phase 3) per CP-030-1.
  - **Spec coverage:** Spec-030 §Required Behavior.
  - **Verifies invariant:** I-030-3.
  - **Tests:** attach with a definition producing matching configuration; explicit request member overriding for that field only; the echo reporting the merged result; a refused attach leaving no agent row, no partial configuration, and no run.
  - **Ownership note:** `AgentAttachRequest` and the attach handler are Owner=Plan-016. This task authors the resolution seam that handler calls; it MUST NOT edit any Plan-016-owned file.
- **T3.3 — Snapshot-isolation regression suite.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/__tests__/snapshot-isolation.test.ts` (NEW).
  - **Provides:** the standing proof of I-030-2 — a live attached agent's configuration is unaffected by any mutation of the definition it came from, including deletion.
  - **Consumes:** T3.2.
  - **Spec coverage:** Spec-030 §Required Behavior; Spec-030 §Pitfalls To Avoid.
  - **Verifies invariant:** I-030-2.
  - **Tests:** edit every mutable field under a live attached agent and assert the agent's stored configuration is byte-identical; delete the definition and assert the agent's run continues; a static import check proving no module on the agent read path reaches the definition store.

### Phase 4 — Peer invocation

**Precondition:** Phase 3 merged; Plan-005 Phase 3 merged; Plan-016 Phase 2 merged; Plan-016 Phase 4B merged; Plan-006 Phase 1 merged. Phase 4B is gated here and not only cited by T4.4, because a phase whose task consumes the session cost receipt cannot dispatch while its own gate does not require the receipt to exist. Plan-006 Phase 1 is gated because T4.2 both registers and appends `session.peer_invocation_set`: it lands the type literal, the registry row, and the payload arm into Plan-006's `event.ts` union through the additive registration seam (CP-030-5), which requires that union to already exist.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 30, phase: 3, status: merged }
  - { type: external_plan_phase_merged, plan: 5, phase: 3 }
  - { type: external_plan_phase_merged, plan: 16, phase: 2 }
  - { type: external_plan_phase_merged, plan: 16, phase: 4B }
  - { type: external_plan_phase_merged, plan: 6, phase: 1 }
```

**Goal:** an enabled session exposes both peer tools; an invocation produces an admitted, timeline-visible child run whose cost lands where the spec says.

#### Tasks

- **T4.1 — Tool definitions and unconditional, allowlist-filtered registration.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/peer-invocation-tools.ts` (NEW).
  - **Provides:** the `ask_sidekick` and `delegate_to_sidekick` `SessionCallbackTool` declarations — name, description, and JSON-Schema arguments accepting a sidekick target as either a session agent id or a `definitionId` — and the spawn-time registry contribution, which yields both tools **unconditionally with respect to enablement** (the `workflow_start` shape) and applies exactly one filter: the resolved agent's tool allowlist. An empty allowlist yields neither tool, a populated one yields only the tools it names, and an absent one leaves the driver-default composition unchanged (I-030-10). Enablement is not consulted here at all — it is a per-call Cedar context input in T4.3.
  - **Consumes:** the resolved allowlist ← T3.1; Plan-005 callback-tool registry (published, Phase 3).
  - **Spec coverage:** Spec-030 §Required Behavior (the registration rule and the allowlist-filters-the-registry rule); Spec-030 §Default Behavior.
  - **Verifies invariant:** I-030-5, I-030-10.
  - **Tests:** both tools present in a registry composed for a session with enablement off; the four allowlist compositions of I-030-10 (empty → neither, populated-naming-neither → neither, populated-naming-both → both, absent → driver default unchanged); the argument schema rejecting a target naming a provider, a model, an account, or a node; a static check that this module reads no enablement state.
- **T4.2 — Enablement lifecycle.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/peer-invocation-handler.ts` (NEW — enablement leg), `packages/contracts/src/event.ts` (EXTEND — the `session.peer_invocation_set` type literal, its `SESSION_EVENT_CATEGORY_BY_TYPE` row, and its `SessionEventSchema` payload arm, through the additive union-registration seam per CP-030-5).
  - **Provides:** the enablement setter behind `sidekick.peerInvocationSet` — the `Action::"sidekick::manage"` check against the named **session** resource, the append of `session.peer_invocation_set` (`{sessionId, enabled, actor}`, `actor` daemon-resolved from the authenticated caller and never client-supplied), and the projection of that event into the session-state flag T4.3 reads as Cedar context. The event is the durable home: no column and no table backs the flag, and replay is how a restarted daemon relearns it. The response reads the post-append projected value rather than echoing the request.
  - **Consumes:** T4.1; T2.2 method registration; Plan-006 event registry (Phase 1) for the type literal and payload schema.
  - **Spec coverage:** Spec-030 §Required Behavior (the enablement rule).
  - **Verifies invariant:** I-030-5.
  - **Tests:** enable then disable, asserting one event appended per transition with `actor` populated from the authenticated caller; a client-supplied `actor` ignored; the projected flag rebuilt correctly by replaying the event log alone with no local row; a withdrawal asserting the very next invocation on an already-running leg answers `denied` **without a respawn**; re-enablement restoring service on the next call; an unauthenticated or unauthorizable caller refused `sidekick.permission_denied` with no event appended.
- **T4.3 — Invocation handler.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/peer-invocation-handler.ts` (EXTEND — invocation leg).
  - **Provides:** target resolution (session agent, or definition attached on demand through T3.2), the per-call Cedar check — `Action::"sidekick::invoke"` with the T4.2-projected enablement flag supplied as context, so a disabled session answers `denied` on a tool that is nonetheless present — child-run creation through Plan-016's orchestration admission with link type `spawn` for `ask_sidekick` and `delegate` for `delegate_to_sidekick`, the invoking turn's effective principal supplied to that admission call for stamping under CP-030-4, and the mapping of every outcome onto the callback-tool result arms. **`ask_sidekick` settlement:** the handler subscribes to the child's run-lifecycle terminal **before returning**, so a terminal landing between admission and subscription is still observed, and every terminal settles the waiting call — a child that fails, is cancelled, or is interrupted answers `failed` naming the terminal state, and one that completes without producing an answer answers `failed` rather than `completed` with empty output. No invocation is left unanswered. **Admission — the depth check included — is evaluated synchronously inside the creation call this handler makes, before the tool returns.** This matters asymmetrically: `ask_sidekick` waits for the peer's answer anyway, but `delegate_to_sidekick` returns as soon as the run is admitted, so if the depth check were deferred to a later dispatch step the tool would answer `completed` with the identity of a run that then died at admission — a success the asking model would act on. `delegate_to_sidekick` therefore returns `completed` only on the far side of a successful admission, and never returns a run identity for a run admission would refuse — the peer's answer or the delegated run's identity on `completed`, an authorization or admission refusal on `denied` carrying its reason, an unknown target or invalid arguments on `failed`.
  - **Consumes:** T4.1, T4.2, T3.2; Plan-016 orchestration admission (Phase 2) and run-link projection.
  - **Spec coverage:** Spec-030 §Required Behavior; Spec-030 §Fallback Behavior.
  - **Verifies invariant:** I-030-6, I-030-5, I-030-11.
  - **Tests:** each tool producing a child run with its documented link type; a call under a disabled session answered `denied` while the tool is present in the registry; an invocation from inside a peer-invoked run refused by admission under the existing `orchestration.depth_exceeded` and answered `denied`; an unresolvable target answered `failed` with no run created; an attach refusal surfacing its reason through `denied`; a `tool_activity` row landed per invocation; the four `ask_sidekick` settlement rows (child failed, cancelled, interrupted, completed-without-answer) each answering `failed` naming the terminal; a race row landing the child terminal between admission and subscription and asserting the call still settles; a static check that this module declares no limit constant of its own.
- **T4.4 — Invoking-principal propagation, and cost-and-causation conformance.**
  - **Files:** `packages/runtime-daemon/src/sidekicks/invoking-principal.ts` (NEW), `packages/runtime-daemon/src/sidekicks/__tests__/peer-invocation-cost.test.ts` (NEW).
  - **Provides:** the producer side of the attribution rule — resolution of the invoking turn's effective principal at the moment the tool call is dispatched (the turn is already resolved when its call is issued, so this is a read of a settled fact rather than a later lookup), and its supply to Plan-016's child-run creation for stamping onto `run_links.invoking_principal_id` under CP-030-4. The value is daemon-resolved and never read from tool arguments; a call whose principal cannot be resolved refuses **before** admission, so no unattributed child run is ever created. Plus the standing proof that a peer-invoked run's spend lands on its own receipt row under the target sidekick's paying account, that the asking run's row is unchanged, and that the causal edge is carried by the run link rather than by a receipt roll-up.
  - **Consumes:** T4.3; the turn-scoped effective principal ← Plan-012 permission-check service (read, never authored); the stamping column ← Plan-016 `run_links` (CP-030-4 ⇄ CP-016-19); Plan-016 cost receipt (Phase 4B).
  - **Spec coverage:** Spec-030 §Required Behavior (the invoking-principal rule and the cost-and-causation rules).
  - **Verifies invariant:** I-030-11.
  - **Tests:** the stamped principal equal to the invoking turn's effective principal; a second participant steering the asking run and issuing the call, asserting the stamp is that participant and **not** the parent run's initiator; an unresolvable principal refusing before admission with no run and no link row written; a smuggled principal in the tool arguments ignored; the child's `costCents` on its own run row and on the target account's row; the asking run's row byte-identical to a control run that made no invocation; both receipt partition identities still summing to the session total.

### Phase 5 — Desktop editor and enablement control

**Precondition:** Phase 3 merged; Phase 4 merged; Plan-023 Phase 6 merged. Phase 4 is gated because T5.2 is presentation over the enablement leg T4.2 authors — the toggle's stated disable timing is T4.2's behavior, so shipping it earlier would ship a control verified against a handler that does not yet exist.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 30, phase: 3, status: merged }
  - { type: plan_phase, plan: 30, phase: 4, status: merged }
  - { type: external_plan_phase_merged, plan: 23, phase: 6 }
```

**Goal:** a user can build, edit, and pick a sidekick definition from the desktop, and can turn peer invocation on and off for a session.

#### Tasks

- **T5.1 — Definition editor subtree.**
  - **Files:** `apps/desktop/src/renderer/src/sidekick-definitions/` (NEW — list, editor form, and delete confirmation).
  - **Provides:** the create / edit / rename / delete surface over the `sidekick.*` handlers, with the tool allowlist's absent and empty states presented as visibly different choices rather than as one empty control, and the pinned-account field showing the account's readiness as an **advisory** signal, so a definition whose account would refuse at spawn under I-029-3 is legible before it is used — never as a resolution-time gate, which checks registry existence only.
  - **Consumes:** T2.2 handlers through the client SDK; Plan-023 renderer shell mount per CP-030-2.
  - **Spec coverage:** Spec-030 §Scope; Spec-030 §Pitfalls To Avoid.
  - **Verifies invariant:** I-030-4.
  - **Tests:** renderer tests covering the three allowlist states, a rename preserving selection, and a delete confirmation naming what will and will not be affected.
  - **Ownership note:** the shell, router, and navigation files are Owner=Plan-023. This subtree owns none of them and is reached through the mount CP-030-2 registers.
- **T5.2 — Peer-invocation enablement control.**
  - **Files:** `apps/desktop/src/renderer/src/sidekick-definitions/PeerInvocationToggle.tsx` (NEW).
  - **Provides:** the session-scoped enable / disable control over `sidekick.peerInvocationSet`, stating that enabling grants automatic peer invocation for the remainder of the session and that disabling takes effect on the next invocation on every leg, including legs already running.
  - **Consumes:** T5.1; T4.2 — the enablement leg this control is presentation over, which is why Phase 5 gates on Phase 4.
  - **Spec coverage:** Spec-030 §Required Behavior (the enablement rule).
  - **Verifies invariant:** none — presentation over an already-verified handler.
  - **Tests:** the control reflecting the current projected enablement flag on mount; the disable path's stated timing matching T4.2's behavior (effective on the next call, no respawn).
- **T5.3 — Client SDK surface.**
  - **Files:** `packages/client-sdk/src/sidekickClient.ts` (NEW), `packages/client-sdk/src/index.ts` (EXTEND — barrel export only).
  - **Provides:** typed client methods for the five `sidekick.*` pairs, consumed by both the CLI commands and the desktop subtree.
  - **Consumes:** T2.2; Plan-001 client SDK transport (shipped).
  - **Spec coverage:** Spec-030 §Interfaces And Contracts.
  - **Verifies invariant:** none — transport surface over already-verified handlers.
  - **Tests:** one round-trip per pair against a stub transport; the barrel export asserted present.
  - **Ownership note:** `packages/client-sdk/src/index.ts` is Owner=Plan-001. This task appends one export line and edits nothing else in that file.

## Rollout Order

1. Phase 1 — contracts, migration, conformance.
2. Phase 2 — store, handlers, CLI.
3. Phase 3 — resolver and attach-by-reference.
4. Phase 4 — peer invocation.
5. Phase 5 — desktop surfaces.

## Rollback Or Fallback

- Phases 1–3 are additive: an unshipped `sidekick.*` namespace and an unused `definitionId` member leave `agent.attach` behaving exactly as before, so rolling back a phase never breaks inline attach.
- Phase 4 ships inert by default: a session that has never appended `session.peer_invocation_set` projects enablement off, so both tools are present in the registry but every invocation is refused at adjudication. Turning peer invocation off for a session is one `sidekick.peerInvocationSet` call, effective on the next invocation, with no code change and no respawn.
- The migration is additive and creates one table; rolling it back drops a table nothing else references, because no foreign key points at it in either direction.

## Risks And Blockers

- **Intra-tier ordering.** This plan sits at Tier 6 with Plans 012, 016, and 029, and depends on all three. Its phases carry explicit `external_plan_phase_merged` gates so the ordering is enforced mechanically rather than by tier membership alone.
- **Effort validation depends on a driver-reported set.** A driver that reports no effort levels makes every explicit effort unresolvable. The resolver treats an empty reported set as "effort not supported by this driver" and refuses an explicit effort while accepting an absent one, rather than passing an unvalidated value through.
- **Definition text is unbounded operator input.** `instructions` is the largest free-text column this plan owns; its CHECK bounds length so a pathological definition cannot make every attach path slow or a spawn argument list unbuildable.
- **Peer invocation makes a run's cost depend on another account's readiness.** A target whose account has gone unauthenticated refuses at spawn under I-029-3 — not at resolution, which checks existence only — and that surfaces to the asking sidekick as `denied` mid-turn. That is the intended fail-closed behavior, and T4.3 pins the reason reaching the caller so it is diagnosable rather than opaque.

## Decision Log

- **D-030-1 — No foreign key from `provider_account_id` to `provider_accounts`.** `ON DELETE CASCADE` would delete a definition when its account is removed, discarding operator-authored configuration; `ON DELETE SET NULL` would silently convert a pinned account into "the provider's default account", which is exactly the substitution I-030-3 forbids; `ON DELETE RESTRICT` would make account removal fail because an unrelated definition names it. The row therefore carries an unenforced reference and resolution checks account **existence** at attach time — never readiness, which I-029-3's live spawn probe settles — which is the only point at which the answer matters.
- **D-030-2 — A definition stores a posture mode, not a composed posture.** A composed `ExecutionPosture` carries a content-addressed `credentialPolicyRef` that is meaningful only against the session that composed it; persisting one lets a stale definition re-grant a superseded trust decision, or dangle. The mode literal is the operator's actual intent, and the session composes the rest.
- **D-030-3 — An attached agent is a snapshot, not a live reference.** The live-reference alternative reads as the more useful feature and is an authorization hole: it widens a running agent's authority without an authorization act. Configuration reuse is delivered at attach time, which is where the authorization check already sits.
- **D-030-4 — Enablement is an event, not a remembered approval rule and not a table.** The remembered-grant route was specified first and is **unrepresentable**, not merely redundant: `remembered_approval_rules` closes its `category` column over the approval-pipeline categories and requires `created_from_request_id` to reference an `approval_resolutions` row, and a named-operation Cedar action traverses no approval pipeline and produces no resolution — so there is no legal row to write. A dedicated table was the next candidate and was rejected because this corpus projects no session-configuration table at all: the session goal, the closest analogue, lives in the event log and is rebuilt by replay (`session_goal_dispatch_intents` is a crash-consistency intent row, not the goal's home). The event is therefore the corpus's own answer for session-scoped mutable configuration, and it buys the audit trail for free — which matters here, because the thing being granted lets a running model start other runs.
- **D-030-5 — The tools are registered unconditionally and adjudicated per call.** Grant-gated registration was specified first, on the reasoning that a tool a model can see is one it will plan around. It does not work: `callbackTools` rides only the session-creation and resume parameter shapes, and the corpus has no live-registry mutation seam, so a registry filtered by enablement is frozen at spawn. Enabling mid-session would then change nothing an operator could observe until the leg respawned, and withdrawal would leave a live leg holding a revoked capability until the same boundary. Per-call adjudication makes both directions take effect on the next call, needs no seam that does not exist, and matches `workflow_start` — the corpus's only other concrete session callback tool, which is likewise registered at spawn and Cedar-checked per invocation. The cost is the visible-but-refusable tool the original reasoning objected to, and it is the smaller cost.
- **D-030-6 — The tool allowlist is three-state.** `NULL` means the driver's defaults and `'[]'` means no tools. Representing "no tools" as an absent value would make the most restrictive choice unexpressible, which is the wrong direction for a security control to be lossy in.
- **D-030-7 — No depth rule is authored here.** `Spec-016 §Default Behavior`'s one-layer rule already refuses the grandchild a nested peer invocation would create, and `orchestration.depth_exceeded` already carries `maxDepth: 1`. A second check in the handler would be a second source of truth whose drift would surface as runaway fan-out rather than as a failing test.
- **D-030-8 — Five wire pairs, with `definitionList` returning full records.** A separate read verb would duplicate the list's projection and give two surfaces that can disagree about what a definition is. This follows the `providerAccount.list` shape, which returns full rows for the same reason.
- **D-030-10 — The invoking principal is stamped on the run link, not derived later.** A peer-invoked child resolves no effective principal under either existing arm — no intervention row, no participant who started it — and deriving one by chaining to the parent run is wrong rather than merely lossy, because a run accumulates turns from several principals and the newest is not necessarily the caller. The invoking turn's principal is already settled at the moment its tool call is dispatched, so stamping it there records a fact instead of reconstructing a guess, and a call that cannot resolve one refuses before admission rather than creating an unattributed run.
- **D-030-9 — The CLI group word is `sidekick-definition`.** Two shorter alternatives were considered and rejected. Bare `definition` collides with `Spec-017`'s frozen **workflow definitions**, whose command group lives in this same `apps/cli/src/commands/` directory, so `definition-*.ts` beside `workflow-*.ts` would be ambiguous at exactly the point a reader needs disambiguation. Bare `sidekick` truncates a two-word resource to one word, which both stutters as `sidekicks sidekick list` and reads as a command over _running_ session agents rather than over the saved records this plan owns — a distinction `Spec-030 §Required Behavior` draws throughout, since a peer-invocation target may be either. The group word therefore names the resource in full, following the corpus's only other two-word CLI resource: [Plan-029](./029-provider-accounts-and-credential-homes.md)'s `sidekicks provider-account` group with its matching `provider-account-*.ts` files. The wire namespace stays `sidekick.*` because it also carries the peer-invocation enablement pair, which is not a definition operation; the CLI group is narrower than the namespace on purpose. The everyday form is `sk sidekick-definition list`.

## Progress Log

### Shipment Manifest

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

- **2026-08-26 — Plan minted with a first-time targeted readiness audit (PR #368, §6 node NS-86).** Spec-030 and Plan-030 were authored and promoted `draft → review → approved` in one swap, the in-swap mint shape [Plan-029](./029-provider-accounts-and-credential-homes.md) established at NS-74. The audit walked all four gates over the five phases, sixteen tasks, eleven invariants, and five cross-plan obligations authored here, and minted **no** born-unchecked box: every upstream this plan consumes is a published surface (Plan-005's callback-tool host and driver capability surface, Plan-012's Cedar gate and turn-scoped effective principal, Plan-016's admission pipeline, run links, and cost receipt, Plan-029's account-readiness projection, Plan-007's base command class under the existing CP-007-15 binding), so each dependency is expressible as a phase gate rather than as a carrier hold. The three obligations that do require reciprocal registration — CP-030-1 on Plan-016's attach surface (⇄ CP-016-18), CP-030-2 on Plan-023's renderer mount (⇄ CP-023-6), and CP-030-4 on Plan-016's `run_links` invoking-principal stamp (⇄ CP-016-19) — were registered in the same swap, flipping and restoring those plans `approved` with their own in-swap deltas — part of the eight-document flip set (Spec-006, Plan-006, Spec-012, Spec-016, Plan-016, Plan-023, Spec-028, Plan-028) this swap restores. CP-030-3 extends the Spec-012 enumeration, which carries no plan-side reciprocal, and CP-030-5 rides the one-sided `event.ts` union-registration seam. Census moves re-derived from the files: local SQLite 57 → 58 (`sidekick_definitions`), plans 29 → 30, specs 29 → 30, and the Spec-006 event taxonomy 158 → 159 across 20 unchanged categories (one event type minted — `session.peer_invocation_set` under `session_lifecycle`, registered by T4.2 per CP-030-5); Postgres 26 unmoved, no approval category minted; five `sidekick.*` refusal codes registered in [error-contracts.md](../architecture/contracts/error-contracts.md) for the definition and attach paths, with the peer-invocation path minting none.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
