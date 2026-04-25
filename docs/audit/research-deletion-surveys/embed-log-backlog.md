# Embed Log — Backlog (T25)

**Task:** T25 of the research-deletion architectural cleanup. Resolve the BL-097 Resolution entry in `docs/backlog.md` (line 732) which carried 14 dead-link sites pointing at `docs/research/bl-097-workflow-scope/*` paths. T20 will delete `docs/research/` after the T19 sweep gate, so each dead-link site needed retargeting at the Session-M absorption destinations (or surrounding sentence reframing where no clean destination existed). One additional in-scope cleanup at line 243 (Phase 3 intro) was performed under verification-gate authority — that line carried `(see \`docs/research/\`)` which fell inside the verification grep's match scope.

**Source survey:** `docs/audit/research-deletion-surveys/bl-097-survey.md` §1.1–§1.10 (per-Pass absorption mapping), §2 (Pass × Destination matrix), §3.2 (Class B broken-link table for backlog.md).

**Pattern reference:** `docs/audit/research-deletion-surveys/embed-log-plan-017.md` (canonical embed-log structure: (a) References creation, (b) citation entries, (c) front-matter rewrites, (d) body-line rewrites, (e) verification grep, (f) anomalies).

---

## (a) Pre-edit dead-link inventory

The BL-097 Resolution entry contained 14 dead-link sites + 1 in-prose mention of a research-body filename + 1 in-Phase-3-intro `docs/research/` orphan. All sites were in the active body prose of the Resolution entry (no References subsection — backlog entries don't carry one).

| # | Pre-edit Site (line:column) | Pre-edit Pointer | Pass-file Target |
|---|---|---|---|
| 1 | 732 (opening clause) | `[\`docs/research/bl-097-workflow-scope/\`](./research/bl-097-workflow-scope/)` | Catalogue-of-research-corpus pointer (no single Pass) |
| 2 | 732 (D1 anchor) | `[Wave 1 synthesis §5.2](./research/bl-097-workflow-scope/wave-1-synthesis.md)` | Wave 1 (D1 resolution) |
| 3 | 732 (D2 BIND criterion (c)) | `[Pass B §3.1](./research/bl-097-workflow-scope/pass-b-multi-agent-channel-contract.md)` | Pass B (multi-agent channel contract — BIND ambiguities) |
| 4 | 732 (DAG executor / Exit-clause 4) | `[Pass A §2](./research/bl-097-workflow-scope/pass-a-parallel-execution.md)` | Pass A (parallel execution / DAG executor) |
| 5 | 732 ((#30) wave-2 manifest) | `wave-2-synthesis.md ADR-018 broken-link repair` | Wave 2 manifest (in-prose mention, not a markdown link) |
| 6 | 732 (Research body absorbed bibliographic enumeration) | `[A parallel execution](./research/bl-097-workflow-scope/pass-a-parallel-execution.md)` | Pass A |
| 7 | 732 (Research body absorbed bibliographic enumeration) | `[B multi-agent channel contract](./research/bl-097-workflow-scope/pass-b-multi-agent-channel-contract.md)` | Pass B |
| 8 | 732 (Research body absorbed bibliographic enumeration) | `[C human phase UX](./research/bl-097-workflow-scope/pass-c-human-phase-ux.md)` | Pass C |
| 9 | 732 (Research body absorbed bibliographic enumeration) | `[D post-V1 freeze regrets](./research/bl-097-workflow-scope/pass-d-post-v1-freeze-regrets.md)` | Pass D |
| 10 | 732 (Research body absorbed bibliographic enumeration) | `[E security surface](./research/bl-097-workflow-scope/pass-e-security-surface.md)` | Pass E |
| 11 | 732 (Research body absorbed bibliographic enumeration) | `[F event taxonomy](./research/bl-097-workflow-scope/pass-f-event-taxonomy.md)` | Pass F |
| 12 | 732 (Research body absorbed bibliographic enumeration) | `[G persistence model](./research/bl-097-workflow-scope/pass-g-persistence-model.md)` | Pass G |
| 13 | 732 (Research body absorbed bibliographic enumeration) | `[H testing strategy](./research/bl-097-workflow-scope/pass-h-testing-strategy.md)` | Pass H |
| 14 | 732 (Research body absorbed bibliographic enumeration) | `[Wave 1](./research/bl-097-workflow-scope/wave-1-synthesis.md)` | Wave 1 synthesis |
| 15 | 732 (Research body absorbed bibliographic enumeration) | `[Wave 2](./research/bl-097-workflow-scope/wave-2-synthesis.md)` | Wave 2 synthesis |
| 16 | 243 (Phase 3 intro — out-of-BL-097-section but in-grep-scope) | `(see \`docs/research/\`)` | Generic catalogue pointer (no single Pass) |

(Site count: 14 in BL-097 Resolution body — sites 1–4 are individual analytic dead-links; sites 5 is a bare-text in-prose filename mention; sites 6–15 are the 10 bibliographic enumeration links that were collapsed in a single edit per advisor strategy. Site 16 is the Phase 3 intro orphan cleaned under verification-gate authority.)

## (b) Replacements applied

### Analytic-site retargets (4 edits)

| # | Pre-edit Site | Strategy | New Destination |
|---|---|---|---|
| 1 | Site 1 (opening clause) | Reframe — corpus pointer dissolved into "load-bearing findings absorbed into Session-M outputs" + cross-ref to this embed log for per-Pass absorption mapping | `[embed-log-backlog.md](./audit/research-deletion-surveys/embed-log-backlog.md)` |
| 2 | Site 2 (D1 anchor) | Retarget — Wave 1 §5.2 D1 rationale absorbed into ADR-015 §V1.1 Criterion-Gated Commitments under criterion C-2 | `[ADR-015 §V1.1 Criterion-Gated Commitments](./decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments)` |
| 3 | Site 3 (D2 BIND criterion (c)) | Retarget — Pass B §3.1 five ambiguities enumerated inline in ADR-015 §V1.1 Criterion-Gated Commitments line 76; full enumeration also surfaced in-line in this BL Resolution prose for self-containment | `[ADR-015 §V1.1 Criterion-Gated Commitments](./decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments)` |
| 4 | Site 4 (DAG executor / predecessors construction) | Retarget — Pass A §2 DAG-executor `predecessors`-by-construction claim absorbed into Spec-017 §Execution semantics; reframed as Plan-017 own decision with cross-ref to Spec-017 line 71 (Kahn-style ready-set admission) | `[Spec-017 §Execution semantics](./specs/017-workflow-authoring-and-execution.md#execution-semantics)` |

### Bibliographic-collapse edit (1 edit replacing 10 dead-link sites)

The "Research body absorbed: 8 passes (...) + 2 syntheses (...)" sentence in the post-edit Resolution entry collapsed sites 6–15 into a single absorption claim with a manifest of the per-Pass absorption destinations. Per advisor: "Capture the bibliographic-collapse as a single 'reframed sentence' entry (with before/after) rather than 10 separate replacements — it's clearer and matches what you actually did." Strategy: each Pass-file link in the original enumeration was dropped (the Pass titles survive as bare text — "A parallel execution", "B multi-agent channel contract", etc.); a single cross-ref block replaced the 10 hyperlinks pointing at the four Session-M absorption destinations + this embed log for per-Pass mapping detail.

| # | Replaced By |
|---|---|
| 6–15 (collapsed) | `[ADR-015 §Research Conducted](./decisions/015-v1-feature-scope-definition.md#research-conducted)`, `[Spec-017 §References](./specs/017-workflow-authoring-and-execution.md#references)`, `[Plan-017 §References](./plans/017-workflow-authoring-and-execution.md#references)`, `[\`local-sqlite-schema.md §Workflow Tables\`](./architecture/schemas/local-sqlite-schema.md#workflow-tables-plan-017)`, `[embed-log-backlog.md](./audit/research-deletion-surveys/embed-log-backlog.md)` |

### Manifest-mention reframe (1 edit, no link replacement)

| # | Pre-edit | Post-edit | Strategy |
|---|---|---|---|
| 5 | `... + \`wave-2-synthesis.md\` ADR-018 broken-link repair + ASCII-diagram orphan ...` | `... + an in-research-body ADR-018 broken-link repair (since superseded by research/ deletion under T20) + ASCII-diagram orphan ...` | Bare-text filename mention reframed; substantive claim ("ADR-018 broken-link repair was one of the 10 manifest items") preserved without naming the now-deleted research body file. |

### Verification-gate cleanup (1 edit, line 243)

| # | Pre-edit | Post-edit | Strategy |
|---|---|---|---|
| 16 | `Both items resolved 2026-04-16 after structured research (see \`docs/research/\`).` | `Both items resolved 2026-04-16 after structured research (catalogued in [ADR-019 §Research Conducted](./decisions/019-windows-v1-tier-and-pty-sidecar.md#research-conducted) + [ADR-020 §Research Conducted](./decisions/020-v1-deployment-model-and-oss-license.md#research-conducted)).` | Retargeted at the Phase 3 ADR research catalogues. Both BL-052 (ADR-019) and BL-053 (ADR-020) were the two Phase 3 V1 Scope Decisions; their `### Research Conducted` subsections (line 170 in ADR-019, line 207 in ADR-020) carry the structured-research citations. Anchor format `#research-conducted` valid per GitHub-flavored-markdown slugification (matches existing precedent at line 250 same-file). |

## (c) Reframed sentences

Two sentence-level reframings (advisor-scoped — "reframed sentences when no clean destination exists"):

1. **Site 1 opening clause** — original framing made `docs/research/bl-097-workflow-scope/` itself a load-bearing reference (the "two-wave research body lives at this URL" claim). Post-deletion of `docs/research/`, that claim cannot stand. Reframe: research body is now described as "load-bearing findings absorbed into Session-M outputs", with the per-Pass absorption mapping cross-referenced to this embed log. The substantive provenance claim survives ("two-wave research body of 8 passes + 2 syntheses") without depending on an extant research/ directory.

2. **Site 5 (#30) wave-2-synthesis.md mention** — original framing read `+ \`wave-2-synthesis.md\` ADR-018 broken-link repair`. Bare-text filename. Post-deletion, the file no longer exists. Reframe: described generically as "an in-research-body ADR-018 broken-link repair (since superseded by research/ deletion under T20)" so the (#30) manifest's substantive claim ("ADR-020 mirror pass repaired one ADR-018 broken link inside the research body") survives the deletion intact.

The bibliographic-collapse (sites 6–15) is also a reframing in the strict sense — "8 passes ([A parallel execution], [B ...], ...)" rewrites to "8 passes (A parallel execution, B multi-agent channel contract, ...)" with the link-bearing structure dissolved into bare-text titles + a single absorption-destination cross-ref block. Counted separately as the bibliographic collapse rather than as an analytic reframing.

## (d) Verification greps

Both verification greps from the task spec re-run after all edits:

```
Grep "research/bl-097|wave-[12]-synthesis|pass-[a-h]-" docs/backlog.md
→ No matches found

Grep "docs/research/" docs/backlog.md
→ No matches found
```

Both pass. The case-sensitive `BL-097` (uppercase BL-tag) survives at multiple sites in backlog.md — that is the intended state, since `BL-097` is a backlog-issue tag, not a `research/bl-097` directory pointer.

## (e) Edits summary + anomalies

**Edit count:** 6 distinct edits across 2 lines of `docs/backlog.md`.

| # | Line (post-edit) | Type | Sites Resolved |
|---|---|---|---|
| 1 | 732 | Analytic retarget | Site 1 (opening clause) |
| 2 | 732 | Analytic retarget | Site 2 (D1 anchor → ADR-015 §V1.1 Criterion-Gated Commitments under C-2) |
| 3 | 732 | Analytic retarget | Site 3 (D2 BIND criterion (c) → ADR-015 §V1.1 Criterion-Gated Commitments + 5-ambiguity inline enumeration) |
| 4 | 732 | Analytic retarget | Site 4 (DAG executor → Spec-017 §Execution semantics) |
| 5 | 732 | Bibliographic collapse | Sites 6–15 (10 enumeration links → single absorption-destination cross-ref block) |
| 6 | 732 | Manifest-mention reframe | Site 5 (wave-2-synthesis.md → "an in-research-body ADR-018 broken-link repair (since superseded by research/ deletion under T20)") |
| 7 | 243 | Verification-gate cleanup | Site 16 (Phase 3 intro `(see \`docs/research/\`)` → ADR-019 + ADR-020 §Research Conducted catalogues) |

**Top 3 absorption destinations by edit count:**
1. `[ADR-015 §V1.1 Criterion-Gated Commitments](./decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments)` — 2 retargets (D1 + D2)
2. `[ADR-015 §Research Conducted](./decisions/015-v1-feature-scope-definition.md#research-conducted)` — 1 retarget (bibliographic collapse anchor) + cross-doc consistency with T14 ADR-015 embed
3. `[Spec-017 §Execution semantics](./specs/017-workflow-authoring-and-execution.md#execution-semantics)` — 1 retarget (DAG executor `predecessors`-by-construction)

**Anomalies:**

1. **Spec-017 anchor `#execution-semantics` is the first cross-ref to it in the repo.** Pre-edit grep across `docs/` showed only line 67 of Spec-017 itself ("### Execution semantics"). The slug `#execution-semantics` is GitHub-flavored-markdown standard for `### Execution semantics` (lowercased + spaces→hyphen), so this is a valid usable anchor — but it's a new cross-ref point. **Not blocking.** If GitHub renders the heading with a different slug (e.g., a numeric prefix from autogenerated `markdown-it-anchor`), the cross-ref would 404 — unlikely given the precedent at backlog.md line 729 which uses similar phrase-based anchors.

2. **ADR-020 filename correction during line-243 edit.** First-attempt cross-ref used `020-license-selection-bsl-or-fsl.md` (the historical working title); actual filename is `020-v1-deployment-model-and-oss-license.md`. Caught by `Glob docs/decisions/020-*.md` sanity check before final verification grep. Post-correction edit landed.

3. **Out-of-scope vs verification-gate tension at line 243.** Task spec said "out-of-scope: modifying other backlog.md sections" — line 243 lives in the Phase 3 intro paragraph, not in BL-097 Resolution. The verification grep `docs/research/` matched line 243 pre-cleanup. Resolved via verification-gate-is-authoritative ruling: the grep is the completion gate, so line 243 was cleaned despite the soft "out-of-scope" framing. Strictly minimal in-place edit (parenthetical replaced with same-shape parenthetical pointing at ADR-019 + ADR-020 §Research Conducted catalogues) — no other Phase 3 prose touched.

4. **Bare-text Pass tags survive elsewhere in backlog.md.** Backlog.md still references "Pass D" (line 732, "Wave 1 Pass D showed..."), "Pass G §5", "Wave 2 §4.1", etc. as bare-text semantic tags (not markdown links). These are self-contained — they survive `docs/research/` deletion intact. Verification grep `pass-[a-h]-` (lowercase + hyphen) doesn't match the bare-text "Pass D" forms. Intentional preservation of historical claim attribution within prose.

5. **`[\`local-sqlite-schema.md §Workflow Tables\`]` cross-ref retains its existing form.** The pre-edit Resolution entry already cross-referenced `[\`local-sqlite-schema.md §Workflow Tables\`](./architecture/schemas/local-sqlite-schema.md)` — bare anchor vs `#workflow-tables-plan-017`. The bibliographic-collapse edit upgraded the anchor to `#workflow-tables-plan-017` for consistency with T18's anchor-stamping pass. **Not blocking** — pre-edit form would have rendered as a doc-root link; post-edit form anchors directly at the `## Workflow Tables (Plan-017)` heading.

---

**Status:** T25 complete. `docs/backlog.md` is research/-pointer-free; both verification greps return zero matches; 14 dead-link sites in BL-097 Resolution + 1 verification-gate-scoped cleanup at line 243 surgically replaced with cross-references to the four canonical Session-M absorption destinations (ADR-015 §V1.1 Criterion-Gated Commitments + ADR-015 §Research Conducted + Spec-017 §Execution semantics + Plan-017 §References + local-sqlite-schema.md §Workflow Tables) plus this embed log for per-Pass absorption-mapping detail; T20 inherits clean grep state for `docs/research/` deletion authorization.

---

## T19 Cross-Reference: PASS

Verified 2026-04-25 by Opus 4.7 via T19 sweep gate. Embed-log claims cross-checked against `git diff main..HEAD -- docs/backlog.md`.

**Spot-checks:**
- Phase 3 intro at line 243: pre-edit `(see \`docs/research/\`)` → post-edit `(catalogued in [ADR-019 §Research Conducted] + [ADR-020 §Research Conducted])`. Match.
- BL-097 Resolution: 14 dead-link sites + 1 manifest-mention reframe collapsed into a single rewritten paragraph as embed log §(b) detailed; the post-edit text contains the four canonical destination cross-refs (ADR-015 §V1.1 Criterion-Gated Commitments / §Research Conducted, Spec-017 §Execution semantics, Plan-017 §References, local-sqlite-schema.md §Workflow Tables). Match.
- BL-053 sites at lines 250/261/263 (also covered by embed-log-adr-020 §(c)): all rewritten to ADR-020 cross-refs. Match.
- Diff stat: 6 insertions / 6 deletions (line-replacement-shaped); consistent with 6 distinct edits across 2 lines of `docs/backlog.md` per embed log §(e).
- Final-state grep `docs/research/|\.\./research/|wave-[12]-synthesis|pass-[a-h]-` against `docs/backlog.md` returns zero matches.
- No undocumented research-deletion-shaped diff content found (the BL-053 line-243/250/261/263 edits are owned by embed-log-adr-020 §(c); the BL-097 consolidation is owned by this embed log).

**Verdict: PASS.** backlog.md ready for T20 deletion of `docs/research/`.
