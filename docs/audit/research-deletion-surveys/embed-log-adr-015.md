# Embed Log — ADR-015 (BL-097 Research-Deletion Cleanup)

Tracks T14–T15 application of `surface-external-citations` strategy against `docs/decisions/015-v1-feature-scope-definition.md`. T15 will append below T14 once executed.

---

## T14 — 2026-04-25

### (a) Section creation

`### Research Conducted` was created as the FIRST subsection under the existing `## References` section (line 156 in pre-edit file; unchanged after edits). New subsection occupies lines 158–173 in the post-edit file:

- Line 158: `### Research Conducted` heading.
- Line 160: 1-paragraph intro framing scope of citations (event taxonomy, persistence, test infra, OWASP) and pointing at Spec-017 §References and §Amendment History for the Pass-A/B/D/E primaries that are consumed inline elsewhere.
- Lines 162–173: 4-column table per ADR-016 / ADR-017 canonical format (`Source | Type | Key Finding | URL/Location`).

`## References` already existed pre-edit; no parent-section creation was needed. Placement matches the precedent: `### Research Conducted` precedes `### Related ADRs` (which precedes `### Related Docs`).

### (b) Citation rows added

**10 rows** added at lines 164–173, sourced from T11 §1.2 Wave 2 unique-externals list (the `better-sqlite3` row in T11 §1.2 was marked "redundant — already in Spec-015; do not re-cite", so it was excluded; all 10 remaining Wave 2 unique externals were landed):

1. CloudEvents v1.0.2 specification — anchors SA-18.
2. OpenTelemetry Semantic Conventions for Events — anchors SA-19.
3. Temporal Events Reference — anchors SA-20.
4. SQLite Write-Ahead Logging — anchors Pass G persistence rationale.
5. Crosby & Wallach 2009 (USENIX) — anchors C-13 / I7.
6. AuditableLLM (MDPI 2025) — anchors C-13 LLM precedent.
7. Google Trillian — anchors C-13 operational precedent.
8. fast-check — anchors SA-29 property tests.
9. Jazzer.js — anchors SA-29 fuzz tests.
10. OWASP File Upload Cheat Sheet — anchors I6 / SA-26.

Cross-Pass duplications per T11 §3.3 anomaly #3 were de-duplicated: each source appears exactly once in the table even though several (Crosby & Wallach, OWASP, CloudEvents, OTel semconv) recur in multiple Passes' bibliographies.

### (c) Lines rewritten

**6 line-level rewrites** (citation-source pointers replaced with §Research Conducted / §Amendment History references; no analytic content removed):

| Pre-edit line | Section | Change |
|---|---|---|
| 56 | §Decision → V1 Features (17), Feature 17 row | Dropped `docs/research/bl-097-workflow-scope/wave-1-synthesis.md + wave-2-synthesis.md` mention; replaced with "from BL-097 research; primary sources consolidated in §Research Conducted". |
| 68 | §V1.1 Criterion-Gated Commitments preamble | Dropped `docs/research/bl-097-workflow-scope/wave-1-synthesis.md §5.3` mention; replaced with "stated inline; primary sources consolidated in §Research Conducted". |
| 149 | §Consequences → Negative | Dropped `docs/research/bl-097-workflow-scope/pass-d-post-v1-freeze-regrets.md` source pointer; preserved the inline live links to the Dagger CUE→SDK rewrite blog (already a primary source link) and added "Primary sources consolidated in §Research Conducted". |
| 176 (now 191) | §References → BL-097 Research Provenance preamble | Dropped `docs/research/bl-097-workflow-scope/` path mention; replaced with reference to §Research Conducted + §Amendment History. |
| 230 (post-edit ≈ 244) | §Amendment History → "How decided" paragraph | Dropped `wave-1-synthesis.md §5` reference; replaced with "Rationale captured inline in §V1.1 Criterion-Gated Commitments above; primary sources in §Research Conducted." (Out of prompt's stated CITATION SCOPE list but inside the verification grep's required-zero-matches scope — see Anomalies (f).) |
| 234 (post-edit ≈ 248) | §Decision Log row 3 | Dropped `docs/research/bl-097-workflow-scope/` path mention; replaced with "primary-source citations consolidated in §References → §Research Conducted; rationale and cross-reference list in §Amendment History." |

### (d) Bullet items removed

**2 bullets removed** at pre-edit lines 178–179 in `### BL-097 Research Provenance`:

- Pre-edit line 178: `[Wave 1 synthesis](../research/bl-097-workflow-scope/wave-1-synthesis.md)` — removed (Wave 1 was synthesis prose only; no unique external citations per T11 §1.1 Wave 1 Synthesis; its role as a citation-anchor surface is now filled by §Research Conducted).
- Pre-edit line 179: `[Wave 2 synthesis](../research/bl-097-workflow-scope/wave-2-synthesis.md)` — removed (Wave 2's 10 unique externals all land in the new §Research Conducted table).

The remaining Pass A–H bullet items (pre-edit lines 180–187, post-edit lines 195–202) were left intact — they are out of T14's CITATION SCOPE per the prompt; they will become dead links upon `docs/research/` deletion. See Anomalies (f) below.

### (e) Verification grep result

Command: `Grep "wave-[12]-synthesis|research/bl-097/wave" docs/decisions/015-v1-feature-scope-definition.md`

Result: **No matches found**. Verification clean.

### (f) Anomalies

1. **CITATION SCOPE list vs. verification-grep target — line 230 (post-edit ≈ 244) was inside the verification target but not in the prompt's explicit CITATION SCOPE list.** The prompt enumerated lines [56, 68, 149, 176, 178–179, 234] as the rewrite scope and required `Grep "wave-[12]-synthesis|research/bl-097/wave"` to return zero matches. Line 230's `wave-1-synthesis.md §5` reference would have failed the grep verification, so the line had to be cleaned up to satisfy acceptance. This was treated as the prompt intending verification-clean state; the rewrite was minimal (replaced the path with an in-doc cross-reference to §V1.1 Criterion-Gated Commitments and §Research Conducted).

2. **Out-of-prompt-scope research/ pointers persist on lines 76 and 195–202 (post-edit).** Per T11 survey §3.2, the Class B broken-link sites in ADR-015 include line 76 (sub-criterion (c) of the BIND commitment, embedding `pass-b-multi-agent-channel-contract.md §3.1`) and lines 180–187 pre-edit / 195–202 post-edit (the eight Pass A–H bullet items each pointing at `../research/bl-097-workflow-scope/pass-X-*.md`). These were explicitly NOT in the prompt's CITATION SCOPE list and were left intact. Both will become dead links when `docs/research/` is deleted unless covered by a follow-up T-task. **Parent agent must decide:** (i) the prompt's narrow scope is intentional and a later T-task will clean these, or (ii) the prompt missed them and they need cleanup before research/ deletion. Surface count: 9 dead-link sites would persist after T14 as written.

3. **Phantom section names in prompt resolved by substitution.** Prompt referenced "§V1 Engine Scope" and "§Amendment Sources" which do not exist as anchors in ADR-015. Substituted with the closest existing anchors: "§V1 Features (17) Feature 17 row" / "§Decision" for "V1 Engine Scope content"; "§Amendment History" for "Amendment Sources content". The new `### Research Conducted` heading serves as the canonical citation-anchor surface called out by both the prompt and the T11 survey.

4. **Structural awkwardness in `### BL-097 Research Provenance` after Wave-bullet removal.** Section now opens with a preamble ("grounded in the BL-097 research body") and a colon-introduced bullet list of 8 Pass items only — no Wave items. Reads slightly oddly but the section header retains research-provenance semantics and the bullets cover Pass-level rationale anchors. Not fixed because outside prompt scope; flagged here for awareness.

5. **Spec-017 / Plan-017 pointer-rewrite work is downstream T-tasks** (T15: Spec-017 §References Pass C + Pass E delta additions; T16/T17: Plan-017). T14 only addressed ADR-015 and consumed the Wave 2 unique externals. Pass A / B / D / E primary externals destined for ADR-015 §Research Conducted per T11 §1 are NOT yet landed — the table only carries Wave 2's 10 externals, not the ~50 orphan externals total surfaced in T11 §3.1 Class A. **This may be intentional scope-narrowing for T14** (Wave 2 is "synthesis" the table can replace cleanly; Pass A/B/D/E primaries arguably belong in Spec-017 §References per the dual-mapping in T11 §1) **but it should be confirmed by the parent agent before declaring the BL-097 ADR-015 surface citation-complete.**

---

## T15 — 2026-04-25

### (a) Pass-level citations added to Research Conducted table

**50 rows** added to the existing `### Research Conducted` table (extended after the OWASP File Upload row T14 landed). The table now carries 60 total citation rows (T14: 10 Wave 2 unique externals + T15: 50 Pass A/B/D/E externals). Row breakdown by Pass framing (table is flat per ADR-016 canonical pattern; Pass framing is conceptual, not section-headed):

- **Pass A (parallel execution): 7 rows** at lines 174–180 — Apache Airflow `dag.py` source, Apache Airflow Pools, Astronomer trigger rules, Temporal Go SDK, Argo Workflows parallelism, Dagster Run Concurrency, AWS Step Functions Error Handling. Anchors C-3 (DAG executor), SA-3 (resource pools), SA-4 (`ParallelJoinPolicy` `fail-fast`).
- **Pass B (multi-agent channel contract / BIND-criterion evidence): 11 rows** at lines 181–191 — Temporal ParentClosePolicy, Apache Airflow 2.0 release blog, `apache/airflow#1350` (SubDAG removal), Astronomer Airflow 2.0 upgrade guide, Twine Labs SubDAG deadlock writeup, n8n `executeWorkflow`, Activepieces SubFlows, Argo DAG walkthrough, `argoproj/argo-workflows#12425`, AWS Step Functions Best Practices, Dapr Workflow Patterns. Anchors SA-6 (multi-agent ownership: OWN-only V1) and §V1.1 Criterion-Gated Commitments BIND-criterion (b) "concrete failure case documented."
- **Pass D (post-V1 freeze regrets / 7-system survey evidence): 17 rows** at lines 192–208 — Apache Airflow 3.0 release blog, Astronomer Airflow upgrade guide, `apache/airflow#9606` (Smart Sensors), Apache Airflow 2.4.0 release notes, Temporal Versioning with Patches, Temporal Worker Versioning (legacy + new), `dagger/dagger#4086` (CUE→SDK), n8n BREAKING-CHANGES.md, n8n 1.0 + 2.0 migration guides, GitHub Actions HCL → YAML migration (2019), GitHub Actions `set-output` + Node 16→20 + Artifact v3 deprecations, GitHub Actions Immutable Actions GA, CircleCI 1.0 EOL. Anchors the full-engine-at-V1 thesis ("every surveyed system shipped a V1 subset and broke later") and three freeze-regret patterns (additive enum expansion / replacement expansion / execution-model commitment).
- **Pass E (security invariants I1–I7 / CVE corpus): 15 rows** at lines 209–223 — OWASP CI/CD Top 10, NVD CVE-2025-54550 (Airflow secret-masker), CVE-2025-67895 (Airflow Edge3 RCE), CVE-2024-53862 + CVE-2024-47827 (Argo), CVE-2025-30066 (tj-actions) + CISA tj-actions advisory, GitHub Security Lab script-injection research, GitHub Actions Security hardening guide, NVD CVE-2025-61671 (`pull_request_target`), Jenkins Script Security plugin, Temporal Data Encryption, NVD CVE-2025-3248 (Langflow), CVE-2024-8183 (Prefect), CircleCI January 2023 incident. Anchors I1 (argv-only execution), I2 (secrets-by-reference), I3 (typed substitution), I4 (content-addressed external refs), I6 (human-upload OWASP minimums), C-9 (artifact immutability), C-12 (secrets-by-reference).

Per T11 §3.3 anomaly #3 + #4 (cross-Pass duplications), Crosby & Wallach + AuditableLLM + Trillian + OWASP File Upload + CloudEvents + OpenTelemetry semconv + Temporal events Reference are cited once each (T14 landing), not duplicated per Pass. Pass-internal NVD CVEs already inline in Spec-017 / Plan-017 (CVE-2025-68613 n8n, CVE-2024-39877 Airflow Jinja2, CVE-2024-56373 Airflow log template, CVE-2025-66626 Argo symlink, CVE-2024-34144 + CVE-2024-34145 Jenkins, CVE-2025-34291 Langflow) were NOT re-cited — per T11 those are explicitly tagged "already absorbed — redundant."

### (b) Line edits applied (line-specific sites)

**3 line-level rewrites** (all citation-source pointers replaced with consolidated-elsewhere references; no analytic content removed):

| Pre-T15 line | Section | Change |
|---|---|---|
| 76 | §V1.1 Criterion-Gated Commitments → C1 BIND criterion (c) | Dropped `documented in `docs/research/bl-097-workflow-scope/pass-b-multi-agent-channel-contract.md` §3.1` clause; preserved the 5 ambiguities enumerated inline after the em-dash. |
| 160 | §References → §Research Conducted intro | Rewrote intro paragraph from T14's "Pass A/B/D/E primaries consumed inline by Spec-017 / Amendment History" framing to seven-research-dimensions framing reflecting that those primaries now land directly in this table. Initial rewrite cited `docs/audit/research-deletion-surveys/bl-097-survey.md` §1 for the dual-mapping; that citation was then dropped to satisfy the verification grep (the `bl-097` token would fail). Replaced with "dual-mapping established at amendment time." |
| 224 | §Amendment History → "Why" preamble | Dropped `(\`docs/research/bl-097-workflow-scope/\`)` parenthetical; preserved the "Wave 1 + Wave 2 research confirmed:" lead-in. |

### (c) Bullet items removed

**8 bullets removed** at pre-T15 lines 195–202 (the entire `### BL-097 Research Provenance (added 2026-04-22)` subsection contents — Pass A through Pass H bullets pointing at `../research/bl-097-workflow-scope/pass-X-*.md`).

Plus: **the entire `### BL-097 Research Provenance (added 2026-04-22)` subsection itself** (header + preamble + 8 bullets) was removed. Rationale: with all 8 bullets gone, the subsection's preamble ("Amendment to Feature 17 ... is grounded in the BL-097 research body. Primary-source citations consolidated in §Research Conducted above; rationale narrative in §Amendment History below.") becomes orphaned content duplicative of the §Research Conducted intro paragraph T14 had already written. Subsection's citation-anchor function is now fully filled by §Research Conducted. Per advisor consultation: "Removing entirely is cleaner."

T14 had explicitly flagged in its (f) Anomalies #2 that the 8 Pass A–H bullets at post-T14 lines 195–202 + the §3.1 BIND lifecycle pointer at line 76 would persist as dead links unless covered by a follow-up T-task. T15 covers all of them.

### (d) T14 anomaly resolution — additional dead-link sites found post-T14

The advisor's broader-pattern analysis surfaced one additional dead-link site beyond T14's flagged 9 (line 76 + lines 195–202):

| Site | Pre-T15 line | Original content | Handled by | Notes |
|---|---|---|---|---|
| Line 76 — BIND criterion (c) `pass-b-*.md §3.1` pointer | 76 | `documented in \`docs/research/bl-097-workflow-scope/pass-b-multi-agent-channel-contract.md\` §3.1` | **REMOVE** (per task spec — content already inline; drop pointer only) | T14 (f) #2 had flagged this. |
| Lines 195–202 — Pass A through Pass H bullets | 195–202 | 8 bullets each linking `../research/bl-097-workflow-scope/pass-X-*.md` | **REMOVE** (entire bullet block + parent subsection per advisor recommendation) | T14 (f) #2 had flagged these. |
| Line 224 — "Wave 1 + Wave 2 research (`docs/research/bl-097-workflow-scope/`)" path | 224 | path-citation parenthetical inside "Why" amendment-history paragraph | **REMOVE** (parenthetical only; preserve the "Wave 1 + Wave 2 research confirmed:" lead-in) | NOT flagged by T14 narrow grep; surfaced by advisor under broader-pattern grep. **This is the additional T14-narrow-grep-miss the task warned about.** |
| Line 160 — T14's intro paragraph cited `bl-097-survey.md` | 160 | `per the destination-mapping in \`docs/audit/research-deletion-surveys/bl-097-survey.md\` §1` | **REPLACE** (with "per dual-mapping established at amendment time"; the survey path triggered the case-sensitive `bl-097` token in the verification grep even though `docs/audit/...` is not deletion-target territory) | Surfaced by post-edit verification grep run. |

Total T14-anomaly resolution count: **4 sites** (3 already in T14's (f) #2 anomaly callout + 1 newly surfaced + 1 self-introduced by T15's intro-paragraph rewrite). All resolved.

### (e) Verification grep result

Command: `grep -n -E "bl-097|research/bl-097|pass-[a-h]-|wave-[12]-synthesis" docs/decisions/015-v1-feature-scope-definition.md`

Result: **No matches found**. Verification clean.

Broader pattern check: `grep -nP "research/|bl-097|pass-[a-h]-" docs/decisions/015-*` returns one line — line 216, an external URL `https://securitylab.github.com/research/github-actions-untrusted-input/`. This is a primary-source GitHub Security Lab research path used as an external citation, NOT a `docs/research/` pointer. Per the task decision tree it is legitimate; left as-is.

Case-insensitive check (`-i`) returns 14 surviving "BL-097" uppercase tokens at lines 9, 34, 56, 130, 149, 238, 244, 250, 261, 271, 272, 273, 274, 275, 276, 286. These are bare-text traceability tags referencing the backlog item ID (e.g., "amended 2026-04-22 per BL-097", "BL-097 task #29"). Per the task rule "Bare-text 'Pass A/B/C/etc.' without hyphen-or-link IS FINE; do not delete those," these are legitimate narrative references and stay.

### (f) Anomalies

1. **Line 160 self-introduced dead-link site.** T15's intro-paragraph rewrite initially cited `docs/audit/research-deletion-surveys/bl-097-survey.md` §1 as the destination-mapping source for Pass C/F/G/H land-elsewhere routing. Although the audit dir is NOT a deletion target, the case-sensitive `bl-097` token in the file name triggered the verification grep. Resolved by rewriting to "per dual-mapping established at amendment time" — preserves the semantic claim (these primaries land elsewhere) without naming the audit artifact. Embed-log readers can still trace the dual-mapping via T11 survey `bl-097-survey.md` §1 + this embed log itself.

2. **`### BL-097 Research Provenance` subsection removal vs. T14 (f) #4 awareness flag.** T14 (f) #4 had noted "Structural awkwardness in `### BL-097 Research Provenance` after Wave-bullet removal." T15 resolves the awkwardness fully by removing the subsection entirely once all 8 Pass bullets become unanchorable on research/ deletion. Net change: ADR-015 §References now has §Research Conducted (60-row table) + §Related ADRs + §Related Docs + §Provenance (the formerly-buried "Pre-implementation architecture audit + BL-097 reconciliation" sub-block now bumped one heading-level forward in adjacency). Section structure cleaner than T14 left it.

3. **External-URL `research/` substring in Pass E rows.** Two rows in the new T15 additions reference primary-source URLs containing `/research/` (GitHub Security Lab) and `/security-guides/` (GitHub Actions docs). Both are external-host paths, not `docs/research/` pointers, and survive the deletion. Tagged here for future-grep-survey awareness; both are legitimate per task decision tree.

4. **No Spec-017 / Plan-017 / `local-sqlite-schema.md` work performed.** T15 scope is ADR-015 only. Pass A/B/D/E externals dual-targeting Spec-017 (per T11 §1 dual-mapping) are NOT landed in Spec-017 by T15. T11 §3.1 Class A externals destined for Plan-017 §References (new section) and `local-sqlite-schema.md` Workflow Tables introduction remain TODO for T16/T17/T18. Per advisor: this scope split is intentional per the original T14–T18 sequencing in T11 §4.

5. **Citation-density delta across ADR-015.** T14 left the ADR with 10 §Research Conducted citations + 4 inline external URLs (Temporal Child Workflows in §V1.1 BIND rationale + Temporal long-running workflows blog in §V1.1 human-phase rationale + Argo suspending walkthrough in same + Dagger CUE→SDK + Airflow `#12292` in §Amendment History). T15 brings the ADR to 60 §Research Conducted citations + the same 4 inline citations. Citation density now matches ADR-016 (8 rows) / ADR-017 (~12 rows) precedent at substantially higher absolute count, reflecting the Wave-1 + Wave-2 + 5-Pass research depth behind the 2026-04-22 amendment.

---

## T19 Cross-Reference: PASS

Verified 2026-04-25 by Opus 4.7 via T19 sweep gate. Embed-log claims cross-checked against `git diff main..HEAD -- docs/decisions/015-v1-feature-scope-definition.md` (working-tree state at HEAD c41d109; research-deletion edits live in working-tree only).

**Spot-checks:**
- §Research Conducted table: 60 data rows (lines 162–223); embed log claimed "T14: 10 + T15: 50 = 60 total." Match.
- `### BL-097 Research Provenance` subsection: removed from file; embed log T15 (c) claimed full removal of the heading + 8 Pass A–H bullets. Match.
- Diff stat: 74 insertions / 22 deletions; consistent with 50-row table extension + Pass-bullet block removal + 6 line-level rewrites at lines 56/68/76/149/176/224/230/234.
- Final-state grep `docs/research/|wave-[12]-synthesis|pass-[a-h]-` against ADR-015 returns zero matches.

**Verdict: PASS.** ADR-015 ready for T20 deletion of `docs/research/bl-097-workflow-scope/`.
