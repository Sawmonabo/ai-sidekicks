# T16 — Embed Log: Spec-017 (BL-097 Pass A/B/C)

**Task:** T16 of the research-deletion architectural cleanup. Dissolve the `### BL-097 research provenance` outlier subsection in `docs/specs/017-workflow-authoring-and-execution.md` and surface Pass A/B/C external citations into the existing `## References > ### Primary sources (external)` topical groupings.

**Strategy decision:** Spec-017 already uses the canonical "single `## References` heading with topical sub-groupings at end-of-file" pattern (lines 389+). Rather than introducing a new `### Primary Sources` flat-list (Spec-015 distributes per-section `### References`, which is a different pattern), citations were folded into the existing `### Primary sources (external)` topical buckets. This matches the spec's actual structural convention.

**Source artifacts:**
- Survey: `docs/audit/research-deletion-surveys/bl-097-survey.md` §1.3, §1.4, §1.5
- Pattern reference: `docs/specs/015-persistence-recovery-and-replay.md` (inline-citation discipline at lines 142, 146, 161, 165 etc.)

---

## (a) BL-097 research provenance subsection dissolution result

**Before:** Lines 391–402 contained `### BL-097 research provenance` heading + 10 bullets pointing into `docs/research/bl-097-workflow-scope/` (Wave 1, Wave 2, Pass A through Pass H).

**After:** Subsection deleted in full. The parent `## References` heading at line 389 is preserved. The next sub-heading is now `### Governing docs` (formerly at line 404, now at line 391 of the modified file). Pass A/B/C external citations are folded into the existing `### Primary sources (external) > Execution semantics + human phase` topical bucket; Pass D/E/F/G/H research-internal pointers were already absorbed into the body prose pre-T16 (per survey §1.10 absorption matrix).

**Net diff:** −15 lines (10 research-pointer bullets + heading + blank lines − 0 replacement lines at the deletion site, since destination is the existing topical bucket lower in the same References section).

## (b) Inline citations added (count + sites)

Six new inline citations and one cross-reference rewording, distributed across the `### Primary sources (external) > Execution semantics + human phase` bucket (lines 433–448 of the post-edit file):

| # | Citation | URL | Anchors | Source Pass |
|---|---|---|---|---|
| 1 | Argo — Intermediate Parameters | https://argo-workflows.readthedocs.io/en/latest/intermediate-inputs/ | SA-10 (human-phase form-input pattern) | Pass C |
| 2 | Airflow — Pools | https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html | SA-3 (resource-pool precedent) | Pass A |
| 3 | AWS Step Functions — Error handling | https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html | SA-4 (`fail-fast` `ParallelJoinPolicy`) | Pass A |
| 4 | Dagster — Run concurrency | https://docs.dagster.io/concepts/configuration/run-tags#run-concurrency | SA-3 (multi-tier pool precedent) | Pass A |
| 5 | GitHub Actions — Reviewing deployments | https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments | SA-12 (`human-approval` gate UX) | Pass C |
| 6 | Model Context Protocol — Elicitations | https://spec.modelcontextprotocol.io/specification/2025-06-18/server/utilities/elicitations/ | SA-12 (`mcp_elicitation` Cedar overlap) | Pass C |
| 7 | W3C WCAG 2.2 §3.3.7 — Redundant Entry | https://www.w3.org/TR/WCAG22/#redundant-entry | SA-26 / SA-28 (form-state UX requirement) | Pass C |

Bucket header label updated from `(D1, D2, SA-1…SA-11)` to `(D1, D2, SA-1…SA-12, SA-26)` to reflect the new SA-anchor coverage.

## (c) Cross-refs added (research-pointer rewordings)

Three load-bearing pointer-replacement edits where the in-body sentence cross-refs ADR-015 directly instead of pointing into a Pass file:

| Site | Before | After |
|---|---|---|
| Line 146 (Multi-agent §, BIND criterion (c)) | `…BIND lifecycle contract addressing the five ambiguities in [Pass B §3.1](../research/...).` | `…BIND lifecycle contract addressing the five ambiguities recorded canonically in ADR-015 §V1.1 Criterion-Gated Commitments.` |
| Line 269 (workflow_gate_resolution event) | `Base payload per [Pass F §2.5](../research/...); extended at the persistence layer with `gate_resolution_id` + `row_hash` fields per [Pass G §5 verification procedure](../research/...) to realize…` | `The base payload is extended at the persistence layer with `gate_resolution_id` + `row_hash` fields to realize…` (research-internal §-pointers dropped; surrounding prose stands on its own) |
| Lines 376–377 (ADR Triggers) | `…five ambiguities documented in [Pass B §3.1](../research/...).` and `…proposed follow-up task per [Wave 2 §4.1](../research/...).` | `…five ambiguities documented in [ADR-015 §V1.1 Criterion-Gated Commitments](...).` and `…proposed follow-up task per [ADR-015 §V1.1 Criterion-Gated Commitments](...).` |

Per advisor + survey §1.4, **Pass B's destination doc is ADR-015 only** (not Spec-017); Spec-017's Pass B work is therefore confined to these three pointer-replacement sites + the deletion. No new Pass B citations were added to Spec-017's References section because they already live (or will live) in ADR-015 §Research Conducted (T14).

## (d) References section additions (count + line range)

**Section unchanged structurally** — the existing `## References` heading at line 389 was preserved; only the outlier `### BL-097 research provenance` sub-heading + 10 bullets at lines 391–402 were dissolved, and the `### Primary sources (external) > Execution semantics + human phase` bucket received 7 new inline citations.

