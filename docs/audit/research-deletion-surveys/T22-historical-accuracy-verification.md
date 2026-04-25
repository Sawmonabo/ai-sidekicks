# T22 — Historical-Accuracy Verification of Audit-Plan References to `docs/research/`

**Task:** T22 of the research-deletion architectural cleanup. After T20 deleted `docs/research/`, verify that every `docs/research/`- or `../research/`-referencing statement remaining inside `docs/audit/*` is framed as a historical-correctness statement (i.e., reads as past-state describing what the audit/embed-work observed at the time it ran), not as a current-state assertion or live cross-reference that becomes false post-deletion.

**Verification window:** 2026-04-25 (post-T20 deletion of `docs/research/`).
**Method:** Per-match read with surrounding sentence/context; classify as **Historical**, **Current-state assertion**, or **Cross-reference**; flag any non-historical match for editor's-note remediation.
**Scope:** Two file groups —
1. **H-final audit artifacts** (`docs/audit/session-h-final-*`) — frozen audit artifacts authored 2026-04-22 against an extant `docs/research/`.
2. **Research-deletion-surveys** (`docs/audit/research-deletion-surveys/*`) — current train's own embed logs/surveys/auth notes; reference `docs/research/` as the source of just-completed embed work.

---

## §1. Match Inventory (per file)

### §1.1 H-final audit artifacts (the historical-correctness verification target)

