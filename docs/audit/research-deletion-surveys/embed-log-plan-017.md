# Embed Log — Plan-017 (T17)

**Task:** T17 of the research-deletion architectural cleanup. Embed BL-097 Pass C/F/G/H load-bearing externals into `docs/plans/017-workflow-authoring-and-execution.md` by (i) creating a new `## References` section per the Plan-024 flat-list pattern and (ii) rewriting six inline pointers into `docs/research/bl-097-workflow-scope/` to primary-source citations or canonical cross-refs.

**Source survey:** `/home/sabossedgh/dev/ai-sidekicks/docs/audit/research-deletion-surveys/bl-097-survey.md` §1.5 (Pass C), §1.8 (Pass F), §1.9 (Pass G), §1.10 (Pass H), plus §3.2 broken-link table for Plan-017.

**Pattern reference:** `docs/plans/024-rust-pty-sidecar.md` lines 187+ (canonical flat `## References` heading; mixed internal cross-refs to ADRs/specs and external URL bullets).

---

## (a) References Section Creation

- **Heading inserted:** line 154 (`## References`)
- **Span:** lines 154 → 196 (43 lines including heading + blank line + 41 bullet entries)
- **Position:** end of file, immediately after the `## Done Checklist` block
- **Format:** flat unordered list, mixed internal cross-refs and external URLs, each bullet as `- [Title](URL) — short rationale phrase`. Matches Plan-024 lines 187–212 conventions.
- **Pre-state:** Plan-017 had no end-of-file `## References` section (per T11 survey §3.3 anomaly #2). The front-matter `**References**` row was the only references-bearing surface; it pointed at three research files.

## (b) Citation Entries Added

- **Total bullets:** 41
- **Internal cross-refs:** 8 (Spec-017, ADR-015, local-sqlite-schema §Workflow Tables, Plan-006, Plan-012, Plan-014, Plan-015, Plan-016)
- **External primary-source citations:** 33

**External breakdown by Pass origin (post-dedup; survey-mapped):**
- Pass C (Human Phase UX): 14 externals (Argo intermediate-parameters, Argo suspend-template-outputs, Argo discussion #8365, Camunda 8 user tasks, Camunda 8 form-data, GitHub Actions reviewing deployments, AWS Step Functions human-approval tutorial, AWS Step Functions SendTaskHeartbeat, Temporal Python message passing, Temporal HITL tutorial, Cloudflare Workflows waitForEvent, LangGraph HITL, Microsoft Agent Framework HITL 2026-03-31, W3C WCAG 2.2 §3.3.7)
- Pass F (Event Taxonomy): 5 externals (CloudEvents v1.0.2, OpenTelemetry Semantic Conventions for Events, OpenTelemetry GenAI observability blog, Argo Workflows architecture, n8n executions API)
- Pass G (Persistence): 6 externals (Restate Building Modern Durable Execution 2025, Temporal custom persistence 2024, Argo workflow archive, Argo offloading-large-workflows, Cadence persistence, SQLite JSON1)
- Pass H (Testing): 7 externals (fast-check, Jazzer.js, Jazzer.js fuzz-targets docs, Endor Labs CVE-2025-66626 analysis, Astronomer testing Airflow, Bitovi replay testing, Temporal TS SDK testing suite)
- Cross-Pass / shared (already inline in Test table; re-listed in References per Plan-024 mixed-pattern precedent): 1 (OWASP File Upload Cheat Sheet)

**Cross-Pass deduplication applied (per T11 §3.3 anomaly #3):**
- CloudEvents v1.0.2 — Wave 2 + Pass F → cited once
- OpenTelemetry semconv events — Wave 2 + Pass F → cited once
- Crosby & Wallach 2009 + AuditableLLM + Trillian — covered in ADR-015 §Research Conducted (T14) and Spec-017 §Hash-chain scheme (T15); not duplicated here
- OWASP File Upload — already inline in Test table line 121; one References entry retained matching Plan-024 mixed-pattern (inline in body + listed in References)
- Temporal TS SDK testing suite — already inline at SA-31 narrative line 124; References entry tagged `(SA-31; also inline)` for clarity

## (c) Front-Matter Rewrites

| Line | Before | After | Notes |
|---|---|---|---|
| 9 (`Amended` row) | `... absorbs SA-24/29/30/31 from [wave-2-synthesis.md §5](../research/bl-097-workflow-scope/wave-2-synthesis.md))` | `... absorbs SA-24/29/30/31 per [Spec-017](../specs/017-workflow-authoring-and-execution.md) + [ADR-015 §Amendment History](../decisions/015-v1-feature-scope-definition.md#amendment-history))` | Verified ADR-015 line 192 has `## Amendment History` heading. Spec-017 has no Amendment History heading; cross-ref kept generic to Spec-017 root. |
| 15 (`References` row) | `[Updated Spec-017]; [BL-097 Wave 2 Synthesis] (SA-24/29/30/31); [Pass G Persistence]; [Pass H Testing]` (3 research/ pointers) | `[Spec-017] (canonical contract surface; SA-24/29/30/31 narrative); [ADR-015 §Research Conducted] (BL-097 primary-source corpus); see also \`## References\` at end of file` | Verified ADR-015 §Research Conducted exists per survey §3.3 anomaly #1 (T14 created it). Frontmatter row points at end-of-file References section as the canonical surface. |

## (d) Body-Line Rewrites

| Line (post-edit) | Pass | Before | After | Strategy |
|---|---|---|---|---|
| 61 | Pass C | `... per [Pass C §3](../research/bl-097-workflow-scope/pass-c-human-phase-ux.md). Table reserved for V1.x daemon-side fallback (SA-28).` | `... per [Spec-017 §Ship-empty tables (SA-28)](../specs/017-workflow-authoring-and-execution.md#ship-empty-tables-sa-28). Table reserved for V1.x daemon-side fallback.` | Reframed as Plan-017 own decision with cross-ref to Spec-017 §Ship-empty tables (SA-28) at Spec-017 line 209. SA-28 tag absorbed into the section reference. |
| 67 | Pass F | `... per [Pass F event taxonomy](../research/bl-097-workflow-scope/pass-f-event-taxonomy.md) — 5 categories, 23 event types.` | `... 5 categories, 23 event types per Spec-017 §Workflow Timeline Integration. Envelope follows [CloudEvents v1.0.2](...); semantic-convention naming aligns with [OpenTelemetry Semantic Conventions for Events](...).` | 5/23 claim canonicalized in Plan-017; primary-source CloudEvents + OTel inserted inline (also in References). |
| 90 | Pass G | `... and halts on \`chain_break_detected\` per [Pass G §5](../research/bl-097-workflow-scope/pass-g-persistence-model.md).` | `... and halts on \`chain_break_detected\`. Per-row recompute walks \`prev_hash \|\| JCS-canonical(row_body)\` and asserts equality with the persisted \`row_hash\` (flat hash-chain pattern per [Local SQLite Schema §Workflow Tables](../architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017)).` | Chain-recompute mechanism canonicalized in Plan-017; underlying hash-chain primaries (Crosby & Wallach + Trillian) are landed by T18 in `local-sqlite-schema.md` per the survey routing table. |
| 102 | Pass H | `Five test categories per [Pass H §1](../research/bl-097-workflow-scope/pass-h-testing-strategy.md) (SA-29). ...` | `Five test categories (SA-29): property-based, fuzz, load, long-running integration, security regression. Each carries a V1 *ambition level* ... Replay-determinism scaffolding follows the Temporal \`runReplayHistory\` pattern; property + fuzz frameworks pinned to \`fast-check\` and \`@jazzer.js/core\`; CVE-reproducer corpus seeds the security-regression battery (SA-30).` | 5-category claim canonicalized inline; framework precedent (`fast-check` + Jazzer.js + Temporal `runReplayHistory`) named in prose with full citations in `## References`. |

Inline CVE links in the Test table (lines 117–124) are intentionally retained — they are body-prose primary-source citations, not research/ pointers, and match Plan-024's pattern of citing externals both inline (as anchors of specific table rows) and at end-of-file.

## (e) Verification Grep

Two verification passes run after edits:

```
Grep "research/bl-097|pass-[a-h]-|wave-[12]-synthesis" docs/plans/017-workflow-authoring-and-execution.md
→ No matches found

Grep "research/" docs/plans/017-workflow-authoring-and-execution.md
→ No matches found
```

Both pass. The case-sensitive `BL-097` (uppercase, in line 9) is the only remaining BL reference and is the intended state — it points at `../backlog.md` and ADR-015, not at `docs/research/`.

Final file: 196 lines (was 152; +44 from References section creation).

## (f) Anomalies

1. **Spec-017 has no `## Amendment History` heading.** ADR-015 has it at line 192, but Spec-017's amendment narrative lives in the body of `## Resolved Questions and V1 Scope Decisions` (line 380) and `### BL-097 research provenance` (line 391, due to be renamed when T15 completes Spec-017 cleanup). Line-9 cross-ref to Spec-017 is therefore generic-to-doc rather than section-anchored. **Not blocking** — root cross-ref still resolves; if T15 lands a `## Amendment History` heading in Spec-017, line 9 should be tightened to anchor it.

2. **Pass C `human-upload OWASP` and Pass H `OWASP File Upload Cheat Sheet`** — same external. Inline citation already lives in the Test table at line 121; References entry retained per Plan-024 mixed-pattern (inline anchor + References list) so deletion of the Test-table inline link in any future edit doesn't lose the citation.

3. **CVE inline-link density in Test table (lines 117–124).** These are not surveyed-Pass orphans — they were already inline pre-T17 and survive research/ deletion intact. Not duplicated to References except OWASP File Upload (per Plan-024 precedent for I6-anchoring). If future audit prefers strict no-duplication-with-inline-CVE policy, the OWASP entry can be dropped from References without losing citation density.

4. **One Pass-C-resolved citation deferred to "future Plan-017 detail":** Pass C's `mcp_elicitation` Cedar-category overlap (MCP elicitations spec) is anchored at SA-12, which is canonically owned by Spec-017 §149 (Human phase) + Spec-012 (approvals). Plan-017's References list does not duplicate it; it lives in Spec-017's References per T11 survey §1.5. **Verify in T15** Spec-017 carries the MCP elicitations URL.

5. **Survey §3.2 said Plan-017 had ~6 broken-link sites.** Confirmed: lines 9 + 15 + 61 + 67 + 90 + 102 — exactly 6. All 6 surgically replaced.

6. **Bare-text Pass tags survive.** Lines 68, 89, 124, 143, 145 reference "Pass F event type", "Pass G §5", "Pass G §7", "Pass H §5.2" as bare-text semantic tags (not markdown links). These are self-contained and survive `docs/research/` deletion intact — they consistently match how Spec-017 retains Pass-tag prose for SA narrative continuity. The verification grep `bl-097|research/bl-097|pass-[a-h]` (the exact prompt spec) returns zero matches; the lowercase-pattern-with-hyphen in the grep doesn't match the bare-text "Pass G §5" forms. Intentional.

---

**Status:** T17 complete. Plan-017 is research/-pointer-free; new `## References` section conforms to Plan-024 flat-list pattern; 33 external load-bearing primary-source citations from Pass C/F/G/H landed; cross-Pass dedup with ADR-015 §Research Conducted (T14) and Spec-017 §References (T15) applied; T18 inherits the local-sqlite-schema landing for Crosby & Wallach + Trillian per survey routing.

---

## T19 Cross-Reference: PASS

Verified 2026-04-25 by Opus 4.7 via T19 sweep gate. Embed-log claims cross-checked against `git diff main..HEAD -- docs/plans/017-workflow-authoring-and-execution.md`.

**Spot-checks:**
- `## References` section at line 154 with 41 bullet entries; embed log §(b) claimed "Total bullets: 41 (8 internal + 33 external)." Match.
- Front-matter line 9 `Amended` row: pre-edit `from [wave-2-synthesis.md §5](../research/...)` → post-edit `per [Spec-017] + [ADR-015 §Amendment History]`. Match.
- Front-matter line 15 `References` row: 3 research-pointers replaced with Spec-017 + ADR-015 §Research Conducted + end-of-file References cross-ref. Match.
- Body-line rewrites at lines 61 / 67 / 90 / 102: all 4 surgically replaced per embed log §(d) — Pass C → Spec-017 §Ship-empty tables (SA-28); Pass F → 5/23 inline + CloudEvents/OTel; Pass G § 5 → flat hash-chain pattern + sqlite-schema cross-ref; Pass H §1 → 5-category prose + framework-precedent inline.
- Diff stat: 50 insertions / 6 deletions; consistent with 41-bullet References creation + 4 line-level body rewrites + 2 front-matter row rewrites.
- Final-state grep `docs/research/|\.\./research/|wave-[12]-synthesis|pass-[a-h]-` against Plan-017 returns zero matches.

**Verdict: PASS.** Plan-017 ready for T20 deletion of `docs/research/bl-097-workflow-scope/`.