**Final References section line range:** 389–468 (post-edit; 90 lines, comprising `### Governing docs`, `### Related specs`, and `### Primary sources (external)` with five topical buckets).

**Per T11 §(d) cross-Pass dedup discipline:**
- Camunda 8 user tasks already present (line 442) — **not duplicated** despite Pass C survey row tagging it.
- Temporal Child Workflows already present (line 436) — **not duplicated** despite Pass A + Pass B both citing it.
- CloudEvents v1.0.2 + OpenTelemetry semconv + Temporal events all already covered in `Event taxonomy` bucket (lines 452–459) — Pass F's contributions were absorbed pre-T16.
- All Pass D/E/F/G/H load-bearing externals already absorbed in pre-T16 inline citations within the body prose (lines 62, 86, 147, 165, 178, 200, 204–207, 261, 269, 342–348) — survey §1.10 absorption matrix confirms.

## (e) Verification grep

Two grep passes run against the post-edit file:

**Pass 1 — narrow file-path-component pattern (definitive):**

```
Grep "research/bl-097|bl-097-workflow-scope" docs/specs/017-workflow-authoring-and-execution.md
→ No matches found.
```

**Pass 2 — broad pattern (literal `pass-[a-h]`):**

```
Grep "pass-[a-h]|wave-[12]|BL-097 research provenance" docs/specs/017-workflow-authoring-and-execution.md
→ Match at line 222 only:
  - **Parallel with `all-settled`.** A research workflow spawns `{pass-a, pass-b, pass-c, pass-d, pass-e}` in parallel under `ParallelJoinPolicy: all-settled`. …
```

The line 222 hit is **intentional unrelated content**: an example-flow phase-name set in the "Example Flows" section illustrating parallel execution with `all-settled` `ParallelJoinPolicy`. The phase names `pass-a`…`pass-e` are user-authored example identifiers (a meta-reference to the BL-097 research structure used as a relatable example, not a research-pointer). Per advisor pre-edit guidance, this match was anticipated and does not constitute a residual research/ pointer.

**Verification verdict: clean.**

## (f) Anomalies

1. **Heading-level promotion side-effect.** Dissolving `### BL-097 research provenance` and keeping the `## References` parent caused `### Governing docs` (formerly the second `###` under `## References`) to become the first sub-heading. No structural defect — the existing four sub-headings (`### Governing docs`, `### Related specs`, `### Primary sources (external)`, plus the topical bold-headers within `### Primary sources (external)`) remain coherent.

2. **Survey row staleness — Camunda 8.** Survey §1.5 listed `Camunda 8 user tasks` as a Pass C citation needing Spec-017 absorption; verification confirms it was already present at line 442 (pre-T16), so it was not re-added. Advisor flagged this row as stale; treating it as no-op was correct.

3. **Pass C — `mcp_elicitation` Cedar-category linkage.** Spec-017's body prose at line 167 already says "human_phase_contribution" (the new Spec-012 approval category for SA-12), but does not surface the MCP Elicitations spec as the external precedent for a sibling Cedar category. The added MCP Elicitations citation in the References bucket signals the design-precedent linkage without requiring a body-prose edit (the SA-12 anchor is sufficient).

4. **No new ADR triggers required.** All three line 376/377-area ADR triggers either (a) already cross-ref ADR-015 (the BIND-lifecycle ADR trigger is now self-consistent: ADR-015 holds the 5 ambiguities, the trigger says "draft a BIND-lifecycle ADR resolving the 5 ambiguities documented in ADR-015"), or (b) are forward-looking V1.x triggers for SQLite STRICT and OTel ratification.

5. **Bucket-header label expansion was scope-correct.** Updating the Execution-semantics bucket header from `(D1, D2, SA-1…SA-11)` to `(D1, D2, SA-1…SA-12, SA-26)` reflects the new citations (SA-12 added the MCP elicitation + GH Actions deployments + Camunda user tasks; SA-26 added WCAG 2.2). No new SA-anchors were created — only the bucket label was widened to acknowledge existing anchors that the new citations support.

---

**T16 complete. Spec-017 is now research/-pointer-free except for line 222's intentional example-flow content. Ready for T17 + T18 to follow.**

---

## T19 Cross-Reference: PASS

Verified 2026-04-25 by Opus 4.7 via T19 sweep gate. Embed-log claims cross-checked against `git diff main..HEAD -- docs/specs/017-workflow-authoring-and-execution.md`.

**Spot-checks:**
- `### BL-097 research provenance` subsection: removed from file (verified by grep — no matches in current Spec-017). Match.
- 7 inline citations added to `### Primary sources (external) > Execution semantics + human phase` bucket per embed log §(b): Argo intermediate-parameters, Airflow Pools, AWS Step Functions error-handling, Dagster run-concurrency, GitHub Actions reviewing-deployments, MCP Elicitations, W3C WCAG 2.2 §3.3.7. Match.
- Three pointer-replacement rewrites at lines 146, 269, 376–377 per embed log §(c): all redirected to ADR-015 §V1.1 Criterion-Gated Commitments (or replaced with self-standing prose). Match.
- Diff stat: 12 insertions / 18 deletions; consistent with subsection dissolution (-15 lines) + 7 citation additions + 3 pointer-replacement rewrites.
- Final-state grep `research/bl-097|wave-[12]-synthesis|pass-[a-h]-` against Spec-017 returns zero matches; only the intentional example-flow content `pass-a…pass-e` at line 222 remains as bare-text example identifiers (not file pointers — task allowed bare-text pass tags per the "Pass A/B/C without hyphen-or-link IS FINE" rule).

**Verdict: PASS.** Spec-017 ready for T20 deletion of `docs/research/bl-097-workflow-scope/`.