| # | File | Line | Context (1-line) | Classification |
|---|---|---|---|---|
| 1 | `session-h-final-scope.md` | 63 | `**docs/research/** — research passes are frozen-in-time snapshots per the research-standards discipline. They are the *source* for downstream citations, not audit targets.` | **Historical** — out-of-scope declaration scoping the audit's input domain at the time it ran. |
| 2 | `session-h-final-scope.md` | 274 | `docs/research/ is explicitly out of scope for H2 audit. Subagents MUST NOT: ...` | **Historical** — normative scope-rule for the audit's subagents at the time they were dispatched. |
| 3 | `session-h-final-h5-remediation-plan.md` | 260 | Pre-seed finding evidence row: `\| 1 \| docs/research/bl-097-workflow-scope/wave-1-synthesis.md:87 \| ...` (inside table cell capturing source quote with path-attribution at audit time) | **Historical** — evidence-attribution citation captured during H5 plan authoring; recorded the pre-deletion source location of the synthesis quote that drove the SHF-D-005 adjudication. |
| 4 | `session-h-final-h5-remediation-plan.md` | 1135 | Verbatim *Before* code-block: `... 31 amendments SA-1…SA-31 from docs/research/bl-097-workflow-scope/wave-1-synthesis.md + wave-2-synthesis.md` | **Historical** — frozen pre-edit snapshot of ADR-015:56 captured for audit-trail evidence; this is what the file said at the moment H5 read it (T15 has since rewritten this surface per `embed-log-adr-015.md`). |
| 5 | `session-h-final-h5-remediation-plan.md` | 1141 | Verbatim *After* code-block: same path tokens preserved inside the post-edit text rendering | **Historical** — frozen post-edit snapshot from H5 remediation moment (note: these two snapshot lines are H5's intermediate state; T15 later rewrote the line further to remove the `docs/research/` path tokens entirely — a separate train of work). |
| 6 | `session-h-final-h5-remediation-plan.md` | 1230 | `... grep-verified against source doc corpus (docs/**/*.md excluding docs/research/ per §4/§9.3 research-trust scope ...)` | **Historical** — describes the exclusion filter applied during H5 verification scan at audit time. |
| 7 | `session-h-final-h5-remediation-plan.md` | 2024 | `... per-file review with source re-verification. §4/§9.3 research-trust scope applies — research docs (docs/research/) preserve source-accurate quotes and are out of scope ...` | **Historical** — methodology rule scoped to H6 execution mode at audit time. |
| 8 | `session-h-final-h6b-closeout.md` | 39 | `Research docs (docs/research/) preserve source-accurate quotes and are out of scope per §4/§9.3 research-trust scope ...` | **Historical** — methodology rule echoing §1.1 row 7 in the H6b closeout reflection. |
| 9 | `session-h-final-h2-findings/lane-b-external-citation-quote-fidelity.md` | 7 | `External sources include public URLs AND research files under docs/research/ (trusted sources per §9.3).` | **Historical** — Lane B verdict-scope declaration at audit time. |
| 10 | `session-h-final-h2-findings/lane-b-external-citation-quote-fidelity.md` | 11 | `Globbed in-scope corpus (§3 — ...). Research files (docs/research/) and reference files (docs/reference/) are out-of-scope per §4.` | **Historical** — Lane B discovery-methodology step at audit time. |
| 11 | `session-h-final-h2-findings/lane-b-external-citation-quote-fidelity.md` | 27 | Pre-seed finding row: `... cited-source ... docs/research/bl-097-workflow-scope/pass-g-persistence-model.md §2 line 32 ...` (table cell capturing the cited source path of a drift finding) | **Historical** — Lane B ledger evidence row captured at audit time; documents what the audited file (Spec-017) cited at the moment of the SHF-preseed-002 drift verdict. |
| 12 | `session-h-final-h2-findings/lane-b-external-citation-quote-fidelity.md` | 96 | `Out-of-scope (per §4): docs/research/ files (12+ files with blockquote/italic-quote patterns) were NOT audited; they are trusted sources per §9.3.` | **Historical** — Lane B discovery-notes scope confirmation at audit time. |
| 13 | `session-h-final-h2-findings/lane-c-internal-cross-reference-validity.md` | 21 | `Respected scope §4 / §9.3: file-existence checked for links INTO docs/research/; anchors inside research files NOT audited.` | **Historical** — Lane C audit primitive step description at audit time. |
| 14 | `session-h-final-h2-findings/lane-c-internal-cross-reference-validity.md` | 65 | `Links into docs/research/*.md (e.g., [Pass F — Event taxonomy...](../research/bl-097-workflow-scope/pass-f-event-taxonomy.md) in Spec-017 L400): target file existence checked per §4/§9.3 ... All such file-existence checks passed.` | **Historical** — Lane C out-of-scope confirmation describing the verification-pass result against the corpus state at audit time (Spec-017 L400 has since been rewritten by T16 per `embed-log-spec-017.md`). |
| 15 | `session-h-final-h2-findings/lane-d-internal-cross-reference-bidirectionality.md` | 13 | `Research directory (docs/research/) was treated as a trusted source, not an audit target (§4 / §9.3).` | **Historical** — Lane D scope-notes declaration at audit time (note past-tense verb "was treated"). |
| 16 | `session-h-final-h2-findings/lane-d-internal-cross-reference-bidirectionality.md` | 30 | SHF-D-006 finding row: `claim-text ... full contract pinned in Spec-017 (31 amendments SA-1…SA-31 from docs/research/bl-097-workflow-scope/wave-1-synthesis.md + wave-2-synthesis.md).` | **Historical** — Lane D ledger evidence row capturing the verbatim claim-text of ADR-015:56 at audit time (subsequently rewritten by T15). |
| 17 | `session-h-final-h2-findings/lane-g-feature-scope-count-consistency.md` | 6 | `Scope: docs/ corpus excluding docs/research/** and docs/archive/** per [session-h-final-scope.md §4](...).` | **Historical** — Lane G scope declaration at audit time. |
| 18 | `session-h-final-h2-findings/lane-i-resolution-backlog-trace.md` | 1218 | `evidence-quote: ... two-wave research body (8 passes A–H + 2 syntheses under [docs/research/bl-097-workflow-scope/](./research/bl-097-workflow-scope/)). ...` | **Historical** — Lane I ledger evidence-quote row capturing the verbatim BL-097 Resolution prose at audit time (subsequently rewritten by T25 per `embed-log-backlog.md`). |
| 19 | `session-h-final-h2-findings/lane-j-open-questions-deferred-trace.md` | 11 | `In-scope corpus per §3: ... Out of scope: docs/research/, docs/reference/, docs/archive/, ...` | **Historical** — Lane J scope declaration at audit time. |
| 20 | `session-h-final-h2-findings/lane-k-numeric-consistency.md` | 84 | `Out-of-scope per session-h-final-scope.md §3: docs/research/** directory — SHF-K-034 verified only the in-scope schema-file pragma block against Spec-015:156; no research-dir sources consulted.` | **Historical** — Lane K method-notes describing scope-filter behavior at audit time (past-tense "consulted"). |
| 21 | `session-h-final-h2-findings/lane-l-adr-status-consistency.md` | 11 | `In-scope corpus per §3: ... Out of scope: docs/research/, docs/reference/, docs/archive/, ...` | **Historical** — Lane L scope declaration at audit time. |

**H-final group total: 21 matches across 11 files (`session-h-final-scope.md`, `session-h-final-h5-remediation-plan.md`, `session-h-final-h6b-closeout.md`, and 8 lane files: b, c, d, g, i, j, k, l). All 21 classify as Historical. Zero current-state assertions, zero broken cross-references that need rewrite.**

### §1.2 Research-deletion-surveys (current train's own artifacts)

This group is the in-flight T9–T26 train; per task framing, references to `docs/research/` are appropriately historical or pre-deletion-state. Match-by-match audit:

| File | Match count | Framing summary | Verdict |
|---|---|---|---|
| `00-pre-T9-gate-log.md` | 2 | "60 files changed: ... 3 research orphan files (docs/research/spec-017-citation-research/)" + "deleted at T20 alongside docs/research/" | All past-state or future-state with anchored timestamp; **Historical** — describes the snapshot taken at T9 gate time. |
| `T19-sweep-authorization.md` | 14 | All references frame `docs/research/` as either (a) the soon-to-be-deleted source ("before T20 deletes docs/research/", "T20 will verify after deletion") or (b) the about-to-be-deleted directory whose orphans the grep is detecting. | **Historical** — every match is bound by an explicit T20-deletion-pending temporal marker. |
| `bl-052-survey.md` | 1 | "Subject brief: docs/research/bl-052-windows-tier-research.md (Windows V1 tier evaluation; ... superseded by ADR-019 ...)" | **Historical** — survey was authored against the brief at T10, before T20 deletion. |
| `bl-053-survey.md` | 1 | "Source brief: /home/sabossedgh/dev/ai-sidekicks/docs/research/bl-053-self-hosted-scope-research.md" | **Historical** — survey artifact at T10 time. |
| `bl-097-survey.md` | 1 | "Survey all 10 files in docs/research/bl-097-workflow-scope/ for embed-worthy citations ... before research/ is deleted." | **Historical** — survey scoping at T11 time. |
| `embed-log-adr-015.md` | 18 | All matches frame the path tokens as the pre-edit text being surgically removed, or as the source brief slated for deletion. Verdict block at line 156: "ADR-015 ready for T20 deletion of docs/research/bl-097-workflow-scope/". | **Historical** — embed log captures pre-/post-edit diff state at T14/T15 time. |
| `embed-log-adr-019.md` | 7 | Same pattern: pre-edit citation token captured in diff cells, post-edit replacement shown, final verdict "ADR-019 ready for T20 deletion." | **Historical** — embed log captures T12 edit state. |
| `embed-log-adr-020.md` | 8 | Same pattern: pre-edit/post-edit diff cells, "ready for T20 deletion of bl-053 brief", "T20 may now safely delete." | **Historical** — embed log captures T13 edit state. |
| `embed-log-backlog.md` | 11 | Pre-edit dead-link inventory + post-edit retargeting + verification-grep statements. All matches frame the path as either (a) the pre-edit dead-link form being removed, (b) the about-to-be-deleted source dir, or (c) the verification-grep target string. | **Historical** — embed log captures T25 edit state. |
| `embed-log-plan-017.md` | 9 | Same pattern: pre-edit text in diff cells, post-edit text shown, final-state grep returns zero matches, "ready for T20 deletion." | **Historical** — embed log captures T17 edit state. |
| `embed-log-plan-024.md` | 5 | "Plan-024 contains zero research/bl-052 pointers" + "T20 can safely delete docs/research/bl-052-windows-tier-research.md without leaving dangling links." | **Historical** — embed log captures T16 state (Plan-024 was already clean). |
| `embed-log-spec-017.md` | 5 | Pre-edit "Lines 391-402 contained ### BL-097 research provenance heading + 10 bullets pointing into docs/research/bl-097-workflow-scope/" + post-edit replacement table. | **Historical** — embed log captures T16 edit state. |
| `embed-log-sqlite-schema.md` | 6 | "T18 ... before docs/research/bl-097-workflow-scope/ is deleted" + post-edit primary-source citations. Note: lines 14, 32, 47 contain `[Pass G §...](../../research/...)` markdown links inside post-edit code-block snippets — these are inside the embed-log's *example post-edit text* showing what the schema file said at one intermediate point. The actual schema file post-T18 carries inline-citation patterns with primary-source URLs, not these path-pointers. | **Historical** — embed log captures T18 intermediate edit-snapshot state inside example blocks; the final state of the consuming doc is asserted clean by the §(e) verification grep ("Final-state grep ... returns zero matches"). |

**Research-deletion-surveys group total: 88 matches across 13 files. All 88 classify as Historical (frozen pre-deletion-window snapshots).**

---

## §2. Classification Summary

| File group | Files | Total matches | Historical | Current-state assertion | Cross-reference |
|---|---|---|---|---|---|
| H-final audit artifacts | 11 | 21 | 21 | 0 | 0 |
| Research-deletion-surveys | 13 | 88 | 88 | 0 | 0 |
| **Total** | **24** | **109** | **109** | **0** | **0** |

---

## §3. Editor's Notes Added

**None.** All 109 matches across 24 files classified as historical. No current-state assertions or broken cross-references requiring editor's-note remediation.

---

## §4. Final Verdict

**PASS — no edits required (all historical).**

Every `docs/research/` and `../research/` reference inside `docs/audit/*` is framed as past-state or pre-deletion-state at the moment the audit/embed-work captured it. The audit artifacts retain accurate historical evidence of (a) the corpus state H2/H6 verified against, (b) the pre-edit text the embed train rewrote, and (c) the verification-grep filter that delimited audit scope. None of these statements assert that `docs/research/` exists post-T20; the absorbed content's current home is captured in the consuming docs' §References / §Research Conducted sections per the embed train's design.

---

## §5. Anomalies and Notes

### §5.1 Path tokens in code-fenced verbatim blocks

Several H-final and embed-log matches occur inside ```` ``` ```` markdown code blocks that quote pre-edit file content verbatim. These are inherently historical (they are *recordings* of what the file said) and do not assert current-state existence. Examples: `session-h-final-h5-remediation-plan.md:1135` and `:1141` are inside `*Before:*` / `*After:*` code blocks; multiple `embed-log-*.md` rows show pre-edit/post-edit diff cells inside markdown tables. All such matches classify as Historical without ambiguity.

### §5.2 Narrative `../research/` markdown links inside example blocks (`embed-log-sqlite-schema.md` lines 14, 32, 47)

These are inside indented quote blocks (`> ...`) that show example post-edit text the embed log proposed at one stage. The §(e) verification grep statement at line 109 of the same file ("Final-state grep ... returns zero matches") confirms the final state of the consuming `local-sqlite-schema.md` does NOT carry these tokens — they live only inside the embed-log's narrative example blocks. The consuming doc's primary-source URLs (e.g., for Pass G persistence claims) live in inline-citation form per Spec-015 convention. **Classification: Historical (embed-log narrative artifact, not a live navigation pointer).**

### §5.3 Past-tense verb usage (positive signal)

Multiple H-final scope statements use past-tense verbs ("was treated", "consulted", "audited") which provide unambiguous historical framing:
- `lane-d:13` — "was treated as a trusted source"
- `lane-k:84` — "no research-dir sources consulted"
- `lane-c:65` — "checks passed"

These verb tenses naturalize the historical framing without requiring an editor's note.

### §5.4 No ambiguous matches

Every match resolved cleanly to **Historical** under the classification rubric. No row triggered a "needs editor's note" verdict, and no row was uncertain enough to warrant escalation. The H-final audit's §4 / §9.3 research-trust scope discipline produced uniformly past-tense, scope-anchored prose; the research-deletion train's embed logs uniformly carry T20-deletion-pending temporal markers.

---

## §6. Cross-Reference: T20 Authorization (T19) and T22 Disposition

T19 authorized T20 contingent on:
- (1) corpus-wide grep showing zero `docs/research/` matches outside `docs/research/` itself and `docs/audit/`;
- (2) `docs/audit/` matches preserved as historical evidence under explicit allowance.

T22 verifies condition (2)'s historical-evidence preservation property holds: the residual `docs/audit/*` matches are uniformly framed as historical. The `docs/audit/` directory therefore continues to function as the corpus's audit-trail-of-record without breaking under T20's deletion. Plan-001 code execution remains safe to commence on the doc-first basis established by Sessions H-final + the research-deletion train.

---

**T22 status:** Complete. Verification PASS; no edits applied.
