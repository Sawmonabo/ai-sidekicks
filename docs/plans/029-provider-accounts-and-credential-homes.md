# Plan-029: Provider Accounts And Credential Homes

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `029` |
| **Slug** | `provider-accounts-and-credential-homes` |
| **Date** | `2026-08-18` |
| **Author(s)** | `Sawmon Abo` |
| **Spec** | [Spec-029](../specs/029-provider-accounts-and-credential-homes.md) |
| **Required ADRs** | [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | Plan-005 (driver contract, spawn seam, spawn-bound configuration record, authentication probe); Plan-007-remainder (IPC namespace registry); Plan-012 (policy evaluation for per-run selection, credential-policy environment discipline) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

> **Amendment (2026-08-25, first-run provider-authentication surfacing — the readiness derivation and sign-in handoff this plan owes [Plan-026](./026-first-run-onboarding.md)'s provider step; user-ratified, §6 node NS-77).** Flips the previously-`approved` plan to `review` per the audit runbook's plan behavior-change row — it adds **I-029-9** and **I-029-10**, **CP-029-7**, and task **T2.5** — and **restores `approved` in the same diff** through the targeted readiness-audit delta riding it, the in-swap flip-and-restore shape the NS-63 / NS-65..NS-74 cohort established. `Spec-029` flips and restores in the same swap; the §Preconditions boxes below carry the scoped Re-opened / Delivered record. **The growth.** `providerAccount.list` gains a per-provider **readiness projection** derived from the registry — never a second source of truth, served from the account row's **stored** last-probe result so a registry read spawns no provider process, advisory only against the unchanged I-029-3 spawn gate — together with the credential-free-detection and remedy-disclosure rules the first-run surface consumes. **Mints no census-moving surface**: the namespace stays at **seven** verbs, no refusal code is registered, no table is added and no Plan-005 driver contract is widened; two nullable columns are added to the **unshipped** `provider_accounts` CREATE statement — the stored health reading and its observation timestamp, the reading Plan-029 T1.2's own migration test already expected a CHECK for and that the readiness projection reads. No table, no migration ordinal, and **no census move** (SQLite stays at 56).

## Goal

Deliver the node-local provider-account plane: a registry of provider accounts, per-account isolated credential homes wired into the existing constructed-environment discipline, per-run account selection with fail-closed validation at spawn, the account identity and credential generation that three other specs consume by name, and the per-account cost attribution the session cost receipt and the global cost page read.

## Scope

- The `provider_accounts` table and its contracts.
- The account registry service: registration, listing, default selection, removal, and the durable authentication-probe state, keyed per `(driver, account)`.
- Account identity and credential generation as defined derivations, produced here and consumed elsewhere.
- Per-account credential homes: construction, the reserved run-provisioned variables, spawn-time validation, and the fail-closed refusals.
- The named capability probe that decides whether concurrent cross-account execution is available at the pinned binaries, plus the per-provider-account serialization floor that holds until it does.
- Brokering the provider-initiated credential-refresh server request per account.
- The `providerAccount` wire namespace, the Cedar action family for per-run selection, the CLI surface, and the global cost page read.

## Non-Goals

- **No cost fold of its own.** Every cost figure this plan surfaces is supplied by the Plan-016 `BudgetAccountant`'s committed-spend accessor. This plan builds no second accountant and no spend table (`Spec-016 §Cost Figure Display Consistency` clause (a)).
- **No session cost receipt.** The receipt itself is Plan-016's surface; this plan provides the account axis it reads (CP-029-3).
- **No Plan-005 driver-internal authoring.** The account leg of the driver contract lands in Plan-005's own tasks under CP-029-1; this plan does not author files in the provider-driver tree.
- **No control-plane surface.** No Postgres table, no tRPC procedure, no relay payload.
- **No first-run onboarding surface.** The provider step of the first-run flow — its trigger, its walkthrough, and its CLI and desktop surfaces — is authored by [Plan-026](./026-first-run-onboarding.md) Phase 7 under CP-029-7. This plan supplies the registry that step registers into and the readiness derivation it reads (`Spec-029 §Node provider readiness and the sign-in handoff`), and authors no onboarding UI. Landed 2026-08-25; [BL-154](../archive/backlog-archive.md) is `completed`.

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-029 PRs and downstream extensions. Any change that would weaken or remove an invariant requires a coordinated cross-plan amendment (see [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md)).

### I-029-1 — Account identity is opaque, immutable, and never derived from credential material

An account's `accountId` is daemon-minted at registration, opaque to callers, immutable for the account's lifetime, and never reused after removal. It is not derived from a credential, token, email address, subscription identifier, or filesystem path.

**Grounds in.** `Spec-029 §Account identity and credential generation`.

**Why load-bearing.** Every consumer of the account axis keys on this value: the attention-key fold at Plan-017, the quota display at Plan-013, the cost receipt at Plan-016, and this plan's own registry. An identity derived from credential material would fragment an account's history at every token refresh — the same account would appear as several — and would place account material on every payload carrying it, breaching the inherited no-token-custody posture.

**Verification.** Registry unit tests assert identity stability across a simulated re-authentication, a relabel, and a default change; a rejection row asserts that a caller-supplied `accountId` at registration is refused.

### I-029-2 — Credential generation is monotonic per account and never resets

`credentialGeneration` starts at 1 and strictly increases at each credential-home lifecycle transition the daemon performs or observes. It never decreases and never resets, including across a home reset.

**Grounds in.** `Spec-029 §Account identity and credential generation`.

**Why load-bearing.** The attention-key fold at `Spec-017 §Provider-limit pacing and durable resumption (SA-40)` composes on the generation held stable across a refusing dispatch; a reset would let a repaired account's fresh refusals fold into the stale epoch, so the operator's re-authentication would appear not to have worked. Monotonicity is also what lets any consumer order two observations without a clock.

**Verification.** Registry tests assert strict increase across each transition class and assert that a home reset increments rather than restarts; a replay test asserts the value is durable, not recomputed.

### I-029-3 — A provider process is never spawned against an unvalidated account

Before spawn the daemon MUST establish that the account is registered, that its credential home exists, and that the driver's authentication probe reports `authenticated` for that home. Any other outcome refuses the run before any provider process is created.

**Grounds in.** `Spec-029 §Validation at spawn — fail-closed`.

**Why load-bearing.** The three failure modes this forecloses are all silent: falling back to the default account bills the wrong operator account; falling back to ambient configuration makes the paying account unknowable and defeats the receipt; spawning unauthenticated starts work that cannot complete and consumes a queue slot. The refusal is what makes the cost receipt's paying-account column trustworthy.

**Verification.** Spawn-path tests assert refusal with no child process created for each of: unregistered account, absent home, husked home, and `indeterminate` probe. A negative control asserts the authenticated path does spawn.

### I-029-4 — Reserved credential-home variables are daemon-set, never inherited, and never empty

The provider credential-home variables are a closed, per-provider set. The daemon is their sole writer; an inherited or caller-supplied value of a reserved name is discarded at environment construction rather than merged; and the daemon emits an absolute path or omits the variable entirely — never an empty string.

**Grounds in.** `Spec-029 §Credential homes and the constructed environment`.

**Why load-bearing.** The reservation is the only thing that makes account binding trustworthy: a caller able to set the home could redirect a run's credentials to an account it was not authorized to spend from. The empty-string clause closes a distinct and sharper hole — on at least one provider leg an empty value behaves as unset _and_ suppresses the companion variable, silently collapsing a home partition back to the shared credential entry. That failure is both fail-open and silent, so it cannot be caught by observing that the run succeeded.

**Verification.** Environment-construction tests assert reserved names are stripped from a polluted inherited environment before provisioning, assert the daemon-set value survives, and assert that an empty value is never emitted for any account. A rejection row asserts a registration whose home path is empty or relative is refused.

### I-029-5 — Exactly one default account per provider, enforced by the schema

At most one row per provider carries the default flag, enforced by a partial unique index rather than by application code.

**Grounds in.** `Spec-029 §The account registry`.

**Why load-bearing.** Two defaults make run admission non-deterministic in the exact place where determinism decides who pays. Enforcing it in application code leaves the invariant true only while every write path remembers it; enforcing it in the index makes the violating state unrepresentable.

**Verification.** Migration test inserts a second default for one provider and asserts the constraint rejects it; a same-provider default handover test asserts the transactional clear-then-set path succeeds.

### I-029-6 — The daemon brokers credential refresh and stores nothing

Answering a provider's credential-refresh server request resolves the requesting binding's account and lets the provider's own mechanism write into that account's home. The daemon does not read the material into its persistence, does not log it, does not place it on any event or error payload, and does not serve it to any client.

**Grounds in.** `Spec-029 §Credential-refresh brokering`, which inherits the posture of `Spec-028 §Non-Goals`.

**Why load-bearing.** This is the one code path where credential material transits daemon-adjacent machinery, so it is the one place the no-token-custody posture could be lost by accident rather than by decision. A refresh answered against the wrong home also writes one account's credential into another's — the precise corruption per-account isolation exists to prevent.

**Verification.** Brokering tests assert no credential-shaped value reaches storage, logs, events, or errors; assert the refusal path for an unregistered account and for a missing home; and assert the generation bump on a completed refresh.

### I-029-7 — Cross-account concurrency is a probed fact, never an assumption

The daemon enables concurrent execution across two accounts of one provider only where the capability probe has established it against the pinned binaries. Absent a positive probe, runs bound to accounts of the same provider serialize.

**Grounds in.** `Spec-029 §Concurrency Posture`.

**Why load-bearing.** The design's mechanism (one process per run, isolated homes) makes concurrency plausible, and plausible is exactly the state in which teams ship it. The failure it risks is credential corruption on the operator's real paid account, which is unrecoverable without a browser re-login. The probe converts a hope into a capability the daemon can read.

**Verification.** The probe task is its own verification; the serialization floor is asserted by a scheduler test that admits two runs on two accounts of one provider with the probe unresolved and observes serial execution, and by a negative control with the probe positive observing concurrency.

### I-029-8 — Sharing a credential home is never a fallback

No execution path, degradation, recovery, or error handler causes two accounts to resolve to the same credential home.

**Grounds in.** `Spec-029 §Fallback Behavior`.

**Why load-bearing.** Every other degradation in this plan is safe — serializing is slow, refusing is visible. Sharing a home is the one degradation that silently destroys operator credentials, and it is the state the whole isolation design exists to make unreachable. Stating it as an invariant makes it reviewable rather than merely intended.

**Verification.** A registry constraint asserts home-path uniqueness across accounts; a spawn test asserts that the serialization floor and every refusal path leave home assignment unchanged rather than coalescing.

### I-029-9 — Provider readiness is derived, stored-read, and advisory

Readiness is computed per provider by the same resolution the spawn path performs — resolve the default account, then report that account's **stored** last observed authentication probe result verbatim, with two registry-shape arms where resolution reaches no account. Deriving it MUST NOT spawn a provider process, MUST NOT open, parse, copy, or transmit credential material, MUST NOT compute a keychain entry name, and MUST NOT run a provider sign-in command. It authorizes nothing: I-029-3 re-validates unconditionally at spawn and refuses on its own reading.

**Grounds in.** `Spec-029 §Node provider readiness and the sign-in handoff`.

**Why load-bearing.** A readiness surface is worth having only if it cannot disagree with admission. Re-deriving the predicate anywhere else guarantees that it eventually does, and the copy the operator is looking at is the one enforcing nothing; probing on every read turns a pollable surface into a provider-process fork bomb; and letting readiness authorize a spawn would convert a cached observation into a grant.

**Verification.** A registry read against a two-account node asserts zero child processes spawned and zero credential-file opens, with the reply's observation timestamp equal to the stored row's. A negative control mutates the stored probe result and asserts the readiness arm follows it without a new probe. A spawn bound to an account whose stored reading is authenticated but whose home has since been emptied asserts refusal.

### I-029-10 — No surface claims authentication it has not observed, and remedies disclose in messages only

No surface reports a provider as authenticated on any reading other than the authenticated arm — `indeterminate` included, which renders as undetermined rather than as a sign-in failure — and no authenticated claim is manufactured from a plan label, a subscription echo, a declared billing mode, or the existence of a home directory. Guidance naming a credential home or a provider sign-in invocation is **operator-facing only**, and the rule binds the **reader rather than the encoding**: it reaches an operator through message text or through the readiness reply's `remedy` member on the node-local, node-operator-authorized `providerAccount.list` — and never an event payload, a relayed payload, a refusal envelope, or a log line. That the remedy travels structured does not relax the rule; it is why the rule has to be stated about the audience. Provider sign-in process output is never placed in an error payload, an event, or a log.

**Grounds in.** `Spec-029 §Node provider readiness and the sign-in handoff`.

**Why load-bearing.** Both halves close a disclosure or honesty leak that is invisible until it matters. A false authenticated claim sends the operator away satisfied while every run refuses; a credential-home path on an evented or relayed payload puts a node-local filesystem location — recorded as an account-plane PII residual in [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map) — into a durable, replicated record it was never scoped for; and provider sign-in output may carry OAuth state, PKCE values, or credential fields.

**Verification.** A table-driven assertion over all six readiness arms that only the authenticated arm renders as authenticated, and that the `remedy` member is present on each non-authenticated arm and absent on the authenticated one. An event-payload and log-scrape test asserting no credential-home path appears on any emitted event, relayed payload, or log line for a node with a husked home — the readiness reply excluded by construction, since it is the one operator-facing surface the rule permits. A refusal test asserting the error payload carries neither captured provider output nor the remedy.

## Cross-Plan Obligations

Plan-029 declares the following obligations on adjacent plans (or inherits obligations declared by them). Implementation cannot proceed (or must defer specific surfaces) without these being satisfied or explicitly staged.

### CP-029-1 — Plan-005 threads account identity through the driver contract and spawn path

Plan-005 owns the provider-driver tree and the spawn-bound configuration record. It carries the account leg: the optional account data leg on the session-create and resume parameter surfaces, its persistence through the binding's spawn-bound configuration record so a resume re-realizes the same account, the per-`(driver, account)` scoping of the cached authentication state and its refresh cadence, and the reserved credential-home variables in the constructed child environment.

**Resolution.** Plan-005 Phase 3B (`Plan-005 §Phase 3B — Provider-account seam + typed usage-limit signal`), authored in the same amendment that registers this obligation. Plan-029 authors no file under the provider-driver tree; it supplies the registry read the Plan-005 tasks consume.

### CP-029-2 — Plan-005 mints the typed provider-limit signal that this plan's account plane keys on

The typed provider usage-limit signal is a Plan-005-owned driver-contract surface (a sibling axis beside the recovery-condition set, never a widening of it). Plan-029 consumes it: the signal's account scoping keys on this plan's `accountId` and `credentialGeneration`.

**Resolution.** Plan-005 Phase 3B, task T3.18, in the same amendment. Plan-029's consumption is read-only and adds no member to the signal.

### CP-029-3 — Plan-016 consumes the account axis on the session cost receipt

Plan-016 owns the committed-spend fold and the session cost receipt. This plan provides the paying account for each run (the admission stamp) and the account's billing mode (the registry read); Plan-016 renders them as receipt columns and enforces the billing-mode labeling rule.

**Resolution.** Plan-016 Phase 4B (`Plan-016 §Phase 4B — Session cost receipt`), authored in the same amendment. Plan-029 supplies data and asserts no display behavior of its own beyond the labeling rule stated in `Spec-029 §Billing mode`.

### CP-029-4 — Plan-029 joins the CP-016-16 committed-spend-fold consumer set

`Plan-016 §Cross-Plan Obligations` CP-016-16 obliges any plan that grows a cost-displaying surface to source every figure from the accountant's committed-spend accessor and to return-cite the obligation at its own audit. This plan's global cost page is such a surface.

**Resolution.** Discharged at this plan's authoring audit: the global cost page read (T4.2) is a projection over the accountant's accessor with no independent fold, and the `Spec-016 §Cost Figure Display Consistency` clause (b) declaration is carried per figure. The reciprocal registration is recorded on the `cross-plan-dependencies.md` §3 edge, which CP-016-16 anticipated for exactly this case.

### CP-029-5 — Plan-013 renders the account-scoped provider quota

`Spec-013 §Rate-Limit Display` is amended by this bundle to the account-scoped, event-sourced form. The producer side — account identity and credential generation on the account-scoped quota event — is registered here; the renderer is Plan-013's.

**Resolution.** Plan-013's own rate-limit carrier precondition box names the lead-owned amendment that registers the producer side; this bundle is that amendment. The box check and the renderer task are Plan-013-owned work and are deliberately not authored here.

### CP-029-6 — Plan-028's config-home observation is account-relative

Plan-028 observes provider configuration files inside a provider home and derives a per-binding governance digest from them. Once a binding's home is account-selected, the configuration Plan-028 observes is account-relative: two accounts of one provider may present different MCP inventories, and a governance digest is meaningful only within its account's home.

**Resolution.** Not a code dependency in either direction — the two plans share a substrate rather than an interface, and this plan writes nothing into a provider config file (`Spec-029 §Non-Goals`, inheriting `Spec-028 §Non-Goals`). Registered so the interaction is visible; Plan-028 return-cites at its next audit, per the open-consumer-set convention.

### CP-029-7 — Plan-026's first-run provider step consumes this plan's registry and readiness

**Obligation.** [Plan-026](./026-first-run-onboarding.md) Phase 7 authors the first-run provider-authentication step group. It registers accounts through this plan's `providerAccount.*` namespace rather than minting a second registry, reads this plan's per-provider readiness projection rather than re-deriving readiness from account fields, and renders the remedy this plan discloses rather than composing its own. `Plan-026 §Cross-Plan Obligations` CP-026-6 carries the reciprocal.

**Resolution.** Live and reciprocal, producer on this side. This plan owns the derivation (T2.5, I-029-9, I-029-10) and adds no onboarding surface; Plan-026 owns the trigger, the walkthrough, and the CLI and desktop surfaces, and adds no registry and no second store — its step persists nothing, so the registry stays the single source of provider truth. The dependency is carried mechanically rather than by a human tick: Plan-026's Phase 7 block declares `external_plan_phase_merged` on this plan's Phase 2, so the step cannot dispatch before the surface it consumes ships. **Direction:** produce for Plan-026.

## Preconditions

- [x] Paired spec is approved — Spec-029 authored and promoted `approved` in this same bundle, its spec-status promotion gate cleared by the in-swap targeted readiness audit recorded below. **Re-opened 2026-08-25, scoped to the first-run provider-authentication amendment:** Spec-029 gained normative §Required Behavior, §Fallback Behavior, §Interfaces And Contracts, and §Acceptance Criteria text (the readiness derivation, the sign-in handoff, and the vendor authentication-policy constraints), so the spec flipped `approved → review` per the audit runbook's spec-amendment rule and this plan flips with it under the runbook's plan behavior-change row. **Delivered 2026-08-25** by the targeted readiness-audit delta riding the same diff (§6 node NS-77), which audits the amendment, re-checks this box, and restores both to `approved`.
- [x] Required ADRs are accepted (verified: ADR-006 `accepted`, ADR-012 `accepted`, ADR-017 `accepted`, ADR-018 `accepted`)
- [x] Blocking open questions are resolved — **the first-run provider-authentication surfacing gap is no longer deferred**. It was the one named gate this box carried ([BL-154](../archive/backlog-archive.md)); the 2026-08-25 amendment settles it on this side (`Spec-029 §Node provider readiness and the sign-in handoff`, I-029-9, I-029-10, T2.5, CP-029-7) and on the onboarding side (`Spec-026 §Provider Authentication (Group B)`, Plan-026 Phase 7), BL-154 is `completed` and archived, and `Spec-029 §Open Questions` records the closure. No open question remains on this plan.
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — **Re-opened 2026-08-25, scoped to the first-run provider-authentication amendment's growth** (I-029-9, I-029-10, CP-029-7, T2.5) and **Delivered 2026-08-25** by the targeted readiness-audit delta riding the same diff (§6 node NS-77), which re-checks this box and restores `approved`. Original record: first-time targeted readiness audit taken **in this same bundle** against the plan as authored (the in-swap delta shape established by the 2026-08-17 amendment cohort). Gate walk recorded in the dated §Notes entry below. The audit certifies the four-phase `#### Tasks` decomposition across Phases 1–4 and the 4B supplement, I-029-1..8, CP-029-1..6, and the Spec-029 acceptance-criteria coverage mapping; it does **not** certify the carrier-held supplement phase below, whose producer is external and unlanded.
- [ ] **Turn-scoped effective principal carrier registered.** Per-turn billing attribution (`Spec-016 §Session Cost Receipt` — the run starter is billed by default, the intervener for turns they steered or edited) requires the turn-scoped effective principal and its admitting-principal stamp, registered by CP-004-14 and the [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) §Authenticated Principal class rule. Until that registration lands, this plan's attribution leg has no principal to key on and would have to infer the billed party from run ownership alone — which is wrong exactly in the steered-turn case the requirement exists for. **Holds Phase 4B in whole** — the attribution leg is homed in its own supplement phase, and this box carries that phase's Gate-5 `precondition_box_checked` entry, so the hold it records and the hold the gate enforces are the same set. Phase 4's own tasks are unaffected.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/provider-account.ts` (NEW — the registry contract surface, brands, and Zod schemas)
- `packages/runtime-daemon/src/migrations/` (new guarded-block migration — `provider_accounts`) + `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND — the paired registration edit, same commit)
- `packages/runtime-daemon/src/accounts/` (NEW directory): `provider-account-registry.ts`, `provider-credential-home-service.ts`, `provider-account-resolver.ts`, `provider-account-serializer.ts`, `errors.ts`
- `packages/runtime-daemon/src/ipc/handlers/` (EXTEND — the `providerAccount.*` namespace binder, registered under Plan-007's registry)
- `packages/runtime-daemon/src/policy/` (EXTEND — the additive `providerAccount` Cedar action-family policy module, the Plan-028 `mcp` action-family precedent)
- `packages/client-sdk/src/providerAccountClient.ts` (NEW)
- `apps/cli/src/commands/` (CREATE — Plan-029-authored content inside Plan-007's `apps/cli` scaffold, the per-file ownership crossing pinned in [cross-plan §2](../architecture/cross-plan-dependencies.md)) + `apps/cli/src/main.ts` (EXTEND — registration calls)
- `apps/desktop/src/renderer/src/provider-accounts/` (NEW renderer subtree — the settings registry, the run-start selector, and the global cost page)

## Data And Storage Changes

- One new node-local table, `provider_accounts`, per [Local SQLite Schema §Provider Account Tables (Plan-029)](../architecture/schemas/local-sqlite-schema.md#provider-account-tables-plan-029) — the local SQLite census moves 55 → 56.
- **Row-canonical daemon configuration, not evented** — the `session_budgets` posture. The registry is node-local operator configuration mutated by wire method; it is not a session fact, carries no session scope, and takes no part in session replay. This is why it needs no event type and appears in no session timeline.
- **No control-plane table.** The Postgres census is unchanged at 26. The shared schema's permitted row classes do not admit provider-account rows, and this plan does not widen that enumeration.
- **No spend table.** Cost accounting stays the in-memory, replay-rebuilt fold at Plan-016 (D-016-5); the account axis rides the existing `run.queued` admission stamp and this registry, so no parallel ledger exists to drift.
- The operator label is potentially personal data and is mapped at [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map). The credential-home path is a filesystem location; no credential material is stored in this table.

## API And Transport Changes

- A node-local `providerAccount.*` JSON-RPC namespace of seven verbs: registry list and read, register, correct (the operator-authored display label and billing mode, the only two mutable descriptive fields), remove, set-default, credential-home reset, and per-account authentication probe. Registered under Plan-007's namespace registry at this plan's tier, the `driver.*` / `mcp.*` precedent. Shapes in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md).
- Run creation gains an optional account-override input; run admission stamps the resolved account on the `run.queued` payload as a path-independent server stamp (`admittedProviderAccountId`, never client-suppliable — the `admittedModelFamily` precedent).
- The account-scoped quota event gains account identity and credential generation ([Spec-006 §Usage Telemetry](../specs/006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry)). Both payload growths are additive-optional under ADR-018.
- The registry list reply gains a per-provider **readiness projection** — exactly one entry per provider the request selects, carrying the derived state, the timestamp of the stored observation it was derived from, and the per-arm remedy. It is **required, not additive-optional**: ADR-018's additive-optional rule binds shapes that have already shipped, and `ProviderAccountListResponse` is registered by this same plan and has not, so the growth is pre-shipment and the member is required exactly as the contract registers it. A reply permitted to omit readiness would push every client back into deriving it locally, which is what I-029-9 exists to forbid. **The namespace count is unmoved at seven verbs**, and readiness mints no refusal code because every arm mirrors a refusal already registered.
- Refusal codes for the fail-closed paths in [Error Contracts](../architecture/contracts/error-contracts.md).

## Implementation Steps

1. Contracts, migration, and the contract-to-DDL conformance suite.
2. The registry service, the credential-home service, the Cedar action family, and the wire namespace.
3. Credential homes at spawn: reserved variables, fail-closed validation, refresh brokering, the capability probe, and the serialization floor.
4. Cost attribution and the operator-facing surfaces: the account axis for the receipt, the global cost page, the CLI, and the renderer.

## Parallelization Notes

- Phase 1's three tasks are sequential (contracts → migration → conformance).
- Within Phase 2, the registry service and the Cedar action family are independent; the wire namespace depends on both.
- Phase 3's capability probe (T3.3) is independent of the rest of Phase 3 and can run as soon as the credential-home service exists — it is a measurement against the pinned binaries, not a feature.
- Phase 4's tasks are independent of one another; T4.1 is additionally carrier-held.

## Test And Verification Plan

- **Unit:** registry CRUD and constraint rejection rows; identity stability and generation monotonicity; default-handover transaction; home-path validation (absolute, daemon-owned, outside any worktree, unique); environment construction under a polluted inherited environment.
- **Integration:** spawn refusal for each of the four unvalidated-account classes with no child process created; resume re-realizing the same account from the durable record and refusing when it cannot; refresh brokering against the correct home with no material reaching storage, logs, events, or errors; serialization of two same-provider accounts with the probe unresolved.
- **Readiness.** All six readiness arms table-driven from fixture registry states; a registry read asserting no provider process is spawned and no credential file is opened; the stored-observation timestamp round-tripped rather than regenerated; and a spawn refusal for an account whose stored reading is authenticated but whose home has since been emptied — the honest-limit case that proves readiness is advisory and I-029-3 is the authority.
- **Manual:** two real accounts on one provider registered on a developer machine, a run bound to each, and the cost receipt inspected for correct paying-account and billing-mode attribution.
- **Adversarial-Tampering Boundary.** The verification suite exercises: a caller-supplied `accountId` at registration (rejected); a caller-supplied `admittedProviderAccountId` on run creation (ignored, server-stamped); reserved credential-home variables supplied by the caller, by the inherited environment, and by an execution posture (all discarded); an empty-string reserved variable (never emitted, and treated as a defect when observed); a home path pointing inside a repo working tree (rejected); a home path equal to another account's (rejected by uniqueness); and a refresh request arriving on a binding whose account was removed mid-run (refused, not redirected).
- **CI-Pinned Tool Versions.** Verification commands name CI-pinned tool versions explicitly per [ADR-023 §Axis 4](../decisions/023-v1-ci-cd-and-release-automation.md), so local-version drift surfaces at plan-authoring time rather than at PR push. The capability probe (T3.3) additionally pins the provider CLI versions it measures against and records them with its result, since a probe result is meaningless without the binary version it was taken at.

## Implementation Phase Sequence

Plan-029 implementation lands as a sequence of small PRs. Each PR exercises one slice of the plan's vertical and carries a `**Precondition:**` line so the merge order is reviewer-checkable.

### Phase 1 — Contracts and migration

**Precondition:** Plan-005 Phase 2 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: external_plan_phase_merged, plan: 5, phase: 2 }
```

**Goal:** the registry's contract surface and durable table exist, with a mechanical conformance suite pinning them to one another.

#### Tasks

- **T1.1 — Provider-account contracts.**
  - **Files:** `packages/contracts/src/provider-account.ts` (NEW).
  - **Provides:** the `ProviderAccountId` brand; `ProviderName` (the two-member closed set); `BillingMode` (`subscription` \| `metered` \| `unknown`); `CredentialGeneration` (a positive integer); the `ProviderAccount` record shape; and the request/response pairs for register, remove, set-default, list, read, home-reset, and probe. Strict Zod schemas with unknown-key rejection. `accountId` and `credentialGeneration` are **response-only** projections — a register request carrying either does not parse, so a caller cannot assert an identity or a generation.
  - **Consumes:** branded-id factory (Plan-001, shipped).
  - **Spec coverage:** Spec-029 §Interfaces And Contracts; Spec-029 §The account registry.
  - **Verifies invariant:** I-029-1.
  - **Tests:** schema acceptance/rejection rows per pair; unknown-key rejection; caller-supplied `accountId` and `credentialGeneration` rejected on the register request; `BillingMode` discriminates all three members; home path required absolute and non-empty.
- **T1.2 — Migration: `provider_accounts`.**
  - **Files:** `packages/runtime-daemon/src/migrations/0NNN-provider-accounts.ts` (CREATE — NNN = next free version per migration-runner append order at PR-open time), `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND — version-N guarded block with an in-transaction re-check, per the runner's documented extension contract, in the **same commit** as the migration file; an orphan file leaves the table absent at `no such table`).
  - **Provides:** the table byte-matching [local-sqlite-schema.md §Provider Account Tables (Plan-029)](../architecture/schemas/local-sqlite-schema.md#provider-account-tables-plan-029), including the partial unique index that makes a second default per provider unrepresentable and the uniqueness constraint on the credential-home path.
  - **Consumes:** Plan-001 migration-runner seam (shipped).
  - **Spec coverage:** Spec-029 §State And Data Implications.
  - **Verifies invariant:** I-029-5, I-029-8.
  - **Tests:** migration up + idempotence; second-default insert for one provider rejected; duplicate home-path insert rejected; CHECK rejection rows for provider, billing mode, the stored health state, and a non-positive generation; the health-state / observation-timestamp pair proven nullable and proven to round-trip; index presence.
- **T1.3 — Contract ↔ DDL conformance suite.**
  - **Files:** `packages/runtime-daemon/src/accounts/__tests__/provider-account-schema-conformance.test.ts` (NEW).
  - **Provides:** mechanical lockstep checks — the contract's provider, billing-mode, and probe-result enums against the DDL CHECK lists; the record shape against the column set; the generation floor against the CHECK.
  - **Consumes:** T1.1, T1.2.
  - **Spec coverage:** Spec-029 §State And Data Implications.
  - **Verifies invariant:** I-029-2.
  - **Tests:** the suite is the test — one row per pinned pair (documented-pin ≠ enforced-pin discipline).

### Phase 2 — Registry service and authorization

**Precondition:** Phase 1 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 29, phase: 1, status: merged }
  - { type: external_plan_phase_merged, plan: 12, phase: 2 }
```

**Goal:** accounts can be registered, listed, defaulted, and removed through an authorized wire surface, with identity and generation behaving as specified.

#### Tasks

- **T2.1 — Provider-account registry service.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-account-registry.ts` (NEW), `errors.ts` (NEW).
  - **Provides:** registration minting an opaque immutable identity at generation 1; listing and reading; the transactional default handover (clear-then-set inside one transaction so no window has two defaults or none); removal refusing while a run bound to the account is live and never touching the credential home; and the generation bump applied at each lifecycle transition — including the authenticated-boundary crossing, applied **atomically with** the stored-observation write by whichever validation observed it. The stored pair (`health_state` + `health_observed_at`) is written by exactly two callers, the probe verb and spawn validation, and is written as a pair or not at all. Home-path validation at registration: absolute, daemon-owned, outside any repo working tree, and unique across accounts.
  - **Consumes:** T1.1 contracts; T1.2 table.
  - **Spec coverage:** Spec-029 §The account registry; Spec-029 §Account identity and credential generation.
  - **Verifies invariant:** I-029-1, I-029-2, I-029-5, I-029-8.
  - **Tests:** identity stable across re-authentication, relabel, and default change; generation strictly increasing per transition class and never reset by a home reset; **the authenticated-boundary rule in both directions and its negative control** — an observation crossing into `authenticated` bumps, one crossing out bumps, and one that re-observes the same authenticated-ness does not — with the bump and the health write proven to land in one transaction (a failed write leaves neither applied); default handover atomic under concurrent callers; removal refused with a live bound run; removal leaves the home directory present; home-path rejection rows (relative, empty, inside a worktree, duplicate).
- **T2.2 — Credential-home service.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-credential-home-service.ts` (NEW).
  - **Provides:** home creation with restrictive permissions, existence and health checks distinguishing _absent_ from _present-but-husked_, the home-reset operation, and the per-provider reserved-variable set as a **named closed set** resolved from the pinned provider reference at build time rather than hard-coded in prose. Emits an absolute path or omits the variable; never an empty string.
  - **Consumes:** T2.1.
  - **Spec coverage:** Spec-029 §Credential homes and the constructed environment.
  - **Verifies invariant:** I-029-4, I-029-8.
  - **Tests:** absent-versus-husked classification rows; permission assertions on a created home; reset increments the generation; the reserved set is closed and per-provider; no code path yields an empty reserved value.
- **T2.3 — `providerAccount` Cedar action family.**
  - **Files:** `packages/runtime-daemon/src/policy/provider-account-actions.ts` (NEW — additive action-family policy module, the Plan-028 `mcp` family precedent).
  - **Provides:** the single named action authorizing a **per-run account override**, evaluated against the same effective principal that authorizes the run. Registry mutation is deliberately **not** in this family: it is node-operator authority outside the session-role matrix, so it mints no Cedar action and the wire handlers gate it on node-local operator authority instead.
  - **Consumes:** Plan-012 policy-evaluation surface.
  - **Spec coverage:** Spec-029 §Authorization Posture.
  - **Verifies invariant:** none — the task adds a policy module and asserts no plan invariant of its own, the authorization split it implements being stated by the spec clause above.
  - **Tests:** override authorized for a permitted principal and denied for a non-permitted one; taking the default account performs **no** authorization call (a default is not a selection); a control-plane-relayed registry mutation is denied rather than queued.
- **T2.4 — `providerAccount.*` wire namespace.**
  - **Files:** `packages/runtime-daemon/src/ipc/handlers/provider-account-handlers.ts` (NEW — registered under Plan-007's namespace registry), `packages/client-sdk/src/providerAccountClient.ts` (NEW).
  - **Provides:** the handler binders for the T1.1 pairs, the node-local operator-authority gate on **every verb in the namespace — the `list` read included, not only the mutating six** — and the SDK client marshalling wire values without deriving any of them. The read takes the same gate because its reply discloses a daemon-owned credential-home path in the readiness remedy (`Spec-029 §Authorization Posture`); gating it like an ordinary read would leave that path readable by any local caller that can reach the daemon socket.
  - **Consumes:** T2.1, T2.2, T2.3; Plan-007 namespace registry.
  - **Spec coverage:** Spec-029 §Interfaces And Contracts.
  - **Verifies invariant:** I-029-1.
  - **Tests:** per-method request validation; the operator-authority gate asserted on **each of the seven verbs**, enumerated so a later verb cannot be added ungated — the `list` row asserting a non-operator local caller is refused and receives no readiness entry and no remedy, the failure this gate exists to prevent; SDK round-trip asserting no client-side derivation; a relayed mutation denied; and a relayed `list` denied likewise.

- **T2.5 — Per-provider readiness projection and remedy disclosure.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-account-resolver.ts` (**NEW — created here, not in Phase 3**), `packages/runtime-daemon/src/accounts/provider-readiness.ts` (NEW), `packages/runtime-daemon/src/ipc/handlers/provider-account-handlers.ts` (EXTEND — the `list` binder's reply), `packages/client-sdk/src/providerAccountClient.ts` (EXTEND — marshalling only).
  - **Phase placement, stated because it moved:** the shared default-account resolution primitive is authored **here**, in the phase that first consumes it, and T3.1 extends the same file rather than creating it. I-029-9's guarantee is that readiness and admission run the _same_ resolution; if the resolver were born in Phase 3 while readiness shipped in Phase 2, Phase 2 would have had to duplicate it, and the two copies would satisfy the invariant only until the first divergent edit. The primitive this task lands is deliberately narrow — resolve a provider to exactly one account or to a named no-account / no-default outcome — and the admission-side obligations (the server stamp, the refusal envelopes, the spawn triple) stay T3.1's and T3.2's.
  - **Provides:** the single daemon-side readiness derivation — resolve the provider's default account **or, when the request pins one, that named account**, report the resolved account's **stored** last-probe result verbatim, and stand in the two registry-shape arms where resolution reaches no account (unreachable on the pinned path, where an account was named: an unknown or removed id refuses with the already-registered `provideraccount.unknown` rather than falling back to the default, since the fallback would hand a post-refusal caller a remedy for an account that did not fail) — plus the per-provider remedy (which account, the provider's own first-party sign-in invocation, and that account's credential home), composed at read time from the resolved row and carried on the readiness entry's schema-optional `remedy` member. The producer obligation is the task's: populate it on every non-authenticated arm, omit it on `authenticated`, and store it nowhere. The derivation shares the resolver T3.2 validates with, so admission and readiness cannot drift apart. No probe is taken here and no credential file is opened; refreshing stays `providerAccount.probe`.
  - **Consumes:** T2.1 (registry rows and the stored observation pair), T2.4 (the `list` binder). **Provides to Phase 3:** the resolver T3.1 extends and T3.2 validates through.
  - **Spec coverage:** Spec-029 §Node provider readiness and the sign-in handoff, Spec-029 §Vendor authentication-policy constraints, Spec-029 §Interfaces And Contracts
  - **Verifies invariant:** I-029-9, I-029-10
  - **Tests:** all six arms table-driven from fixture registry states, asserting one entry per selected provider and never zero or two; the same table asserting the `remedy` member present on all five non-authenticated arms and absent on `authenticated` (the producer obligation, per arm, not spot-checked), that each arm carries the **right union member** — `register` for `no_account`, `choose_default` (listing every candidate and electing none) for `no_default`, `sign_in` for all three of `reauth_required` / `home_missing` / `indeterminate`, so the many-to-one mapping is pinned rather than assumed — and that the `sign_in` arm's values are composed from the resolved row rather than read from any column; a two-account read asserting zero child processes and zero credential-file opens with the observation timestamp equal to the stored row's; a mutated stored probe result moving the arm with no new probe; the pinned-account path deriving against the named account and **not** the provider default on a node where the two differ and only one is authenticated — the wrong-account-remedy regression, asserted directly — with an unknown pinned id refusing rather than falling back, and `observedAt` absent on both registry-shape arms even when candidate accounts carry stored observations (the `no_default` case, where summarizing a candidate's timestamp would report an observation of an account the reply did not resolve); an assertion that no readiness or remedy value reaches an event payload, a relayed payload, a refusal envelope, or a log line; and a negative control asserting the authenticated arm alone renders as authenticated.

### Phase 3 — Credential homes and spawn binding

**Precondition:** Phase 2 merged; Plan-005 Phase 3B merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 29, phase: 2, status: merged }
  - { type: external_plan_phase_merged, plan: 5, phase: 3B }
```

**Goal:** a run binds an account, validates it fail-closed, spawns into the account's isolated home, and either runs concurrently with another account's run or serializes — on the strength of a probe, not an assumption.

#### Tasks

- **T3.1 — Account resolution and admission stamping.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-account-resolver.ts` (NEW).
  - **Provides:** resolution of exactly one account before spawn (override else provider default), the `admittedProviderAccountId` server stamp on the run's admission record (never client-suppliable), and the refusals for no-account-registered and no-default-with-no-override.
  - **Consumes:** T2.1; the Plan-005 spawn seam via CP-029-1.
  - **Spec coverage:** Spec-029 §Selection at run start; Spec-029 §Fallback Behavior.
  - **Verifies invariant:** I-029-3.
  - **Tests:** default binding with no override; override binding after authorization; refusal rows for no accounts and for no-default-no-override; a client-supplied stamp on the create request is ignored and the server value used; the stamp is present on every admitted provider run regardless of creation path.
- **T3.2 — Fail-closed spawn validation.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-account-resolver.ts` (EXTEND).
  - **Provides:** the pre-spawn validation triple — registered, home present and healthy, probe `authenticated` — **with the observation written back**: every spawn validation records what it observed into the account's `health_state` / `health_observed_at` pair and applies the authenticated-boundary generation rule in the same transaction, exactly as the probe verb does, because the stored value is the last _validation_ and not the last _explicit probe_ (a node whose first run succeeded must not keep serving `indeterminate`). The write is not conditional on the outcome: a refusing validation records the reading that made it refuse. With a typed refusal for each failing class and no provider process created — the codes are registered at [error-contracts.md §Provider Account](../architecture/contracts/error-contracts.md#provider-account) (`provideraccount.unknown`, `provideraccount.credential_home_unavailable`, `provideraccount.not_authenticated`), alongside the resolution refusals T3.1 raises (`provideraccount.not_registered`, `provideraccount.no_default`). Consumes the driver authentication probe **without** adding a capability flag: the probe is required of every driver and stays uncapability-gated.
  - **Consumes:** T2.2; the Plan-005 authentication probe.
  - **Spec coverage:** Spec-029 §Validation at spawn — fail-closed.
  - **Verifies invariant:** I-029-3.
  - **Tests:** four refusal rows (unregistered, absent home, husked home, `indeterminate` probe) each asserting zero child processes; a positive control asserting the authenticated path spawns; a resume against a since-husked home refuses rather than rebinding to the default; and the writeback leg — a successful validation on a row stored `indeterminate` leaves it `authenticated` with a fresh timestamp and a bumped generation, a refusing validation records the reading that refused, and a validation observing no boundary crossing leaves the generation alone (the same three-row discrimination T2.1 pins, asserted here at the second writer so the rule cannot hold at one call site and lapse at the other).
- **T3.3 — Cross-account concurrency capability probe.**
  - **Files:** `packages/runtime-daemon/src/accounts/__tests__/cross-account-concurrency-probe.test.ts` (NEW).
  - **Provides:** the named verification obligation `Spec-029 §Concurrency Posture` defers to. Against the **pinned provider binaries, with versions recorded alongside the result**, the probe establishes whether two accounts of one provider execute concurrently with isolated homes without credential-file corruption, cross-account keychain collision, or provider-side single-flight refusal. It observes isolation empirically — asserting that each home's authentication state survives the other's activity — and **never computes or predicts a keychain entry name**. The outcome is recorded on the driver's declared capability surface so the scheduler reads a probed fact.
  - **Consumes:** T2.2; the Plan-005 driver capability surface.
  - **Spec coverage:** Spec-029 §Concurrency Posture.
  - **Verifies invariant:** I-029-7.
  - **Tests:** the probe is the test. It must be able to **fail**: a seeded negative control runs the same assertions with both accounts pointed at one home and requires the corruption or collision to be detected, so a clean result proves the probe discriminates rather than proving it is inert.
- **T3.4 — Credential-refresh brokering and provider-limit account scoping.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-credential-home-service.ts` (EXTEND).
  - **Provides:** the answer to the provider-initiated credential-refresh server request, resolved to the requesting binding's account, brokered without storage, with the generation bump on completion and refusals for an unregistered account or a missing home. Second arm: the account scoping of the typed provider-limit signal, keyed on `(accountId, credentialGeneration)`. That arm's producer dependency is carried mechanically by this phase's `external_plan_phase_merged` entry on Plan-005 Phase 3B rather than by a human-ticked carrier box — the entry resolves against Plan-005's own shipment manifest, so the signal cannot be consumed before it ships.
  - **Consumes:** T2.1, T2.2; the Plan-005 provider-limit signal via CP-029-2.
  - **Spec coverage:** Spec-029 §Credential-refresh brokering; Spec-029 §Provider quota is account-scoped.
  - **Verifies invariant:** I-029-6, I-029-2.
  - **Tests:** brokering asserts no credential-shaped value reaches storage, logs, events, or errors (an allow-list assertion over each sink, not a spot check); refusal rows for removed account and missing home; generation bump on completion; the signal carries the correct account on a two-account node.
- **T3.5 — Per-provider-account serialization floor.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-account-serializer.ts` (NEW).
  - **Provides:** the degrade-honestly floor — with the T3.3 probe unresolved or negative, runs bound to accounts of the same provider serialize, visibly in run state rather than as unexplained latency; with the probe positive, they proceed concurrently. Never coalesces two accounts onto one home under any path.
  - **Consumes:** T3.3's recorded capability; T3.1.
  - **Spec coverage:** Spec-029 §Concurrency Posture; Spec-029 §Fallback Behavior.
  - **Verifies invariant:** I-029-7, I-029-8.
  - **Tests:** two same-provider accounts serialize with the probe unresolved; proceed concurrently with it positive; different providers never serialize against each other; a queued run's waiting state is observable; no path assigns two accounts the same home.

### Phase 4 — Cost attribution and operator surfaces

**Precondition:** Phase 3 merged.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 29, phase: 3, status: merged }
```

**Goal:** the operator can see which account paid for what, labeled by billing mode, across one session and across all of them.

#### Tasks

- **T4.2 — Global cost page read.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-account-registry.ts` (EXTEND), `packages/client-sdk/src/providerAccountClient.ts` (EXTEND).
  - **Provides:** the per-user, all-sessions cost read broken down per account, each figure **supplied by** the Plan-016 committed-spend accessor rather than recomputed here (CP-029-4), each carrying its account's billing mode, and each declaring its aggregation scope per `Spec-016 §Cost Figure Display Consistency` clause (b). A total spanning both billing modes states that it does.
  - **Consumes:** T2.1; the Plan-016 committed-spend accessor.
  - **Spec coverage:** Spec-029 §Billing mode; Spec-016 §Cost Figure Display Consistency.
  - **Verifies invariant:** none — the single-fold rule is Plan-016's I-016-24, return-cited here per CP-029-4 rather than restated as a Plan-029 invariant.
  - **Tests:** figures equal the accountant's accessor value at the same fold state (no independent derivation); billing mode present on every account-attributable figure; a mixed-mode total carries the mixed-mode statement; a subscription-only view never presents an unlabeled dollar total.
- **T4.3 — CLI surface.**
  - **Files:** `apps/cli/src/commands/provider-account-*.ts` (CREATE), `apps/cli/src/main.ts` (EXTEND — registration calls).
  - **Provides:** list, register, correct, remove, set-default, probe, and the global cost view; plus the run-start account override option that makes the selection reachable from the CLI.
  - **Consumes:** T2.4, T4.2.
  - **Spec coverage:** Spec-029 §Interfaces And Contracts.
  - **Verifies invariant:** none — a client surface over already-asserted wire behavior.
  - **Tests:** command parsing and error surfacing per verb; the override option reaches the resolver; billing mode rendered on cost output.
- **T4.4 — Renderer surfaces.**
  - **Files:** `apps/desktop/src/renderer/src/provider-accounts/` (NEW subtree).
  - **Provides:** the settings-level account registry, the run-start account selector, and the global cost page — each a thin projection over the preload bridge with no client-side derivation, rendering wire values verbatim.
  - **Consumes:** T2.4, T4.2; the Spec-023 preload bridge.
  - **Spec coverage:** Spec-029 §Interfaces And Contracts; Spec-023 §Signature Feature Composition Sketches.
  - **Verifies invariant:** none — a renderer projection honoring Plan-016's I-016-19, applied here by the same bridge discipline every renderer subtree follows.
  - **Tests:** mock-bridge render rows; badge text equals wire value; billing-mode label present on every cost figure; the selector defaults to the provider default and sends an override only when the operator changes it.

### Phase 4B — Per-participant billing attribution

**Precondition:** Phase 3 merged; the turn-scoped effective principal carrier registered.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 29, phase: 3, status: merged }
  - { type: precondition_box_checked, box: "Turn-scoped effective principal carrier registered" }
```

**Goal:** the caused-by axis of the session cost receipt resolves to the party that actually caused each turn, not to whoever started the run.

A supplement phase rather than a task inside Phase 4, because its gate is a **whole-phase** gate: Gate 5 resolves `precondition_box_checked` against the phase that declares it, so a carrier-held task sharing a phase with unheld ones would block all of them. Homing the held work alone here keeps the enforced hold and the recorded hold identical — the shape Plan-004's Phase-3B rollback cluster and Plan-009's Phase 2B already use.

#### Tasks

- **T4.1 — Per-participant billing attribution.**
  - **Files:** `packages/runtime-daemon/src/accounts/provider-account-resolver.ts` (EXTEND).
  - **Provides:** the caused-by axis the receipt reads — the run starter billed by default, the intervener billed for turns they steered or edited — keyed on the turn-scoped effective principal rather than on run ownership, so a steered turn attributes to the steerer. Without that stamp the attribution would have to infer the billed party from run ownership alone, which is wrong in exactly the case the requirement exists for; that is why the leg is held rather than shipped against a weaker key.
  - **Consumes:** T3.1; the turn-scoped effective principal (external producer, per the §Preconditions box naming CP-004-14 and the api-payload §Authenticated Principal class rule).
  - **Spec coverage:** Spec-016 §Session Cost Receipt.
  - **Verifies invariant:** none — the attribution rule is stated by the Spec-016 clause above and asserted by Plan-016's receipt tasks, with this task supplying the account-side input.
  - **Tests:** an unsteered run attributes wholly to its starter; a steered turn attributes to the intervener and the remainder to the starter; an edit-and-resend composite attributes the resent turn to the editor; a system-initiated turn attributes to the system arm rather than to any participant.

## Rollout Order

1. Phase 1 — contracts, migration, conformance.
2. Phase 2 — registry, credential-home service, Cedar family, wire namespace.
3. Phase 3 — spawn binding, brokering, the capability probe, and the serialization floor. **The probe result gates whether concurrency is enabled at all**; shipping Phase 3 with the probe unrun means shipping the serialization floor, which is a correct and complete state.
4. Phase 4 — operator surfaces: the global cost page, CLI, and renderer.
5. Phase 4B — per-participant billing attribution, once its carrier lands. Dispatchable independently of Phase 4; both gate only on Phase 3.

## Rollback Or Fallback

- The registry is additive node-local configuration; with no accounts registered the daemon refuses provider runs with a typed refusal rather than misbehaving. The remedy for an **empty registry** is registration, not repair: the operator registers an account through the node-local `providerAccount.register` surface (T2.1) and authenticates it into that account's own credential home, after which the same run starts. Re-authentication is the remedy for a **different** state — a registered account whose credentials have expired — and is documented at [Provider Failure Runbook §Provider Re-Authentication (Per Account)](../operations/provider-failure-runbook.md#provider-re-authentication-per-account). The two are distinguished by the refusal itself, which names the empty-registry and unauthenticated cases with separate codes precisely so the operator is not sent to the wrong procedure.
- Disabling cross-account concurrency is the serialization floor, which is always a safe state.
- The migration is a plain table add with no backfill and no data dependency, so reverting it costs nothing beyond the registry rows.
- **There is no rollback that shares a credential home** (I-029-8). If the account plane must be disabled entirely, the correct degradation is to refuse provider runs, not to fall back to ambient credentials.

## Risks And Blockers

- **The capability probe may refute concurrency.** That is a designed-for outcome, not a blocker: the serialization floor ships regardless and the normative contract does not depend on the answer.
- **Provider credential-home variable names are version-fragile**, and one of the two Claude variables has no vendor documentation at all. Mitigated by resolving the reserved set from the pinned reference at build time and re-verifying at each pin bump, rather than embedding names in normative prose.
- **Phase 4B is carrier-held** on an external producer; Phase 4 ships without it, and the receipt degrades to account attribution without the participant split until it lands. The degradation is visible rather than silent: the receipt's caused-by partition is absent, not wrong.
- **First-run provider authentication is surfaced as of 2026-08-25** — a fresh install meets [Plan-026](./026-first-run-onboarding.md)'s provider step rather than discovering the gap at the first refused run (CP-029-7; [BL-154](../archive/backlog-archive.md) `completed`). The residual this leaves is honest and named rather than closed: a credential-free probe cannot distinguish a healthy first-party login from one whose stored credential has since been destroyed, so the authenticated arm is necessary and not sufficient. It is bounded by the unchanged I-029-3 spawn gate and the per-account re-authentication runbook, and it is deliberately **not** closed by reading credential bytes — that would reverse the no-token-custody posture, which is an ADR-level reversal.

## Progress Log

### Shipment Manifest

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

- 2026-08-18 — **Plan authored and first-time targeted readiness audit taken in one swap**, the in-swap delta shape established by the 2026-08-17 amendment cohort (NS-63 / NS-65..NS-70). Audit scope: this plan as authored, plus Spec-029 as its paired spec. Gate walk: **Gate 1** (paired spec `approved` in the same bundle, its promotion gate cleared here). **Gate 2** (`#### Tasks` decomposition present on all four numbered phases and the 4B supplement, every task carrying Files / Provides / Consumes / Spec coverage / Verifies invariant / Tests). **Gate 3** (§Invariants I-029-1..8 each grounded in a named `Spec-029` clause per the template's grounding rule — no plan self-cite, no sibling-plan precedent; §Cross-Plan Obligations CP-029-1..6 each bidirectionally surfaced at its counterpart). **Gate 4** (every `Spec coverage:` marker line carries the unbackticked `Spec-NNN §Heading` form and every cited heading byte-compared against the target file's real heading; every `Verifies invariant:` value is either a declared `I-029-M` id or the literal `none` with a trailing reason). **Gate 5** (one born-unchecked §Preconditions box, naming its external producer and holding exactly one phase, with its matching `precondition_box_checked` entry on the Phase-4B block; the entry's `box` value is the resolver's prefix form — leading bold markers stripped, stopping short of the label's closing pair — verified against the resolver's own `/^- \[([ xX])\] \**(.+)$/` capture rather than assumed. The audit deliberately **removed** a second box drafted for the Plan-005 provider-limit signal: Phase 3 already carries `external_plan_phase_merged` on Plan-005 Phase 3B, which resolves the same dependency against that plan's shipment manifest instead of a human tick, so the box was redundant enforcement — the NS-64 "check the box by making the carrier unnecessary" outcome. The per-phase `audit_status` entries were likewise removed: this plan carries the checked plan-level audit box, which `gatePhaseAuditCheckbox` honors for every phase, and a per-phase entry would have had to name an evidence PR that does not exist at authoring time.) Coverage mapping: Spec-029 AC-1..AC-10 each resolve to at least one task — AC-1/AC-2 to T1.2/T2.1, AC-3 to T2.3/T3.1, AC-4 to T3.1 and CP-029-1, AC-5 to T3.2, AC-6 to T2.2, AC-7 to T3.4, AC-8 to T3.4, AC-9 to T4.2, AC-10 to T3.3/T3.5. **Audit outcome: pass**, with one dimension honestly scoped rather than certified — Phase 4B is audit-covered as authored but not dispatch-eligible until its external producer lands, which is what the born-unchecked box records. Status promoted `draft → review → approved` within this diff on the strength of that pass.
- 2026-08-18 — **Provider-fact discipline recorded.** Every provider claim in Spec-029 carries the TRUST / PROVENANCE grade of its source, and the two claims that would most tempt over-assertion are deliberately under-asserted: the credential-file concurrency prohibition is vendor-published for one provider and **this project's conservative default** for the other (whose vendor publishes nothing on the subject), and keychain partitioning is treated as a property to observe rather than one to derive. T3.3's seeded negative control exists because a concurrency probe that cannot fail would certify the very assumption the parity triad's verify leg is there to test.

- 2026-08-25 — **First-run provider-authentication surfacing amendment and its restoring targeted readiness-audit delta, in one swap** (§6 node NS-77; the NS-63 / NS-65..NS-74 in-swap shape). Audit scope: this plan's amendment growth (I-029-9, I-029-10, CP-029-7, T2.5) plus Spec-029's. Gate walk: **Gate 1** (paired spec flipped and restored `approved` in the same diff). **Gate 2** (T2.5 carries Files / Provides / Consumes / Spec coverage / Verifies invariant / Tests, on the Phase-2 block that already declares its preconditions). **Gate 3** (I-029-9 and I-029-10 each ground in a named `Spec-029` clause authored by this same amendment — no plan self-cite, no sibling-plan precedent; CP-029-7 is bidirectionally surfaced at Plan-026 CP-026-6). **Gate 4** (T2.5's `Spec coverage:` markers carry the unbackticked `Spec-NNN §Heading` form, each heading byte-compared against Spec-029's real headings; `Verifies invariant:` names declared ids). **Gate 5** (no new born-unchecked box: the Plan-026 consumer dependency is carried mechanically by that plan's Phase-7 `external_plan_phase_merged` entry on this plan's Phase 2, which resolves against this plan's own shipment manifest instead of a human tick — the NS-64 "check the box by making the carrier unnecessary" outcome; the two pre-existing boxes are Re-opened and Delivered in-diff). Coverage mapping extended: Spec-029 AC-11 / AC-12 / AC-13 / AC-14 all resolve to T2.5, with AC-13's spawn-refusal half additionally covered by T3.2. **Audit outcome: pass**; Status flipped and restored `approved` within this diff on the strength of it. **Codex round 1 (two findings, both accepted and folded into normative content):** the sign-in remedy had **no transport** — every non-authenticated surface was required to display four values (provider, account, first-party invocation, credential home) that no wire member carried and no client can compose, since only the daemon knows which account resolution reached; the remedy now rides the readiness entry as the schema-optional, producer-obligated `remedy` member (`ProviderSignInRemedy`), composed at read time and never stored, on the `Spec-004 §Required Behavior` `resendDisposition` precedent, with the message-text-only disclosure rule unchanged and re-scoped to the reader rather than the encoding (the `api-payload-contracts.md` NOTE this bundle itself authored was corrected rather than weakened, since the rule was never "no path on the wire" but "no path where an operator is not the reader"); and the **stored readiness observation had no persisted home** — `health_state` and `health_observed_at` are added to the unshipped `provider_accounts` CREATE, so a restart cannot silently convert a stored read into a fresh probe (that half landed before this round's fold, in the same PR). No verb, method, error code, or table is minted by either; the namespace stays at seven verbs and the SQLite census at 56. **Codex round 2 (twelve findings across the bundle, all accepted and folded; five on this pair):** the remedy became a **discriminated union** — a single sign-in shape was structurally unproducible on `no_account` (no home exists) and `no_default` (resolution deliberately chose none of several), so each arm now carries the next action it can actually produce, and the `choose_default` arm lists candidates while electing none, since electing one would bind a run's spend to an account the operator never chose; the **shared resolver moved into Phase 2** (T2.5 creates it, T3.1 extends it) because I-029-9 guarantees readiness and admission run the _same_ resolution and a Phase-3 birth would have forced Phase 2 to duplicate it; the probe clause's claim that `credentialGeneration` never moves was **corrected against this spec's own generation rule**, which names the authenticated-boundary crossing as a lifecycle transition — both directions bump, atomically with the health write, so a repaired credential ends its old attention epoch; **spawn validation joined the probe verb as a writer of the stored pair**, since a value recording only explicit probes would leave a node whose first run succeeded serving `indeterminate` forever; the readiness member's ADR-018 **additive-optional misclassification** was corrected to required pre-shipment growth, matching the contract; and AC-11's no-default case was **reseeded** — registering a second account beside an existing default does not clear that default, so the criterion as written would have required silently changing which account pays. **Codex round 3 (six findings, all accepted and folded; three on this pair):** the readiness reply's disclosure boundary was **asserted but not gated** — the remedy names a daemon-owned credential home while T2.4 gated only the mutating verbs, so the whole namespace now takes the node-operator gate, the read included, with the gate asserted per verb and the `list` row asserting a refused non-operator caller receives no remedy; the readiness read became **account-scopable**, because a run refused while bound to a per-run override needs that account's remedy and the provider-default projection may describe a perfectly healthy different account (an unknown pinned id refuses rather than falling back, since the fallback is how the wrong-account remedy returns); and `observedAt`'s absence was **re-scoped to this resolution** rather than to the node's probe history — on `no_default` the candidates may well have been probed, and summarizing one of their timestamps would report an observation of an account the reply did not resolve. One additive optional request member (`accountId`) is registered; no verb, method, error code, table, or column is minted, and the namespace stays at seven verbs.
- 2026-08-25 — **Why no login verb was minted.** The first-run obligation is reachable without one: the surface offers registration through the verbs that already exist, discloses the remedy, and hands the operator to the provider's own first-party sign-in flow, which is what `Spec-029 §Vendor authentication-policy constraints` requires of any design — the vendor's published policy bars a developer from collecting, storing, or intermediating provider credentials, so there is no shape in which the daemon could own the sign-in itself. Adding a verb here would also have moved the seven-verb count claim that `api-payload-contracts.md §Plan-029` and this plan's §API And Transport Changes hold in lockstep, for no capability the obligation needs.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
