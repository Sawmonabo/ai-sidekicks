# Failure-Mode Catalog

> **Doc shape note.** This is a process-methodology catalog (proactively invoked during commit / PR / review), not a failure-recovery runbook. The 10-section operations template (`docs/operations/template.md`) does not apply; the structure here is one row per failure pattern, indexed on **structural action**. The same convention is used by [`plan-implementation-readiness-audit-runbook.md`](./plan-implementation-readiness-audit-runbook.md), which is also a methodology doc rather than a recovery procedure.

## Purpose

Every row indexes one doc-corpus regression pattern by **structural action** (what an edit physically does to the corpus) so disciplines, hooks, skills, and audit prompts resolve to the same canonical row regardless of which **domain framing** the author used. This fixes the recall-by-domain-label miss documented in the PR-#27 post-mortem: a memory called `feedback_canonicalization_sweep_completeness.md` existed but did not fire for the surface label `archival` because the human framing was `archival` while the structural action was `string move`.

The catalog is the single source of truth. Hooks, skills, and audit-prompts reference catalog rows by ID (`CAT-NN`); adding a new failure pattern means adding one row plus wiring detection — there is no parallel registry.

## How to use

1. **Authoring an edit.** Read the row whose **Structural Action** matches what your edit physically does. The "What discipline restores correctness" cell names the pre-commit / CI / audit / human action you owe.
2. **Adding a new failure pattern.** Insert one row indexed on the structural action, never on the domain label. List the domain framings that triggered the discovery as **Surface-Label Aliases**. Wire detection (file path or skill name); a row with no detection-layer wiring is documentation theater.
3. **Skill `/ripple-check`.** Walks the catalog at runtime, identifies which rows' structural-action signals are present in the staged diff, and dispatches up to five parallel subagents — one per related-row group (A=CAT-01/02, B=CAT-03/04, C=CAT-05 broad, D=CAT-06/07) plus one cross-document coherence subagent (E) that audits the residual not keyed to any single row. CAT-08 is excluded because `lychee` already covers it at CI.
4. **Audit-prompt augmentation.** Plan-readiness audit prompts include the line "walk every catalog row marked Detection-layer=audit and re-derive the claim from primary source".

## Catalog

### CAT-01 — Path canonicalization

| Field | Value |
| --- | --- |
| Structural Action | A literal-path string (filesystem path, package path, build output, command argument) is moved or canonicalized. |
| Surface-Label Aliases | "rename", "consolidation", "carve-out", "scaffold restructure", "monorepo move". |
| Detection Layer | pre-commit hook + CI |
| Hook | [`tools/docs-corpus/lib/path-canonical-ripple.ts`](../../tools/docs-corpus/lib/path-canonical-ripple.ts) reads [`tools/docs-corpus/canonical-paths.json`](../../tools/docs-corpus/canonical-paths.json) and fails on any surviving deprecated occurrence outside the configured `exclude` paths. Composed by the dispatch runner [`tools/docs-corpus/bin/pre-commit-runner.ts`](../../tools/docs-corpus/bin/pre-commit-runner.ts). |
| Off-the-shelf Tool | None. (`lychee` covers `[text](path/file.md)` link syntax but not literal-path strings inside command snippets like `pnpm rebuild --filter=apps/desktop/shell better-sqlite3`.) |
| Failing Example | PR #24 (BL-101): ADR-022 cited `apps/desktop/{shell,renderer}/`. Round 1 fixed the literal-path citation but missed three executable-form occurrences (`pnpm rebuild --filter=apps/desktop/shell ...`), then missed `cross-plan-dependencies.md:228` in round 2, then missed Tier-8 prose in Plan-002/003/008 in round 3. Four review rounds, four fix commits. |
| Memory | `feedback_canonicalization_sweep_completeness.md` — frame structurally, not by domain label. |
| What Discipline Restores Correctness | Add the deprecated form to `tools/docs-corpus/canonical-paths.json` at the same time you make the canonical edit. The pre-commit hook fails if any deprecated occurrence survives outside the registered `exclude` paths; fix-and-restage. |

### CAT-02 — Identifier rename

| Field | Value |
| --- | --- |
| Structural Action | An exported name (function, type, constant, SQL column, migration filename, Zod schema) is renamed. |
| Surface-Label Aliases | "refactor", "rename", "schema migration", "type cleanup". |
| Detection Layer | TypeScript compiler + ESLint cover the code path. The catalog focuses on the **doc-cite ripple** that compilers do not see. |
| Hook | Same registry + script as CAT-01 (identifier strings are entries in `canonical-paths.json` with their own `(canonical, deprecated[])` row). |
| Off-the-shelf Tool | None for the doc-cite ripple. |
| Failing Example | None tracked in this corpus yet. |
| Memory | Same as CAT-01. |
| What Discipline Restores Correctness | Treat the rename as a CAT-01 entry — every rename of an identifier referenced by name from doc prose belongs in `canonical-paths.json`. |

### CAT-03 — Heading move / archival

