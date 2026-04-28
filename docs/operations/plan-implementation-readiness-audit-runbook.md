# Plan Implementation-Readiness Audit Runbook

> **Doc shape note.** This runbook is a process-methodology runbook (proactively
> invoked) rather than a failure-recovery runbook (incident-driven). It
> therefore follows the 12-section outline below instead of `docs/operations/template.md`'s
> Symptoms/Detection/Recovery shape. The methodology has no user-facing
> behavior change and no shipped artifact beyond the audit's amendments to
> existing plans, so it lives in `docs/operations/` rather than
> `docs/specs/` + an ADR + a plan.

## Purpose

Catch implementation-readiness defects in `approved` plans **before** code
execution begins. The four defect classes this audit hunts:

1. **Phase-level dep-ordering gaps** — a Phase imports from a plan/Phase in a
   later tier than its own (the Plan-001 Phase 5 → Plan-007/008 substrate gap
   GitHub PR-#11 surfaced retroactively).
2. **Tasks-block fabrication or omission** — `#### Tasks` blocks invented
   beyond what the spec/plan supports, or unstarted Phases lacking concrete
   step-by-step detail an implementer can execute.
3. **Cross-plan obligation drift** — `CP-NNN-M` declared on one side but not
   surfaced on the other; the Plan-007 cyclic-dep defect class.
4. **Substrate-vs-namespace conflation** — a plan claims to deliver a substrate
   another plan needs without the carve-out being documented in
   `cross-plan-dependencies.md` §5.

The audit runs once per tier across the V1 build order (Tiers 1 → 9). After
the initial sweep, the audit becomes self-perpetuating: future plans inherit
the audit gate at template-copy time via `docs/plans/000-plan-template.md`
Preconditions.

## When To Invoke

Invoke this runbook in any of the following situations:

- **Before promoting a plan from `review` → `approved`** (the plan-template
  Precondition gate). The promotion PR description must cite the audit's
  REVIEW.md.
- **Before any plan's first code-execution PR opens.** A plan whose `approved`
  state predates this runbook (e.g., Plans 001-027 at runbook adoption time)
  must clear the audit before its first code PR.
- **When `cross-plan-dependencies.md` §1 / §2 / §3 gains an edge or row
  affecting an already-`approved` plan.** Re-audit only the affected plan; do
  not re-walk the whole tier.
- **When a downstream-plan dep trace surfaces a substrate gap in an
  upstream-tier plan** (the cross-tier amendment contingency). Surface in the
  current tier's REVIEW.md; do not auto-amend a previously-committed tier.

Do NOT invoke for: cosmetic doc edits, ADR amendments that don't change
plan-internal references, or backlog-item authoring.

## Preconditions

- `docs/architecture/cross-plan-dependencies.md` is current (last commit reflects
  the latest `cross-plan-deps`-relevant ADR).
- The plans in scope are all at `approved` status (unless this audit run is
  the gate for a `review → approved` promotion).
- The audit calibration band (B1–B6) was established against Opus 4.7 during
  the Tier 1 pilot. Recent-data research subagents follow the project's
  research-standards convention (Opus 4.7 only, per `AGENTS.md`). The
  main-agent dep trace and per-Phase audit subagents MAY substitute an
  equivalently-capable model when Opus 4.7 is unavailable; record the
  substitution and any calibration drift in §Lessons Learned for that tier.
- Pre-audit naming sweep (`PR #N` → `Phase N`) has been committed; otherwise
  findings cite stale GitHub-auto-link-colliding shapes.
- `.agents/tmp/research/plan-readiness-audit/` working directory exists and is
  gitignored (it is, via the project's root `.gitignore`).

## Audit Procedure

The audit walks **Tiers 1 → 9 strictly sequentially**. Within a tier, plans
are walked sequentially by the main agent; within a plan, Phases are audited
in parallel by per-Phase subagents.

### Per-Tier Inner Loop

```text
For each Plan in Tier:
  1. Main agent reads plan + spec + cited ADRs + cross-plan-deps rows
     + upstream-tier findings.

  2. Main agent enumerates Phase boundaries from the plan body.

  3. Main agent dispatches N parallel Opus 4.7 subagents
     (one per Phase) with disjoint output paths under
     .agents/tmp/research/plan-readiness-audit/plan-NNN/.

  4. While subagents run, main agent performs the 8-dimension
     dep-ordering trace per Phase (D1-D8 below).

  5. Main agent waits for all subagents to complete.

  6. Main agent applies amendments to working copies under
     .agents/tmp/research/.../working/tier-K/plan-NNN.md
     (corpus files remain untouched throughout).

After all plans in Tier:
  7. Main agent synthesizes tier findings into tier-K-synthesis.md.

  8. Mechanical structural-skeleton verification on every working copy
     (G1 gate).

  9. Generate per-plan diff-plan-NNN.patch + REVIEW.md.

  10. advisor() sanity check on tier diff bundle.

  11. USER-REVIEW PAUSE: present REVIEW.md; user decides
      approve/reject/escalate per plan.

  12. SWAP: cp working copy → corpus location.

  13. Commit: "docs(repo): resolve Tier-K plan-readiness audit findings".

  14. Cleanup: rm -rf .agents/tmp/research/.../working/tier-K/.

  15. Tier-(K+1) waits for tier-K commit on develop.
```

### Concurrency

- Plans within a tier: **sequential** (main agent context).
- Phases within a plan: **parallel** (subagents are independent; disjoint
  output files).
- Tiers: **strictly serialized** (Tier-K cannot start until Tier-(K-1)
  commits to `develop`).
- Audit vs. code execution: **Tier 1 is the only blocker for Plan-001 Phase
  5**. Once Tier 1 commits, Plan-001 Phase 5 can begin even though Tiers 2-9
  are unfinished. The plan-template Precondition gates _each plan on its own
  tier's audit_ — so Plan-NNN at Tier-K can begin once Tier-K is committed,
  regardless of Tier-(K+1) status.

### Working-Copy + Swap Pattern

Audit edits never touch the corpus directly. The pattern:

1. Tag baseline: `git tag plan-readiness-audit-tier-K-baseline`.
2. Copy each plan in tier-K to
   `.agents/tmp/research/plan-readiness-audit/working/tier-K/plan-NNN.md`.
3. Extract structural skeleton (mechanical: invariant IDs, CP IDs, Phase
   headers, Required ADR list, Target Areas paths, test IDs) to
   `skeleton-plan-NNN.md`.
4. Subagents and main agent operate on working copies + axis files. Corpus
   untouched.
5. Mechanical skeleton verification at tier closing: every anchor from
   skeleton present in working copy. Block swap on failure (G1 gate).
6. Generate diff bundle + REVIEW.md.
7. advisor() sanity check.
8. USER-REVIEW PAUSE.
9. On approval: `cp working/tier-K/plan-NNN.md docs/plans/NNN-*.md` (the swap).
10. `git diff HEAD docs/plans/ docs/specs/ docs/architecture/` — final
    visual check.
11. Commit per tier.
12. Cleanup tier working files.

### Status Flip Rule

| Amendment Class                                                                                         | Plan Status After Swap                                |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Citation fix, surface-forward, narrowing of ambiguity, typo, header rename                              | Stays `approved`                                      |
| Adding `#### Tasks` subsection (writing-plans format)                                                   | Stays `approved` (additive)                           |
| New invariant promoted from narrative, new CP-NNN-M entry, new Phase added/renumbered, new Required ADR | Flip to `review`                                      |
| Behavior change in plan body                                                                            | Flip to `review`; likely also requires spec amendment |

**Default rule (when in doubt):** stay `approved` and surface the ambiguous
case to user review in REVIEW.md as an explicit question. The flip-to-`review`
path is reserved for amendments that meet the row criteria above; cosmetic,
wording, or structural-clarification edits that do not introduce new contracts
default to `approved`. This default biases against unnecessary status churn
(which would ripple through downstream plan-template Preconditions and gate
Plan-001 itself) while keeping the user as final arbiter on edge cases.

### Cross-Tier Amendment Contingency

When auditing Tier-N (N ≥ 2) surfaces a finding requiring an amendment to a
plan in a previously-committed Tier-K (K < N):

1. Surface the finding in the current tier's REVIEW.md under
   `## Upstream-Tier Amendments Required`.
2. Cite the offending Tier-N plan + Phase + finding ID, and the proposed
   amendment to the Tier-K plan.
3. Pause for user direction at the user-review step. The user picks:
   (a) amend Tier-K in this tier's commit (re-opens previously-`approved`
   plan briefly); (b) escalate to a `BL-NNN` follow-up;
   (c) reject the finding.
4. **Do not auto-amend a previously-committed tier.** The user-review
   checkpoint is the only authority that re-opens a sealed tier.

## Validation

The audit has three validation surfaces: **Tier 1 pilot acceptance gate**
(one-time, validates the methodology itself), **per-tier coverage gates G1-G6**
(every tier, mechanical, before swap), and **final synthesis verification**
(after Tier 9, validates the full corpus).

### Tier 1 Pilot — Two-Part Acceptance Gate

Tier 1 doubles as a methodology pilot. Both parts must pass before Tier 2
starts.

**Part A — Regression (does the methodology catch the known failure?)**

The methodology must reproduce the canonical Plan-001 Phase 5 finding when
run against the pre-carve-out baseline (`git checkout` of pre-PR-#11 state on
a throwaway branch). Specifically, the per-Phase completeness subagent for
Plan-001 Phase 5 must produce findings that include:

- F-001-5-XX (critical, dimension 10) — Phase 5 imports JSON-RPC wire
  substrate from Plan-007 (Tier 4); breaks build-order
- F-001-5-XX (critical, dimension 10) — Phase 5 imports tRPC v11 server
  skeleton from Plan-008 (Tier 5); breaks build-order

If the methodology cannot reproduce this finding on the pre-carve-out state,
it is broken; fix before proceeding.

| Criterion                           | Pass condition                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 — Canonical-finding reproduction | Pre-PR-#11 audit produces F-001-5-XX critical findings citing both Plan-007 (JSON-RPC wire) and Plan-008 (tRPC v11 server skeleton) substrate imports |
| A2 — Build-order corollary          | Same audit flags Plan-001 Phase 5 tier-placement (D5) as critical under pre-PR-#11 dep map                                                            |
| A3 — No false-finding bleed         | ≤2 false-positive critical findings on Plan-001 Phases 1-4 (correctly merged)                                                                         |

**Part B — Calibration band (quantitative)**

Run the audit on Tier 1 at current `develop` HEAD. Measure each metric;
record actual values in §Lessons Learned.

| Metric                                         | Target band                                                                    | Out-of-band signal                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| B1 — Critical findings per Phase               | 0–2 average; 0–4 max for any single Phase                                      | >2 average → methodology too strict                                      |
| B2 — Total findings per plan                   | 5–50 (across all Phases)                                                       | <5 → too lenient; >50 → over-amending                                    |
| B3 — Tasks-authored vs. blocking-finding ratio | ≥2:1                                                                           | <2:1 → spec/plan too thin to support Tasks authoring                     |
| B4 — User-review walltime per plan             | 30 min – 2 hours                                                               | >2 hours → REVIEW.md too dense; refactor schema                          |
| B5 — advisor() signal-to-noise                 | ≥1 substantive critique per tier diff bundle, ≤5 cosmetic-only acknowledgments | All-cosmetic → advisor not adding value                                  |
| B6 — Status flip rate                          | 0–1 plan flips to `review` per tier                                            | >1 → audit making contract changes that should have been spec amendments |

**Disposition after Tier 1 commit:**

- All within band: record metrics in §Lessons Learned; proceed to Tier 2 unmodified.
- One metric out of band: document in §Lessons Learned; adjust corresponding
  dimension/threshold; proceed to Tier 2 with adjustment noted.
- Multiple metrics out of band: pause; revise §Subagent Prompt Template
  and/or §Main-Agent Dep-Trace Dimensions before Tier 2 starts; re-run Tier
  1 calibration on the pilot tier.
- Part A regression fails: methodology is broken; do not proceed past Tier 1
  until reproduced.

### Per-Tier Coverage Gates (G1-G6)

All six gates pass → swap commits. Any fail → block, surface to user.

| Gate | Check                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | Structural skeleton preserved (every anchor from baseline present in working copy)                                                                                                                         |
| G2   | No critical findings unaddressed                                                                                                                                                                           |
| G3   | Per-plan diff line-count within reasonable bounds: amendments excluding `#### Tasks` blocks must be < 1.5× original plan length; `#### Tasks` blocks have a separate budget of < 50 step-entries per Phase |
| G4   | No fabricated specs (every Tasks Step traces to a Spec-NNN AC or invariant)                                                                                                                                |
| G5   | `rg "Plan-\d+ PR #\d+" docs/` returns 0 AND `rg "PR #\d+" docs/plans/` returns 0 (catches both qualified `Plan-NNN PR #N` and bare `PR #N` regressions); `pr_preparations` table name preserved            |
| G6   | Tier-(K-1) commit on develop                                                                                                                                                                               |

### Final Synthesis Verification (after Tier 9 ships)

| Check                                             | Mechanism                                                   |
| ------------------------------------------------- | ----------------------------------------------------------- |
| Every unstarted Phase has `#### Tasks` subsection | Mechanical grep                                             |
| No corpus regressions                             | `git diff plan-readiness-audit-tier-1-baseline HEAD` review |
| Runbook §Lessons Learned populated                | Visual check                                                |
| Backlog escalations resolved or scheduled         | Every `BL-NNN` has owner + status                           |
| Plan-template updated                             | Mechanical check                                            |
| Tags exist                                        | `git tag --list "plan-readiness-audit-*"`                   |

### Failure Mode Recovery

| Signal                     | Cause                                 | Recovery                                 |
| -------------------------- | ------------------------------------- | ---------------------------------------- |
| G1 fails after swap        | Working-copy edit clobbered an anchor | `git revert` tier swap; re-run audit     |
| G4 fails post-amendment    | Subagent invented behavior            | `git revert`; spec needs amendment first |
| Multiple tiers fail G3     | Methodology over-amending             | Pause; revisit dimensions                |
| User rejects ≥3 tier swaps | User disagrees with methodology       | Pause; reconcile                         |

## Status Promotion Gate

A plan cannot transition `review → approved` (or open its first
code-execution PR if already-`approved` predating this runbook) without:

1. Completing the audit at its tier's place in the build order.
2. The plan's REVIEW.md showing `Decision Required` resolved (approve all,
   approve subset + escalations, or reject).
