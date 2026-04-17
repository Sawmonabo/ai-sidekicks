# ADR-015: V1 Feature Scope Definition

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 1 (two-way door)` |
| **Domain** | `Scope / Product` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Reviewers** | `Accepted 2026-04-17` |

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

V1 consists of **16 features**. V1.1 defers **4 features**. Everything else inferable from the product vision is out of scope for the V1 horizon and carries a V2 label for future re-evaluation.

### V1 Features (16)

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

### V1.1 Features (4, deferred)

| # | Feature | Deferral Rationale |
|---|---------|-------------------|
| 1 | MLS relay E2EE | Pending audit of an MLS implementation (OpenMLS, mls-rs, or a post-audit TypeScript implementation); V1 ships pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](./010-paseto-webauthn-mls-auth.md). |
| 2 | Email invite delivery | V1 uses shareable-link tokens; email delivery adds an external-service dependency with no category-positioning payoff. |
| 3 | Cross-node shared artifacts | Local artifact publication ships in V1; shared-artifact relay is incremental scope on top of relay core. |
| 4 | Workflow authoring and execution | V1 queue + approval gates + multi-agent channels cover the structured-execution use case; the workflow authoring engine is incremental scope. |

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

- **Reversal cost:** Low to Medium while pre-code. Moving a feature between V1 / V1.1 / V2 requires: superseding this ADR, rewriting `docs/architecture/v1-feature-scope.md`, updating `docs/architecture/cross-plan-dependencies.md` tier placement, updating the affected plan file's scope label. No code-migration cost before first ship; moderate doc-churn cost. Once V1 ships, promoting a V1.1 feature to V1 requires re-versioning the release and is higher cost.
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
- [Spec-023: Desktop Shell and Renderer](../specs/023-desktop-shell-and-renderer.md) — to be authored per BL-041; enables Feature 15 implementation.

### Provenance

- Pre-implementation architecture audit — session `2026-04-16-arch-audit-163537`. The audit surfaced the Multi-Agent Channels and Desktop GUI scope inconsistencies against vision signaling; this ADR is the declarative scope decision that closes those inconsistencies.

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-17 | Proposed | Drafted against BL-038 exit criteria |
| 2026-04-17 | Accepted | ADR accepted as the governing V1 scope definition |
