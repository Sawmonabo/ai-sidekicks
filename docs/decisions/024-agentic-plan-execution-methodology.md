# ADR-024: Agentic Plan Execution Methodology

| Field          | Value                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| **Status**     | `proposed`                                                               |
| **Type**       | `Type 1 (two-way door)`                                                  |
| **Domain**     | Engineering Process / AI Agent Workflow                                  |
| **Date**       | 2026-04-26                                                               |
| **Author(s)**  | Claude (AI-assisted)                                                     |
| **Reviewers**  | Sawmon                                                                   |

> Type 1: the methodology lives in a skill file and an ADR. Switching cost is hours (rewrite the skill, supersede the ADR). Affects only *future* PRs — already-merged work is untouched. Reversal does not require migration.

---

## Context

V1 ships 17 features across [27 implementation plans](../architecture/cross-plan-dependencies.md) in 9 dependency tiers ([ADR-015](015-v1-feature-scope-definition.md)). Each plan is a `docs/plans/NNN-*.md` file that decomposes a spec into 1–N PR-sized work units. Across V1 that totals roughly 50–60 PR-sized chunks of code authored primarily by Claude (Opus 4.7) acting as the implementer, with the human user (`Sawmon`) as principal-engineer reviewer.

The repository is in the doc-first phase: no source code exists yet; [Plan-001 PR #1](../plans/001-shared-session-core.md) is the first code-execution PR. [ADR-023](023-v1-ci-cd-and-release-automation.md) (V1 CI/CD and Release Automation) defines the CI workflow architecture, pre-commit hooks, and release-please orchestration. [CONTRIBUTING.md](../../CONTRIBUTING.md) defines branch naming (`<type>/<topic>` per Conventional Branch), commit format (Conventional Commits 1.0), and the GitFlow-lite branch model (`develop` integration, `main` release-only).

What ADR-023 and CONTRIBUTING.md *do not* define is the **execution loop** — how Claude actually walks a plan from "branch off `develop`" to "squash-merge to `develop`" with appropriate state preservation, subagent dispatch, and failure-mode handling. Without a written, repeatable execution loop, every plan becomes a one-off: the user re-explains the workflow, the agent re-derives subagent boundaries, and crash recovery is ad-hoc.

## Problem Statement

How should Claude execute a multi-PR implementation plan such that (a) the workflow is repeatable across 50–60 PRs, (b) state survives session compaction or crash, (c) spec-drift and code-quality issues are caught before squash-merge, and (d) the trigger phrase remains short enough that the human user does not have to re-specify the workflow on every PR?

### Trigger

[Plan-001 PR #1](../plans/001-shared-session-core.md) is the next code-execution PR (gate cleared 2026-04-26 with [BL-100/ADR-023 acceptance](023-v1-ci-cd-and-release-automation.md)). Before kicking off the first plan, the user requested a reusable standard for plan execution rather than re-deriving the workflow each session. This ADR captures that standard; the [`plan-execution`](../../.claude/skills/plan-execution/SKILL.md) skill is the executable form.

---

## Decision

**We will execute each implementation plan PR-by-PR using the `plan-execution` skill, which dispatches three subagent roles (implementer, spec-reviewer, code-quality-reviewer) on a feature branch off `develop`, with state preserved on the branch and in TaskCreate before the draft PR description.**

Triggers:

- `execute Plan-NNN` — auto-detects the next PR via state inference (active branch → most recently merged PR for plan → next-up PR `M` = `merged_count + 1`).
- `execute Plan-NNN PR #M` — explicit override for resumption, retry, or out-of-order execution.

### Thesis — Why This Option

1. **Subagent fan-out catches different failure classes.** A single reviewer collapses two distinct concerns: *did the implementation match the plan / spec?* (spec drift) and *is the code idiomatic, tested, and maintainable?* (code quality). Empirically these surface different defects — spec drift manifests as missing fields, wrong return shapes, or unimplemented branches; code-quality issues manifest as missing tests, weak typing, or unclear control flow. Splitting the role forces each reviewer to focus, and reduces the chance that one concern eclipses the other in a single review pass.
2. **State canonicality on the branch + TaskCreate enables crash recovery.** The PR description is a UI surface that can be edited, lost, or out of sync. The branch (commits) and TaskCreate (in-session task durability) are the canonical state. On resume, the skill reads the active branch tip and TaskList to infer where work paused, then re-dispatches from that point.
3. **Auto-detection keeps the trigger phrase short.** `execute Plan-NNN` is the default; the skill walks the merged-PR history for that plan and infers PR `M`. The explicit `PR #M` override exists for retry / out-of-order cases. This matters across 50–60 invocations — a 4-word trigger compounds into hours saved versus a 12-word "execute Plan-NNN PR #M from develop with state X" formula.
4. **The skill / ADR split versions the methodology correctly.** The decision (this ADR) is stable and rarely changes. The skill (executable form) evolves with each plan's lessons. Splitting them lets us keep the ADR small and let the skill body grow without re-opening the decision.

### Antithesis — The Strongest Case Against

A skeptical staff engineer would argue:

1. **Three subagents per PR is overkill for the doc-first repo's first code PRs.** PR-sized work is small (Plan-001 PR #1 is `pnpm` workspace scaffold + Vitest config). One implementer + one merge-time review pass is enough; two reviewers triple token burn for marginal additional signal.
2. **Skill files are Claude-Code-specific tooling.** [`AGENTS.md`](../../AGENTS.md) explicitly defines this repo as multi-tool (Claude, Codex, Cursor, Aider). Encoding the workflow in `.claude/skills/...` privileges Claude Code and creates a divergence risk: if Codex executes a plan with a different loop, the methodology fragments.
3. **Failure-mode taxonomy is premature optimization.** Naming `BLOCKED`, `NEEDS_CONTEXT`, `DONE_WITH_CONCERNS`, `DONE` before observing real failures encodes guesses as policy. Just retry on failure and let the actual failure modes inform a future taxonomy.
4. **TaskCreate is also Claude-Code-specific durability.** A multi-agent world needs a tool-neutral state layer (e.g., a `.agents/state/<plan>.md` file). Pinning state to TaskCreate makes resumption Claude-only.

### Synthesis — Why It Still Holds

1. **Subagent overhead is the cheapest insurance against rework.** Token cost of two reviewer subagents per PR is small relative to the cost of squash-merging a defect into `develop` and unwinding it. The user is the principal-engineer reviewer at the *PR* level; subagents are the line-of-defense *inside* the PR before human review. For very small PRs, the skill MAY collapse to implementer + single reviewer — see the [`plan-execution` skill](../../.claude/skills/plan-execution/SKILL.md) for the size-tier rule. The default is fan-out; the small-PR collapse is an explicit, documented variation.
2. **The methodology generalizes; only the execution mechanism is Claude-Code-specific.** The principles — branch off integration, fan out implementation/review, preserve state durably, gate squash on green CI — transfer directly to Codex (`/run` sequences), Cursor (`@-mention review` agents), and Aider (`/architect` flow). The Claude skill is the *current* implementation; AGENTS.md gets a pointer to the methodology so other agents can implement the same loop with their own tooling. Cross-tool divergence is contained to the executor, not the policy.
3. **The four failure modes are observed, not theoretical.** They surfaced in prior agentic sessions on this repo (BL-097/BL-098 doc work, ADR-022/023 drafting). Naming them lets the dispatch loop *route* them — e.g., `BLOCKED` halts, `NEEDS_CONTEXT` re-prompts, `DONE_WITH_CONCERNS` annotates the PR, `DONE` advances. Without names, every failure becomes a one-off improvisation. The taxonomy is small (4 cases), explicit, and revisable — adding a fifth mode is an edit, not a rewrite.
4. **Branch commits are the durable layer; TaskCreate is in-session bookkeeping.** State canonicality order is **branch commits > TaskCreate > draft PR description**. The branch is durable across sessions, machines, and tools — Codex resuming a Claude branch reads commits the same way. TaskCreate is the *current Claude session's* working memory, not the cross-session truth. The skill's resumption protocol reads the branch tip first; TaskList is consulted only to recover the *intent* of the next task within the current session.

---

## Alternatives Considered

### Option A: Three-Subagent Fan-out with Skill + ADR (Chosen)

- **What:** Skill triggers on `execute Plan-NNN[ PR #M]`; dispatches implementer subagent, then spec-reviewer + code-quality-reviewer in parallel; gates squash-merge on both reviewer DONEs + green CI. ADR captures the decision; skill captures the executable form.
- **Steel man:** Repeatable across 50–60 PRs with sub-linear cognitive load on the user. Subagent fan-out catches both spec drift and code-quality issues. State on branch + TaskCreate survives crashes. Auto-detection keeps the trigger short. ADR / skill split lets the decision stay stable while the executor evolves.
- **Weaknesses:** Three subagents per PR cost more tokens than a single-shot. Skill is Claude-Code-specific (mitigated by AGENTS.md cross-link + tool-neutral methodology principles). The four-mode failure taxonomy may need refinement after PR #1.

### Option B: Single-shot Implementation, Human-only Review (Rejected)

- **What:** Claude implements the full PR end-to-end in one pass; user reviews the PR before squash-merge. No subagent fan-out.
- **Steel man:** Simplest possible loop. Lowest token cost per PR. Forces the human user to engage on every PR rather than rubber-stamping.
- **Why rejected:** The user is principal-engineer reviewer at the *PR* level; expecting that role to also catch every spec-drift defect *and* every code-quality issue without an inner review loop is a recipe for either (a) defects landing on `develop` or (b) the user becoming a bottleneck. The inner subagent review is cheap insurance; the user's review focuses on "does this PR advance the plan" rather than "is this line of code idiomatic".

### Option C: Pair Programming — Claude Implements, Human Reviews Inline (Rejected)

- **What:** Claude pauses after each substantial code change; user reviews inline before Claude continues.
- **Steel man:** Tightest possible feedback loop. Defects surface within minutes. User builds intuition for Claude's failure modes.
- **Why rejected:** Defeats the agentic-execution goal. V1 has 50–60 PR-sized chunks; pair-programming each one would push the V1 timeline by months. The user explicitly opted for an autonomous-execution loop with PR-level review.

### Option D: Workflow in CONTRIBUTING.md, No Skill (Rejected)

- **What:** Document the workflow as prose in CONTRIBUTING.md; rely on Claude's instruction-following from the file rather than a skill.
- **Steel man:** Tool-neutral. Visible in the GitHub UI. No `.claude/`-specific tooling.
- **Why rejected:** CONTRIBUTING.md is *reference* — it's not loaded into Claude's context on every plan invocation. Claude would have to be told "read CONTRIBUTING.md first" each time, which defeats the short-trigger goal. The skill is the reliable trigger mechanism. CONTRIBUTING.md retains a *pointer* to the skill for visibility and cross-tool discoverability.

---

## Reversibility Assessment

- **Reversal cost:** Hours. Edit the skill file (or delete it) and supersede this ADR. No code migration; the methodology only governs *future* PRs.
- **Blast radius:** Future PRs only. Already-merged PRs are unaffected.
- **Migration path:** If the methodology proves wrong (e.g., three-subagent fan-out is consistently overkill), update the skill body, mark this ADR `superseded by ADR-NNN`, and continue.
- **Point of no return:** None. The methodology can be revised between any two PRs.

## Consequences

### Positive

- **Repeatable workflow across 50–60 PRs.** The user does not re-explain the loop on each invocation.
- **Crash and compaction recovery built in.** State on branch + TaskCreate lets the skill resume at the next subagent boundary.
- **Both spec-drift and code-quality defects caught pre-merge.** Subagent fan-out gives each concern a dedicated reviewer.
- **Auto-detection keeps the trigger short.** `execute Plan-NNN` (4 words) versus `execute Plan-NNN PR #M from develop with state X` (12 words) — compounds across V1.
- **Decision and execution versioned independently.** ADR captures policy; skill captures executor; each evolves on its own cadence.

### Negative (accepted trade-offs)

- **Three subagents per PR consume more tokens than single-shot.** Accepted because the cost of an undetected defect on `develop` is higher than the marginal token cost of two reviewer passes. Small-PR collapse rule is documented in the skill for cases where fan-out is genuinely overkill.
- **Skill file is Claude-Code-specific.** Accepted because: (a) the methodology principles are tool-neutral and documented in this ADR + AGENTS.md cross-link, (b) other agents can implement the same loop with their own tooling, (c) the V1 implementer is Claude Opus 4.7 per the user's stated implementer model.
- **Methodology may need refinement after Plan-001 PR #1.** Accepted because Type 1 reversibility means the cost of refinement is hours, not weeks.

### Unknowns

- **Optimal subagent fan-out for very small PRs.** The skill defaults to three-subagent fan-out; the small-PR collapse rule is a heuristic that needs validation against Plan-001 PR #1 (small) and Plan-001 PR #5 (medium-large). Will be revisited after Plan-001 completes.
- **Whether the four-mode failure taxonomy is complete.** The four modes (`BLOCKED`, `NEEDS_CONTEXT`, `DONE_WITH_CONCERNS`, `DONE`) are observed in prior sessions but may not cover all cases that emerge during code-execution PRs. Will be revisited after Plan-001 PR #1.

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| Prior agentic sessions on this repo (BL-097/BL-098 doc work, ADR-022/023 drafting) | In-repo session observation | The four failure modes (`BLOCKED`, `NEEDS_CONTEXT`, `DONE_WITH_CONCERNS`, `DONE`) were observed empirically, not invented — they recurred across multiple subagent dispatches before this ADR was drafted | `git log` Sessions A–N (2026-04-18 → 2026-04-26) |
| `docs/decisions/023-v1-ci-cd-and-release-automation.md` | In-repo ADR | CI workflow (§Axis 1), pre-commit hooks (§Axis 2), and release automation (§Axis 3) define the boundary the execution loop integrates with — squash-merge gates on `ci-gate`, commit format on commitlint, releases on release-please | [ADR-023](023-v1-ci-cd-and-release-automation.md) |
| `CONTRIBUTING.md` | In-repo policy | GitFlow-lite branch model + Conventional Branch + Conventional Commits define the *shape* of each PR; this ADR defines how Claude *executes* within that shape | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

No external (web/library/community) research was conducted — the methodology is a synthesis of in-repo session experience and existing project policy.

### Related ADRs

- [`ADR-015`](015-v1-feature-scope-definition.md) — V1 feature scope (17 features → 27 plans).
- [`ADR-022`](022-v1-toolchain-selection.md) — pnpm + Turbo + Vitest + ESLint stack.
- [`ADR-023`](023-v1-ci-cd-and-release-automation.md) — CI/CD and release automation; this ADR's execution loop integrates with §Axis 1 (CI workflow), §Axis 2 (pre-commit hooks), §Axis 3 (release-please).

### Related Documents

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — branch naming, commit format, PR workflow. Cross-links to the skill.
- [`CLAUDE.md`](../../CLAUDE.md) — Claude Code instructions; references this ADR as the execution-loop policy.
- [`AGENTS.md`](../../AGENTS.md) — cross-tool conventions for AI agents; references this ADR's methodology principles for non-Claude executors.
- [`.claude/skills/plan-execution/SKILL.md`](../../.claude/skills/plan-execution/SKILL.md) — the executable form of this ADR.
- [`docs/plans/001-shared-session-core.md`](../plans/001-shared-session-core.md) — first plan to use this methodology.

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-26 | Proposed | Drafted alongside the [`plan-execution` skill](../../.claude/skills/plan-execution/SKILL.md) in PR #5. Captures the methodology agreed in conversation during Session N immediately after BL-100/ADR-023 acceptance, in preparation for Plan-001 PR #1. Awaiting PR #5 review (final-review task gate) before promotion to `accepted`. |
