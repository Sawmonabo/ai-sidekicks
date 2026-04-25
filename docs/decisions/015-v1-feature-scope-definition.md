# ADR-015: V1 Feature Scope Definition

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 1 (two-way door)` |
| **Domain** | `Scope / Product` |
| **Date** | `2026-04-17` |
| **Amended** | `2026-04-22` (workflow V1.1 → V1 per BL-097 — see §Amendment History) |
| **Author(s)** | `Claude (AI-assisted)` |
| **Reviewers** | `Accepted 2026-04-17`; amendment accepted `2026-04-22` |

## Context

The product vision (`docs/vision.md`) positions this system as a collaborative agent operating system for software work, with mid-session human invites, multi-runtime agent collaboration, multi-user and multi-agent chat, and a desktop-plus-CLI client story as the defining claims.

The pre-implementation architecture audit run on 2026-04-16 (session `2026-04-16-arch-audit-163537`) reviewed all 20 implementation plans, 22 specs, and an earlier draft triage in `docs/architecture/v1-feature-scope.md`. The audit identified two scope inconsistencies with vision signaling that the draft triage did not reflect:

1. **Multi-Agent Channels (Spec-016)** — the vision calls out "multi-user and multi-agent chat" as a signature feature and positions the product against commodity single-agent CLI runners on exactly this axis; V1 must include it or the category-positioning claim does not match what ships.
2. **Desktop GUI** — the vision build order lists desktop as step 6 of V1 delivery, and the product differentiates against CLI-only offerings (Claude Code, Codex CLI, Aider) in part through a richer desktop surface; V1 must include it for the same reason.

Twenty implementation plans and five cross-cutting specs need one authoritative V1 scope source before propagation edits (`docs/architecture/cross-plan-dependencies.md` tier graph, per-plan `V1 / V1.1` labels) can proceed. This ADR is that source.

## Problem Statement

What features compose the V1 release of the product, what is deferred to V1.1, and what is out of scope for the V1 horizon entirely?

### Trigger

The pre-implementation audit completed 2026-04-16 before any implementation plan begins coding. The existing scope triage signaled positions that would not survive launch positioning review. Downstream plans cannot safely cite a scope source until this decision lands.

## Decision

V1 consists of **17 features** (amended 2026-04-22 per BL-097 — was 16 at 2026-04-17 acceptance; see §Amendment History). V1.1 defers **3 features** and carries **2 criterion-gated sub-feature commitments** (see §V1.1 Criterion-Gated Commitments below). Everything else inferable from the product vision is out of scope for the V1 horizon and carries a V2 label for future re-evaluation.

### V1 Features (17)

| # | Feature | Governing Spec(s) |
|---|---------|-------------------|
| 1 | Session creation and join | [Spec-001](../specs/001-shared-session-core.md) |
| 2 | Mid-session invites via shareable link | [Spec-002](../specs/002-invite-membership-and-presence.md) |
| 3 | Membership roles and permissions | [Spec-002](../specs/002-invite-membership-and-presence.md), [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| 4 | Runtime node attach/detach | [Spec-003](../specs/003-runtime-node-attach.md) |
| 5 | Single-agent runs (Codex, Claude) | [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) |
| 6 | Queue, steer, pause, resume, interrupt | [Spec-004](../specs/004-queue-steer-pause-resume.md) |
| 7 | Approval gates | [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| 8 | Repo attach and workspace binding | [Spec-009](../specs/009-repo-attachment-and-workspace-binding.md) |
| 9 | Worktree-based execution | [Spec-010](../specs/010-worktree-lifecycle-and-execution-modes.md) |
| 10 | Session timeline with replay | [Spec-013](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md), [Spec-015](../specs/015-persistence-recovery-and-replay.md) |
| 11 | Local daemon with CLI | [Spec-007](../specs/007-local-ipc-and-daemon-control.md) |
| 12 | Presence (online/idle/offline) | [Spec-002](../specs/002-invite-membership-and-presence.md) |
| 13 | Event audit log | [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) |
| 14 | Artifact publication (local) | [Spec-014](../specs/014-artifacts-files-and-attachments.md) |
| 15 | Desktop GUI | Spec-023 (from BL-041) |
| 16 | Multi-Agent Channels | [Spec-016](../specs/016-multi-agent-channels-and-orchestration.md) |
| 17 | Workflow authoring and execution (full engine) | [Spec-017](../specs/017-workflow-authoring-and-execution.md); V1 engine scope per BL-097 resolution (see §Amendment History) covers DAG executor, all four phase types (`single-agent`, `automated`, `multi-agent` OWN-only, `human`), all four gate types, parallel execution with `ParallelJoinPolicy`, resource pools, and 23 workflow event types — full contract pinned in Spec-017 + Plan-017 (31 amendments SA-1…SA-31 from `docs/research/bl-097-workflow-scope/wave-1-synthesis.md` + `wave-2-synthesis.md`: 27 land in Spec-017 body; SA-24/29/30/31 land in Plan-017 per implementation-detail separation). |

### V1.1 Features (3, deferred)

| # | Feature | Deferral Rationale |
|---|---------|-------------------|
| 1 | MLS relay E2EE | Pending audit of an MLS implementation (OpenMLS, mls-rs, or a post-audit TypeScript implementation); V1 ships pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](./010-paseto-webauthn-mls-auth.md). |
| 2 | Email invite delivery | V1 uses shareable-link tokens; email delivery adds an external-service dependency with no category-positioning payoff. |
| 3 | Cross-node shared artifacts | Local artifact publication ships in V1; shared-artifact relay is incremental scope on top of relay core. |

### V1.1 Criterion-Gated Commitments

Sub-features explicitly committed for V1.1 under named criteria (per memory `feedback_criterion_gated_deferrals` — V1→V1.1 deferrals require concrete promotion gates in the ADR, not vague "maybe later"). Criteria are drawn from `docs/research/bl-097-workflow-scope/wave-1-synthesis.md` §5.3 and grounded in 2025–2026 durable-execution convergence evidence.

**C1 — BIND multi-phase channel reuse (committed V1.1):**

Add `ownership: 'BIND'` to `multi-agent` phase contract in V1.1, contingent on **all three** criteria:

- (a) **Production signal:** ≥3 production workflows reporting OWN + transcript-inheritance insufficient for a documented user goal, AND
- (b) **Concrete failure case:** at least one documented case where the transcript-as-context pattern degrades UX measurably (e.g., agent context loss detectable in outcomes), AND
- (c) **Lifecycle contract:** a BIND lifecycle contract addressing the 5 ambiguities documented in `docs/research/bl-097-workflow-scope/pass-b-multi-agent-channel-contract.md` §3.1 — phase-A-retry semantics, phase-A-abandonment handling, gate-scoping-lattice resolution, membership-snapshot timing, termination-authority resolution.

If (a)–(c) are satisfied, BIND ships as an additive amendment to the `multi-agent` phase type (SDK ergonomics: new `ownership: 'BIND'` discriminant). If any of (a)–(c) is not satisfied within V1.1's scoping window, BIND remains deferred under the same criteria.

**Rationale for criterion-gated deferral (not inclusion at V1):** 2025–2026 durable-execution composition convergence is state-passing, not handle-binding. Temporal Child Workflows use explicit Signals over shared state ([Temporal Child Workflows](https://docs.temporal.io/child-workflows), accessed 2026-04-22); Airflow's closest BIND analogue (SubDAGs) was deprecated in favor of TaskGroups after multi-year lifecycle-bug and worker-slot-starvation history ([Airflow SubDAG deprecation tracking issue #12292](https://github.com/apache/airflow/issues/12292)). BIND at V1 would import a 5-invariant state-machine expansion and confused-deputy vulnerability class for a feature lacking production demand signal. OWN-only → V1.1 BIND is additive (no breaking change); OWN + BIND at V1 → V1.1 revision would be breaking.

**C2 — `human` phase default-timeout behavior (committed V1.x):**

Reconsider the `HumanPhaseConfig` default-timeout policy once a notification-routing primitive exists in the product. Single promotion criterion:

- (a) **Notification-routing V1.x feature shipped:** daemon can route a "human phase escalated" event to an actual human recipient (not telemetry-only).

Until (a) is met, V1's required typed `timeout: "none" | Duration` opt-in (per Spec-017 SA-10) stands: authors must type either `"none"` or an explicit duration. A 7-day soft-cap + escalate default was considered and rejected for V1 because without notification routing the escalate path fires a `workflow.human_phase_escalated` event to telemetry but does not page a human — a "guardrail that looks like protection but isn't" (silent-failure class, directly violating C-12 Loud-errors invariant). The V1 stance matches modern durable-execution convention: Temporal Workflow Execution Timeout defaults to ∞ and authors opt in explicitly ([Temporal — Managing very long-running workflows](https://temporal.io/blog/very-long-running-workflows), accessed 2026-04-22); Argo suspend primitives are indefinite-by-default ([Argo Workflows — Suspending walk-through](https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/)).

### V2 (Out of Scope for the V1 Horizon)

Any feature inferable from the vision document or signature-feature framing but not listed above — including but not limited to first-party native runtime, provider marketplace, mobile clients, enterprise OIDC/SAML flows, SOC 2 compliance artifacts — is V2 and re-evaluated only after V1 ships.

### Thesis — Why This Option

The product's category positioning rests on three claims: mid-session collaboration, multi-participant multi-agent sessions, and a desktop-plus-CLI experience. Shipping V1 without Multi-Agent Channels or Desktop GUI launches into a crowded market (Claude Code, Codex CLI, Aider, Cursor, Windsurf) without the features that justify the product's existence. Landing V1 at 16 features rather than narrower alternatives pays the implementation cost to preserve the differentiators.

Treating Multi-Agent Channels as a V1 quality gate (per BL-042's V1-readiness review) forces the team to harden Spec-016 — turn policy defaults, budget policy defaults, stop conditions, partition behavior — rather than leaving it as "spec exists, implementation deferred." That quality work matters the moment any two agents talk to each other in a shared session, which happens on day one of collaborative V1.

### Antithesis — The Strongest Case Against

A staff engineer looking at a pre-code project with a 16-feature V1 target has legitimate concern: a broad V1 is the single most common cause of greenfield project slip. Every V1 feature is a concurrent dependency in the critical path. Multi-Agent Channels in particular carries orchestration, budget, and partition-behavior complexity that single-agent runs do not. Desktop GUI carries Electron packaging, auto-update, code-signing, and cross-platform QA burden. A narrower V1 (Option B below) launches faster, validates the collaborative-runtime core under real load, and upgrades to multi-agent in a V1.1 release six months later with full production data to drive the quality bar. That is how most successful platforms have shipped.

### Synthesis — Why It Still Holds

The antithesis assumes V1 launch speed is the dominant cost. For this product, launch positioning is the dominant cost. A CLI-only single-agent V1 does not survive the first launch-day comparison thread — the product would be reviewed as "another CLI agent runner, but less mature than Aider or Claude Code." The scope-size risk is real but bounded by two factors: (1) AI implementation costs (Claude Opus 4.7 executing the plans) collapse engineering-week counts relative to human-labor estimates; (2) tier discipline via `cross-plan-dependencies.md` and the phased backlog (Phase 0 → Phase 7) keeps work sequenced rather than parallel-fire. The quality risk on Multi-Agent Channels is the more serious concern, and BL-042 is the explicit mitigation: a V1-readiness review of Spec-016 before Plan-016 is treated as approved.

## Alternatives Considered

### Option A: V1 = 16 features (Chosen)

- **What:** Ship the full feature list above as the V1 target.
- **Steel man:** Aligns shipped scope with vision positioning; removes the audit's scope-inconsistency flag; establishes one authoritative source that 20 plans and 5 cross-cutting specs cite; sets the Multi-Agent Channels quality bar at V1 where it belongs.
- **Weaknesses:** Larger V1 surface = more implementation work before first ship; Multi-Agent Channels quality bar adds hardening work that would otherwise defer; Desktop GUI adds a second client track in the critical path rather than strictly after CLI proves the contract.

### Option B: V1 = 14 features (Rejected)

- **What:** Ship the existing 14-feature scope as V1 with Desktop GUI and Multi-Agent Channels pushed to V1.1.
- **Steel man:** Faster time to first-ship. CLI-first validates the typed client SDK and daemon contract before desktop-specific UX adds complexity (which matches the vision build-order recommendation for CLI as step 3 and desktop as step 6). Single-agent V1 validates the run state machine, driver contract, and approval gates under real traffic before multi-agent adds turn policy and budget enforcement. Solo / small-team reality check: 14 features is already a stretch for one engineering resource, even with AI implementation.
- **Why rejected:** A CLI-only single-agent V1 launches into direct comparison with Claude Code, Codex CLI, Aider, Cursor, Windsurf, and the broader coding-agent field. Those products are mature on the CLI+single-agent axis. The category-defining claim for this product is explicitly *multi-participant, multi-agent, collaborative* — vision Thesis and Product Goal both state this in the first ten lines. Shipping V1 without the category-defining features launches the product as a weaker commodity offering on the axis where it is strongest. The time-to-first-ship optimization is chasing the wrong metric for a greenfield product whose value is its positioning.

### Option C: Tiered M1–M4 milestone track (Rejected)

- **What:** Partition the 16 V1 features into four sequential milestone releases (M1 ≈ 8 features, M2 ≈ +3, M3 ≈ +3, M4 ≈ +2), each a customer-facing release.
- **Steel man:** Incremental customer feedback at each milestone; reduced risk of a big-bang launch; explicit cut points for scope adjustment between milestones; operational release-pipeline discipline earned incrementally rather than all at once; easier to message "we're shipping now, more next month" than "we're still building, launch TBD."
- **Why rejected:** Adds PM overhead and customer-communication surface without reducing engineering risk for a greenfield pre-code project. Each milestone boundary requires release-pipeline investment (signing, auto-update, changelog cadence, deprecation windows) earlier than a single-target V1 requires it. The backlog already enforces tier structure via `docs/architecture/cross-plan-dependencies.md`; that granularity is sufficient for engineering sequencing without making milestone boundaries customer-facing. Making them customer-facing is the cost; the benefit (incremental feedback) is available to any greenfield team via private beta without public M1/M2/M3 release mechanics. The milestone track also pushes the category-positioning launch to M2 or later, which re-raises the Option B problem.

## Reversibility Assessment

- **Reversal cost:** Low to Medium while pre-code. Moving a feature between V1 / V1.1 / V2 requires: amending or superseding this ADR (amendment precedent established 2026-04-22 per BL-097 — see §Amendment History; supersession remains valid for non-additive stance reversals), rewriting `docs/architecture/v1-feature-scope.md`, updating `docs/architecture/cross-plan-dependencies.md` tier placement, updating the affected plan file's scope label. No code-migration cost before first ship; moderate doc-churn cost. Once V1 ships, promoting a V1.1 feature to V1 requires re-versioning the release and is higher cost.
- **Blast radius:** `docs/architecture/v1-feature-scope.md`, `docs/architecture/cross-plan-dependencies.md`, 20 plan files, any ADR or spec referencing a V1 label.
- **Migration path:** Supersede this ADR with a new ADR. Rerun the `V1\.1|V2|deferred` grep sweep against `docs/plans/*.md` (the BL-055 process) to catch label drift. Rerun `cross-plan-dependencies.md` tier-graph alignment (the BL-054 process).
- **Point of no return:** First V1 ship to users. Until then, reversal is free. After, feature-set expectations carry.

## Consequences

### Positive

- Single authoritative scope source for 20 plans and 5 cross-cutting specs.
- Shipped scope matches vision positioning; the two audit-flagged scope inconsistencies resolve against this ADR.
- Multi-Agent Channels quality bar lands at V1 where it meets the category-positioning claim.
- Desktop GUI lands at V1 so launch positioning includes both client tracks vision names.

### Negative (accepted trade-offs)

- Larger V1 surface means more implementation work before first ship.
- Multi-Agent Channels V1-readiness review (BL-042) becomes a V1 gate rather than a V1.1 nice-to-have; hardening cost is real.
- Desktop GUI adds Electron packaging, auto-update, code-signing, and cross-platform QA work to V1; carried via ADR-016 (desktop shell) and Plan-023 (desktop implementation, from BL-043).
- **(Added 2026-04-22 per BL-097)** Full workflow engine surface per Spec-017 (V1 feature 17) is V1 build cost — covers DAG executor, four phase types, four gate types, parallel execution, resource pools, 23 workflow event types, 9-table SQLite persistence schema, property/fuzz/load/integration/security test battery. Justified by BL-097 research showing post-V1 retrofit of phase-type additions, parallel execution, and durable human-phase resumption is architecturally heavier than V1-native implementation: every surveyed system (Airflow, Dagger, GitHub Actions, n8n, Temporal, Argo, CircleCI) paid breaking-change cost retrofitting what V1-native would have covered additively. Sources: `docs/research/bl-097-workflow-scope/pass-d-post-v1-freeze-regrets.md` (7-system survey, 3 patterns: additive enum expansion — safe; replacement expansion — breaking per [Dagger CUE→SDK rewrite](https://dagger.io/blog/ending-cue-support/); execution-model commitment — deprecate-within-releases).

### Unknowns

- V1 delivery timeline under the chosen scope — no fixed date commitment; tier discipline drives sequencing.
- Whether the Multi-Agent Channels V1 quality bar can be met without in-production traffic; BL-042 review is the primary gate.

## References

### Related ADRs

- [ADR-016: Electron Desktop Shell](./016-electron-desktop-shell.md) — chosen desktop runtime; enables Feature 15.
- [ADR-019: Windows V1 Tier and PTY Sidecar](./019-windows-v1-tier-and-pty-sidecar.md) (from BL-052) — Windows tier decision; enables V1 shipment across Windows, macOS, Linux.
- [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) (from BL-053) — how V1 is shipped (OSS self-host + hosted SaaS), distinct from what V1 contains.
- [ADR-010: PASETO + WebAuthn + MLS Auth](./010-paseto-webauthn-mls-auth.md) — relay encryption choice that places MLS at V1.1 rather than V1 (rewritten per BL-048).

### Related Docs

- [Vision](../vision.md) — signature features, build order, category positioning.
- [V1 Feature Scope](../architecture/v1-feature-scope.md) — V1 / V1.1 / V2 triage rewritten against this ADR per BL-039.
- [Cross-Plan Dependencies](../architecture/cross-plan-dependencies.md) — tier graph updated against this ADR per BL-054.
- [Spec-016: Multi-Agent Channels and Orchestration](../specs/016-multi-agent-channels-and-orchestration.md) — V1 per this ADR; V1-readiness review tracked in BL-042.
- [Spec-017: Workflow Authoring and Execution](../specs/017-workflow-authoring-and-execution.md) — governs V1 Feature 17 (added per 2026-04-22 amendment). Spec-017 body carries 27 of 31 load-bearing amendments from BL-097 research (SA-1…SA-23, SA-25, SA-26, SA-27, SA-28); SA-24/29/30/31 land in Plan-017 per implementation-detail separation.
- [Spec-023: Desktop Shell and Renderer](../specs/023-desktop-shell-and-renderer.md) — to be authored per BL-041; enables Feature 15 implementation.

### BL-097 Research Provenance (added 2026-04-22)

Amendment to Feature 17 (Workflow authoring and execution) is grounded in the BL-097 research body under `docs/research/bl-097-workflow-scope/`:

- [Wave 1 synthesis](../research/bl-097-workflow-scope/wave-1-synthesis.md) — consolidates Passes A–E; lands V1 commitments C-1 through C-16 and security invariants I1–I7; resolves D1 (human-phase default timeout) and D2 (multi-phase channel reuse) decisions; drafts ADR-015 amendment language in §5.3.
- [Wave 2 synthesis](../research/bl-097-workflow-scope/wave-2-synthesis.md) — consolidates Passes F–H; adds 14 Spec-017 amendments SA-18…SA-31; resolves 6 themed cross-pass open questions; lands event taxonomy, persistence schema, and testing strategy. §7 References lists 29 primary sources.
- [Pass A — Parallel execution](../research/bl-097-workflow-scope/pass-a-parallel-execution.md) (scheduling, loop safety, backpressure, parallel join policy, cancellation synchrony)
- [Pass B — Multi-agent phase ↔ channel contract](../research/bl-097-workflow-scope/pass-b-multi-agent-channel-contract.md) (ownership, gate scoping, channel-lifecycle deltas, termination; source of BIND criteria in §V1.1 Criterion-Gated Commitments)
- [Pass C — Human phase UX + contract](../research/bl-097-workflow-scope/pass-c-human-phase-ux.md) (`human` phase vs `human-approval` gate semantic separation, Cedar `human_phase_contribution` category, timeout decision)
- [Pass D — Post-V1 freeze-regret patterns](../research/bl-097-workflow-scope/pass-d-post-v1-freeze-regrets.md) (7-system V1 shipping-pattern survey; justifies full-engine-at-V1 over subset-now-expand-later)
- [Pass E — Security surface](../research/bl-097-workflow-scope/pass-e-security-surface.md) (invariants I1–I7 — argv-only, typed substitution, typed approver capability, secrets-by-reference, content-addressed external refs, human-upload OWASP minimums, append-only approval history)
- [Pass F — Event taxonomy + observability](../research/bl-097-workflow-scope/pass-f-event-taxonomy.md) (24 workflow event types across 5 new Spec-006 categories; envelope additive MINOR bump)
- [Pass G — Persistence model](../research/bl-097-workflow-scope/pass-g-persistence-model.md) (9-table normalized SQLite schema; hash-chain anchored to Spec-006; truth/projection/ephemeral hierarchy)
- [Pass H — Testing strategy](../research/bl-097-workflow-scope/pass-h-testing-strategy.md) (5 test categories: property/fuzz/load/integration/security-regression; 85/95/90% coverage targets)

### Provenance

- Pre-implementation architecture audit — session `2026-04-16-arch-audit-163537`. The audit surfaced the Multi-Agent Channels and Desktop GUI scope inconsistencies against vision signaling; this ADR is the declarative scope decision that closes those inconsistencies.
- BL-097 scope-drift reconciliation (opened 2026-04-21; resolved via this amendment 2026-04-22) reconciled Spec-017:40 subset claim against ADR-015 row 4 + v1-feature-scope.md:39 V1.1 deferral. Resolution path selected was γ-iii (full workflow engine at V1) after D1/D2 decisions resolved and Wave 2 confirmed implementation readiness.

## Amendment History

This section records material amendments to this ADR. Each amendment preserves the original decision context (historical sections `§Context`, `§Thesis`, `§Antithesis`, `§Synthesis`, `§Alternatives Considered` reflect the 2026-04-17 decision-time state where V1 = 16 features). The current V1 surface is defined by the `§Decision` section as amended below.

### Amendment 2026-04-22: Workflow V1.1 → V1 (per BL-097)

**What changed:**

| | Before (2026-04-17) | After (2026-04-22) |
|---|---|---|
| V1 feature count | 16 | **17** (added Feature 17: Workflow authoring and execution) |
| V1.1 deferred features | 4 (MLS, email invite, cross-node artifacts, workflow) | **3** (MLS, email invite, cross-node artifacts) |
| V1.1 criterion-gated commitments | 0 | **2** (BIND multi-phase channel reuse; human-phase default-timeout) |
| Spec-017 status | Deferred V1.1 (conflicted with Spec-017:40 subset claim) | Authoritative V1 (31 amendments SA-1…SA-31 split: 27 land in Spec-017 body; SA-24/29/30/31 land in Plan-017 per implementation-detail separation) |

**Why:** BL-097 opened 2026-04-21 surfaced a direct contradiction — Spec-017:40 declared a V1 workflow subset (single-agent + automated + all 4 gates + sequential), while ADR-015 row 4 and `v1-feature-scope.md:39` declared the entire workflow feature was V1.1-deferred. Three resolution paths were on the table (α — keep subset, β — declare all-V1.1, γ-i/ii/iii — expand V1 scope to full engine). The user selected γ-iii (full engine) on the basis that post-V1 retrofit of phase-type additions, parallel execution, and durable human-phase resumption is architecturally heavier than V1-native implementation. Wave 1 + Wave 2 research (`docs/research/bl-097-workflow-scope/`) confirmed:

1. **Freeze-regret evidence** (Pass D): every surveyed workflow system (Airflow, Dagger, GitHub Actions, n8n, Temporal, Argo, CircleCI) paid breaking-change cost retrofitting features that V1-native implementation would have covered additively. Three freeze-regret patterns were identified — additive enum expansion (safe) vs. replacement expansion (breaking, e.g., [Dagger CUE→SDK 2023 rewrite](https://dagger.io/blog/ending-cue-support/)) vs. execution-model commitment (deprecate-within-releases, e.g., [Airflow SubDAG → TaskGroup migration](https://github.com/apache/airflow/issues/12292)).
2. **Security invariant grounding** (Pass E): 7 testable security invariants I1–I7 close the workflow-engine vulnerability class at V1 contract time (argv-only execution, typed substitution, typed approver capability, secrets-by-reference, content-addressed external refs, human-upload OWASP minimums, append-only approval history). These are expensive to retrofit — they shape the parameter-substitution model and state-access boundary.
3. **Composition-model convergence** (Pass B): 2025–2026 durable-execution and agent-framework convergence is explicit state-passing ([Temporal Child Workflows + Signals](https://docs.temporal.io/child-workflows)), not implicit handle-binding. V1 takes this stance directly.

**How decided:** Staff-engineer analysis against four criteria (architectural correctness, modern 2025–2026 practices, bug/regression surface, vulnerability surface) was applied to the two load-bearing sub-decisions (D1: `human` phase default timeout; D2: multi-phase channel reuse). D1 resolved to "no default, required typed opt-in" (matches Temporal, Argo, Camunda convergence). D2 resolved to "V1 OWN-only + criterion-gated V1.1 BIND" (keeps V1 engineering surface small while giving scope-hygiene a concrete promotion path). Rationale in `wave-1-synthesis.md` §5.

**Cross-references that consume this amendment:**

- [v1-feature-scope.md](../architecture/v1-feature-scope.md) — mirror amendment (BL-097 task #29)
- [Spec-017](../specs/017-workflow-authoring-and-execution.md) — body rewrite to carry 27 of 31 amendments (SA-1…SA-23, SA-25, SA-26, SA-27, SA-28; SA-24/29/30/31 land in Plan-017 per BL-097 task #27); §Non-Goals line 40 V1/V1.1 subset language removed
- [Plan-017](../plans/017-workflow-authoring-and-execution.md) — design-section rewrite (BL-097 task #28)
- [ADR-017: Shared Event Sourcing Scope](./017-shared-event-sourcing-scope.md) — "16 features" reference updated to "17" (BL-097 task #30)
- [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) — "16-feature surface" → "17-feature surface" (BL-097 task #30)
- [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) — "V1 scope is 16 features" → "17 features" (BL-097 task #30)

**Amendment precedent:** This is the first material amendment to ADR-015. Future amendments follow the same structure: a Before/After table, a Why paragraph, a How-decided paragraph, a Cross-references-consuming-this-amendment list, and a Decision Log row. Supersession (creating ADR-015.1 or ADR-N) remains the correct path for non-additive stance reversals; amendments are for additive scope adjustments where ≥90% of the original context and alternatives analysis remains applicable.

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-17 | Proposed | Drafted against BL-038 exit criteria |
| 2026-04-17 | Accepted | ADR accepted as the governing V1 scope definition |
| 2026-04-22 | Amended | Workflow promoted V1.1 → V1 per BL-097; feature count 16 → 17; V1.1 deferred-feature count 4 → 3; added 2 V1.1 criterion-gated commitments (BIND multi-phase channel reuse; human-phase default timeout). Amendment grounded in Wave 1 + Wave 2 research under `docs/research/bl-097-workflow-scope/`. See §Amendment History for full rationale and cross-reference list. |
