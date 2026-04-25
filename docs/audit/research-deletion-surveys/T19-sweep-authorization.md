# T19 Sweep Authorization — Research-Deletion Gate

**Date:** 2026-04-25
**Verifier:** Opus 4.7 via T19 subagent
**Branch:** `docs/audit-realignment` (post-H8 commit `c41d109`)
**Scope:** Three-phase verification before T20 deletes `docs/research/`.

---

## Phase 1 — Corpus-Wide Grep Sweep

| Grep | Matches outside `docs/research/` + `docs/audit/` | Verdict |
|------|--------------------------------------------------|---------|
| `docs/research/` | 0 | **PASS** |
| `\.\./research/` | 0 | **PASS** |
| `research/bl-(052\|053\|097)\|spec-017-citation-research` | 0 | **PASS** |
| `pass-[a-h]-\|wave-[12]-synthesis` | 0 | **PASS** |

**Combined verification:** `grep -rnE "docs/research/|\.\./research/|research/bl-(052|053|097)|spec-017-citation-research|pass-[a-h]-|wave-[12]-synthesis" docs/ --include="*.md"` filtered to exclude `docs/research/` and `docs/audit/` returns **zero matches**.

In-scope files (`docs/decisions/`, `docs/specs/`, `docs/plans/`, `docs/architecture/`, `docs/domain/`, `docs/backlog.md`, `README.md`) are clean of inbound `docs/research/` citations. The remaining matches inside `docs/research/` (about-to-be-deleted) and `docs/audit/` (frozen historical artifacts) are explicitly allowed.

**Phase 1 verdict: PASS.**

---

## Phase 1.5 — bl-052 §6 Spillover-Gotcha Verification

T26 §(f) flagged 3 additional bl-052 §6 gotchas with uncertain Plan-024 coverage status. T19 verified each against bl-052 §6 verbatim source + current Plan-024 + ADR-019 state.

| # | Gotcha (bl-052 §6 line) | Coverage status | T19 action |
|---|--------------------------|-----------------|------------|
| (a) | Unicode/IME (`vscode#255285`, line 171) | bl-052 §6 line 171 is purely failure-mode classification (no `Mitigation:` clause); ADR-019 §Research Conducted line 189 captures the same classification at equal depth. Plan-024 not present. | **No augmentation.** Per task spec ("ADR-019 may suffice if the gotcha is purely failure-mode classification rather than implementation guidance"). |
| (b) | `useConptyDll` regression (`node-pty#894`, line 176) | Plan-024 line 35 §Non-Goals defers per ADR-019 Tripwire 3; Plan-024 References line 239 carries the PowerShell 7 regression context inline. The deferral decision is anchored to the right primary source. | **No augmentation.** Coverage adequate. |
| (c) | `spawn locks cwd` (`node-pty#647`, line 174) | bl-052 §6 line 174 has implementation guidance: "spawn from a stable parent dir, pass the target as `env.CWD` or `cd &&`." ADR-019 line 180 has only the failure-mode classification. Plan-024 References line 241 had only the issue link. | **EMBED.** Implementation-guidance gap (worktree-swap is a real Plan-001 daemon concern). Embedded as Gotcha 5 in Plan-024 §Windows Implementation Gotchas. |

**Phase 1.5 result:** 1 of 3 spillover gotchas required augmentation. Plan-024 §Windows Implementation Gotchas now carries 5 subsections (was 4); section preamble rolled "Four"→"Five"; existing `node-pty#647` reference row enriched with `(cited by Gotcha 5: Spawn locks cwd on Windows; blocks worktree workflows)` per the convention T26 used for `#437` and `#904`. Augmentation logged in `docs/audit/research-deletion-surveys/embed-log-plan-024.md` under `## T19 Spillover Augmentation`.

**Phase 1.5 verdict: PASS** (1 augmentation applied; 2 gotchas confirmed adequately covered).

---

## Phase 2 — Embed-Log ↔ Git-Diff Cross-Reference

Each `embed-log-*.md` file's claims spot-checked against `git diff main..HEAD -- <consuming-doc>` (research-deletion edits live in working-tree only; H8 already landed at HEAD `c41d109`). Each log carries an appended `## T19 Cross-Reference: PASS` footer with per-file spot-check details.