3. The promotion-PR description citing the audit-completion date and the
   tier's git-tag (`plan-readiness-audit-tier-K-complete`).

A plan attempting promotion without audit fails the plan-template
Preconditions checklist. The audit-complete checkbox is added at template-copy
time, so future plans inherit the gate without action.

A `cross-plan-dependencies.md` §1 / §2 / §3 amendment affecting an
already-`approved` plan triggers re-audit of the affected plan only (not the
whole tier).

## Escalation

Escalate to user direction when any of the following triggers fire:

- **G1 fails after working-copy edits.** Skeleton anchor was dropped during
  amendment; the amendment is structurally unsafe. Stop, restore anchor, or
  revise the amendment.
- **G4 fails post-amendment.** A `#### Tasks` Step traces to no
  Spec-NNN AC or invariant — subagent fabricated. Surface in REVIEW.md;
  default response is to file a finding for source amendment instead of
  authoring the fabricated Task.
- **Subagent disagrees with main agent.** Per-Phase completeness subagent
  flags a finding the main-agent dep trace did not catch (or vice versa).
  Both findings go into REVIEW.md; the user decides which to keep.
- **Cross-tier amendment surfaces.** Tier-N audit finds a Tier-K (K < N) plan
  needs amendment. Surface in current tier's REVIEW.md; user decides
  (a) amend Tier-K alongside Tier-N, (b) escalate to backlog, (c) reject.
