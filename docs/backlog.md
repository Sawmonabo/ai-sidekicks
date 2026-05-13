# Backlog

## Purpose

This file is the active development backlog for the product defined in [vision.md](./vision.md).

## How To Use This Backlog

- Add items only when they represent real remaining work.
- Link every item to the governing spec, plan, ADR, or operations doc where possible.
- Keep items outcome-oriented. A backlog item should describe a deliverable, not a vague area of concern.
- Remove or rewrite stale items instead of letting the file become a historical log.
- When work is complete, update the canonical docs it depends on first, then move the item to [Backlog Archive](./archive/backlog-archive.md).
- If information in a backlog item becomes durable product truth, move that information into the canonical docs and keep only the remaining work here.

## Status Values

- `todo`
- `in_progress`
- `blocked`
- `completed`

## Priority Values

- `P0` — blocks all implementation or blocks a critical feature
- `P1` — blocks a specific feature or must resolve before v1
- `P2` — should resolve before v1 ship

---

## Item Template

Use this shape for new backlog items:

```md
### BL-0XX: Short Title

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Relevant Spec](./specs/000-spec-template.md), [Relevant Plan](./plans/000-plan-template.md)
- Summary: One or two sentences describing the deliverable or change.
- Exit Criteria: Concrete condition that makes this item complete.
```

---

## Active Items

The items below were surfaced by the [plan-readiness-audit Tier 1](./operations/plan-implementation-readiness-audit-runbook.md) audit (commit `05125dc`, 2026-04-28). Each tracks a cross-cutting governance amendment that the Tier 1 plan amendments deferred via `BLOCKED-ON-CN` tags. Resolution unblocks the corresponding Tier 1 plan content for first-code-execution PRs. BL-104 (C-4 — ADR-014 runtime authorization reconciliation) resolved 2026-04-30 and archived. BL-101 (C-3 — Plan-023 Tier-8 substrate carve-out from Tier 1) resolved 2026-04-30 via path (1) Plan-023 Tier 1 Partial carve-out and archived. BL-102 (C-6 — JSON-RPC handshake `protocolVersion` ISO 8601 date-string), BL-103 (C-7 — JSON-RPC two-layer error envelope per RFC 7807 + LSP 3.17), and BL-105 (C-8 + C-9 — Spec-006 `membership.created` + `security.*` registrations) resolved 2026-05-01 and archived. BL-107 (C-13 + C-2 — cross-plan-deps.md §3 missing edges + §2 ownership rows) resolved 2026-05-01 via the cross-plan-deps audit pass and archived.

### BL-106: C-5 + C-16 — Plan-024 calendar-window decoupling from `completed` status

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Plan-024](./plans/024-rust-pty-sidecar.md) Phase 5 (BLOCKED-ON-C5 ×6), [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md)
- Summary: Plan-024 calendar-window completion gate (2-week monitoring) contradicts the Tier 1 promotion gate (per runbook §Status Promotion Gate). ADR-019 monitoring-window scope must clarify whether the 2-week window is a (a) substrate-promotion gate (delays `RustSidecarPtyHost` from default-on to default-on at Tier 5), or (b) plan-completion gate (delays Plan-024 status flip to `completed`). Recommended: (a). Plan-024 Phase 5 amendment + ADR-019 monitoring-window scope clarification land together.
- Exit Criteria: ADR-019 monitoring-window scope explicitly carved out from Plan-024 `completed` status; Plan-024 Phase 5 BLOCKED-ON-C5 tags resolved with ADR-019 citation; F-024-5-01 closed.

### BL-108: Plan-024 Windows + macOS signing procurement evidence

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-024](./plans/024-rust-pty-sidecar.md) §Preconditions + Phase 4 (T-024-4-3), [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md) §Decision item 8, [ADR-023](./decisions/023-v1-ci-cd-and-release-automation.md) §Axis 5, [Spec-023](./specs/023-desktop-shell-and-renderer.md) §macOS
- Summary: Procurement evidence record for Plan-024 signing-identity gates (per F-024-4-06). Four artifacts: (a) Microsoft eligibility-determination response (Track A) OR vendor procurement contract + token-shipment confirmation (Track B); (b) signing-identity attestation matching Spec-023's Electron shell per ADR-019 §Decision item 8 + ADR-023 §Axis 5; (c) Plan-024 §Decision Log entry naming the chosen track + date; (d) macOS Developer ID Application certificate procurement evidence (cert thumbprint + team-ID + Apple Developer enrollment-confirmation email).
- Exit Criteria: All four artifacts attached; Plan-024 §Decision Log records the Windows signing-track choice + date; Plan-024 Phase 4 Preconditions row flips checked.