| Field | Value |
| --- | --- |
| Structural Action | An H1-H6 heading is deleted from one file and a (possibly identical, possibly rephrased) heading is added to another file. |
| Surface-Label Aliases | "archival", "promotion", "supersession", "section move", "consolidation". |
| Detection Layer | pre-commit hook + CI |
| Hook | `lychee` over the staged set (pre-commit) and full repo (CI). Slug algorithm matches GFM. |
| Skill | [`/ripple-check`](../../.claude/skills/ripple-check/SKILL.md) dispatches Subagent B (CAT-03 / CAT-04) to verify post-staging that every inbound `<file>#<old-slug>` reference was rewritten and that the new heading exists in the destination file with the expected slug. Surfaces inbound references that are technically valid after the move but read awkwardly because the citing-doc prose still names the OLD heading by name. In `--with-fixes` mode the subagent can propose unstaged edits which the orchestrator applies via `git apply`. |
| Failing Example | PR #27 round 1 (commit `e7f7807`): archived BL-107 from `backlog.md` to `backlog-archive.md`; inbound cites at `Plan-024:94` + `Plan-024:328` were broken; the fix-sweep also caught `Plan-024:312` (BL-103) + `Plan-023:236` (BL-101) silently broken for 2-3 days from prior archivals. |
| Memory | `feedback_canonicalization_sweep_completeness.md` — note the framing-blindness ("archival" is a domain action; the structural action is "string move"). |
| What Discipline Restores Correctness | Stage the heading move + inbound-cite rewrites in one commit. The lychee pre-commit hook gates truly-broken anchors; if it fails, compute the new slug and rewrite every cite, then re-stage. Optionally invoke `/ripple-check` after staging to surface inbound references that lychee accepts as valid but where the citing prose still names the OLD heading. |

### CAT-04 — Heading-text edit (slug change)

| Field | Value |
| --- | --- |
| Structural Action | An H1-H6 heading text is modified in place such that the GFM slug changes, even though the section content is unchanged. |
| Surface-Label Aliases | "polish", "wording fix", "rename heading". |
| Detection Layer | pre-commit hook + CI |
| Hook | Same as CAT-03 — `lychee`. |
| Failing Example | None recorded yet. The failure mode is identical to CAT-03 by the slug-change criterion. |
| What Discipline Restores Correctness | Same as CAT-03. |

### CAT-05 — Set-quantifier invalidation

| Field | Value |
| --- | --- |
| Structural Action | A set membership change (graph node added/removed, list bullet added/removed, table row added/removed) without re-deriving every quantifying claim about the set. |
| Surface-Label Aliases | "added node to graph", "added row to table", "added bullet to list", "expanded scope". |
| Detection Layer | pre-commit hook (narrow hard-signal) + audit (broader cases) |
| Hook | [`tools/docs-corpus/lib/mermaid-set-coherence.ts`](../../tools/docs-corpus/lib/mermaid-set-coherence.ts) — narrow hard-signal: a file containing both a Mermaid graph with `:::class`-decorated nodes AND a prose enumeration `<adjective> set (X, Y, Z)` whose adjective matches the class. The set must equal. Composed by the dispatch runner [`tools/docs-corpus/bin/pre-commit-runner.ts`](../../tools/docs-corpus/bin/pre-commit-runner.ts). |
| Audit Prompt | "For every set claim of the shape `... set (X, Y, Z) <verb> ...` in this PR's diff, has the enumeration been re-derived from the post-edit set state?" |
| Off-the-shelf Tool | None. |
| Failing Example | PR #27 round 2 (commit `00ec528`): NS-22 was added as a `:::ready` graph node; the prose `The ready set (NS-01, NS-03, NS-04, NS-11, NS-12, NS-13a, NS-14, NS-22) shares no code paths` claim went stale (NS-22 sweeps `Plan-001` and NS-12 amends `Plan-001:357`, both edit the same file). |
| Memory | `feedback_set_quantifier_reverification.md` — the "shares no" claim re-derivation discipline. |
| Known Gaps | Table-shaped and list-shaped set claims are not detected by the hook (residual). The audit prompt covers the residual but is not a gate. |
| What Discipline Restores Correctness | (a) For Mermaid + enumeration cases: pre-commit hook fails; fix by editing prose OR graph until they match. (b) For table / list cases: audit prompt prompts manual re-derivation. |

### CAT-06 — Line-citation drift (truncation floor)

| Field | Value |
| --- | --- |
| Structural Action | A `file.md:NNN` cite remains pointing at a file whose line count dropped below NNN, or whose line NNN became whitespace, or whose target file was deleted / renamed. |
| Surface-Label Aliases | "deleted section", "consolidated content", "moved file". |
| Detection Layer | pre-commit hook + CI |
| Hook | [`tools/docs-corpus/lib/cite-target-existence.ts`](../../tools/docs-corpus/lib/cite-target-existence.ts) — catches missing target file, line-out-of-range, target-line-empty. Composed by the dispatch runner [`tools/docs-corpus/bin/pre-commit-runner.ts`](../../tools/docs-corpus/bin/pre-commit-runner.ts). |
| Off-the-shelf Tool | None. |
| Failing Example | PR #27 commit `aab5bf9` ("docs(repo): fix two line-citation drifts found by adversarial pass") — `Spec-027:6` should have been `Spec-027:5`; NS-22 References missed `Plan-001:12` and `:121`. Floor cases (file truncation) caught by hook; semantic cases are CAT-07. |
| What Discipline Restores Correctness | When you intend to cite a specific line, prefer to cite by content (inline anchor or quoting a unique substring) over by line number. When line number is required, run the hook. |