- **Multiple tiers fail any G-gate (G2-G6).** Methodology issue, not a
  per-tier finding. Pause the audit; reconcile dimensions before continuing.
- **User rejects ≥3 tier swaps.** Methodology disagreement at scale. Stop;
  reconcile with user before any further tiers.

For all escalation triggers: the audit pauses at the user-review checkpoint
(per-tier step 11). Do not proceed past that checkpoint without user
direction.

## Subagent Prompt Template

Each per-Phase completeness subagent gets the following self-contained
prompt. The main agent dispatches one subagent per Phase, in parallel, with
disjoint output paths.

````text
ROLE: You are a per-Phase completeness auditor for an AI Sidekicks V1
implementation plan. You audit ONE Phase of ONE plan, in isolation, and
produce a findings file.

MODEL: You must run as Opus 4.7. Refuse if other model.

SCOPE: Plan-NNN, Phase N (single Phase only).

INPUTS YOU MUST READ:
- docs/plans/NNN-*.md (the plan body)
- docs/specs/NNN-*.md (the paired spec)
- docs/architecture/cross-plan-dependencies.md
- Every ADR cited in the plan's "Required ADRs" row
- Findings files from upstream-tier audits, if present, at
  .agents/tmp/research/plan-readiness-audit/plan-MMM/