| Embed log | Consuming doc(s) | Verdict |
|-----------|------------------|---------|
| `embed-log-adr-015.md` | `docs/decisions/015-v1-feature-scope-definition.md` | **PASS** (60 §Research Conducted rows match T14:10+T15:50; `### BL-097 Research Provenance` subsection removed; line-level rewrites at 56/68/76/149/176/224/230/234) |
| `embed-log-adr-019.md` | `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md` | **PASS** (32 §Research Conducted rows; AV/EDR row in §Failure Mode Analysis with `vscode#239184` + `node-pty#887` citations; 8 inbound-mention rewrites; Plan-024 gotcha gap closed by T26 + T19 spillover) |
| `embed-log-adr-020.md` | ADR-020 + Spec-025 + backlog.md (multi-file) | **PASS** (37 §Research Conducted rows; Spec-025 line 148 Ably extraction; backlog BL-053 sites at 250/261/263 rewritten) |
| `embed-log-backlog.md` | `docs/backlog.md` | **PASS** (BL-097 Resolution 14-site mega-rewrite; Phase 3 intro line 243 cleanup; consistent with embed-log-adr-020 BL-053 site coverage) |
| `embed-log-plan-017.md` | `docs/plans/017-workflow-authoring-and-execution.md` | **PASS** (41-bullet `## References` section created; 4 body-line rewrites at 61/67/90/102; 2 front-matter row rewrites at 9/15) |
| `embed-log-plan-024.md` | `docs/plans/024-rust-pty-sidecar.md` | **PASS** (T26: 4 gotcha subsections + 1 new reference row; T19: 5th gotcha subsection + 0 new reference rows + 1 enrichment) |
| `embed-log-spec-017.md` | `docs/specs/017-workflow-authoring-and-execution.md` | **PASS** (`### BL-097 research provenance` subsection dissolved; 7 inline citations added to `### Primary sources (external) > Execution semantics + human phase` bucket; 3 pointer-replacement rewrites; line 222 intentional `pass-a…pass-e` example identifiers retained) |
| `embed-log-sqlite-schema.md` | `docs/architecture/schemas/local-sqlite-schema.md` | **PASS** (3 dead-link sites replaced with industry-precedent inline citations; 1 SQL-comment reference rewritten) |

**Files-vs-embed-log coverage check:**
- 11 modified files in working tree (post-H8): 8 are covered directly by an embed log; ADR-020's embed log is multi-file (covers ADR-020 + Spec-025 + backlog.md BL-053 sites); backlog.md is additionally covered by embed-log-backlog.md (BL-097 Resolution).
- 3 files (`docs/decisions/016-electron-desktop-shell.md`, `docs/decisions/018-cross-version-compatibility.md`) carry diffs that are H8-only (markdown URL angle-bracket normalization), not research-deletion-shaped.
- Spec-025 was confirmed as part of embed-log-adr-020's multi-file scope (line 148 BL-053 brief link → Ably citation).
- No file's diff contains research-deletion-shaped content (citation-row additions, `docs/research/` removals, References-section creations) NOT covered by an embed log.

**Phase 2 verdict: PASS** (8 of 8 embed logs verified; no undocumented research-deletion-shaped diff content; no discrepancies).

---

## Final Verdict

**PASS — T20 (delete `docs/research/`) AUTHORIZED.**

All three phases pass clean:
1. Corpus-wide grep sweep returns zero matches outside `docs/research/` (about-to-be-deleted) and `docs/audit/` (frozen artifacts).
2. bl-052 §6 spillover-gotcha verification complete; 1 augmentation applied to Plan-024 (Gotcha 5: spawn-locks-cwd implementation guidance); 2 gotchas confirmed adequately covered without augmentation.
3. Each of 8 embed logs cross-referenced against `git diff main..HEAD` for the corresponding consuming doc; all PASS; no discrepancies surfaced.

T20 may now safely:
- Delete `docs/research/bl-052-windows-tier-research.md`
- Delete `docs/research/bl-053-self-hosted-scope-research.md`
- Delete `docs/research/bl-097-workflow-scope/` (all 10 files)
- Delete `docs/research/spec-017-citation-research/` (3 files; absorbed into Spec-017/Plan-017/sqlite-schema or otherwise out-of-scope per existing audit)
- Delete `docs/research/` itself (the parent directory)

After T20 deletes, T22 will verify audit-plan accuracy of the remaining `docs/audit/*` historical artifacts, which by convention preserve their pre-deletion `docs/research/` references as historical evidence.

---

## Out-of-Scope Items Acknowledged

- T19 did NOT delete `docs/research/` — that is T20's exclusive job. T19 only authorizes.
- T19 did NOT modify ADR/Spec/Plan/backlog body content beyond the Phase 1.5 inline augmentation (Gotcha 5 in Plan-024 §Windows Implementation Gotchas).
- T19 did NOT modify `docs/audit/*` historical artifacts beyond appending `## T19 Cross-Reference: PASS` footers + the `## T19 Spillover Augmentation` section in `embed-log-plan-024.md`. T22 owns audit-plan accuracy verification.

---

*End of T19 sweep authorization. T20 may proceed.*
