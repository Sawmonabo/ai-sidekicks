# Plan-Execution Estate Refinement — design memo

| Field       | Value                                                        |
| ----------- | ------------------------------------------------------------ |
| Drafted     | 2026-07-06                                                   |
| Owner       | user (a.sawmon@gmail.com)                                    |
| Implementer | Claude Fable 5                                               |
| Derived via | plugin:memory-audit estate audit → superpowers:writing-plans |

Not a corpus-lifecycle doc (no status field) — this is the durable design record for the 2026-07-06 plan-execution estate refinement, following the `docs/superpowers/` precedent (housekeeper 2026-05-03, crypto-paseto 2026-05-20, capability-enhancements 2026-07-01).

## 1. Problem

The estate encoded one worldview: **every code change is plan-task shipment.** Three walls followed. (a) Citations were positional (`file.ts:NNN` / `Spec-NNN:LL`), so any edit that shifts lines either fails the required docs-corpus cite floor — re-checked repo-wide on every PR — or rots silently. (b) CONTRIBUTING §PR Workflow step 3 defined "fixing or extending" shipped code as plan work (mandatory `Plan-NNN` title token → preflight Gate-6 manifest coupling), while `/plan-execution` structurally cannot run post-completion work (a completed plan has no unshipped task) and the Housekeeping Exception excludes behavioral change — so no compliant maintenance lane existed. (c) Ceremony was size-invariant: a 30-line improvement paid a task DAG, up to 6 review passes, a Codex-gated merge, and a second gated housekeeper PR.

## 2. Findings digest (2026-07-06 audit)

- **C1** SKILL.md's "prose does NOT duplicate the gate logic" claim vs. inlined Phase D.5/E mechanics. **C2** doc-first scope asymmetry: AGENTS.md binds a plan's _first_ PR; the "every code PR" extension lived only in SKILL.md, CONTRIBUTING, and CLAUDE.md restatements. **C3** audit-runbook G5's bare-`PR #N` grep had 136 legitimate matches in provenance sections.
- **ST1/ST2** stale line-number cross-cites inside the skill tree; **ST3** a committed session codename; **ST4** a 1,575-char frontmatter description.
- **D1–D5** duplication: DAG-schema prose ×2 per file, ×3–5 shared agent boilerplate (~70 KB estate), housekeeper contract prose ×3 homes, a verbatim candidate-lookup mirror.
- **MC1–MC5** missing coverage: no durable-citation convention (root cause of the cite pain), no post-completion enhancement lane, no local reverse-direction cite warning, no scaled-down ceremony, no floor on `.claude/**` internal cross-refs.
- **Walls census**: three "every code PR" binding surfaces (CONTRIBUTING §PR Workflow step 3, SKILL.md §When This Skill Triggers, CLAUDE.md §Current State); unscoped tier-order language (CLAUDE.md + cross-plan-dependencies §5/§6 intros); no work-classification surface. Verified NON-walls (no action): CODEOWNERS, commitlint config, absent PR template, plan-manifest-presence, the CI full-sweep shape, NEEDS_CONTEXT doc-first mentions.
- **Cite census (2026-07-07 full-repo sweep @ bf50225)**: 259 code→docs `Spec/Plan/ADR-NNN:LL` occurrences in `packages/` (Spec 229 / Plan 30 / ADR 0; zero in `apps/`); 22 path-shaped docs→code sites (20 canonical + 2 non-canonical repairs); 41 backticked bare-name+line sites (49 occ) in governance docs + 4 unbackticked; 5 fully-qualified `docs/….md:LL` cites in code; docs→docs raw `.md:NNN` = 92 occ / 76 sites. Adjacent populations that stay (residual register, §7): 693 occ of `Spec-NNN:LL` label forms in DOCS prose, 72 bare-name `.md:NNN` wire-doc annotations in `packages/` code, 380 code→code line cites, ~653 unbackticked `§`-cites already in code, 27+13 label cites in `tools/`/`.claude/` code.

