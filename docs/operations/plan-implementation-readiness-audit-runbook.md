# Plan Implementation-Readiness Audit Runbook

> **Doc shape note.** This runbook is a process-methodology runbook (proactively invoked) rather than a failure-recovery runbook (incident-driven). It therefore follows the 12-section outline below instead of `docs/operations/template.md`'s Symptoms/Detection/Recovery shape. The methodology has no user-facing behavior change and no shipped artifact beyond the audit's amendments to existing plans, so it lives in `docs/operations/` rather than `docs/specs/` + an ADR + a plan.

## Purpose

Catch implementation-readiness defects in `approved` plans **before** code execution begins. The four defect classes this audit hunts:

1. **Phase-level dep-ordering gaps** — a Phase imports from a plan/Phase in a later tier than its own (the Plan-001 Phase 5 → Plan-007/008 substrate gap GitHub PR-#11 surfaced retroactively).
2. **Tasks-block fabrication or omission** — `#### Tasks` blocks invented beyond what the spec/plan supports, or unstarted Phases lacking concrete step-by-step detail an implementer can execute.
3. **Cross-plan obligation drift** — `CP-NNN-M` declared on one side but not surfaced on the other; the Plan-007 cyclic-dep defect class.
4. **Substrate-vs-namespace conflation** — a plan claims to deliver a substrate another plan needs without the carve-out being documented in `cross-plan-dependencies.md` §5.

The audit runs once per tier across the V1 build order (Tiers 1 → 9). After the initial sweep, the audit becomes self-perpetuating: future plans inherit the audit gate at template-copy time via `docs/plans/000-plan-template.md` Preconditions.

## When To Invoke

Invoke this runbook in any of the following situations:

- **Before promoting a spec from `draft`/`review` → `approved`** (the spec-template Precondition gate per §Spec-Status Promotion Gate below). The promotion PR description must cite the spec's doc-first-before-coding attestation.
- **Before promoting a plan from `review` → `approved`** (the plan-template Precondition gate). The promotion PR description must cite the audit's REVIEW.md. **For a post-adoption new plan, the same Precondition checkbox additionally gates `draft → review`:** the audit runs against the `draft` plan — targeted (the Plan-014-delta shape) when the plan joins a tier whose audit already closed — its pass ticks the checkbox, and the subsequent `review → approved` promotion cites the same audit's REVIEW.md (no second audit absent a scope change between the two promotions). First exercised by Plan-028 (campaign B18, 2026-07-22).
- **Before any plan's first code-execution PR opens.** A plan whose `approved` state predates this runbook (e.g., Plans 001-027 at runbook adoption time) must clear the audit before its first code PR.
- **When `cross-plan-dependencies.md` §1 / §2 / §3 gains an edge or row affecting an already-`approved` plan.** Re-audit only the affected plan; do not re-walk the whole tier.
- **When a downstream-plan dep trace surfaces a substrate gap in an upstream-tier plan** (the cross-tier amendment contingency). Surface in the current tier's REVIEW.md; do not auto-amend a previously-committed tier.

Do NOT invoke for: cosmetic doc edits, ADR amendments that don't change plan-internal references, or backlog-item authoring.

## Preconditions

- `docs/architecture/cross-plan-dependencies.md` is current (last commit reflects the latest `cross-plan-deps`-relevant ADR).
- The plans in scope are all at `approved` status (unless this audit run is the gate for a `review → approved` promotion, or a new-plan `draft` audit per §When To Invoke).
- The audit calibration band (B1–B6) was established against Opus 4.7 during the Tier 1 pilot. Audit, dep-trace, and recent-data research subagents run the session's frontier-tier model, inherited at dispatch per `AGENTS.md` §Model Policy. On a model-family change (e.g. Opus → Fable), record any calibration drift against B1–B6 in §Lessons Learned for that tier.
- Pre-audit naming sweep (`PR #N` → `Phase N`) has been committed; otherwise findings cite stale GitHub-auto-link-colliding shapes.
- `.agents/tmp/research/plan-readiness-audit/` working directory exists and is gitignored (it is, via the project's root `.gitignore`).

## Audit Procedure

The audit walks **Tiers 1 → 9 strictly sequentially**. Within a tier, plans are walked sequentially by the main agent; within a plan, Phases are audited in parallel by per-Phase subagents.

### Per-Tier Inner Loop

```text
For each Plan in Tier:
  1. Main agent reads plan + spec + cited ADRs + cross-plan-deps rows
     + upstream-tier findings.

  2. Main agent enumerates Phase boundaries from the plan body.

  3. Main agent dispatches N parallel frontier-model subagents
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
      approve/reject/escalate per plan. REVIEW.md MUST confirm each
      Phase exercises the §Adversarial-Tampering Boundary threat classes
      from `000-plan-template.md` §Test And Verification Plan; surface
      gaps as findings (not amendments — subagent-fabrication risk).

  12. SWAP: cp working copy → corpus location.

  13. Commit: "docs(repo): resolve Tier-K plan-readiness audit findings".

  14. Cleanup: rm -rf .agents/tmp/research/.../working/tier-K/.

  15. Tier-(K+1) waits for tier-K commit on develop.
```

### Concurrency

- Plans within a tier: **sequential** (main agent context).
- Phases within a plan: **parallel** (subagents are independent; disjoint output files).
- Tiers: **strictly serialized** (Tier-K cannot start until Tier-(K-1) commits to `develop`).
- Audit vs. code execution: **Tier 1 is the only blocker for Plan-001 Phase 5**. Once Tier 1 commits, Plan-001 Phase 5 can begin even though Tiers 2-9 are unfinished. The plan-template Precondition gates _each plan on its own tier's audit_ — so Plan-NNN at Tier-K can begin once Tier-K is committed, regardless of Tier-(K+1) status.

### Working-Copy + Swap Pattern

Audit edits never touch the corpus directly. The pattern:

1. Tag baseline: `git tag plan-readiness-audit-tier-K-baseline`.
2. Copy each plan in tier-K to `.agents/tmp/research/plan-readiness-audit/working/tier-K/plan-NNN.md`.
3. Extract structural skeleton (mechanical: invariant IDs, CP IDs, Phase headers, Required ADR list, Target Areas paths, test IDs) to `skeleton-plan-NNN.md`.
4. Subagents and main agent operate on working copies + axis files. Corpus untouched.
5. Mechanical skeleton verification at tier closing: every anchor from skeleton present in working copy. Block swap on failure (G1 gate).
6. Generate diff bundle + REVIEW.md.
7. advisor() sanity check.
8. USER-REVIEW PAUSE.
9. On approval: `cp working/tier-K/plan-NNN.md docs/plans/NNN-*.md` (the swap).
10. `git diff HEAD docs/plans/ docs/specs/ docs/architecture/` — final visual check.
11. Commit per tier.
12. Cleanup tier working files.

### Status Flip Rule

| Amendment Class | Plan Status After Swap |
| --- | --- |
| Citation fix, surface-forward, narrowing of ambiguity, typo, header rename | Stays `approved` |
| Adding `#### Tasks` subsection (writing-plans format) | Stays `approved` (additive) |
| New invariant promoted from narrative, new CP-NNN-M entry, new Phase added/renumbered, new Required ADR | Flip to `review` |
| Behavior change in plan body | Flip to `review`; likely also requires spec amendment |

**Default rule (when in doubt):** stay `approved` and surface the ambiguous case to user review in REVIEW.md as an explicit question. The flip-to-`review` path is reserved for amendments that meet the row criteria above; cosmetic, wording, or structural-clarification edits that do not introduce new contracts default to `approved`. This default biases against unnecessary status churn (which would ripple through downstream plan-template Preconditions and gate Plan-001 itself) while keeping the user as final arbiter on edge cases.

### Cross-Tier Amendment Contingency

When auditing Tier-N (N ≥ 2) surfaces a finding requiring an amendment to a plan in a previously-committed Tier-K (K < N):

1. Surface the finding in the current tier's REVIEW.md under `## Upstream-Tier Amendments Required`.
2. Cite the offending Tier-N plan + Phase + finding ID, and the proposed amendment to the Tier-K plan.
3. Pause for user direction at the user-review step. The user picks: (a) amend Tier-K in this tier's commit (re-opens previously-`approved` plan briefly); (b) escalate to a `BL-NNN` follow-up; (c) reject the finding.
4. **Do not auto-amend a previously-committed tier.** The user-review checkpoint is the only authority that re-opens a sealed tier.

## Validation

The audit has three validation surfaces: **Tier 1 pilot acceptance gate** (one-time, validates the methodology itself), **per-tier coverage gates G1-G7** (every tier, mechanical, before swap), and **final synthesis verification** (after Tier 9, validates the full corpus).

### Tier 1 Pilot — Two-Part Acceptance Gate

Tier 1 doubles as a methodology pilot. Both parts must pass before Tier 2 starts.

**Part A — Regression (does the methodology catch the known failure?)**

The methodology must reproduce the canonical Plan-001 Phase 5 finding when run against the pre-carve-out baseline (`git checkout` of pre-PR-#11 state on a throwaway branch). Specifically, the per-Phase completeness subagent for Plan-001 Phase 5 must produce findings that include:

- F-001-5-XX (critical, dimension 10) — Phase 5 imports JSON-RPC wire substrate from Plan-007 (Tier 4); breaks build-order
- F-001-5-XX (critical, dimension 10) — Phase 5 imports tRPC v11 server skeleton from Plan-008 (Tier 5); breaks build-order

If the methodology cannot reproduce this finding on the pre-carve-out state, it is broken; fix before proceeding.

| Criterion | Pass condition |
| --- | --- |
| A1 — Canonical-finding reproduction | Pre-PR-#11 audit produces F-001-5-XX critical findings citing both Plan-007 (JSON-RPC wire) and Plan-008 (tRPC v11 server skeleton) substrate imports |
| A2 — Build-order corollary | Same audit flags Plan-001 Phase 5 tier-placement (D5) as critical under pre-PR-#11 dep map |
| A3 — No false-finding bleed | ≤2 false-positive critical findings on Plan-001 Phases 1-4 (correctly merged) |

**Part B — Calibration band (quantitative)**

Run the audit on Tier 1 at current `develop` HEAD. Measure each metric; record actual values in §Lessons Learned.

| Metric | Target band | Out-of-band signal |
| --- | --- | --- |
| B1 — Critical findings per Phase | 0–2 average; 0–4 max for any single Phase | >2 average → methodology too strict |
| B2 — Total findings per plan | 5–50 (across all Phases) | <5 → too lenient; >50 → over-amending |
| B3 — Tasks-authored vs. blocking-finding ratio | ≥2:1 | <2:1 → spec/plan too thin to support Tasks authoring |
| B4 — User-review walltime per plan | 30 min – 2 hours | >2 hours → REVIEW.md too dense; refactor schema |
| B5 — advisor() signal-to-noise | ≥1 substantive critique per tier diff bundle, ≤5 cosmetic-only acknowledgments | All-cosmetic → advisor not adding value |
| B6 — Status flip rate | 0–1 plan flips to `review` per tier | >1 → audit making contract changes that should have been spec amendments |

**Disposition after Tier 1 commit:**

- All within band: record metrics in §Lessons Learned; proceed to Tier 2 unmodified.
- One metric out of band: document in §Lessons Learned; adjust corresponding dimension/threshold; proceed to Tier 2 with adjustment noted.
- Multiple metrics out of band: pause; revise §Subagent Prompt Template and/or §Main-Agent Dep-Trace Dimensions before Tier 2 starts; re-run Tier 1 calibration on the pilot tier.
- Part A regression fails: methodology is broken; do not proceed past Tier 1 until reproduced.

### Per-Tier Coverage Gates (G1-G7)

All seven gates pass → swap commits. Any fail → block, surface to user.

| Gate | Check |
| --- | --- |
| G1 | Structural skeleton preserved (every anchor from baseline present in working copy) |
| G2 | No critical findings unaddressed |
| G3 | Per-plan diff line-count within reasonable bounds: amendments excluding `#### Tasks` blocks must be < 1.5× original plan length; `#### Tasks` blocks have a separate budget of < 50 step-entries per Phase |
| G4 | No fabricated specs (every Tasks Step traces to a Spec-NNN AC or invariant) |
| G5 | Task bodies are specification, never a shipment ledger. A PR reference (bare `PR #N` or qualified `Plan-NNN PR #N` — the bare pattern subsumes the qualified form) inside an audit-authored `#### Tasks` block is DENIED when it records shipment or dispatch state (what the Shipment Manifest, Progress Log, and dependency-map dispatch state own) or appears bare with no attributive function, and EXEMPT when its function is provenance attribution of a mechanism the task specifies — review-round findings in any spelling (`Codex PR #N round M`, `PR #N round M`, `PR #N Codex round M`, `PR #N review round M`), dated amendment or follow-up vehicles, design baselines, precondition discharge records, and dependency-rationale cross-references to shipment facts recorded canonically elsewhere. The exemption keys on the reference's semantic kind, never on one surface spelling (re-scoped 2026-08-01 from the original require-empty rule after the calibration census: 21 matching task lines / 48 references across Plans 004, 006, 009, 010 — every one adjudicated exempt provenance attribution, zero shipment-ledger records). Mechanics: for each tier plan run `awk '/^#### Tasks/{f=1;next} /^#{1,4} /{f=0} f' <plan>.md \| rg "PR #\d+"` as a surfacing screen and adjudicate every hit by kind — output is no longer required empty. Provenance surfaces (Progress Log, Shipment Manifest, Preconditions, Decision Log, dependency-map dispatch state) legitimately carry PR references and are exempt as before. `pr_preparations` table name preserved |
| G6 | Tier-(K-1) commit on develop |
| G7 | Table-total arithmetic clean: running the standalone table-total checker over the tier-changed governance docs (`node --experimental-strip-types tools/docs-corpus/bin/table-total-check.ts <docs>`) exits 0 — every `corpus:total-check`-marked breakdown table reconciles with its own column sum, in-table **Total** row, and declared prose totals (the lint at `tools/docs-corpus/lib/table-total-coherence.ts`). Use the table-total checker, **not** the full `pre-commit-runner.ts`: gates run on pre-swap working copies under `.agents/tmp/.../working/`, where the runner's `cite-target-existence` would resolve `../specs/...`-relative links from that base and mint false missing-target failures, and a gate named for arithmetic must not red-light on an unrelated cite / mermaid / manifest finding. The table-total check is within-document only, so it is correct on the working copies. This mechanizes only the within-document arithmetic slice; the cross-document agreement and prose-restatement reciprocity are judgment work recorded per §Cross-Document Design-Fact Reciprocity, not gated here. |

### Final Synthesis Verification (after Tier 9 ships)

| Check | Mechanism |
| --- | --- |
| Every unstarted Phase has `#### Tasks` subsection | Mechanical grep |
| No corpus regressions | `git diff plan-readiness-audit-tier-1-baseline HEAD` review |
| Runbook §Lessons Learned populated | Visual check |
| Backlog escalations resolved or scheduled | Every `BL-NNN` has owner + status |
| Plan-template updated | Mechanical check |
| Tags exist | `git tag --list "plan-readiness-audit-*"` |

### Failure Mode Recovery

| Signal | Cause | Recovery |
| --- | --- | --- |
| G1 fails after swap | Working-copy edit clobbered an anchor | `git revert` tier swap; re-run audit |
| G4 fails post-amendment | Subagent invented behavior | `git revert`; spec needs amendment first |
| Multiple tiers fail G3 | Methodology over-amending | Pause; revisit dimensions |
| User rejects ≥3 tier swaps | User disagrees with methodology | Pause; reconcile |

## Status Promotion Gate

A plan cannot transition `review → approved` (or open its first code-execution PR if already-`approved` predating this runbook) without:

1. Completing the audit at its tier's place in the build order.
2. The plan's REVIEW.md showing `Decision Required` resolved (approve all, approve subset + escalations, or reject).
3. The promotion-PR description citing the audit-completion date and the tier's git-tag (`plan-readiness-audit-tier-K-complete`).

A plan attempting promotion without audit fails the plan-template Preconditions checklist. The audit-complete checkbox is added at template-copy time, so future plans inherit the gate without action.

A `cross-plan-dependencies.md` §1 / §2 / §3 amendment affecting an already-`approved` plan triggers re-audit of the affected plan only (not the whole tier).

## Spec-Status Promotion Gate

A spec cannot transition `draft → review → approved` without:

1. All declared `Depends On` specs and ADRs being at terminal status (`approved` for specs; `accepted` for ADRs). Forward-declared draft deps fail this gate.
2. All blocking `## Open Questions` resolved or explicitly deferred (referencing a BL-NNN follow-up). Open questions that gate Required Behavior MUST be resolved, not deferred.
3. **Doc-first-before-coding attestation.** No downstream plan PR has shipped code citing this spec's Required Behavior, Default Behavior, Fallback Behavior, or Acceptance Criteria rows while the spec was in `draft` or `review`. If a violation exists (the Spec-027 / Plan-007 PR #16 historical case), the promotion PR description MUST enumerate the violating PRs and attest that the spec body as promoted remains authoritative for the rows already shipped (a _post-hoc affirmation_, not a _retroactive approval_).
4. The promotion-PR description citing this runbook §Spec-Status Promotion Gate by name.

A spec attempting promotion without clearing these checks fails the spec-template Preconditions checklist. The Preconditions section is added at template-copy time, so future specs inherit the gate without action.

This gate is **lighter-weight than the plan-readiness audit**: no `#### Tasks` block authoring, no per-Phase subagent dispatch, no REVIEW.md schema. The spec gate enforces only (a) dependency-graph closure (criterion 1), (b) open-question discipline (criterion 2), and (c) the doc-first invariant (criterion 3) — the structural properties that make the spec a stable contract for downstream plan-readiness audits to consume. Specs do not have phases, invariants-of-implementation, or cross-plan obligations of their own; the heavy machinery lives at the plan tier.

A spec-body amendment after promotion (typo, citation, narrowing) does NOT re-trigger this gate. Amendments that change Required Behavior, Acceptance Criteria, or `Depends On` flip the spec back to `review` (mirrors the plan §Status Flip Rule) and re-trigger the gate at the next promotion attempt.

## Per-Phase Audit Semantics

Audit-completeness applies at phase granularity for plans that ship across tiers via the substrate-vs-namespace decomposition pattern (see [cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order)). Each phase that opts into the per-phase mechanism declares its status via the `audit_status` precondition entry (see [preflight-contract.md](../../.claude/skills/plan-execution/references/preflight-contract.md) Gate 5); phases without a declaration fall back to the plan-level `Plan-readiness audit complete` checkbox via Gate 2's legacy path. Two values are permitted:

| `status` | YAML shape | Meaning |
| --- | --- | --- |
| `complete` | `{ type: audit_status, status: complete, evidence_pr: <PR#>, baseline_tag: <git tag> }` | The phase was covered by the tier audit at its tier's place in the build order. `evidence_pr` + `baseline_tag` are documentary (preserved for downstream reviewers and archaeology) — the act of declaring `complete` is the load-bearing assertion. |
| `substrate_exempt` | `{ type: audit_status, status: substrate_exempt, carve_out_ref: "<§5 carve-out heading>" }` | The phase is a substrate slice of a substrate-vs-namespace carve-out per cross-plan-dependencies.md §5. Three criteria below — criterion (3) is mechanically enforced. |

### The `substrate_exempt` three-criterion predicate

A phase qualifies as `substrate_exempt` only if ALL THREE hold:

1. **Substrate is single-owned and load-bearing for an earlier-tier consumer** ([Plan-007 §Execution Windows](../plans/007-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out) criterion (a)). The substrate phase ships infrastructure that a later-tier or sibling plan's behavioral phases depend on; no other plan owns it.
2. **Namespaces have natural cohesion with their owning plans** ([Plan-007 §Execution Windows](../plans/007-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out) criterion (b)). The carve-out doesn't fragment a well-scoped plan; it isolates a substrate from later-tier behavior.
3. **The phase's Spec coverage declaration is explicitly empty.** Phase §Goal (or sibling block) MUST state "Phase N covers NO Spec-NNN AC at Tier N" (or canonical equivalent: "covers no Spec-NNN acceptance criteria", "substrate is pre-behavior plumbing"). The `#### Tasks` block MUST NOT cite Spec coverage in bracketed-list form (`Spec coverage: [Spec-NNN row M]`). **This criterion is grep-checkable.** A phase whose Tasks block carries bracketed `Spec coverage:` markers is by definition NOT pre-behavior plumbing. The criterion tests that machine-checkable marker form plus the declaration sentence — not a prose census of every AC contact: a substrate phase may legitimately ship enforcement or verification surfaces that brush acceptance criteria while remaining behaviorally pre-plumbing (clarified 2026-08-10 at the Tier-8 remainder audit, NS-20 M-023-1 — see the Plan-023 example below).

Criteria (1)+(2) are human-judged at audit time and load-bearing in the §5 carve-out entry itself; criterion (3) is mechanically verified by preflight at phase-dispatch time. If a future "substrate" phase claims any Spec AC, it does NOT qualify; the full audit applies regardless of how §5 describes the carve-out.

**Canonical examples** (mechanically verified after the per-phase semantics ship):

- **Plan-008 bootstrap Phase 1** declares "Phase 1 covers NO Spec-008 AC" (per F-008b-1-06) → qualifies under criterion (3). Carve-out ref: `"Plan-008 Bootstrap-vs-Remainder Carve-Out"`.
- **Plan-023 Tier 1 Partial Phase 1** declares the canonical-equivalent sentinel (its `Spec-023 AC coverage.` paragraph states the phase ships no Tier-8 behavior and "the substrate is pre-behavior plumbing") and its `#### Tasks` block cites no bracketed `Spec coverage:` marker → qualifies under criterion (3). The phase does ship three durable enforcement surfaces that partially close `Spec-023 §Acceptance Criteria` bullets — the exemption asserts behavioral emptiness, not zero verification. This example's pre-correction wording quoted a "covers no Spec-023 acceptance criteria" claim the phase's own shipped files contradicted; both the plan paragraph and this example were corrected at the Tier-8 remainder audit (NS-20, M-023-1). Carve-out ref: `"Plan-023 Substrate-vs-Namespace Carve-Out"`.

**Non-qualifying example:**

- **Plan-007 partial Phases 1-3** cover Spec-027 rows 4+10 (Phase 1), `Spec-007 §Wire Format` (Phase 2), and CP-007-1 + `Spec-007 §Required Behavior` (Phase 3). They are split via the substrate-vs-namespace decomposition rule but ship behavior — they do NOT qualify under criterion (3). Plan-007 partials are a legacy coverage gap (shipped pre-audit-framework via PRs #16/#17/#19), retroactively audited via the follow-up [BL-113](../archive/backlog-archive.md#bl-113-plan-007-partial-phases-1-3-retroactive-tier-1-audit) (filed and resolved via PR #75) ahead of Plan-007 remainder Tier 4 execution; they are NOT precedent for `substrate_exempt`.

### Status promotion under `substrate_exempt`

A plan whose Tier 1 phase ships under `audit_status: substrate_exempt` does NOT receive a `[x]` on its plan-level audit checkbox. The checkbox flips to `[x]` only when the full plan-level audit completes at the plan's later-tier remainder (Plan-008 at Tier 5; Plan-023 at Tier 8). Until then, the plan stays in `approved` status (no regression to `review`); only the audit checkbox remains `[ ]` with a footnote pointing to the deferred-audit work. **Plan-007 is not in this `substrate_exempt` set** — its Tier 1 partials shipped behavior, not a substrate exemption (see the non-qualifying example above), so it took the non-exempt path: a retroactive Tier-1 audit (BL-113 / PR #75) plus the Tier-4 remainder audit (NS-16 / PR #124). Its `approved → review → approved` cycle was a [§Status Flip Rule](#status-flip-rule) consequence of the Tier-4 design reopen, **not** the no-regression `substrate_exempt` promotion path described here.

### Per-tier inner-loop addition

Every tier audit MUST enumerate the carve-out partials shipping in that tier and either (a) audit them or (b) confirm an `audit_status: substrate_exempt` declaration is in place on each affected phase. This step closes the Tier 1 pilot omission documented in §Lessons Learned (Tier 1 pilot scope was too narrow).

## Escalation

Escalate to user direction when any of the following triggers fire:

- **G1 fails after working-copy edits.** Skeleton anchor was dropped during amendment; the amendment is structurally unsafe. Stop, restore anchor, or revise the amendment.
- **G4 fails post-amendment.** A `#### Tasks` Step traces to no Spec-NNN AC or invariant — subagent fabricated. Surface in REVIEW.md; default response is to file a finding for source amendment instead of authoring the fabricated Task.
- **Subagent disagrees with main agent.** Per-Phase completeness subagent flags a finding the main-agent dep trace did not catch (or vice versa). Both findings go into REVIEW.md; the user decides which to keep.
- **Cross-tier amendment surfaces.** Tier-N audit finds a Tier-K (K < N) plan needs amendment. Surface in current tier's REVIEW.md; user decides (a) amend Tier-K alongside Tier-N, (b) escalate to backlog, (c) reject.
- **Multiple tiers fail any G-gate (G2-G7).** Methodology issue, not a per-tier finding. Pause the audit; reconcile dimensions before continuing.
- **User rejects ≥3 tier swaps.** Methodology disagreement at scale. Stop; reconcile with user before any further tiers.

For all escalation triggers: the audit pauses at the user-review checkpoint (per-tier step 11). Do not proceed past that checkpoint without user direction.

## Subagent Prompt Template

Each per-Phase completeness subagent gets the following self-contained prompt. The main agent dispatches one subagent per Phase, in parallel, with disjoint output paths.

````text
ROLE: You are a per-Phase completeness auditor for an AI Sidekicks V1
implementation plan. You audit ONE Phase of ONE plan, in isolation, and
produce a findings file.

MODEL: You run as the session's frontier-tier model, inherited at dispatch
per AGENTS.md §Model Policy. Refuse only if you identify as a small/fast-tier
(Haiku- or Sonnet-class) model.

SCOPE: Plan-NNN, Phase N (single Phase only).

INPUTS YOU MUST READ:
- docs/plans/NNN-*.md (the plan body)
- docs/specs/NNN-*.md (the paired spec)
- docs/architecture/cross-plan-dependencies.md
- docs/backlog.md and docs/archive/backlog-archive.md (the BL-NNN
  open-vs-shipped source of truth — read to classify a Dimension 11
  Consumes: entry's BL as a non-completed blocker (status `todo`,
  `in_progress`, or `blocked`) vs a shipped (`completed`) provider)
- Every ADR cited in the plan's "Required ADRs" row
- Findings files from upstream-tier audits, if present, at
  .agents/tmp/research/plan-readiness-audit/plan-MMM/

OUTPUT FILE:
.agents/tmp/research/plan-readiness-audit/plan-NNN/phase-N-completeness.md

THE 11 DIMENSIONS YOU AUDIT:

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
11. Consumption resolution — a Task consumes a contract symbol (RPC/IPC
    method, event channel, request-param shape, or exported type) that
    resolves to no shipped provider, no declared §Precondition, and no
    tracked BL-NNN. This is the consume-side inverse of Dimension 10
    (produce-side, import-granular) and the consume-side analog of the
    Dimension-5 anti-fabrication rule. Resolution is by provider SHAPE,
    not name: a symbol that exists but does not satisfy the consumer
    need is still unresolved — does the endpoint return without the
    caller supplying state it cannot (a non-consuming read)? does the
    subscribe channel carry the params the caller must pass? This
    shape-match is judgment and is the dimension's load-bearing check.
    Classify each BL-NNN by reading docs/backlog.md +
    docs/archive/backlog-archive.md (the open-vs-shipped source of
    truth): a consume resolving only to a non-completed BL-NNN
    (status `todo`, `in_progress`, or `blocked` per the
    docs/backlog.md Status Values taxonomy — only `completed`
    collapses to a shipped provider) is tracked but NOT satisfied:
    record it as a §Precondition / blocked_on blocker so the Phase
    is not execution-ready until the BL ships, never as an available
    dependency. File severity: critical fires only when the consume
    resolves to NOTHING (no shipped provider, no §Precondition, no
    tracked BL) — the implementer cannot proceed without inventing
    the missing provider → blocks tier swap via G2.

OUTPUT FORMAT:

# Plan-NNN Phase N — Completeness Audit

## Findings

### F-NNN-N-01 — {Short headline}
**Dimension:** {1..11 ID}
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

- critical — Implementer cannot proceed without inventing missing behavior. Block tier swap; requires user review.
- major — Implementer would likely guess wrong; ambiguous behavior. Inline amendment.
- minor — Implementer can proceed but loses time/precision. Inline amendment.
- nit — Stylistic, cosmetic, low-value-add. Skip or batch into single cosmetic-cleanup amendment.

CITE ANCHOR DISCIPLINE (HARD RULES):

- **Per-anchor verification.** For each `Spec-NNN AC-X` or `Spec-NNN line NN` you emit, Read `docs/specs/NNN-*.md` and confirm the cited line / AC contains the cited behavior. Do not emit the cite until verified.
- **One anchor per behavior.** When a Task closes multiple Spec behaviors (compound contract claims), emit one anchor per behavior, never a range. Write `line 85 (PresenceUpdate), line 86 (PresenceRead)`, not `lines 85-86`.
- **Plan-NNN ≠ Spec-NNN namespace.** Plan-NNN line numbers, Plan-NNN section headings, and Plan-local row IDs (`Cn`, `Pr-n`, `In`) are NOT Spec-NNN anchors. Spec-NNN anchors are line numbers and section headings in `docs/specs/NNN-*.md` only. Do not co-locate `Plan-NNN:LLL` parentheticals inside the `**Spec coverage:**` field.
- **Return-DONE self-verification.** Before returning DONE, enumerate each anchor you cited in this Phase's output and confirm — by grep/Read — each exists at the cited line. Append a `## Self-Verification` block with one row per cite confirming the spec line content matches.

HARD RULE (anti-fabrication): If the spec doesn't tell you what assertion to write in Step 1, you do NOT invent one. You file a finding (severity: critical, dimension: 5) instead.

WRITING-PLANS FORMAT (Tasks block authoring): For unstarted Phases (no code merged for this Phase yet), author a `#### Tasks` subsection nested under the existing Phase header. Existing Phase prose (Precondition, Goal, scope bullets) is preserved verbatim. Each Task carries three extra fields beyond raw writing-plans format:

- **Spec coverage:** Spec-NNN AC-X (line NN), AC-Y (line MM) (closes Dimension 9 loop; line-anchored shape preferred. AC-only (`Spec-NNN AC-X`) is the fallback when an AC has no canonical line in the spec.)
- **Verifies invariant:** I-NNN-M (closes Dimension 7 loop, when applicable)
- **Consumes:** each contract symbol this Task consumes that is NOT produced within the same Phase (RPC/IPC method, event channel, request-param shape, exported type), each with its resolution — `presence.subscribe({ sessionId }) ← Plan-007 daemon namespace (Tier-4 §Precondition)`, `invites.getMetadata ← BL-133`. Names an upstream Plan/Phase provider, a declared §Precondition, or a tracked `BL-NNN` (closes Dimension 11 loop). A `BL-NNN` resolution means the consume is blocked on that BL — record it as a §Precondition so the Phase is not execution-ready until the BL ships, not a satisfied dependency. Resolution is by provider SHAPE — a symbol that exists but does not satisfy the consumer need is a Finding (severity: critical, dimension: 11), not an entry.

If you cannot author a Task concretely from source materials, file a Finding instead (per the hard rule above).

`````

## Cite-Amendment Subagent Prompt Template

This template is for **cite-fix** dispatches (backfilling or correcting `**Spec coverage:**` and `**Verifies invariant:**` annotations on already-shipped Tasks), not full Phase audits. Use §Subagent Prompt Template above when authoring net-new Tasks; use this template when the Tasks are already present and only the cite annotations need amendment.

````text
ROLE: You are a cite-amendment auditor for an AI Sidekicks V1 implementation
plan. You correct or backfill `**Spec coverage:**` and `**Verifies invariant:**`
annotations on existing `#### Tasks` rows. You DO NOT author new Tasks; you
DO NOT modify Files / Goal / Implementation Notes / Precondition prose.

MODEL: You run as the session's frontier-tier model, inherited at dispatch
per AGENTS.md §Model Policy. Refuse only if you identify as a small/fast-tier
(Haiku- or Sonnet-class) model.

SCOPE: Plan-NNN, Tasks in scope (the orchestrator names specific Task IDs).

INPUTS YOU MUST READ:
- docs/plans/NNN-*.md (the target plan body — Tasks block only)
- docs/specs/NNN-*.md (the paired spec — source of truth for anchors)

DO NOT READ:
- Other plans' bodies. Reading them primes Plan-NNN-as-Spec-NNN confusion;
  use docs/architecture/cross-plan-dependencies.md for context only if
  explicitly asked.

OUTPUT FILE:
{orchestrator-supplied path under .agents/tmp/research/}

OUTPUT FORMAT: one block per Task row, in this exact shape:

# Plan-NNN Cite Amendment

## T-NN.M
**Spec coverage:** {new cite or "(unchanged)"}
**Verifies invariant:** {new cite or "(unchanged)"}
Rationale: {one sentence pointing at the spec line(s) you verified}

## Self-Verification

| Cite emitted | Spec file:line | Line content (quoted) | Match? |
| ------------ | -------------- | --------------------- | ------ |
| Spec-NNN line YY (Subject) | docs/specs/NNN-*.md:YY | "…" | ✓ |
| ...                        | ...                    | ... | ✓ |

CITE ANCHOR DISCIPLINE (HARD RULES — same as §Subagent Prompt Template above):

- **Per-anchor verification.** For each `Spec-NNN AC-X` or `Spec-NNN line NN`
  you emit, Read `docs/specs/NNN-*.md` and confirm the cited line / AC
  contains the cited behavior. Do not emit the cite until verified.
- **One anchor per behavior.** When a Task closes multiple Spec behaviors
  (compound contract claims), emit one anchor per behavior, never a range.
  Write `line 85 (PresenceUpdate), line 86 (PresenceRead)`, not `lines 85-86`.
- **Plan-NNN ≠ Spec-NNN namespace.** Plan-NNN line numbers, Plan-NNN section
  headings, and Plan-local row IDs (`Cn`, `Pr-n`, `In`) are NOT Spec-NNN
  anchors. Spec-NNN anchors are line numbers and section headings in
  `docs/specs/NNN-*.md` only. Do not co-locate `Plan-NNN:LLL` parentheticals
  inside the `**Spec coverage:**` field.
- **Return-DONE self-verification.** Before returning DONE, populate the
  `## Self-Verification` table above. Each row must quote the spec line
  content verifying the cite. If you cannot quote the matching content, the
  cite is unverified — do not emit it.

HARD RULE (anti-fabrication): If the spec doesn't contain a line anchor for
the behavior, emit `(unchanged)` and surface a separate finding requesting
spec amendment. NO FABRICATION.

CROSS-REFERENCE TO VERIFIER: Your output is verified by preflight Gate 4
(`extractCiteAnchors` + `verifyAnchorAgainstSpec` in
`.claude/skills/plan-execution/scripts/preflight.mjs`; see
`.claude/skills/plan-execution/references/preflight-contract.md`
§Gate 4 — Cite Anchor Semantic Check). The `## Self-Verification` block is
the authoring discipline; Gate 4 is the orchestrator-side enforcement. If
Gate 4 fails on a cite you emitted, the orchestrator returns the failing
cite + spec evidence to you for re-amendment.
`````

## Main-Agent Dep-Trace Dimensions

The main agent walks the 8 dep-ordering dimensions per Phase of each plan in tier scope. These complement the 11 completeness dimensions handled by subagents.

| ID | Dimension | Question |
| --- | --- | --- |
| D1 | Phase-level import surface | What files does Phase-N create or modify? What does each file import from outside this plan? _For unstarted Phases (no code yet), the auditor reads the plan body's declared file list (Target Areas + Phase scope bullets) and infers imports from the spec/contracts the plan cites — not actual source._ |
| D2 | Upstream Phase sufficiency | For each external import, is the source shipped by an upstream Plan/Phase in a strictly lower Tier (or earlier Phase within the same plan)? |
| D3 | Plan-header dep accuracy | Does the plan's `Dependencies` row enumerate every plan whose code Phase-N imports from? |
| D4 | Cross-plan-deps §3 alignment | Does §3 of `cross-plan-dependencies.md` show every edge Phase-N needs? Are edges typed correctly? |
| D5 | Tier-placement sufficiency | If Phase-N's deps are at Tier-T, the plan must be placed at Tier ≥ T+1 (or carve-out justification exists). |
| D6 | Forward-declared schema bidirectionality | If Phase-N references a forward-declared column/table, does the §1 Contested-table row cite both CREATE-owner and semantics-owner? |
| D7 | Cross-plan ownership consistency | Does Phase-N create or modify a path/table that another plan claims ownership of in §1 / §2? |
| D8 | Substrate-vs-namespace pattern | If Phase-N depends on a substrate-deliverable from a later-tier plan, is the carve-out documented in §5? |

**Output:** `.agents/tmp/research/plan-readiness-audit/plan-NNN/main-agent-dep-trace.md`

## Cross-Document Design-Fact Reciprocity (synthesis-stage)

A **main-agent** check run once per tier at synthesis — **not** a per-Phase subagent dimension. Each completeness dimension (the 11 subagent dimensions) and each dep-trace walk (D1-D8) reads **one plan**; cross-document reciprocity spans the whole tier bundle, so it can only be verified where the synthesis sees every amended document at once.

**Why this exists.** The Tier-6 audit (PR #152) ratified design facts across a 5-plan corpus and shipped ~70+ latent cross-document inconsistencies — every place an amendment changed a fact in one document but left a sibling document asserting the old value (a 429 `Retry-After` policy, turn-limit semantics, the 125→130 event census, approval-payload identity types, replay-field shapes), plus a census summary that asserted 130 while its own category column summed to 125. The external reviewer became the de-facto consistency checker across 21 review rounds. None of the gates above reads the authored deltas **as a consumer**; this dimension closes that gap. It is the citation-sweep discipline (paths / anchors / line-cites) generalized from tokens to **semantic design facts** — the same sweep PR #153 applied successfully to the citation layer of the same corpus, converging in one round.

**Procedure.** For each design fact this tier's amendments **change the value of**:

1. **Build the "where else is this fact asserted?" map.** Grep the corpus for the literal value AND read each candidate site's prose — a design fact is restated in different words across plan + spec + contract + schema + dependency map, and a literal-value grep alone misses prose restatements. Regex catches the literal half; the prose half requires reading each consumer.
2. **Verify every site agrees in the same tier swap.** A fact changed in one document with a sibling left stale is a `C-K-NN` cross-cutting finding (REVIEW.md §Cross-Cutting Findings This Tier), reconciled before the swap — never deferred to the review loop.
3. **Re-compute every arithmetic total.** Treat each census / generated-union / registry count as a computed invariant: re-sum its source column and reconcile **every** document asserting that total — in-table **Total** row, prose summary line, and any sibling document's restatement — in one pass. Never assert a total you did not just compute.

The within-document arithmetic slice of step 3 is mechanized by gate G7: mark a summable breakdown table with the `corpus:total-check` convention (documented in `tools/docs-corpus/lib/table-total-coherence.ts`) so the lint re-sums it on every commit. Place the marker **inline, trailing the table's total prose line** — not on its own line — so it adds no line (preserving inbound `:NNN` line-cites) and `prettier --check` leaves it untouched:

```markdown
Total enumerated event types: **130** <!-- corpus:total-check column="Count" prose-total="Total enumerated event types" -->

| Category  | Count   | Types |
| --------- | ------- | ----- |
| ...       | ...     | ...   |
| **Total** | **130** | ...   |
```

`prose-total` reconciles two phrasings: the colon form above (`<label>: N`, number after the label) and the prefix form `N-<label>` (number before the label, as Plan-006 restates it: `**156-event type registry across 20 categories**`). Declare one `prose-total` per restatement the table's total is also stated in.

The cross-document agreement (step 2) and the prose-restatement reciprocity remain judgment work here — no regex catches a fact restated in different words across documents.

**Stop rule.** If a review-fix loop's findings-per-round stays flat across ≥3 rounds, the loop is patching symptoms of an un-swept fact class — stop and run this sweep forward over every changed fact before the next push, rather than fixing one named site at a time. (PR #152 ran the narrow per-finding loop 21 times without reading the flat curve.)

**Output:** cross-cutting findings folded into the tier's REVIEW.md §Cross-Cutting Findings This Tier.

## REVIEW.md Schema

Every tier swap presents a REVIEW.md to the user. Schema is non-negotiable (the runbook's mechanical verification depends on the headings).

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
| ---------- | -------- | --------- | ---------------- | --------- |
| F-XXX-1-01 | critical | 10        | dep-map §3       | line NNN  |

#### Diff Preview

[link to working/tier-K/diff-plan-XXX.patch]

## Cross-Cutting Findings This Tier

- C-K-01: ...
- Reciprocity sweep (per §Cross-Document Design-Fact Reciprocity): each design fact this tier changed → the sibling sites verified in agreement; each arithmetic total → re-summed against its source column. Omit if this tier changed no multi-document design fact.

## Upstream-Tier Amendments Required

- (omit section if none; populated when Tier-N audit surfaces a Tier-K, K<N, amendment)

## Findings Escalated to Backlog (proposed BL-NNN)

- BL-XXX: ...

## Decision Required

- [ ] Approve all → swap + commit
- [ ] Approve subset: ...
- [ ] Reject → adjust
- [ ] Escalate item(s) to backlog: ...
```

## Lessons Learned

<!-- Populated post-audit from SYNTHESIS.md after Tier 9 ships. Per-tier
     calibration metrics (B1-B6 actual values), dimension adjustments, and
     methodology revisions land here. -->

### Tier 1 pilot scope was too narrow (2026-04-28)

The Tier 1 audit pilot (PR #15) covered Plan-001 + Plan-024 only and excluded the carve-out partials (Plan-007 partial, Plan-008 bootstrap, Plan-023 partial) shipping at Tier 1 alongside them. The omission surfaced when Plan-023 Phase 1 hit preflight Gate 2 with no audit-complete checkbox and no per-phase mechanism to declare substrate-only status. Going forward, every tier audit MUST enumerate the carve-out partials shipping in that tier and either audit them or surface an `audit_status: substrate_exempt` declaration on each affected phase. See §Per-Phase Audit Semantics § Per-tier inner-loop addition.

### Plan-007 partial is a coverage gap, not a substrate exemption (2026-05-17)

Plan-007 partial Phases 1-3 (PRs #16/#17/#19) shipped without audit coverage AND without `substrate_exempt` declaration. They claim Spec AC coverage (Spec-027 rows 4+10, `Spec-007 §Wire Format`, CP-007-1 + `Spec-007 §Required Behavior`) — fail criterion (3) of the `substrate_exempt` predicate. They are a legacy coverage gap, not substrate exemption, and are NOT precedent for future `substrate_exempt` claims. **(Resolved 2026-05-29: the follow-up BL this entry called for was filed and closed as [BL-113](../archive/backlog-archive.md#bl-113-plan-007-partial-phases-1-3-retroactive-tier-1-audit) via PR #75 — the retroactive Tier-1 audit, completed before Plan-007 remainder Tier 4 execution — and the Tier-4 remainder was then audited under NS-16 / PR #124, promoting Plan-007 `review → approved`.)**

### Tier 2 (Plan-002) — pre-audit `approved` plan calibration (2026-05-20)

NS-14 audited Plan-002 (Tier 2's only plan, status `approved` from 2026-04-14, predates the audit runbook). **Calibration band actuals** (per §Calibration Bands B1–B6 definitions above): **B1 — Critical findings per Phase**: 2.0 avg / 5 max (12 criticals across 6 Phases; Phase 4 deferral cluster F-002-4-01..05 inflated the max but collapsed to a single amendment workstream W3 at synthesis time) — at upper edge of avg target (0–2); above max target (0–4) due to Phase 4 alone, methodology-acceptable given the cluster collapse. **B2 — Total findings per plan**: 58 raw (12 critical, 23 major, 19 minor, 4 nit) — slightly over the 5–50 ceiling by 8, acceptable given a pre-audit `approved` plan surfaced a backlog of 6 Phases' worth of authoring-format gaps in one pass. **B3 — Tasks-authored vs. blocking-finding ratio**: 28 Tasks authored / 12 critical = 2.3:1 — at target. **B4 — User-review walltime per plan**: ~minutes (user approved REVIEW.md decision via single AskUserQuestion turn after Stage 4 PAUSE) — well under the 30 min – 2 hours target; Tier-2-only-one-plan and concise REVIEW.md schema kept walltime tight, not a methodology concern. **B5 — advisor() signal-to-noise**: ~5 advisor calls during the audit run (4 substantive — REVIEW.md schema sequencing, anchor verification, Codex thread classification, B1–B6 alignment fix — plus 1 cosmetic) — at target (≥1 substantive, ≤5 cosmetic). **B6 — Status flip rate**: 0 (Plan-002 stayed `approved`; no Plan-021/Plan-023/Plan-025 body edits) — under target. **Tier-2 supplemental observations** (out-of-band, not part of §Calibration Bands B1–B6): 4 corpus files touched (Plan-002, cross-plan-dependencies.md §3 + §6 NS-14, this runbook, backlog.md), 3 backlog escalations (BL-119/120/121), net Plan-002 diff +75/-25 (~+50 net lines; 304 vs. 254 pre-audit), 0 carve-out declarations (Plan-002 has no substrate-exempt phases). Two cross-cutting patterns hardened by NS-14 (recommendations for runbook v.next): (1) pre-audit plans authored before the writing-plans `#### Tasks` convention now need a Tasks-block backfill at audit time — surfaced as critical findings F-002-1-01 + F-002-2-10 — recommend adding "Tasks block present per writing-plans authoring format" as a per-Phase audit dimension; (2) plans owning files later EXTENDed by downstream plans need an explicit `## Cross-Plan Obligations` section (precedent: Plan-001 + Plan-003 + Plan-007), surfaced as F-MA-01 / F-002-3-01 / F-002-6-04 — recommend declaring this section mandatory for plans with §2 Package-Path-Ownership-Map extenders.

### Tier 6 (Plans 009/010/012/016/021) — five-plan bundle calibration (2026-06-12)

NS-18 (PR #152) audited five plans in one PR — the widest bundle yet. **Calibration band actuals** (per §Calibration Bands B1–B6 definitions above): **B1 — Critical findings per Phase**: 4.25 avg / 13 max (85 criticals across 20 Phases; max = Plan-016 Phase 2) — above the 0–2 avg / 0–4 max targets, the same stub-backfill cluster shape NS-14 documented (format-era findings on pre-Tasks-convention `approved` plans, not behavior inventions). **B2 — Total findings per plan**: 52–76 raw, all five at-or-over the 5–50 ceiling — acceptable-with-rationale (five pre-audit-format `approved` plans each surfaced a full backlog of authoring-format gaps in one pass; 333 findings total). **B3 — Tasks-authored vs. blocking-finding ratio**: 122 Tasks / 85 criticals ≈ 1.4:1 — under the 2:1 target, depressed by the same cluster. **B4 — User-review walltime per plan**: ≈1 min (single AskUserQuestion ratification at the Stage-4 pause) — well under the 30 min – 2 hours target. **B5 — advisor() signal-to-noise**: `advisor()` unavailable in the executing session's toolset — substituted an adversarial-review subagent over the tier diff bundle, recorded per the model-substitution note in §Preconditions. **B6 — Status flip rate**: 0/5 (all five plans stay `approved`; G3 — Required-ADR presence — fired on 4/5 ADR-gaining plans and was overridden ×4 by user ratification at the pause). Cross-cutting recommendations: **C-6-07 (G3 recurrence)** — third consecutive cycle (NS-14, Tier 5, Tier 6) where pre-Tasks-era stubs mechanically fail G3 on required-section backfill; recommend a G3 baseline-multiplier carve-out (or absolute-floor alternative) for plans whose baseline predates the audit-format convention. **C-6-08 (preflight checkbox phrasing)** — three walks wrote the audit checkbox in a non-preflight-matching phrase and one omitted it; all four would have hard-blocked `/plan-execution` Phase 0; the checkbox string is a mechanical contract (`preflight.mjs` Gate 2), not prose — normalize to the regex form at synthesis. Mechanical lessons: (1) prettier respects `.gitignore`, so `--check` over `.agents/tmp/` working copies is vacuous — run it over explicit corpus paths; (2) GFM table cells need `\|` escapes for in-cell pipes (the D-016-11 row); (3) sequential walks amending a shared spec invalidate earlier walks' line cites in non-Gate-4 surfaces (decision blocks, CP-/I- items, §6 rows) — the swap cite-sweep must cover bundle-internal cites, not just out-of-bundle citers.

### Cite-form taxonomy and hook-gate coverage (2026-06-12)

The Tier-6 swap surfaced four distinct cite forms, each with a different validation owner: path-attached `basename.md:NNN[-MMM]` / `basename.md line[s] NNN` (docs-corpus cite-target-existence, docs→docs only); bare continuations `, :NNN` adjacent to a path cite (no hook; sweep-only); prefix-form `Spec-NNN:LLL` in code comments (label-cite gate, code→docs only); link-then-colon `](path.md):NNN` (cite-target-existence). A sweep regex built for one form silently misses the others — the first Tier-6 commit attempt failed on 9 label-cite + 3 cite-target-existence violations from the two unswept forms. Second lesson: byte-identity content-preservation proofs pass vacuously on blank lines (blank==blank), so a mechanical shift of an already-broken cite preserves brokenness undetected — convergence scanning must assert target-line non-blankness, which surfaced 23 pre-existing-broken anchors re-anchored by content. Lefthook prints hook failures above its summary block; a `tail`-truncated read of commit output mistakes failure for success. Round-8 surfaced a FIFTH cite form none of the prior sweeps covered: label-space-line (`Spec-NNN line N`) plus bare `line N` comma-continuations that bind to the most recent Spec/Plan/ADR label — a round-5 one-line spec insert left 69 stale instances in plan-021 alone, undetected for three rounds; sweeps need a label-stateful pass, and bare `line N` tokens adjacent to a path cite must bind to the path, not the label. Round-10 surfaced the code-tree enforcement asymmetry: the full-repo CI label-cite check validates `packages/**`/`apps/**` governance cites for target-line non-emptiness, but lefthook pre-commit scopes to STAGED files — so an in-PR line shift that moves an inbound code-cite's target onto a blank line passes every local gate and fails only in CI (`runtime-node.test.ts:725` citing `error-contracts.md:343` — already semantically stale at develop, where the file was too short for `:343` to exist). Sweep rule: when a doc shifts lines, re-anchor inbound CODE cites in-PR alongside doc cites, even when the cite was already stale at develop (CI enforcement overrides the era-disposition split; the semantic fix rides the mechanical one). Codex review cadence on the swap PR: 21 rounds, 85 threads — 84 adjudicated REAL and fixed in-PR, 1 refuted with scripted re-derivation (the spec-006 census arithmetic; refutations get the same reply-before-resolve treatment, with full receipts in the reply). Large-diff sampling means each round reads new regions — plan on N rounds, not one; re-trigger with an `@codex review` PR comment if the on-push trigger goes silent ~15-20 min; a clean final verdict arrives as a 👀→👍 reaction swap with NO review object, so gate on the reaction actor + zero new threads, never on a review-object ack alone; `gh run rerun <id> --failed` clears the recurring Electron-smoke flake on docs-only diffs. <!-- cite-shape-example -->

2026-07 update: the code→docs prefix-form population this entry describes was converted to gate-verified `§Heading` anchors and new raw forms are denied (see AGENTS.md §Durable-Cite Rule); the code-cite sweep rule above is historical.

### Tier 7 (Plans 011/014/015/025-remainder) — backfill-dominant audit, long-convergence contract lessons (2026-06-19)

NS-19 (PR #160) audited four plans — Plan-011 (gitflow PR & diff attribution), Plan-014 (artifacts/files/attachments), Plan-015 (persistence/recovery/replay), and the Plan-025 (self-hostable node relay) Tier-7 remainder. **Finding-volume actuals** ran well under prior tiers: 41 per-plan findings + 1 cross-cutting (C-7-01) — Plan-011 7, Plan-014 9, Plan-015 6, Plan-025-remainder 19 — all four **under the B2 5–50 ceiling** (contrast NS-14's 58 and NS-18's 52–76), because three of four were backfill-dominant (Plan-011 + Plan-015 stay `approved`: §Invariants / §Cross-Plan Obligations / §Tasks record EXISTING relationships, not behavior inventions), so the pre-Tasks-format stub-backlog cluster that inflated the NS-14 / NS-18 B1/B2 bands did not recur. **B6 status-flip rate 2/4**: Plan-014 `review → approved` (OCI-envelope manifest contract ratified), Plan-025 `approved → review` (new relay behavior; ADR-023 joins its Required ADRs); Plan-011 + Plan-015 unchanged. The audit produced 31 audit-traceable amendment-tasks (A-011/014/015/025-\*) plus the cross-cutting D-decision set. **Convergence cadence**: 20 Codex rounds / 75 threads on a +673/−221, 21-file doc diff — comparable to NS-18's 21/85 despite a far smaller diff, because the rounds were driven by cross-cutting _contract_ decisions, not finding volume. Cross-cutting lessons (runbook v.next): **(1) method-string vs. TS-symbol confusion (D-011-5, surfaced round 19)** — a plan naming wire operations by their PascalCase request-type symbols (`PRPrepare`, `GitActionExecute`) reads as if those were the method strings, but the method string is dotted-camelCase (`gitflow.prPrepare`), which the canonical `METHOD_NAME_FORMAT` permits — though registering these methods in the daemon `MethodRegistry` is gated on [BL-142](../archive/backlog-archive.md) until its deployed `registry.ts` regex (lowercase-only today) conforms, as [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) already records; recommend a per-plan dimension asserting every wire operation's method string resolves in the [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) method registry, not merely its request/response schema name. **(2) optional-field parity across lift surfaces (D-025-5, rounds 19–20)** — a field optional in its canonical source (`security.default.override.row` at Spec-027) must read optional in every downstream lift (the Spec-006 taxonomy) AND the code interface (`SecurityDefaultOverrideEvent.row?`); a required-vs-optional mismatch is a real defect (a row-less override event is rejected by any sink built from the stricter surface) — recommend the cross-cutting-contract sweep assert optionality parity across canonical-spec ↔ taxonomy-lift ↔ code-interface for every touched field. **(3) audit-PR self-citation drift (CAT-07)** — inserting the api-payload method-name table (+11 lines) shifted five inbound Plan-015 line-cites, re-anchored in-PR; an audit that adds rows/tables to a doc cited by line elsewhere must re-anchor those inbound cites in the same PR (the ripple-check CAT-07 axis), not defer to housekeeping.

### Tier 8 (Plans 013/017/019/020/023-remainder) — five-plan bundle with a first-time promotion (2026-08-10)

NS-20 (PR #318) audited the five-plan Tier-8 bundle: the Plan-013 + Spec-013 restore (`review → approved`, discharging the campaign-B9 CP-004-13 consumer flip after adjudicating the `supersededTurns(runId)` provider shape contract-complete), Plan-017's first-time `review → approved` promotion with full structural backfill (§Invariants and §Cross-Plan Obligations authored from zero) plus the visual-builder amendment landing ADR-026 `proposed` for lead ratification, Plan-019 (the notification-queue Reading-A adjudication — dedicated Postgres table, census 23 → 24 — with the D-019-2 aggregate-carrier rule), Plan-020 (structural backfill plus the Spec-027 row-9a/9b reconciliation), and the Plan-023 Tier-8 remainder (flip-and-restore in one swap). Per-plan finding ledgers live where each audit recorded them — the plan's §Preconditions Gate-2 row and its dated §Notes entry — not here; this entry carries only the cross-cutting lessons, each hit empirically during the tier's execution. **(1) Gate-7 Status cells must stay bare** — `preflight.mjs` parses only the exact template shape ``| **Status** | `approved` |``, so a restoration-annotated cell reads as "status unreadable" and leaves every phase non-dispatchable; the narrative belongs in §Preconditions (the Plan-010 shape). Hit three times the same day: the NS-54 Plan-012 delta shipped annotated cells and needed a follow-up commit, and two of this tier's appliers re-shipped the shape on Plan-023 and Spec-017 — both flattened at integration with the narrative moved beside the audit row. **(2) Audit-report §-anchors are claims, not facts** — three phantom headings were proposed across the bundle (an attention-model heading and a bare interfaces heading against Spec-019, and a behavior-table heading against Spec-027 — none existing in its target file; each caught against the file's real heading list at integration, and this entry names them in prose because the literal anchor form would itself be a live label-cite violation); every §-anchor an audit report proposes must be byte-compared against the target's real headings before it is written, since each is a Gate-4 hard error downstream. **(3)** the preflight-contract doc's `AC-X` meta-notation read as a hyphenated literal and cost a Gate-4 halt (`AC-1` vs the parser's `^AC(\d+)`); the contract doc now shows the hyphenless `ACX` form. **(4) `precondition_box_checked` prefix resolution keeps the closing bold marker on a bold-labeled box** — the resolver strips only leading asterisks, so the captured prefix ends with the label's closing double-asterisk pair; an entry keyed on such a box must quote that trailing pair verbatim, and reformatting the bold label silently breaks every entry keyed on it (exact shapes in `.claude/skills/plan-execution/references/preflight-contract.md`). **(5)** prettier corrupts a bold span that wraps a code-quoted glob ending in a double-asterisk — the spaces adjacent to the code span are eaten on rewrite — so keep double-asterisk-terminated globs out of bold spans; this entry's own first draft tripped the corruption twice while describing it with the literal sequences and was reworded to prose.

## Related Architecture / Specs / Plans

- [`docs/architecture/cross-plan-dependencies.md`](../architecture/cross-plan-dependencies.md) — §1 (table ownership), §2 (path ownership), §3 (dep edges), §5 (canonical build order). The dep-trace dimensions (D1-D8) are anchored to this doc.
- [`docs/plans/000-plan-template.md`](../plans/000-plan-template.md) — Preconditions section carries the audit gate; new plans inherit it at template-copy time.
- [`docs/decisions/023-v1-ci-cd-and-release-automation.md`](../decisions/023-v1-ci-cd-and-release-automation.md) — defines the GitFlow-lite branch model the audit's per-tier commits follow.
- [`AGENTS.md`](../../AGENTS.md) — owns the parallel-subagent dispatch convention, the transient research-artifact pattern under `.agents/tmp/research/<topic>/`, and the surface-forward-then-delete rule this runbook is itself an instance of.
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — branch naming, commit message format, and squash-merge workflow used for per-tier swap commits.
- [`README.md`](../../README.md) — V1 feature list and tier graph the audit walks.