OUTPUT FILE:
.agents/tmp/research/plan-readiness-audit/plan-NNN/phase-N-completeness.md

THE 10 DIMENSIONS YOU AUDIT:

1. Schema completeness — table/column Phase-N owns lacks type, nullability,
   FK, index, or semantics-owner citation for forward-declared elements.
2. Contract completeness — API/IPC method/event/error Phase-N introduces
   lacks typed shape (or pointer to schema).
3. File path concreteness — file/module to create lacks exact path, or path
   conflicts with cross-plan-deps §2 ownership.
4. Test specificity — test cited as "tests CRUD" without assertion, or test
   doesn't map to Spec-NNN AC.
5. Implementation step concreteness — step lacks file path, code block, or
   exact command where the writing-plans format requires one.
   AUTHORING RULE: if the source plan/spec/ADRs do not contain enough
   information to author a `#### Tasks` Step concretely, you do NOT author a
   Task block — you file a finding (severity: critical) requesting source
   amendment. NO FABRICATION.
6. Cross-plan obligations bidirectionality — CP-NNN-M lacks source+anchor,
   or consumer plan lacks return-cite.
7. Invariant verification — I-NNN-M lacks Verification line citing
   test/migration/PR.
8. Required ADR coverage — non-trivial decision in Phase-N body lacks ADR
   citation.