## 3. Decisions (owner-ratified 2026-07-06)

1. All five workstreams, sequenced E → B → A(convention) → A(sweep) → D as PR-1..PR-5.
2. Keep the full-repo CI cite sweep on every PR (no scope-to-impact).
3. DENY new raw line-cites into `packages/`+`apps/` (hard gate). Existing cites convert in the same PR the gate lands in, so no grandfather registry is needed.
4. G4 strictness is size-tiered: full grammar hard-gate for L phases; cite-presence + target-existence for S/M (grammar findings demote to warnings).
5. Anchor form is `§Heading` ONLY — no AC-ID convention is minted (28 specs already carry stable headings; an AC-ID sweep would be a new wall). Duplicated-heading targets get a single `<a id>` disambiguator (rare). The form extends two in-repo precedents: preflight Gate 4 already prefers `Spec-NNN §Heading` anchors in plan Tasks blocks (verified by `findSectionHeading`, exact-after-normalize), and the corpus already carries ~2,549 `§`-cite occurrences plus a 7-site `path.ts#symbol` precedent (`local-ipc-gateway.ts#dispatchFrame`).
6. PR-4 also converts bare-name docs→code cites (`session.ts:408` style) so ZERO doc→code line-pins remain; docs→docs `:NNN` cites are convention-forward only (not bulk-converted).
7. Post-sweep, the deny ratchets to the code→docs direction (no new raw `Spec-NNN:LL` / `docs/….md:LL` in code comments).
8. Enhancement-lane boundary: a change that alters a plan §Invariant or a spec Required Behavior / Acceptance Criteria row is NOT an enhancement — spec/plan amends first.
9. S-class housekeeping: the orchestrator applies the deterministic edits directly (no subagent dispatch) in the usual second gated PR, merged on CLEAN per the doc-only precedent. Same-PR batching is impossible because the manifest entry records the squash SHA, which does not exist pre-merge.
10. The housekeeper design spec §4.3.5 verbatim-mirror requirement is superseded: state-recovery points at the canonical rules instead of duplicating them.

## 4. The five PRs

| PR | Branch | Scope |
| --- | --- | --- |
| 1 | `chore/plan-execution-concision` | This memo; SKILL.md description → trigger-essentials; Phase D.5 step-3 mechanics → failure-modes.md §Codex Verdict Gate; Phase E bodies → housekeeper contract; DAG-schema dedup; stale-cite repairs (ST1/ST2); codename sweep (ST3); state-recovery de-mirror (DUP5); agent boilerplate compression (DUP2); runbook G5 rescope (C3); touched `.claude/**` cross-refs → anchor form (MC5) |
| 2 | `docs/post-completion-enhancement-lane` | CONTRIBUTING §How Code Lands 4-lane table + narrowed step-3 token rule + §Post-Completion Enhancements; SKILL.md trigger-law rescope; AGENTS.md §Doc-First lane sentence; CLAUDE.md restatement + tier-order scoping; cross-plan-dependencies §5/§6 scoping + Ownership-Rule cross-ref; preflight G6 boundary comment; rebuild-shipment-manifest title-token candidate filter (lane-2 bodies must not synthesize manifest entries) |
| 3 | `chore/durable-citations` | AGENTS.md §Durable-Cite Rule (+ CONTRIBUTING/plan-template mirrors); cite-target-existence: `path#symbol` verification + range-aware extractor + deny raw line-pins into `packages/`+`apps/`; label-cite: verified `§Heading` anchor form; pre-commit reverse-direction advisory; conversion of all existing volatile docs→code path-shaped cites (three forms: live → `#Symbol`, provenance → bare path + prose, teaching placeholders → `<file>:<lines>`) |
| 4 | `chore/code-cite-anchor-sweep` | Scripted conversion of all `Spec/Plan/ADR-NNN:LL` + `docs/….md:LL` code-comment cites to `§Heading` form; bare-name docs→code sweep; deny-new raw code→docs cites; ripple-check + failure-mode-catalog rescope (CAT-06/07 rewrite; §/`#symbol` drift coverage); /ripple-check verification |
| 5 | `feat/size-classed-ceremony` | `classifyPhaseSize` (S: 1 task; M: ≤3 tasks single package; L: else) in preflight + G4 tiering + size-class stdout line; SKILL.md §Size-Classed Ceremony map (S: 1 reviewer, merged C+D, direct-apply housekeeping; M: 2 reviewers; L: full); reviewer-brief context line; contract + fixture updates |

