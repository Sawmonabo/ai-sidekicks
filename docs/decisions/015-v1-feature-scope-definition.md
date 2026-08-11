# ADR-015: V1 Feature Scope Definition

| Field | Value |
| --- | --- |
| **Status** | `accepted` |
| **Type** | `Type 1 (two-way door)` |
| **Domain** | `Scope / Product` |
| **Date** | `2026-04-17` |
| **Amended** | `2026-04-22` (workflow V1.1 → V1 per BL-097); `2026-07-02` (V1 scope 17 → 23 per the capability-enhancement campaign — see §Amendment History); `2026-07-08` (V1.1 criterion-gated commitments 2 → 3: automated GDPR erasure endpoint per BL-139 — see §Amendment History); `2026-07-08` (V1.1 deferred features 3 → 2: cross-node shared artifacts pulled into V1 as feature-14 scope growth; commitments 3 → 4 with C4 direct-first fetch — see §Amendment History) |
| **Author(s)** | `Claude (AI-assisted)` |
| **Reviewers** | `Accepted 2026-04-17`; amendments accepted `2026-04-22`, `2026-07-02`, `2026-07-08` |

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

V1 consists of **23 features** (amended 2026-07-02 per the capability-enhancement campaign — was 17 from the 2026-04-22 BL-097 amendment and 16 at 2026-04-17 acceptance; see §Amendment History). V1.1 defers **2 features** (amended 2026-07-08: cross-node shared artifacts pulled into V1 as feature-14 scope growth) and carries **4 criterion-gated sub-feature commitments** (see §V1.1 Criterion-Gated Commitments below). Everything else inferable from the product vision is out of scope for the V1 horizon and carries a V2 label for future re-evaluation.

### V1 Features (23)