<!-- DO NOT rename this heading without grepping the repo for the GFM slug `bl-109-reconcile-agentstmp-lifecycle-drift-between-state-recoverymd-and-lefthookyml`; an inbound anchor from `.claude/skills/plan-execution/references/state-recovery.md` depends on it. -->

### BL-109: Reconcile `.agents/tmp/` lifecycle drift between state-recovery.md and lefthook.yml

- Status: `todo`
- Priority: `P3`
- References:
  - [`state-recovery.md` § "What Durable State Means"](../.claude/skills/plan-execution/references/state-recovery.md) — line documents `.agents/tmp/` as gitignored + deleted-at-commit-time per AGENTS.md
  - [`lefthook.yml`](../lefthook.yml) — current pre-commit chain has NO `.agents/tmp/` prune job
  - [Spec docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md §9.3](../docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md) — explicit deferral; out of housekeeper scope
- Summary: The `state-recovery.md` doc claims `.agents/tmp/` is "deleted at commit time per AGENTS.md", but `lefthook.yml`'s pre-commit chain has no prune job. Either add the lefthook job (mechanical fix) or reword the doc to match observed behavior (no auto-prune; manual cleanup expected). Spec §9.3 defers reconciliation to here.
- Exit Criteria: One of (a) `lefthook.yml` gains a `pre-commit > prune-agents-tmp` job that mirrors AGENTS.md's "deleted at commit time" claim, or (b) `state-recovery.md` is reworded to drop the deletion claim and say "manually clean up after commits" — and the corresponding state-recovery.md `> **Note:**` block authored in this task is removed.

### BL-110: Promote post-merge housekeeper from advisory hook to merge-queue gate

- Status: `todo`
- Priority: `P3`
- Owner: `unassigned`
- References:
  - PR #34 squash `d3f08e3` (preflight Gate 3 hardening — exposed the housekeeper SPOF in the post-PR-34 architectural discussion)
  - [`.claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs`](../.claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs) — current post-merge invocation point
  - [`.claude/skills/plan-execution/references/post-merge-housekeeper-contract.md`](../.claude/skills/plan-execution/references/post-merge-housekeeper-contract.md) — script contract
  - [`.claude/agents/plan-execution-housekeeper.md`](../.claude/agents/plan-execution-housekeeper.md) — subagent contract (Phase E of /plan-execution)
  - [ADR-023 §Axis 2](./decisions/023-v1-ci-cd-and-release-automation.md) — gate-vs-detector classification (gates fail-closed, drift detectors warn)
- Summary: The post-merge housekeeper is the only code path that writes shipment-state side effects (cross-plan-deps §6 ready-set re-derivation, line-cite sweep, set-quantifier reverification, NS-XX auto-create, completion-prose composition) and — under the future shipment-manifest refactor surfaced post-PR-34 — would also be the sole writer of any per-plan task shipment manifest. Today it runs as a post-merge hook with no enforcement: if it crashes, runs with a bug, or doesn't run at all (manual `--bypass-checks` merge, CI misconfiguration, future PR disabling the action), the manifest silently drifts from git history. Three architectural fixes are viable, in increasing robustness: (a) **housekeeper-as-CI-gate** — run inside the merge-queue check, not post-merge, so PRs cannot merge unless housekeeper succeeds; converts silent drift to loud merge-block. (b) **self-healing preflight** — preflight detects manifest staleness (latest merged PR newer than latest manifest entry) and invokes housekeeper rebuild before proceeding; manifest becomes a cache, ground truth stays git. (c) **two-phase manifest commit** — PR template includes a manifest-entry placeholder; housekeeper validates and persists post-merge. (a) is the lowest-cost-highest-leverage path; (b) and (c) layer on top if needed.
- Exit Criteria: One of (a)/(b)/(c) lands as the housekeeper invocation contract; ADR-023 §Axis 2 (or successor ADR) reclassifies the housekeeper from drift-detector to gate where applicable; the housekeeper's failure mode is "loud merge-block" rather than "silent post-merge drift" for any field that downstream tooling reads as authoritative; `--rebuild-from-git` recovery mode remains available as the escape hatch.
- Revisit Trigger: Any one of — (1) second author joins the repo (multi-author race risk on the manifest file); (2) housekeeper fails in practice for the first time (concrete failure-mode signal); (3) V2 planning starts (good window for infrastructure refactor before adding new write paths); (4) shipment-manifest refactor (the larger Gate 3 architecture work surfaced post-PR-34) is sequenced for delivery — the manifest write path is the most critical new field that benefits from gate-class enforcement.

---

_Closed items live in [Backlog Archive](./archive/backlog-archive.md)._