### CAT-07 — Line-citation drift (semantic)

| Field | Value |
| --- | --- |
| Structural Action | A `file.md:NNN` cite remains pointing at a non-empty line of a sufficiently long file but the **content** at NNN no longer matches what the cite intended (target moved within file). |
| Surface-Label Aliases | "shifted lines", "edited above", "evolved file". |
| Detection Layer | **audit only** — explicitly residual under static analysis. |
| Hook | None possible without semantic understanding (NLP / model invocation). The CAT-06 hook catches the truncation floor only. |
| Skill | [`/ripple-check`](../../.claude/skills/ripple-check/SKILL.md) dispatches a subagent for the semantic case. |
| Audit Prompt | "When you modify file X, every `X:NNN` cite from the rest of the corpus should be re-checked for semantic match." |
| Failing Example | The `Spec-027:6` → `Spec-027:5` drift in PR #27 fix `aab5bf9` was caught only by an isolated-context Opus 4.7 adversarial subagent. |
| What Discipline Restores Correctness | Manual audit or `/ripple-check` with a semantic-line-cite task. Long-term fix: cite by content (inline anchor / quoted substring) to escape line-number fragility. |

### CAT-08 — Outbound HTTP / file-link breakage

| Field | Value |
| --- | --- |
| Structural Action | A `[text](url)` or `[text](path/file.md)` outbound link points at a 404, a deleted file, or a renamed file. |
| Surface-Label Aliases | "broken external link", "moved doc". |
| Detection Layer | CI (HTTP) + pre-commit (local-file only via `--offline`). |
| Hook | `lychee` (CI does HTTP; pre-commit does file-only via `--offline`). |
| Off-the-shelf Tool | lychee. |
| Failing Example | None tracked yet. |
| What Discipline Restores Correctness | lychee fails CI; fix the link. |

## Known Limitations

- **Slug-algorithm divergence on niche Unicode.** lychee's filter and github-slugger's regex (reproduced verbatim in [`tools/docs-corpus/lib/slug.ts`](../../tools/docs-corpus/lib/slug.ts)) produce identical output for this corpus's headings but diverge on CJK punctuation, math symbols, and emoji-flanking. If a future heading uses such characters, the local TS slug is authoritative for what GitHub renders; lychee's check is the fast-path approximation.
- **Doc corpus lacks a stable identifier system.** Heading text is being used as a stable identifier — a known design weakness. Long-term fix is to give each BL / NS / catalog item a slug-stable shortname (e.g., `<a id="bl-107"></a>` HTML anchors that don't depend on heading text). Out of scope for this catalog.
- **Mermaid graph IS the source of truth; prose enumerations are not generated from it.** Long-term fix is a build step that emits the prose enumeration from the graph. Out of scope for this catalog.

## Detection-layer matrix

| Layer | Runs on | Latency | Determinism | Cost |
| --- | --- | --- | --- | --- |
| pre-commit hook | every `git commit` | <5s p99 | bit-for-bit | $0 |
| CI workflow | every PR + push to develop / main | minutes | bit-for-bit | $0 |
| `/ripple-check` skill | author-invoked | 30-120s | probabilistic | $0.50-3.00 |
| audit prompt | plan-readiness audit | minutes | model-dependent | $0.10-1.00 |

The four layers are complementary, not redundant. Static hooks remove human-in-the-loop entirely for the deterministic 80%; the skill catches the residual 20% on demand. CI is the authoritative gate (matches branch-protection's `required_conversation_resolution` semantics from ADR-023).

## References

- PR #24 (BL-101 path canonicalization, four review rounds): catalyst for CAT-01.
- PR #27 (BL-107 archival + adversarial sweep, two review rounds): catalyst for CAT-03 (round 1) and CAT-05 (round 2). Commits `e7f7807`, `aab5bf9`, `b977365`, `00ec528`, `be206f5`.
- ADR-023 §Axis 2 — pre-commit hooks discipline; this catalog plugs into the existing lefthook chain.
- [`docs/architecture/cross-plan-dependencies.md`](../architecture/cross-plan-dependencies.md) — exemplar of the Mermaid + prose-enumeration shape CAT-05 enforces.
- [`docs/operations/plan-implementation-readiness-audit-runbook.md`](./plan-implementation-readiness-audit-runbook.md) — sibling methodology doc; the Plan-readiness audit's checklist is where the catalog's audit-layer entries plug in.