| # | Feature | Governing Spec(s) |
| --- | --- | --- |
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
| 14 | Artifact publication (local + cross-node shared) | [Spec-014](../specs/014-artifacts-files-and-attachments.md); cross-node payload availability pulled forward from V1.1 (amendment 2026-07-08 — see §Amendment History): eager relay pin of participant-encrypted chunked ciphertext at publish + authenticated `(participant, node)`-scoped fetch against per-node wrapped CEKs, so a shared-visible artifact stays fetchable while the publishing node is offline (**threat-model-scoped 2026-08-08 — see §Decision Log**: honest-node model; the forged-ack and attestation-spoof residuals — both availability- and attribution-class, neither a confidentiality residual — are accepted V1 residuals closing on the Plan-018/Plan-003 node-identity primitive); normative design in [Spec-014 §Cross-Node Artifact Relay (V1)](../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1); direct-first fetch is criterion-gated (C4 below) |
| 15 | Desktop GUI | Spec-023 (from BL-041) |
| 16 | Multi-Agent Channels | [Spec-016](../specs/016-multi-agent-channels-and-orchestration.md) |
| 17 | Workflow authoring and execution (full engine) | [Spec-017](../specs/017-workflow-authoring-and-execution.md); V1 engine scope per BL-097 resolution (see §Amendment History) covers DAG executor, all four phase types (`single-agent`, `automated`, `multi-agent` OWN-only, `human`), all four gate types, parallel execution with `ParallelJoinPolicy`, resource pools, and 23 workflow event types — full contract pinned in Spec-017 + Plan-017 (31 amendments SA-1…SA-31 from BL-097 research: 27 land in Spec-017 body; SA-24/29/30/31 land in Plan-017 per implementation-detail separation; primary sources consolidated in §Research Conducted). |
| 18 | MCP server configuration and governance | Spec-028 + Plan-028 (**landed 2026-07-22 via the campaign's B18 bundle, Task 24** — server-config CRUD, operator-managed trusted-server store with Cedar-gated per-tool overrides, zero-billed-turn status/health probing, server OAuth; Spec-028 promoted `approved` 2026-07-22 via the campaign's W3 gate, Plan-028 at `draft` pending its targeted readiness audit); authored net-new in the capability-enhancement campaign, R4 — see §Amendment History (amendment 2026-07-02) |
| 19 | Session time-travel (run rollback) | [Spec-004](../specs/004-queue-steer-pause-resume.md) (`rollback` intervention on the generic dispatch — landed via the campaign's B2 bundle (PR #205); Spec-004 re-promoted `approved` 2026-07-18 via the W1.5 gate / Task 28, re-flipped `review` 2026-08-03 by the V1 product-vision reconciliation amendment bundle, and restored `approved` 2026-08-08 by its cross-user run-control authorization targeted readiness-audit delta (#299 / NS-49); Plan-004 implements rollback), [ADR-017](./017-shared-event-sourcing-scope.md) (forward `run.rolled_back` event; the log never truncates — registered by the campaign's Spec-006 B1 amendment (merged in-tree via PR #173; Spec-006 re-promoted `approved` 2026-07-18 via the W1.5 batch gate, campaign Task 28)), [Spec-010](../specs/010-worktree-lifecycle-and-execution-modes.md) + [Plan-010](../plans/010-worktree-lifecycle-and-execution-modes.md) (the daemon-side turn-snapshot **file-restore** leg: Codex `thread/rollback` (upstream-deprecated beyond the `0.141.0` pin — Plan-005/Plan-010 re-verify against the then-installed binary per the receipt) reverts conversation only and leaves working-tree restoration to the daemon per the [provider-wire receipt](../reference/provider-wire/codex.md), so time-travel is NOT dispatchable on B1/B2 alone — the turn-snapshot service landed via the campaign's B21→B22→B23 chain (Task 26), gated **before Plan-004 Phase 3 rollback dispatch** — the gate held: the B23 leg shipped 2026-08-09 via PR #303 and Phase 3 remains undispatched, now riding tier order plus its remaining precondition legs; without it a rollback would emit `run.rolled_back` while leaving the worktree at the post-rollback state) |
| 20 | Session goals | [Spec-016](../specs/016-multi-agent-channels-and-orchestration.md) (per-session structured goal, set/clear RPC + `session.goal_*` events — landed 2026-07-06 via the campaign's B6 bundle (§Session Goals, goal RPCs + wire shapes in-tree); events registered by the Spec-006 B1 amendment (merged in-tree via PR #173) — both specs re-promoted `approved` 2026-07-18 via the W1.5 gate / campaign Task 28; Spec-016 was briefly re-flipped `review` 2026-07-21 by the campaign B15 §Stop Conditions amendment and restored `approved` the same day by Plan-016's W2.5 targeted re-audit; re-flipped `review` again 2026-08-03 by the V1 product-vision reconciliation amendment (channel `audience` + two-human `direct` channels + the addressing-gated activation pin, D-016-21), restored `approved` 2026-08-11 — Plan-016 with it — by that bundle's channel-directory targeted readiness-audit delta (PR #321 / §6 NS-56)) |
| 21 | Session callback tools | [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) (daemon-registered tool shape — landed 2026-07-05 via the campaign's B3 bundle (Spec-005 re-promoted `approved` 2026-07-18 via the W1.5 gate)), [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) (Cedar-governed identically to provider tools — B20 amendment, merged via PR #175); both specs re-promoted `approved` 2026-07-18 via the W1.5 gate / Task 28 — Spec-012 re-flipped `review` 2026-08-03 by the V1 product-vision reconciliation amendment bundle and restored `approved` 2026-08-10 by its cross-user run-control authorization targeted readiness-audit delta (PR #317 / §6 NS-54), Spec-005 remaining `approved` |
| 22 | Execution postures and sandbox profiles | [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) (`executionPosture` authorization semantics — B20 amendment, merged via PR #175), [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) (posture shape — campaign B3, merged in-tree 2026-07-05); both specs re-promoted `approved` 2026-07-18 via the W1.5 gate / Task 28 — Spec-012 re-flipped `review` 2026-08-03 by the V1 product-vision reconciliation amendment bundle and restored `approved` 2026-08-10 by its cross-user run-control authorization targeted readiness-audit delta (PR #317 / §6 NS-54), Spec-005 remaining `approved` |
| 23 | Realtime voice channels (capability-gated) | [Spec-016](../specs/016-multi-agent-channels-and-orchestration.md) (V1-scope-decision reservation — landed 2026-07-06 via the campaign's B6 bundle, §Resolved Questions), [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) (reserved `realtime_*` family — B1 amendment, merged in-tree via PR #173; Spec-006 and Spec-016 re-promoted `approved` 2026-07-18 via the W1.5 batch gate, campaign Task 28 — Spec-016 was briefly re-flipped `review` 2026-07-21 by the campaign B15 §Stop Conditions amendment and restored `approved` the same day by Plan-016's W2.5 targeted re-audit; re-flipped `review` again 2026-08-03 by the V1 product-vision reconciliation amendment (channel `audience` + two-human `direct` channels + the addressing-gated activation pin, D-016-21), restored `approved` 2026-08-11 — Plan-016 with it — by that bundle's channel-directory targeted readiness-audit delta (PR #321 / §6 NS-56)); gated on upstream Codex realtime-flag stabilization (named external gate — no Claude-leg emulation claimed) |

### V1.1 Features (2, deferred)

| # | Feature | Deferral Rationale |
| --- | --- | --- |
| 1 | MLS relay E2EE | Pending audit of an MLS implementation (OpenMLS, mls-rs, or a post-audit TypeScript implementation); V1 ships pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](./010-paseto-webauthn-mls-auth.md). |
| 2 | Email invite delivery | V1 uses shareable-link tokens; email delivery adds an external-service dependency with no category-positioning payoff. |

(Cross-node shared artifacts — formerly row 3 — moved into V1 as feature-14 scope growth per the 2026-07-08 amendment; its only remaining deferred leg is the C4 direct-first fetch optimization below.)

### V1.1 Criterion-Gated Commitments

Sub-features explicitly committed for V1.1 under named criteria (V1→V1.1 deferrals require concrete promotion gates in the ADR, not vague "maybe later"). Criteria below are stated inline; they are grounded in 2025–2026 durable-execution convergence evidence (primary sources consolidated in §Research Conducted).

**C1 — BIND multi-phase channel reuse (committed V1.1):**

Add `ownership: 'BIND'` to `multi-agent` phase contract in V1.1, contingent on **all three** criteria:

- (a) **Production signal:** ≥3 production workflows reporting OWN + transcript-inheritance insufficient for a documented user goal, AND
- (b) **Concrete failure case:** at least one documented case where the transcript-as-context pattern degrades UX measurably (e.g., agent context loss detectable in outcomes), AND
- (c) **Lifecycle contract:** a BIND lifecycle contract addressing the 5 ambiguities — phase-A-retry semantics, phase-A-abandonment handling, gate-scoping-lattice resolution, membership-snapshot timing, termination-authority resolution.

If (a)–(c) are satisfied, BIND ships as an additive amendment to the `multi-agent` phase type (SDK ergonomics: new `ownership: 'BIND'` discriminant). If any of (a)–(c) is not satisfied within V1.1's scoping window, BIND remains deferred under the same criteria.

**Rationale for criterion-gated deferral (not inclusion at V1):** 2025–2026 durable-execution composition convergence is state-passing, not handle-binding. Temporal Child Workflows use explicit Signals over shared state ([Temporal Child Workflows](https://docs.temporal.io/child-workflows), accessed 2026-04-22); Airflow's closest BIND analogue (SubDAGs) was deprecated in favor of TaskGroups after multi-year lifecycle-bug and worker-slot-starvation history ([Airflow SubDAG deprecation tracking issue #12292](https://github.com/apache/airflow/issues/12292)). BIND at V1 would import a 5-invariant state-machine expansion and confused-deputy vulnerability class for a feature lacking production demand signal. OWN-only → V1.1 BIND is additive (no breaking change); OWN + BIND at V1 → V1.1 revision would be breaking.

**C2 — `human` phase default-timeout behavior (committed V1.x):**

Reconsider the `HumanPhaseConfig` default-timeout policy once a notification-routing primitive exists in the product. Single promotion criterion:

- (a) **Notification-routing V1.x feature shipped:** daemon can route a "human phase escalated" event to an actual human recipient (not telemetry-only).

Until (a) is met, V1's required typed `timeout: "none" | Duration` opt-in (per Spec-017 SA-10) stands: authors must type either `"none"` or an explicit duration. A 7-day soft-cap + escalate default was considered and rejected for V1 because without notification routing the escalate path fires a `workflow.human_phase_escalated` event to telemetry but does not page a human — a "guardrail that looks like protection but isn't" (silent-failure class, directly violating C-12 Loud-errors invariant). The V1 stance matches modern durable-execution convention: Temporal Workflow Execution Timeout defaults to ∞ and authors opt in explicitly ([Temporal — Managing very long-running workflows](https://temporal.io/blog/very-long-running-workflows), accessed 2026-04-22); Argo suspend primitives are indefinite-by-default ([Argo Workflows — Suspending walk-through](https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/)).

**C3 — Automated GDPR erasure endpoint (committed V1.1):**

Promote the V1 `gdpr.*` stubs (schema + write path ship in V1; the three daemon JSON-RPC methods refuse with `-32603` + `data.type: "gdpr.endpoint_not_v1"` per Plan-022 D-022-3) to automated deletion/export/purge handlers in V1.1, contingent on **all three** criteria (per BL-139, transplanted from [Plan-022 §Non-Goals](../plans/022-data-retention-and-gdpr.md#non-goals); paired spec-side record: [Spec-022 §V1 Erasure Scope Boundary](../specs/022-data-retention-and-gdpr.md#v1-erasure-scope-boundary), which enumerates the promotion criteria via `Plan-022 §Non-Goals`):

- (i) **Fan-out closure complete:** every CP-022-6 fan-out target's owner plan has shipped its table + Path-2 reciprocal — the automated shred spans the full `REFERENCES participants(id)` closure (thirteen rows over Plan-001/002/003/014/018/019 + forward-declared Plan-024/Plan-027/BL-070; Plan-014's two `artifact_relay_*` rows joined 2026-07-08 with the cross-node relay amendment, Plan-024's `session_terminal_leases` 2026-07-13, and Plan-019's `notification_queue` 2026-08-10), several of which are unbuilt until later tiers, AND
- (ii) **FK-safety migration landed:** the D-022-7 `ON DELETE SET NULL` forward ALTER relaxing the anonymize-class FKs has landed, AND
- (iii) **Equivalence proof:** cross-store fan-out equivalence tests prove no closure row is missed.

**Rationale for criterion-gated deferral (not inclusion at V1):** (a) **cross-tier completeness** — with later-tier owner tables unbuilt, a V1 automated endpoint would necessarily be partial and report success on an incomplete fan-out (the silent-failure class the C-12 Loud-errors invariant exists to block); (b) **protection-over-automation** — V1 erasure is satisfiable by hand (crypto-shred = `DELETE FROM participant_keys`; Postgres severance = the D-022-7 migration), so a data-subject request is honorable in V1 via the [GDPR Manual Erasure Runbook](../operations/gdpr-manual-erasure-runbook.md) without risking a half-built automated path. If (i)–(iii) are satisfied, the automated handlers ship in V1.1, replacing the stub refusals additively; until then the deferral stands as scoped in `Plan-022 §Non-Goals`.

**C4 — Direct-first artifact fetch (committed V1.x):**

Add the direct device-to-device fetch leg to the cross-node artifact relay (feature 14 as amended 2026-07-08): fetch the payload from the publishing daemon when it is reachable, with the eagerly pinned relay copy as the guaranteed fallback. Single promotion criterion:

- (a) **Direct daemon transport shipped:** a daemon-to-daemon direct data channel (reachability signaling plus NAT traversal or LAN peer discovery) exists as a shipped, spec-governed transport primitive.

**Rationale for criterion-gated deferral (not inclusion at V1):** the eager relay pin already delivers the user-facing guarantee — a shared-visible artifact is fetchable while its publisher is offline (threat-model-scoped 2026-08-08, §Decision Log; the direct leg is not a remedy for either accepted residual, since both are reachable from inside the participant's own trust domain) — so the direct leg buys only publisher-online latency and relay-bandwidth savings. V1 ships no direct daemon-to-daemon data path (cross-node traffic is relay-mediated: [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) delivers dispatch via the relay's pairwise-encrypted payload channel, and [deployment-topology.md](../architecture/deployment-topology.md) defines remote access as `Relay-Assisted Remote Access`), and building NAT traversal solely for an optimization would couple feature 14 to an unshipped transport subsystem. The [Spec-014 §Cross-Node Artifact Relay (V1)](../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) wire format ships V1-ready for the direct leg (`replicationStatus` pin states, digest addressing, per-chunk signed manifest), so C4 lands additively with no wire or schema break — the magic-wormhole/Syncthing precedent, where direct and relay transports coexist behind one addressing scheme.

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

> **Historical scope note (2026-04-17 decision time).** The options below — including "Option A: V1 = 16 features (Chosen)" — record the original 2026-04-17 analysis, when V1 scope was 16 features. Scope was later amended to 17 (per BL-097, 2026-04-22) and to 23 (capability-enhancement campaign, 2026-07-02); the current V1 surface is defined by [§Decision](#decision) as amended. The 16-/14-feature figures in this section are preserved as the historical record — see [§Amendment History](#amendment-history).

### Option A: V1 = 16 features (Chosen)

- **What:** Ship the full feature list above as the V1 target.
- **Steel man:** Aligns shipped scope with vision positioning; removes the audit's scope-inconsistency flag; establishes one authoritative source that 20 plans and 5 cross-cutting specs cite; sets the Multi-Agent Channels quality bar at V1 where it belongs.
- **Weaknesses:** Larger V1 surface = more implementation work before first ship; Multi-Agent Channels quality bar adds hardening work that would otherwise defer; Desktop GUI adds a second client track in the critical path rather than strictly after CLI proves the contract.

### Option B: V1 = 14 features (Rejected)

- **What:** Ship the existing 14-feature scope as V1 with Desktop GUI and Multi-Agent Channels pushed to V1.1.
- **Steel man:** Faster time to first-ship. CLI-first validates the typed client SDK and daemon contract before desktop-specific UX adds complexity (which matches the vision build-order recommendation for CLI as step 3 and desktop as step 6). Single-agent V1 validates the run state machine, driver contract, and approval gates under real traffic before multi-agent adds turn policy and budget enforcement. Solo / small-team reality check: 14 features is already a stretch for one engineering resource, even with AI implementation.
- **Why rejected:** A CLI-only single-agent V1 launches into direct comparison with Claude Code, Codex CLI, Aider, Cursor, Windsurf, and the broader coding-agent field. Those products are mature on the CLI+single-agent axis. The category-defining claim for this product is explicitly _multi-participant, multi-agent, collaborative_ — vision Thesis and Product Goal both state this in the first ten lines. Shipping V1 without the category-defining features launches the product as a weaker commodity offering on the axis where it is strongest. The time-to-first-ship optimization is chasing the wrong metric for a greenfield product whose value is its positioning.

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
- **(Added 2026-04-22 per BL-097)** Full workflow engine surface per Spec-017 (V1 feature 17) is V1 build cost — covers DAG executor, four phase types, four gate types, parallel execution, resource pools, 23 workflow event types, 9-table SQLite persistence schema, property/fuzz/load/integration/security test battery. Justified by BL-097 research showing post-V1 retrofit of phase-type additions, parallel execution, and durable human-phase resumption is architecturally heavier than V1-native implementation: every surveyed system (Airflow, Dagger, GitHub Actions, n8n, Temporal, Argo, CircleCI) paid breaking-change cost retrofitting what V1-native would have covered additively. Three freeze-regret patterns: additive enum expansion (safe); replacement expansion (breaking, e.g., [Dagger CUE→SDK rewrite](https://dagger.io/blog/ending-cue-support/)); execution-model commitment (deprecate-within-releases). Primary sources consolidated in §Research Conducted.

### Unknowns

- V1 delivery timeline under the chosen scope — no fixed date commitment; tier discipline drives sequencing.
- Whether the Multi-Agent Channels V1 quality bar can be met without in-production traffic; BL-042 review is the primary gate.

## References

### Research Conducted

**2026-07-08 amendment (cross-node artifact relay) sources** — the seven-axis survey behind the 2026-07-08 §Amendment History entry; the full set (~25 primaries) lands in [Spec-014 §References](../specs/014-artifacts-files-and-attachments.md#references) per the dual-mapping precedent the 2026-04-22 amendment established:

- [Wire Security Whitepaper](https://wire-docs.wire.com/download/Wire+Security+Whitepaper.pdf) + [AWS KMS data keys](https://docs.aws.amazon.com/kms/latest/developerguide/data-keys.html) — one-ciphertext-upload with per-recipient key fan-out; the envelope-encryption model the relay adopts
- [Matrix MSC3916 — authentication for media](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3916-authentication-for-media.md) + [Synapse media repository](https://matrix-org.github.io/synapse/latest/media_repository.html) — the capability-URL → authenticated-media retrofit, and the lazy remote-media-cache availability gap that rules out cache-on-miss pinning
- ["Missing Salamanders"](https://lotte.chir.rs/2024/08/17/Missing-Salamanders-Matrix-Media-can-be-decrypted-to-multiple-valid-plaintexts-using-different-keys/), [Albertini et al. (USENIX Security 2022)](https://www.usenix.org/conference/usenixsecurity22/presentation/albertini), and [Len, Grubbs, Ristenpart (USENIX Security 2021)](https://www.usenix.org/conference/usenixsecurity21/presentation/len) — the key non-commitment attack class; grounds the signed `cekCommitment` requirement (AEAD alone is not key-committing)
- [tus resumable-upload protocol 1.0](https://tus.io/protocols/resumable-upload/1-0-x) + [S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) — chunked resumable transfer, received-set/offset discovery, incomplete-upload reaping
- [RFC 9449 DPoP](https://datatracker.ietf.org/doc/html/rfc9449) + [W3C TAG capability-URLs finding](https://www.w3.org/2001/tag/doc/capability-urls/) + [Firefox Send shutdown notice (Mozilla Blog, 2020-09-17)](https://blog.mozilla.org/en/uncategorized/update-on-firefox-send-and-firefox-notes/) — sender-constrained authenticated fetch; the first-party abuse post-mortem ("ship malware and conduct spear phishing attacks") behind prohibiting capability URLs
- [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final) + [CJEU _EDPS v SRB_ (4 Sept 2025)](https://curia.europa.eu/site/upload/docs/application/pdf/2025-09/cp250107en.pdf) — Cryptographic Erase and the recipient-relative personal-data reading framing the relay-ciphertext GDPR posture
- [Bitwarden Send lifespan](https://bitwarden.com/help/send-lifespan/) + [IPFS garbage collection](https://blog.logrocket.com/guide-ipfs-garbage-collection/) + [Synapse issue #3339](https://github.com/matrix-org/synapse/issues/3339) — TTL tiers, watermark GC, and the build-your-own-quota gap

**2026-07-02 amendment (campaign B8) sources:**

- [MCP specification 2025-11-25 — Tools page](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — the execution-safety surface grounding feature #18's governance gates: `execution.taskSupport` on tool definitions, and the Tools-page trust warning — "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers" (verified verbatim 2026-07-02). The MUST binds trust classification, not behavior derivation — the schema doc-comments phrase the same rule as hints ("should never make tool use decisions based on ToolAnnotations received from untrusted servers") — so the gates bind on the operator-managed trusted-server store, never on annotation self-claims
- [MCP blog — tool annotations (2026-03-16)](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) — annotation-trust guidance consumed by the same gates
- [MCP Authorization (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) — the OAuth surface feature #18's `server OAuth` scope targets: OAuth 2.1 (IETF draft) with Authorization Server Metadata, Dynamic Client Registration, and Protected Resource Metadata (verified live 2026-07-02); Spec-028 pins its flow against this revision
- Feature #23's external gate: the `thread/realtime/*` server-notification family is present but feature-gated OFF in the Codex app-server schema regenerated at `codex-cli 0.141.0` (Provisional beyond that pin — current stable is `0.142.5`; Spec-016/Spec-006 authors MUST re-verify the `thread/realtime/*` shapes against the then-installed binary before reserving or gating the surface, per the receipt's §Version pin) — receipts in the campaign's provider-wire reference `docs/reference/provider-wire/codex.md` (B19 — merged as PR #176, follow-up fixes in PR #177, so the receipt file is verifiable in-tree; regenerated from the pinned binary via `codex app-server generate-json-schema`, upstream [openai/codex](https://github.com/openai/codex))

The 2026-04-22 amendment promoting Feature 17 (Workflow authoring and execution) from V1.1 → V1 is grounded in primary-source evidence across seven research dimensions: parallel execution (Pass A — DAG executor, resource pools, parallel join policy), multi-agent channel contract (Pass B — ownership, sub-workflow lifecycle, BIND-criterion evidence backing §V1.1 Criterion-Gated Commitments), event taxonomy (CloudEvents / OpenTelemetry / Temporal — anchors SA-18/19/20), persistence patterns (Pass G — SQLite WAL, Crosby & Wallach hash-chain, Trillian, AuditableLLM), test infrastructure (fast-check, Jazzer.js — anchors SA-29), human-phase upload safety (OWASP — anchors I6), post-V1 freeze-regret evidence (Pass D — 7-system V1-shipping-pattern survey backing the full-engine-at-V1 thesis), and security invariants I1–I7 (Pass E — CVE corpus per invariant). Cross-Pass duplications (Crosby & Wallach, OWASP File Upload, CloudEvents, OpenTelemetry semconv, Temporal events) are cited once with the broadest-applicable Pass framing. Additional Pass C (human-phase UX), Pass F (event-taxonomy detail), Pass G (persistence-pattern detail), and Pass H (testing-strategy detail) primaries land in `Spec-017 §References` and `Plan-017 §References` per dual-mapping established at amendment time.

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| CloudEvents v1.0.2 specification | Specification (CNCF) | Envelope additive-bump rules anchor SA-18 (workflow event envelope additive MINOR bump); subject field carries workflow-run scoping | <https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md> |
| OpenTelemetry Semantic Conventions for Events | Specification (CNCF) | Event-name hierarchical convention anchors SA-19 (`workflow.<resource>.<lifecycle>` naming) | <https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/events.md> |
| Temporal Events Reference | Documentation | Reserved-event taxonomy (`WorkflowExecutionStarted`, `ActivityTaskScheduled`, etc.) anchors SA-20 reserved-event list and projection-rebuild contract | <https://docs.temporal.io/references/events> |
| SQLite Write-Ahead Logging | Specification (SQLite) | WAL-mode durability and `synchronous=FULL` rationale for the 9-table workflow persistence schema (Pass G) | <https://www.sqlite.org/wal.html> |
| Crosby & Wallach — "Efficient Data Structures for Tamper-Evident Logging" (USENIX Security 2009) | Academic paper | Per-run hash-chain construction underwriting C-13 (event-log integrity) and I7 (append-only event log invariant) | <https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf> |
| AuditableLLM — "Auditable AI: Tamper-Evident Logging of LLM Interactions" (MDPI Electronics 14 (10): 2059, 2025) | Academic paper | LLM-specific audit-log precedent corroborating C-13 hash-chain choice for agent-execution event streams | <https://www.mdpi.com/2079-9292/14/10/2059> |
| Google Trillian | Code (Apache-2.0) | Operational transparency-log precedent for hash-chained append-only logging at scale; reference implementation underpinning C-13 | <https://github.com/google/trillian> |
| fast-check (model-based property testing) | Code (MIT) | Property-test framework anchoring SA-29 test-category battery (property/fuzz/load/integration/security-regression) | <https://github.com/dubzzz/fast-check> |
| Jazzer.js (coverage-guided fuzzing for Node.js) | Code (Apache-2.0) | Fuzz-test framework anchoring SA-29 fuzz-target category for parameter-substitution and event-envelope parsing | <https://github.com/CodeIntelligenceTesting/jazzer.js> |
| OWASP File Upload Cheat Sheet | Specification (OWASP) | Human-upload validation minimums anchoring I6 (human-phase upload OWASP minimums) and SA-26 form-state lifecycle | <https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html> |
| Apache Airflow `dag.py` source | Code (Apache-2.0) | Kahn's-algorithm topological-sort DAG executor precedent anchoring C-3 (DAG executor) | <https://github.com/apache/airflow/blob/main/airflow-core/src/airflow/models/dag.py> |
| Apache Airflow Pools | Documentation | Slot-based concurrency pools anchoring SA-3 (resource pools) | <https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html> |
| Astronomer — Managing Dependencies (Airflow trigger rules) | Documentation | Trigger-rules taxonomy (`all_success`, `one_failed`, etc.) anchoring C-3 (DAG executor) trigger semantics | <https://www.astronomer.io/docs/learn/managing-dependencies> |
| Temporal Go SDK (workflow primitives) | Documentation | Durable-execution primitive precedent anchoring C-3 (DAG executor) and C-7 (sub-workflow contract) | <https://docs.temporal.io/develop/go> |
| Argo Workflows — Parallelism | Documentation | Workflow-level parallelism cap anchoring SA-3 (resource pools) parallelism budget | <https://argo-workflows.readthedocs.io/en/latest/parallelism/> |
| Dagster Run Concurrency | Documentation | Multi-tier resource-pool precedent (run-tags + concurrency keys) anchoring SA-3 (resource pools) | <https://docs.dagster.io/guides/operate/managing-concurrency> |
| AWS Step Functions — Error Handling | Documentation | `Catch` / `Retry` semantics anchoring SA-4 (`ParallelJoinPolicy` `fail-fast` precedent) | <https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html> |
| Temporal — ParentClosePolicy | Documentation | Child-workflow lifecycle on parent close anchors SA-6 (multi-agent ownership: OWN-only V1) and BIND lifecycle deltas | <https://docs.temporal.io/develop/typescript/child-workflows#parent-close-policy> |
| Apache Airflow 2.0 release blog | Release blog | SubDAG → TaskGroup migration cost evidence backing BIND-criterion (b) (concrete failure case) and §V1.1 Criterion-Gated Commitments | <https://airflow.apache.org/blog/airflow-two-point-oh-is-here/> |
| `apache/airflow#1350` (SubDAG removal) | Issue | SubDAG deprecation primary record anchoring BIND-criterion (b) failure case | <https://github.com/apache/airflow/issues/1350> |
| Apache Airflow — Task Groups | Documentation | SubDAG migration cost evidence anchoring BIND-criterion freeze-regret rationale | <https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#taskgroups> |
| Apache Airflow — SubDagOperator API | Documentation | Concrete BIND failure mode: SubDagOperator can occupy pool/concurrency slots and must release slots periodically to avoid potential deadlock | <https://airflow.apache.org/docs/apache-airflow/2.5.1/_api/airflow/operators/subdag/index.html> |
| n8n — `executeWorkflow` node | Documentation | Sub-workflow precedent anchoring C-7 (sub-workflow contract) industry alignment | <https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/> |
| Activepieces Sub Flows | Documentation | Sub-workflow precedent anchoring C-7 (sub-workflow contract) industry alignment | <https://www.activepieces.com/pieces/subflows> |
| Argo Workflows — DAG walkthrough | Documentation | DAG/template/suspending composition anchoring C-7 (sub-workflow contract) | <https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/> |
| `argoproj/argo-workflows#12425` | Issue | Sub-workflow lifecycle ambiguity precedent anchoring BIND lifecycle-contract requirement | <https://github.com/argoproj/argo-workflows/issues/12425> |
| AWS Step Functions — Best Practices | Documentation | Sub-workflow break-down precedent anchoring C-7 (sub-workflow contract) | <https://docs.aws.amazon.com/step-functions/latest/dg/bp-cwl.html> |
| Dapr — Workflow Patterns | Documentation | Sub-workflow industry-alignment evidence anchoring C-7 (sub-workflow contract) | <https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-patterns/> |
| Apache Airflow 3.0 release blog | Release blog | Major-version break pattern evidence backing the full-engine-at-V1 thesis (Pass D freeze-regret) | <https://airflow.apache.org/blog/airflow-three-point-oh-is-here/> |
| Apache Airflow — Release Notes | Documentation | Cross-version migration-cost precedent backing the full-engine-at-V1 thesis | <https://airflow.apache.org/docs/apache-airflow/stable/release_notes.html> |
| `apache/airflow#9606` (Smart Sensors) | Issue | Smart Sensors deprecate-within-releases precedent backing freeze-regret pattern (deprecate-within-releases) | <https://github.com/apache/airflow/issues/9606> |
| Apache Airflow 2.4.0 release notes | Release notes | Smart Sensors removal record backing freeze-regret pattern | <https://airflow.apache.org/docs/apache-airflow/2.4.0/release_notes.html> |
| Temporal — TypeScript Versioning | Documentation | Workflow-versioning precedent for V1 contract evolution backing additive-amendment strategy | <https://docs.temporal.io/develop/typescript/versioning> |
| Temporal — Worker Versioning | Documentation | Worker-version migration cost backing freeze-regret pattern (replacement expansion) | <https://docs.temporal.io/worker-versioning> |
| Temporal — Worker Versioning Change Log | Changelog | Worker-version forward-compat strategy backing additive-amendment strategy | <https://temporal.io/change-log/worker-versioning-public-preview> |
| `dagger/dagger#4086` (CUE → SDK) | Issue | DSL-replacement break detail backing freeze-regret pattern (replacement expansion); supplements [Dagger CUE→SDK rewrite](https://dagger.io/blog/ending-cue-support/) cited in §Consequences and §Amendment History | <https://github.com/dagger/dagger/issues/4086> |
| n8n — BREAKING-CHANGES.md | Code (Sustainable Use) | Workflow-engine break manifest backing freeze-regret evidence (every surveyed system broke later) | <https://github.com/n8n-io/n8n/blob/master/packages/cli/BREAKING-CHANGES.md> |
| n8n — 1.0 release notes | Release notes | n8n 1.0 break detail backing freeze-regret evidence | <https://github.com/n8n-io/n8n/releases/tag/n8n%401.0.0> |
| n8n — 2.0 release notes | Release notes | n8n 2.0 break detail backing freeze-regret evidence | <https://github.com/n8n-io/n8n/releases/tag/n8n%402.0.0> |
| GitHub Actions — HCL → YAML migration (2019) | Engineering blog (post) | Early DSL-replacement break precedent (HCL deprecated for YAML) backing freeze-regret pattern | <https://github.blog/2019-08-08-github-actions-now-supports-ci-cd/> |
| GitHub Actions — `set-output` deprecation | Changelog | Deprecate-then-postpone pattern backing freeze-regret evidence | <https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/> |
| GitHub Actions — Node 16 → Node 20 migration | Changelog | Forced-runtime-migration cost backing freeze-regret evidence | <https://github.blog/changelog/2024-03-07-github-actions-all-actions-will-run-on-node20-instead-of-node16-by-default/> |
| GitHub Actions — Artifact v3 deprecation | Changelog | Artifact-API break backing C-9 (artifact immutability) rationale and freeze-regret evidence | <https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/> |
| GitHub — Immutable releases | Documentation | Immutability rationale supporting C-9 (artifact immutability) | <https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases> |
| CircleCI 1.0 EOL announcement | Engineering blog (post) | DSL-replacement break precedent (1.0 → 2.0) backing freeze-regret evidence | <https://circleci.com/blog/sunsetting-1-0/> |
| OWASP CI/CD Top 10 | Specification (OWASP) | Anchors C-12 (secrets-by-reference) / I1 (argv-only) / I3 (typed substitution) industry-minimum bar | <https://owasp.org/www-project-top-10-ci-cd-security-risks/> |
| NVD CVE-2025-54550 (Airflow secret-masker bypass) | CVE record (NVD) | Anchors I2 (secrets-by-reference invariant) — proves need for cipher-pinned reference indirection | <https://nvd.nist.gov/vuln/detail/CVE-2025-54550> |
| NVD CVE-2025-67895 (Airflow Edge3 RCE) | CVE record (NVD) | Anchors I1 (argv-only execution) — proves need to forbid in-template-string command construction | <https://nvd.nist.gov/vuln/detail/CVE-2025-67895> |
| NVD CVE-2024-53862 (Argo Workflows) | CVE record (NVD) | Anchors I6 (human-upload OWASP minimums) — secondary corroboration to CVE-2025-66626 | <https://nvd.nist.gov/vuln/detail/CVE-2024-53862> |
| NVD CVE-2024-47827 (Argo Workflows) | CVE record (NVD) | Anchors I4 (content-addressed external refs) — proves need for content-hash pinning of external workflow refs | <https://nvd.nist.gov/vuln/detail/CVE-2024-47827> |
| NVD CVE-2025-30066 (tj-actions supply-chain compromise) | CVE record (NVD) | Anchors I4 (content-addressed external refs) — supply-chain breach proving content-addressing rationale | <https://nvd.nist.gov/vuln/detail/CVE-2025-30066> |
| CISA — tj-actions advisory | Government advisory (CISA) | Government-attested incident corroborating I4 (content-addressed external refs) for CVE-2025-30066 | <https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-github-action-cve-2025-30066> |
| GitHub Security Lab — script-injection research | Engineering research (post) | Anchors I3 (typed substitution) — categorizes untrusted-input handling failure modes | <https://securitylab.github.com/research/github-actions-untrusted-input/> |
| GitHub Actions — Security hardening guide | Documentation | I3 industry-minimum bar (default-deny untrusted input) anchoring typed-substitution invariant | <https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions> |
| NVD CVE-2026-33475 (Langflow GitHub Actions command injection) | CVE record (NVD) | Anchors I3 (typed substitution) — untrusted GitHub context values interpolated into `run:` shell commands motivate default-deny substitution | <https://nvd.nist.gov/vuln/detail/CVE-2026-33475> |
| Jenkins Script Security plugin | Code (MIT) | I1 (argv-only execution) sandbox precedent anchoring untrusted-script-eval prohibition | <https://plugins.jenkins.io/script-security/> |
| Temporal — Data Encryption | Documentation | C-12 (secrets-by-reference) — encryption-at-rest precedent for workflow payloads | <https://docs.temporal.io/security#encryption-in-transit> |
| NVD CVE-2025-3248 (Langflow) | CVE record (NVD) | Anchors I1 (argv-only execution) — untrusted-code-eval RCE in agent workflow tooling | <https://nvd.nist.gov/vuln/detail/CVE-2025-3248> |
| NVD CVE-2024-8183 (Prefect) | CVE record (NVD) | Anchors I3 (typed substitution) — input-injection in workflow-engine context | <https://nvd.nist.gov/vuln/detail/CVE-2024-8183> |
| CircleCI January 2023 security incident | Engineering blog (post) | I2 (secrets-by-reference) severity evidence — concrete secrets-incident at CI/CD-engine scope | <https://circleci.com/blog/january-4-2023-security-alert/> |

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

### Provenance

- Pre-implementation architecture audit — session `2026-04-16-arch-audit-163537`. The audit surfaced the Multi-Agent Channels and Desktop GUI scope inconsistencies against vision signaling; this ADR is the declarative scope decision that closes those inconsistencies.
- BL-097 scope-drift reconciliation (opened 2026-04-21; resolved via this amendment 2026-04-22) reconciled `Spec-017 §Non-Goals` subset claim against ADR-015 row 4 + `docs/architecture/v1-feature-scope.md §V1.1 Features (2, Deferred)` V1.1 deferral. Resolution path selected was γ-iii (full workflow engine at V1) after D1/D2 decisions resolved and Wave 2 confirmed implementation readiness.

## Amendment History

This section records material amendments to this ADR. Each amendment preserves the original decision context (historical sections `§Context`, `§Thesis`, `§Antithesis`, `§Synthesis`, `§Alternatives Considered` reflect the 2026-04-17 decision-time state where V1 = 16 features). The current V1 surface is defined by the `§Decision` section as amended below.

### Amendment 2026-04-22: Workflow V1.1 → V1 (per BL-097)

**What changed:**

|  | Before (2026-04-17) | After (2026-04-22) |
| --- | --- | --- |
| V1 feature count | 16 | **17** (added Feature 17: Workflow authoring and execution) |
| V1.1 deferred features | 4 (MLS, email invite, cross-node artifacts, workflow) | **3** (MLS, email invite, cross-node artifacts) |
| V1.1 criterion-gated commitments | 0 | **2** (BIND multi-phase channel reuse; human-phase default-timeout) |
| Spec-017 status | Deferred V1.1 (conflicted with `Spec-017 §Non-Goals` subset claim) | Authoritative V1 (31 amendments SA-1…SA-31 split: 27 land in Spec-017 body; SA-24/29/30/31 land in Plan-017 per implementation-detail separation) |

**Why:** BL-097 opened 2026-04-21 surfaced a direct contradiction — `Spec-017 §Non-Goals` declared a V1 workflow subset (single-agent + automated + all 4 gates + sequential), while ADR-015 row 4 and `docs/architecture/v1-feature-scope.md §V1.1 Features (2, Deferred)` declared the entire workflow feature was V1.1-deferred. Three resolution paths were on the table (α — keep subset, β — declare all-V1.1, γ-i/ii/iii — expand V1 scope to full engine). The user selected γ-iii (full engine) on the basis that post-V1 retrofit of phase-type additions, parallel execution, and durable human-phase resumption is architecturally heavier than V1-native implementation. Wave 1 + Wave 2 research confirmed:

1. **Freeze-regret evidence** (Pass D): every surveyed workflow system (Airflow, Dagger, GitHub Actions, n8n, Temporal, Argo, CircleCI) paid breaking-change cost retrofitting features that V1-native implementation would have covered additively. Three freeze-regret patterns were identified — additive enum expansion (safe) vs. replacement expansion (breaking, e.g., [Dagger CUE→SDK 2023 rewrite](https://dagger.io/blog/ending-cue-support/)) vs. execution-model commitment (deprecate-within-releases, e.g., [Airflow SubDAG → TaskGroup migration](https://github.com/apache/airflow/issues/12292)).
2. **Security invariant grounding** (Pass E): 7 testable security invariants I1–I7 close the workflow-engine vulnerability class at V1 contract time (argv-only execution, typed substitution, typed approver capability, secrets-by-reference, content-addressed external refs, human-upload OWASP minimums, append-only approval history). These are expensive to retrofit — they shape the parameter-substitution model and state-access boundary.
3. **Composition-model convergence** (Pass B): 2025–2026 durable-execution and agent-framework convergence is explicit state-passing ([Temporal Child Workflows + Signals](https://docs.temporal.io/child-workflows)), not implicit handle-binding. V1 takes this stance directly.

**How decided:** Staff-engineer analysis against four criteria (architectural correctness, modern 2025–2026 practices, bug/regression surface, vulnerability surface) was applied to the two load-bearing sub-decisions (D1: `human` phase default timeout; D2: multi-phase channel reuse). D1 resolved to "no default, required typed opt-in" (matches Temporal, Argo, Camunda convergence). D2 resolved to "V1 OWN-only + criterion-gated V1.1 BIND" (keeps V1 engineering surface small while giving scope-hygiene a concrete promotion path). Rationale captured inline in §V1.1 Criterion-Gated Commitments above; primary sources in §Research Conducted.

**Cross-references that consume this amendment:**

- [v1-feature-scope.md](../architecture/v1-feature-scope.md) — mirror amendment (BL-097 task #29)
- [Spec-017](../specs/017-workflow-authoring-and-execution.md) — body rewrite to carry 27 of 31 amendments (SA-1…SA-23, SA-25, SA-26, SA-27, SA-28; SA-24/29/30/31 land in Plan-017 per BL-097 task #27); `Spec-017 §Non-Goals` V1/V1.1 subset language removed
- [Plan-017](../plans/017-workflow-authoring-and-execution.md) — design-section rewrite (BL-097 task #28)
- [ADR-017: Shared Event Sourcing Scope](./017-shared-event-sourcing-scope.md) — "16 features" reference updated to "17" (BL-097 task #30)
- [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) — "16-feature surface" → "17-feature surface" (BL-097 task #30)
- [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) — "V1 scope is 16 features" → "17 features" (BL-097 task #30)

**Amendment precedent:** This is the first material amendment to ADR-015. Future amendments follow the same structure: a Before/After table, a Why paragraph, a How-decided paragraph, a Cross-references-consuming-this-amendment list, and a Decision Log row. Supersession (creating ADR-015.1 or ADR-N) remains the correct path for non-additive stance reversals; amendments are for additive scope adjustments where ≥90% of the original context and alternatives analysis remains applicable.

### Amendment 2026-07-02: V1 scope 17 → 23 features (capability-enhancement campaign)

**What changed:**

|  | Before (2026-04-22) | After (2026-07-02) |
| --- | --- | --- |
| V1 feature count | 17 | **23** (added #18 MCP server configuration and governance, #19 session time-travel, #20 session goals, #21 session callback tools, #22 execution postures and sandbox profiles, #23 realtime voice channels — capability-gated) |
| V1.1 deferred features | 3 (MLS, email invite, cross-node artifacts) | 3 (unchanged — none is a capability-bearing deferral in the R3 sense; each stays deferred on its own gate) |
| V1.1 criterion-gated commitments | 2 (BIND multi-phase channel reuse; human-phase default timeout) | 2 (unchanged) |

**Why:** The capability-enhancement integration campaign (design + companion plan drafted 2026-07-01/02) adopted, under the owner's standing "richest features and capabilities" ruling (R3), every capability-bearing enhancement that a prior-art survey of a comparable multi-provider agent runtime surfaced and that the V1 corpus had left deferred or unspecified. Six of those mint net-new V1 features rather than amend existing ones:

- **#18 MCP server configuration and governance (R4):** full server-config CRUD, an operator-managed trusted-server store with Cedar-gated per-tool `idempotency_class` overrides, zero-billed-turn status/health probing, and server-OAuth flows. Authored net-new as Spec-028 + Plan-028 (not a criterion-gated V1.1 stub), consuming the MCP 2025-11-25 execution-safety surfaces.
- **#19 session time-travel:** run rollback as a version-guarded, state-gated `rollback` intervention on the existing generic dispatch, modeled as a forward `run.rolled_back` event on the authoritative log (the log never truncates — [ADR-017](./017-shared-event-sourcing-scope.md) as amended 2026-07-02); dispatchable session time-travel additionally requires the daemon-side turn-snapshot **file-restore** leg (Spec-010/Plan-010, campaign B21→B23, gated before Plan-004 Phase 3 — the provider `thread/rollback` reverts conversation only, per the #19 scope row above).
- **#20 session goals:** a per-session structured goal with set/clear RPC and `session.goal_*` events.
- **#21 session callback tools:** a daemon-hosted tool registry exposed into every run, Cedar-governed identically to provider tools.
- **#22 execution postures and sandbox profiles:** a per-run `executionPosture` treated as an authorization input (not merely a spawn knob), with daemon-side provider-uniform presets.
- **#23 realtime voice channels:** reserved and designed but **capability-gated** on a named external gate — the upstream Codex realtime feature flag, still under development — with no emulation claimed for the Claude leg.

Remote provider transports and provider-native subagents were adopted in the same campaign but **amend existing features** (cross-node dispatch under Spec-024; orchestration under Spec-016) rather than minting feature numbers, so the count rises by six, not eight. The context-window fourth budget stays rejected on **correctness** grounds (estimated-grade window data driving hard interrupts would block co-participants on false positives) — a correctness rejection, not a capability deferral, so it does not read against the R3 ruling.

**How decided:** The campaign design doc is the ratified contract; every structural decision (its R1–R9 ruling table) was presented to and explicitly ratified by the owner during the 2026-07-01/02 brainstorming session. Feature-vs-amendment classification followed one rule: a capability that mints a net-new user-facing surface with its own governing spec (or a distinct reserved event family) is a feature; a capability that extends an already-listed feature's spec is an amendment. The 23-count is re-derived by enumerating the §Decision V1-features table rows, not by incrementing a prior count.

**Cross-references that consume this amendment:**

- [ADR-017: Shared Event Sourcing Scope](./017-shared-event-sourcing-scope.md) — "17 features" reference updated to "23"; also carries the forward-`run.rolled_back` decision row backing #19 (same campaign PR, B8)
- [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) — "17-feature surface" → "23-feature surface" (three sites)
- [v1-feature-scope.md](../architecture/v1-feature-scope.md) — "17-feature surface" → "23-feature surface" (two sites)
- [deployment-topology.md](../architecture/deployment-topology.md) — self-hosted-topology "17-feature V1 surface" → "23-feature V1 surface"
- [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) — "V1 scope is 17 features" → "23 features"
- [README.md](../../README.md) — the §V1 Scope feature census (prose count + enumerated table) extended to 23
- [CLAUDE.md](../../CLAUDE.md) — the repository-summary "V1 ships 17 features … across 27 implementation plans" line: the 17 → 23 feature ripple is applied **in this amendment's PR** together with an explicit pending-28th clause on the plan axis (feature #18's Plan-028 gates MCP-governance code); only the plan-count reconciliation (27 → 28) completes when Plan-028 lands with the campaign's B18 bundle (done 2026-07-22, PR #244)

### Amendment 2026-07-08: V1.1 criterion-gated commitments 2 → 3 (automated GDPR erasure endpoint, per BL-139)

**What changed:**

|  | Before (2026-07-02) | After (2026-07-08) |
| --- | --- | --- |
| V1 feature count | 23 | 23 (unchanged) |
| V1.1 deferred features | 3 | 3 (unchanged) |
| V1.1 criterion-gated commitments | 2 (BIND multi-phase channel reuse; human-phase default timeout) | **3** (added C3: automated GDPR erasure endpoint) |

**Why:** The Tier-5 plan-readiness audit's Codex review (PR #129, round-5 GDPR hardening) surfaced that the automated GDPR deletion/export/purge endpoint — a compliance-relevant V1→V1.1 deferral — was recorded only in Plan-022/`Spec-022 §Non-Goals`, while the project's criterion-gated-deferral discipline places durable V1→V1.1 commitments in this ADR. BL-139 tracked the fold-in. The promotion criteria (i)–(iii) and the (a)/(b) deferral rationale are transplanted from `Plan-022 §Non-Goals`; the interim operator path is the [GDPR Manual Erasure Runbook](../operations/gdpr-manual-erasure-runbook.md).

**How decided:** No new scope decision — this amendment relocates an already-ratified deferral (Plan-022 D-022-3 stubs + §Non-Goals criteria, ratified at the Tier-5 audit) into the scope ADR so the durable record no longer lives only in plan/spec Non-Goals. Recorded alongside Plan-022's `review → approved` promotion (Tier-5 audit amendments D-022-1..8 reviewed and accepted 2026-07-08).

**Cross-references that consume this amendment:**

- [Plan-022 §Non-Goals](../plans/022-data-retention-and-gdpr.md#non-goals) — the source criteria (i)–(iii) + rationale (a)/(b); Plan-022 promoted `review → approved` in the same PR
- [Spec-022 §V1 Erasure Scope Boundary](../specs/022-data-retention-and-gdpr.md#v1-erasure-scope-boundary) — the paired spec-side deferral record (`Spec-022 §Non-Goals` lists unrelated exclusions; the erasure-automation deferral and its criteria pointer live in the scope-boundary section)
- [GDPR Manual Erasure Runbook](../operations/gdpr-manual-erasure-runbook.md) — the interim V1 operator procedure named by rationale (b)
- [Backlog Archive](../archive/backlog-archive.md) — BL-139 closed by this amendment
- [docs/architecture/v1-feature-scope.md](../architecture/v1-feature-scope.md) — the §V1.1 census sentence re-derived for 3 commitments (count + per-commitment spec ties)
- [README.md](../../README.md) — the §Features "V1.1 additions" enumeration re-derived to include the non-workflow C3 commitment

### Amendment 2026-07-08: V1.1 deferred features 3 → 2 (cross-node shared artifacts pulled into V1)

**What changed:**

|  | Before (2026-07-08, after the BL-139 amendment) | After (2026-07-08, this amendment) |
| --- | --- | --- |
| V1 feature count | 23 | 23 (unchanged — cross-node sharing amends feature 14 per the 2026-07-02 feature-vs-amendment rule; no number minted) |
| Feature 14 | Artifact publication (local); cross-node shared artifacts deferred to V1.1 | **Artifact publication (local + cross-node shared)** — payload availability with the publisher offline is a V1 guarantee |
| V1.1 deferred features | 3 (MLS, email invite, cross-node artifacts) | **2** (MLS, email invite) |
| V1.1 criterion-gated commitments | 3 (C1 BIND; C2 human-phase timeout; C3 GDPR erasure endpoint) | **4** (added C4: direct-first artifact fetch, gated on a shipped direct daemon transport) |

**Why:** The 2026-07-08 V1→V1.1 deferral review found the cross-node row the weakest of the three deferrals: its own rationale ("incremental scope on top of relay core") concedes that the enabling infrastructure ships in V1, and a cross-machine collaboration product whose shared artifacts become unfetchable the moment the publishing laptop sleeps undercuts the §Thesis category positioning. The owner ruled the feature must ship in V1, production-hardened, and explicitly rejected publisher-online-only fetch as under-hardened. A seven-axis primary-source survey grounded the selected architecture: E2EE messenger attachment models (Signal / WhatsApp / Wire — all store ciphertext server-side until delivered and fan out only the key inside the E2EE event); Matrix media (authenticated media per MSC3916, and the lazy remote-media-cache availability gap that rules out cache-on-miss pinning); relay-assisted P2P tools (magic-wormhole / croc / Syncthing — synchronous pipes that prove the untrusted-ciphertext-relay trust model but cannot serve an absent peer); resumable-upload protocols (tus, S3 multipart — chunking, per-chunk integrity, incomplete-upload reaping); retention/quota/abuse envelopes (Firefox Send's anonymous capability-URL abuse post-mortem; Bitwarden Send / Synapse / IPFS quota-TTL-GC norms); GDPR treatment of relay-held ciphertext (NIST SP 800-88 Cryptographic Erase, Art 5(1)(e) storage limitation, CJEU _EDPS v SRB_ recipient-relative reading — defensible, not settled); and integrity/authorization (signed-manifest digest binding, RFC 9449 DPoP, W3C TAG capability-URL guidance). Selected: **eager relay pin at publish** (chunked, participant-encrypted, digest-addressed ciphertext — offline availability as a guarantee, not luck) + **authenticated `(participant, node)`-scoped DPoP-bound fetch** (no capability URLs; the token's node half selects the wrapped CEK and attributes the delivery ack) + **refcount/TTL GC with per-`(participant, node)` CEK wrapping and participant crypto-shred**. Rejected: publisher-online-only (fails the availability property); lazy cache-on-miss (fails it whenever no remote peer fetched before the publisher left); a V1 direct-first leg (requires an unshipped direct transport — carved out as C4). Normative design: [Spec-014 §Cross-Node Artifact Relay (V1)](../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1); request-rate rows: [Spec-021](../specs/021-rate-limiting-policy.md).

**How decided:** Owner directive 2026-07-08 (pull forward into V1; hardened production design; publisher-online-only variant rejected), applied through the same four-criteria staff-level analysis as prior amendments (architectural correctness, modern 2025–2026 practice, regression surface, vulnerability surface) over the survey evidence. The relay holds ciphertext + per-`(participant, node)` wrapped keys only — it is trusted to hold bytes, never to read them (the existing relay trust model); integrity binds blob → signed publish event (not blob → itself), so a malicious relay cannot substitute content; the manifest's signed `cekCommitment` closes the non-committing-AEAD multi-plaintext class (a malicious publisher cannot target different plaintexts at different recipients); wrapped CEKs are relay-held per-recipient rows — never carried in the immutable event log — so participant erasure remains a true crypto-shred, and they wrap to **durable per-node artifact-encryption keys** (Spec-022 master-key custody; announced as Ed25519-identity-signed attestations), never to the ADR-010 session-ephemeral X25519 keys whose zeroization would orphan every relay-held CEK on restart (2026-07-09 Codex-round-2 hardening — with the per-node delivery refcount, the PITR-bounded/KEK-destroyable backup posture, and the relay-visible lifecycle envelope recorded in `Spec-014 §Resolved Questions and V1 Scope Decisions`); the abuse surface is closed by authenticated-participant-only fetch plus quota/TTL envelopes.

**Cross-references that consume this amendment:**

- [Spec-014 §Cross-Node Artifact Relay (V1)](../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) — the normative design: publish/fetch/delete flows, integrity + authorization models, size/quota/TTL parameters, failure-mode table, wire-format additivity
- [Spec-021](../specs/021-rate-limiting-policy.md) — six artifact-relay registry rows (`artifact.upload.init`, `artifact.upload.chunk`, `artifact.upload.complete`, `artifact.fetch.authorize`, `artifact.fetch.chunk`, `artifact.fetch.complete`)
- [Plan-014](../plans/014-artifacts-files-and-attachments.md) — implementation growth: relay-pin upload, authenticated fetch, GC/quota accounting, erasure fan-out integration
- [docs/architecture/v1-feature-scope.md](../architecture/v1-feature-scope.md) — V1.1 census re-derived (deferred 3 → 2; commitments 3 → 4)
- [README.md](../../README.md) — feature-14 row + V1.1 enumerations re-derived
- [Spec-017 §Resolved Questions and V1 Scope Decisions](../specs/017-workflow-authoring-and-execution.md#resolved-questions-and-v1-scope-decisions) — the workflow-scoped commitments-count aside re-derived (the aside now records four ADR commitments, two of them non-workflow)
- [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) — artifact-relay resource-ownership rows (Plan-014 CREATEs the relay blob surface; dependent plans EXTEND)

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-04-17 | Proposed | Drafted against BL-038 exit criteria |
| 2026-04-17 | Accepted | ADR accepted as the governing V1 scope definition |
| 2026-04-22 | Amended | Workflow promoted V1.1 → V1 per BL-097; feature count 16 → 17; V1.1 deferred-feature count 4 → 3; added 2 V1.1 criterion-gated commitments (BIND multi-phase channel reuse; human-phase default timeout). Amendment grounded in Wave 1 + Wave 2 research; primary-source citations consolidated in §References → §Research Conducted; rationale and cross-reference list in §Amendment History. |
| 2026-07-02 | Amended — V1 scope 17 → 23 features (R4 + R8) | Capability-enhancement campaign: feature count 17 → 23; added #18 MCP server configuration and governance (net-new Spec-028 + Plan-028, R4), #19 session time-travel, #20 session goals, #21 session callback tools, #22 execution postures and sandbox profiles, #23 realtime voice channels (capability-gated on the upstream Codex realtime flag). Remote transports and provider-native subagents amend existing features (Spec-024 / Spec-016) rather than minting numbers. V1.1 deferred-feature count (3) and criterion-gated commitments (2) unchanged; count re-derived by enumerating the §Decision table rows. Rationale, Before/After table, and cross-reference list in §Amendment History (amendment 2026-07-02). ADR stays `accepted`. |
| 2026-07-08 | Amended — V1.1 criterion-gated commitments 2 → 3 (BL-139) | Added C3 (automated GDPR erasure endpoint, committed V1.1) with promotion criteria (i)–(iii) transplanted from `Plan-022 §Non-Goals`; deferral rationale (cross-tier fan-out completeness; protection-over-automation) recorded in §V1.1 Criterion-Gated Commitments; interim manual-erasure runbook named. V1 feature count (23) and V1.1 deferred-feature count (3) unchanged. Recorded alongside Plan-022 `review → approved` promotion; closes BL-139. ADR stays `accepted`. |
| 2026-07-08 | Amended — V1.1 deferred features 3 → 2 (cross-node shared artifacts → V1) | Cross-node shared artifacts pulled into V1 as feature-14 scope growth (no feature number minted, per the 2026-07-02 feature-vs-amendment rule) by owner directive: eager relay pin of participant-encrypted chunked ciphertext at publish + authenticated `(participant, node)`-scoped DPoP-bound fetch + refcount/TTL GC with per-`(participant, node)` wrapped CEKs and participant crypto-shred — a shared-visible artifact stays fetchable while its publisher is offline. Publisher-online-only fetch and lazy cache-on-miss pinning rejected (both fail the availability property). Added C4 (direct-first artifact fetch, committed V1.x, gated on a shipped direct daemon transport) — commitments 3 → 4. V1 feature count (23) unchanged. Normative design in `Spec-014 §Cross-Node Artifact Relay (V1)`; request-rate rows in Spec-021; implementation via Plan-014 growth. ADR stays `accepted`. |
| 2026-08-08 | Scope recorded — feature-14 offline-availability guarantee threat-model-scoped | Not a feature, count, or deferral change, so no §Amendment History entry and no feature-count census moves; ADR status stays `accepted`. The feature-14 guarantee above ("payload availability with the publisher offline is a V1 guarantee") and the C4 rationale ("the eagerly pinned relay copy as the guaranteed fallback") are **scoped to an honest-node threat model**: they hold against non-members and every other participant, and — for confidentiality and integrity — against the relay itself, which stores only ciphertext and cannot substitute bytes past the signed chunk manifest. Availability additionally assumes an operational byte-holding relay, and neither availability nor confidentiality is guaranteed against a **compromised node inside the owning participant's own trust domain**. Two residuals are **accepted for V1** because V1 ships no node-identity credential: **(a)** a forged `ArtifactFetchComplete` ack (it proves no CEK unwrap) advances a sibling's delivery row and drives premature refcount-zero GC, with no remedy while the publisher is offline — an availability residual; **(b)** artifact-key attestations verify as signed by _any_ identity key registered to the participant, and each workstation holds its own separately-registered key with nothing binding the signer to the attested `node_id`, so an attacker-held X25519 key can be bound to a sibling's `node_id` — **locking that honest sibling out** of artifacts it is entitled to and corrupting attestation and delivery attribution. **Both residuals are availability- and attribution-class; neither is a confidentiality residual** (reclassified 2026-08-08, PR #301 round 3): an attached sibling is already an intended recipient holding the CEK under its own attested key, so no spoof widens plaintext reach, and plaintext reach by an authorized node of the participant is participant-granularity sharing working as designed — a compromised-endpoint problem, not a protocol residual. **Closure criteria (named, not open-ended):** the Plan-018 / Plan-003 non-forgeable node-identity key plus its control-plane resolution surface, tracked as the Plan-014 row in [cross-plan-dependencies.md §V1.1+ Cross-Plan Extensions](../architecture/cross-plan-dependencies.md#v11-cross-plan-extensions) — restoring (i) node-scoped fetch authorization including the multi-node selector, (ii) attestation integrity — binding the signer to the attested `node_id` — and (iii) delivery-attribution integrity. It deliberately does **not** promise node-level content exclusion; no named V1.1 primitive defines that. Normative text in [Spec-014 §Cross-Node Artifact Relay (V1)](../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) (§Required Behavior, Publish step 3, Fetch steps 5–6, §Failure modes, and both scoped §Acceptance Criteria rows). Adjudicated at PR #301 rounds 1–2. |