9. Spec coverage — Spec-NNN AC has no test, or Spec-NNN Required Behavior
   has no implementation step.
10. Dependency completeness — Phase-N imports from outside-plan source not
    shipped by an upstream Plan/Phase in lower Tier.

OUTPUT FORMAT:

# Plan-NNN Phase N — Completeness Audit

## Findings

### F-NNN-N-01 — {Short headline}
**Dimension:** {1..10 ID}
**Severity:** critical | major | minor | nit
**Source location:** {file:line}
**Finding:** {what's missing}
**Evidence:** {quoted fragment}
**Proposed amendment:**
```markdown
{concrete diff or new text}
````

**Escalation target:** plan-amendment | spec-amendment | dep-map-amendment | backlog-item

## Coverage Summary

| Dimension | Findings | Notes |
| --------- | -------- | ----- |

## Out-of-Scope (escalated as findings, not amendments)

- ...

SEVERITY RUBRIC:

- critical — Implementer cannot proceed without inventing missing behavior.
  Block tier swap; requires user review.
- major — Implementer would likely guess wrong; ambiguous behavior. Inline
  amendment.
- minor — Implementer can proceed but loses time/precision. Inline amendment.
- nit — Stylistic, cosmetic, low-value-add. Skip or batch into single
  cosmetic-cleanup amendment.

HARD RULE (anti-fabrication):
If the spec doesn't tell you what assertion to write in Step 1, you do NOT
invent one. You file a finding (severity: critical, dimension: 5) instead.

WRITING-PLANS FORMAT (Tasks block authoring):
For unstarted Phases (no code merged for this Phase yet), author a `#### Tasks`
subsection nested under the existing Phase header. Existing Phase prose
(Precondition, Goal, scope bullets) is preserved verbatim. Each Task carries
two extra fields beyond raw writing-plans format:

- **Spec coverage:** Spec-NNN AC-X (closes Dimension 9 loop)
- **Verifies invariant:** I-NNN-M (closes Dimension 7 loop, when applicable)

If you cannot author a Task concretely from source materials, file a Finding
instead (per the hard rule above).

````

## Main-Agent Dep-Trace Dimensions

The main agent walks the 8 dep-ordering dimensions per Phase of each plan
in tier scope. These complement the 10 completeness dimensions handled by
subagents.

| ID | Dimension | Question |
|----|-----------|----------|
| D1 | Phase-level import surface | What files does Phase-N create or modify? What does each file import from outside this plan? *For unstarted Phases (no code yet), the auditor reads the plan body's declared file list (Target Areas + Phase scope bullets) and infers imports from the spec/contracts the plan cites — not actual source.* |
| D2 | Upstream Phase sufficiency | For each external import, is the source shipped by an upstream Plan/Phase in a strictly lower Tier (or earlier Phase within the same plan)? |
| D3 | Plan-header dep accuracy | Does the plan's `Dependencies` row enumerate every plan whose code Phase-N imports from? |
| D4 | Cross-plan-deps §3 alignment | Does §3 of `cross-plan-dependencies.md` show every edge Phase-N needs? Are edges typed correctly? |
| D5 | Tier-placement sufficiency | If Phase-N's deps are at Tier-T, the plan must be placed at Tier ≥ T+1 (or carve-out justification exists). |
| D6 | Forward-declared schema bidirectionality | If Phase-N references a forward-declared column/table, does the §1 Contested-table row cite both CREATE-owner and semantics-owner? |
| D7 | Cross-plan ownership consistency | Does Phase-N create or modify a path/table that another plan claims ownership of in §1 / §2? |
| D8 | Substrate-vs-namespace pattern | If Phase-N depends on a substrate-deliverable from a later-tier plan, is the carve-out documented in §5? |

**Output:**
`.agents/tmp/research/plan-readiness-audit/plan-NNN/main-agent-dep-trace.md`

## REVIEW.md Schema

Every tier swap presents a REVIEW.md to the user. Schema is non-negotiable
(the runbook's mechanical verification depends on the headings).

```markdown
# Tier-K Audit Review — YYYY-MM-DD

## Plans Audited In This Tier
- Plan-XXX (X findings: A critical, B major, C minor)

## Per-Plan Diffs
### Plan-XXX
- Lines added: NN
- Lines removed: NN
- Structural anchors preserved: ✅ (count/count)
- Status flip: stays approved | flip to review

#### Findings → Amendments Mapping
| Finding ID | Severity | Dimension | Amendment Target | Diff Hunk |
|------------|----------|-----------|------------------|-----------|
| F-XXX-1-01 | critical | 10 | dep-map §3 | line NNN |

#### Diff Preview
[link to working/tier-K/diff-plan-XXX.patch]

## Cross-Cutting Findings This Tier
- C-K-01: ...

## Upstream-Tier Amendments Required
- (omit section if none; populated when Tier-N audit surfaces a Tier-K, K<N, amendment)

## Findings Escalated to Backlog (proposed BL-NNN)
- BL-XXX: ...

## Decision Required
- [ ] Approve all → swap + commit
- [ ] Approve subset: ...
- [ ] Reject → adjust
- [ ] Escalate item(s) to backlog: ...
````

## Lessons Learned

<!-- Populated post-audit from SYNTHESIS.md after Tier 9 ships. Per-tier
     calibration metrics (B1-B6 actual values), dimension adjustments, and
     methodology revisions land here. -->

## Related Architecture / Specs / Plans

- [`docs/architecture/cross-plan-dependencies.md`](../architecture/cross-plan-dependencies.md)
  — §1 (table ownership), §2 (path ownership), §3 (dep edges), §5 (canonical
  build order). The dep-trace dimensions (D1-D8) are anchored to this doc.
- [`docs/plans/000-plan-template.md`](../plans/000-plan-template.md) —
  Preconditions section carries the audit gate; new plans inherit it at
  template-copy time.
- [`docs/decisions/023-v1-ci-cd-and-release-automation.md`](../decisions/023-v1-ci-cd-and-release-automation.md)
  — defines the GitFlow-lite branch model the audit's per-tier commits
  follow.
- [`AGENTS.md`](../../AGENTS.md) — owns the parallel-subagent dispatch
  convention, the transient research-artifact pattern under
  `.agents/tmp/research/<topic>/`, and the surface-forward-then-delete rule
  this runbook is itself an instance of.
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — branch naming, commit
  message format, and squash-merge workflow used for per-tier swap commits.
- [`README.md`](../../README.md) — V1 feature list and tier graph the audit
  walks.