## 5. Size classes (normative for PR-5)

- **S** — 1 declared task. Ceremony: code-reviewer only; per-task review doubles as the PR-scope review (the diffs are identical); housekeeping second PR applied directly by the orchestrator, merged on CLEAN. G4: existence checks hard, grammar findings → warnings.
- **M** — 2–3 declared tasks whose `Files:` paths sit in one top-level `packages/<name>` / `apps/<name>` root (non-code paths don't count against it). Ceremony: code + spec reviewers; separate Phase D; housekeeping as today. G4: as S.
- **L** — everything else. Current full ceremony and full G4 grammar hard-gate.
- Codex gate + CI are invariant across classes. Any ACTIONABLE finding escalates the class one step for the remainder of the run (S→M adds the spec-reviewer; M→L adds code-quality-reviewer and a separate Phase D).

## 6. Non-goals

Doc-first for new plans; plan-readiness audit gates; the Status Promotion Gate; manifest discipline for plan-task shipment; Codex-gated merge; worktree containment. All unchanged.

## 7. Scope rulings + residual register

**Rulings** (what the migration deliberately does NOT touch):

1. Plan-Tasks-block cite grammar (`Spec-NNN row N`, AC forms, line hints) — Gate 4 + the audit runbook own that lifecycle; docs→docs retains ALL its forms (colon, line-word, AC-hint). The S/M grammar demotion (§5) is the deliberate softening lever there.
2. Housekeeper manifest `Plan-NNN:LLL-MMM` line ranges — ephemeral `.agents/tmp` JSON + subagent briefs, never committed; not citations.
3. Reviewer finding-locations (`file.ts:45-52`) — ephemeral diff-anchored review output keeps `file:line` (the right tool); committed EXAMPLES of them use `<file>:<start>-<end>` placeholder form.
4. Docs-prose label cites (`Spec-NNN:LL` in `.md`) and docs→docs `.md:NNN` — stay, per decision 6; §-form and anchor links are convention-forward.

**Residuals** (named, counted 2026-07-07; owners after this refinement):

| Residual | Size | Owner |
| --- | --- | --- |
| docs→docs raw `.md:NNN` | 92 occ / 76 sites | hook floor + CAT-06/07 audit |
| docs-prose `Spec/Plan/ADR-NNN:LL` | 693 occ / 508 sites | CAT-07 audit; §-form forward |
| bare-name `.md:NNN` in `packages/` code | 72 occ | CAT-07 audit (label-cite's excluded class) |
| code→code `file.ts:NNN` | 380 occ | convention only (`#symbol` forward) |
| unbackticked `§`-cites in code | ~653 sites | CAT-04 audit; backtick-forward |
| `tools/`+`.claude/` code label cites | 27 + 13 occ | outside the gate universe by design |
| `#symbol` comment-mention false-pass | — | CAT-02 audit + reverse advisory |
| Gate-4 line-hint drift in L-class plan phases | pre-existing | runbook cite-amendment loop |
| `Refs:` trailer teach-only (no commitlint footer rule) | pre-existing | lane-2 traceability is review-enforced |
| housekeeper-design memo stale DESCRIBES (:104 tier count, :227 spec-promotion non-goal) | 2 sites | dated memo; fix-forward on next touch |
