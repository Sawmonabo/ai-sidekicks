---
name: ripple-check
description: Use when staging or about to push doc-corpus changes — `.md` edits under `docs/`, ADRs, plans, specs, schemas, or any file whose content is cited from elsewhere in the corpus. Specific triggers — heading rename / move / archival, set-membership change in a Mermaid graph / table / list, line-citation drift suspicion, identifier or literal-path rename that doc prose references, plan-readiness audit pre-merge gate, or a Codex finding that suggests the static hooks missed a residual class. Trigger phrases include "check ripples", "audit corpus edit", "verify references after archival", "verify quantifier claims", "find broken inbound anchors", "look for stale line citations", "review my staged docs commit before push", "run pre-commit corpus audit", "I just archived a BL", "I just renamed a heading", "I just added an item to a Mermaid graph", "I just edited a section that other docs cite".
---

# ripple-check

An author-invoked orchestrator that fans out adversarial corpus-regression review across the failure-mode catalog. Layered on top of the static pre-commit + CI hooks; covers the residual classes those hooks cannot enforce. Each invocation dispatches up to 5 narrowly-scoped subagents in parallel, aggregates findings, and (optionally) applies proposed fixes through per-subagent git worktrees.

The catalog at [`docs/operations/failure-mode-catalog.md`](../../../docs/operations/failure-mode-catalog.md) is the single source of truth for what corpus regressions exist. This skill walks the catalog at runtime — adding a new failure pattern means adding a catalog row, not editing this skill.

## Why this skill exists

The static pre-commit + CI hooks (`lychee`, `path-canonical-ripple`, `mermaid-set-coherence`, `cite-target-existence`) catch the deterministic 80% — they always fire, run in <5s, and gate via branch protection. They cannot catch the semantic 20%:

- **CAT-05 (broader)** — set-quantifier claims expressed in tables / lists, not the narrow Mermaid + prose-enumeration shape the hook enforces.
- **CAT-07** — line-citation drift when both old and new lines are non-empty (`Spec-027:6 → :5`).
- **Cross-doc narrative coherence** — "ADR-022 says X; Plan-022 implicitly assumes ¬X." Spans multiple catalog rows and is keyed on a _semantic relationship_, not a single structural action.

The PR #27 post-mortem found two distinct failure modes — heading-move recall by surface label (CAT-03) and set-quantifier invalidation (CAT-05) — that escaped the author's adversarial pass but were caught by isolated-context subagents. This skill institutionalizes that pattern, while explicitly preserving the catalog's structural-action keying for the four catalog-row subagents (A–D) and using a fifth audit-layer subagent (E) for residuals that span rows.

## Modes

### Default — `/ripple-check`

Read-only. Subagents gather findings in parallel, return structured JSON, orchestrator presents one consolidated report. No worktrees, no edits.

### `--with-fixes` — `/ripple-check --with-fixes`

Each subagent runs in its own git worktree (via the `Agent` tool's `isolation: "worktree"` flag). Subagents leave **unstaged** edits in their worktree (no git mutations — same contract as plan-execution: subagents do not run `git`). Orchestrator extracts each worktree's diff, presents to the author for approval, then applies via `git apply` to the main checkout in a single commit.

### `--target=<rev>` — optional, composes with the above

Override the diff source. Default is `git diff HEAD` ∪ `git diff --cached` (working tree + staged against current HEAD). Useful for auditing an open PR before push: `--target=develop` audits everything on the current branch since it diverged from `develop`. Combine with `--with-fixes` if desired.

## Procedure

### Phase 0 — Establish scope

1. **Resolve the target diff.**
   - Default: `git diff HEAD` ∪ `git diff --cached`.
   - With `--target=<rev>`: `git diff <rev>...HEAD`.
2. **Extract structural signals from the diff** — renamed paths, deleted / added / edited headings, added / removed Mermaid graph nodes / table rows / list bullets, modified `:NNN` citations, modified `[text](url)` links.
3. **Run the deterministic doc-corpus checks once locally**, scoped to the staged `.md` files. Run the runner directly (not the full lefthook chain — `lefthook run pre-commit` also fires `lint-staged`, `gitleaks`, and `commitlint`, which are unrelated to corpus regression and can false-stop the skill mid-flight):

   ```bash
   node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts <staged-md-files>
   lychee --offline --no-progress --config .lychee.toml <staged-md-files>
   ```

   Catalog whatever they surface and mark those issues resolved before dispatching subagents — there is no point dispatching for issues the deterministic layer already caught.

4. **Map the residual diff signals to subagents.** Use this lookup:

   | Diff signal | Subagent to dispatch |
   | --- | --- |
   | A literal-path string was renamed | Subagent A (CAT-01 / CAT-02) |
   | An exported identifier (function / type / SQL column / migration filename) was renamed | Subagent A (CAT-01 / CAT-02) |
   | An H1-H6 heading was deleted / added / moved between files | Subagent B (CAT-03 / CAT-04) |
   | An H1-H6 heading text was edited in place (slug change) | Subagent B (CAT-03 / CAT-04) |
   | A Mermaid graph node, table row, or list bullet was added or removed | Subagent C (CAT-05) |
   | The staged file is cited from elsewhere by `<file>:NNN` | Subagent D (CAT-06 / CAT-07) |
   | Any modified `.md` file is referenced by other docs | Subagent E (cross-doc coherence) |

   CAT-08 (outbound HTTP / file-link breakage) is fully covered by `lychee` at CI; no subagent fires for it. Dispatch only the subagents whose signals are present — typical invocations dispatch 1–3, full sweeps dispatch 5.

### Phase 1 — Parallel subagent dispatch

Dispatch the queued subagents in a **single message** with multiple `Agent` tool calls so they run concurrently. Each subagent receives:

- A focused inline prompt scoped to its catalog row(s) or cross-doc coherence axis (templates below).
- The relevant diff hunks for the files it should examine. Pass hunks, not the full repo — context discipline is load-bearing for parallel cost and signal-to-noise.
- The catalog row content for its assigned `CAT-NN` (or, for Subagent E, an inverse-question framing).
- The fixed JSON output schema (see [Subagent output schema](#subagent-output-schema) below).

For `--with-fixes` mode, also pass `isolation: "worktree"` to each `Agent` call. Subagents in worktree mode write file edits but do **not** run `git`; the orchestrator extracts the diff in Phase 3.

#### Subagent output schema

Every subagent returns a single JSON object:

```json
{
  "exit_state": "DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED",
  "findings": [
    {
      "severity": "error | warning | info",
      "catalog_row": "CAT-01",
      "file": "docs/architecture/cross-plan-dependencies.md",
      "line": 228,
      "description": "Surviving deprecated form 'apps/desktop/shell' in executable-form citation.",
      "suggested_fix": "Replace with 'apps/desktop/' (the canonical form per canonical-paths.json entry registered 2026-04-30)."
    }
  ],
  "narrative": "Optional reviewer-shows-work text. No re-dispatch is triggered by narrative content."
}
```

- `severity` — `error` (must fix), `warning` (should fix), `info` (heads-up).
- `catalog_row` — the row this finding maps to (`CAT-NN`); Subagent E uses `cross-doc` when the finding spans rows.
- `line` — optional; omit for whole-file findings.
- `suggested_fix` — required for `severity=error`; recommended otherwise. Free-form prose or a unified diff snippet; the orchestrator does not parse it programmatically in default mode.
- `exit_state` semantics — `DONE` means "no findings or only `info`"; `DONE_WITH_CONCERNS` means "findings exist, but the diff is in scope and the analysis ran cleanly"; `NEEDS_CONTEXT` means "the subagent could not complete because input was insufficient"; `BLOCKED` means "the subagent encountered a gate that requires human resolution".

#### Subagent A — CAT-01 / CAT-02 path & identifier ripple

```
You are auditing a doc-corpus diff for path / identifier rename ripple. Catalog rows: CAT-01 + CAT-02 in docs/operations/failure-mode-catalog.md.

Inputs:
- Diff hunks (renamed paths, renamed identifiers): {hunks}
- Current registry: tools/docs-corpus/canonical-paths.json (each entry has `canonical`, `deprecated[]`, `scope[]`, and `exclude[]` fields).

Scope and exclude discipline. The registry's `scope` field defines where each entry is enforced (typically `docs/**/*.md`, root .md files); `exclude` carves out archives and tool internals. When you grep for surviving deprecated forms, honor BOTH `scope` (limit search to those globs) AND `exclude` (subtract those globs) — the path-canonical-ripple hook does the same and your job is to find what slipped past it (e.g. an executable-form occurrence inside a code block that the hook DID see, or a heading-cite that surfaced an unregistered rename).

Tasks:
1. For each rename in the diff, check whether `canonical-paths.json` has a `(canonical, deprecated[])` entry covering it. If not, propose one (output the new entry as JSON in the suggested_fix field).
2. Within each entry's `scope` minus `exclude`, grep for surviving deprecated forms — including executable / command-snippet contexts and heading-cite contexts.
3. Report: registry-without-rename, rename-without-registry, surviving deprecated form, ambiguous case where the rename is not yet final.

Output: the JSON object specified by the orchestrator's schema. In default mode, do NOT mutate files. In --with-fixes mode, write proposed edits to the working tree but do NOT run any `git` command.
```

#### Subagent B — CAT-03 / CAT-04 heading move & slug change

```
You are auditing a doc-corpus diff for heading move / slug change ripple. Catalog rows: CAT-03 + CAT-04.

Inputs:
- Diff hunks (deleted / added / edited headings): {hunks}
- Recent lychee output (if available): {lychee_output}

GFM slug formula. Compute slugs as: lowercase the heading text, strip Unicode punctuation/symbols (the github-slugger character class — see tools/docs-corpus/lib/slug.ts for the exact regex), replace spaces with hyphens. Duplicate slugs in one file get a numeric suffix (`-1`, `-2`, ...). For this corpus the formula is bit-for-bit faithful; divergences only matter for niche Unicode (CJK punctuation, math symbols, emoji-flanking) and are documented in the catalog's "Known Limitations".

Tasks:
1. For each heading-text change in the diff, compute old-slug and new-slug. If unchanged, report `info` and exit.
2. Grep the corpus for inbound `<file>#<old-slug>` references. lychee catches truly-broken anchors at CI; your job is to surface inbound references that are technically VALID after the move but read awkwardly because the citing-doc prose mentions the OLD heading by name (e.g. "see § Cross-Plan Dependencies" with the link still resolving but the destination heading now reading "§ Build-Order DAG").
3. If a heading was MOVED to another file (deletion in file X, addition in file Y), verify the destination file has the new heading. Report any case where the deletion happened but the addition is missing or the slug differs from what inbound cites assumed.

Output: the JSON object specified by the orchestrator's schema. Do NOT mutate files in default mode.
```

#### Subagent C — CAT-05 set-quantifier ripple (broad)

```
You are auditing a doc-corpus diff for set-quantifier invalidation. Catalog row: CAT-05 (broad — beyond the narrow Mermaid + prose-enumeration shape the mermaid-set-coherence hook enforces).

Inputs:
- Diff hunks (added / removed list items, table rows, graph nodes): {hunks}
- The narrow hook has already passed for the Mermaid + prose-enumeration shape; your job is the residual.

Tasks:
1. In each affected file, find every set-quantifying claim — phrases like "shares no", "all X are", "every X is", "no X is", "concurrent", "ready set", "the full set", "none of these tasks edit X". Look in tables and lists especially — those are residual relative to the hook.
2. For each claim, re-derive whether it still holds given the post-edit set state. The hook checks Mermaid + prose-enumeration; you check tables, lists, and prose enumerations the hook did not key on.
3. For each invalidated claim, propose a fix: rewrite the wording, add a caveat, or move the new item out of the quantifier's scope.

Output: the JSON object specified by the orchestrator's schema. Cite each finding with `catalog_row: CAT-05` and a short rationale in `description` referencing which set-membership change drove the invalidation.
```

#### Subagent D — CAT-06 / CAT-07 line-cite ripple (semantic)

```
You are auditing a doc-corpus diff for line-citation drift. Catalog rows: CAT-06 (truncation floor — hook-covered) + CAT-07 (semantic — residual).

Inputs:
- Diff hunks: {hunks}
- For each modified file, the list of inbound `:NNN` cites from elsewhere in the corpus. Compute via:
    git grep -nE '\]\([^)]*<basename>\.md\):[0-9]+'
  where `<basename>` is the modified file's stem.

Tasks:
1. The cite-target-existence hook has caught the truncation floor (line out of range, target empty). Your job is the residual: CAT-07 semantic drift.
2. For each inbound `<file>:NNN` cite to a modified file, read the target line in the post-edit state AND read the citing-doc prose around the cite. Ask: does the target line still semantically match what the citing prose claims it cites?
3. If the answer is "no" or "unclear", propose either (a) a corrected line number or (b) a content-based citation form (an inline anchor `<a id="..."></a>` near the target, or a quoted unique substring).

Output: the JSON object specified by the orchestrator's schema. Use `catalog_row: CAT-07` for semantic drift and `catalog_row: CAT-06` only if you find something the hook should have caught but did not.
```

#### Subagent E — Cross-document narrative coherence (audit-layer residual)

```
You are auditing a doc-corpus diff for cross-document narrative coherence — claims in one doc that depend on assumptions in another. This is keyed on a SEMANTIC RELATIONSHIP across documents, not a single structural action; it is the audit-layer residual that spans the catalog's row-keyed checks.

Inputs:
- Diff hunks: {hunks}
- A list of docs that reference any of the modified files. Compute via:
    git grep -lF '<modified-file-basename>' -- '*.md'
  for each modified file's stem.

Tasks:
1. For each modified file, identify load-bearing claims that other docs depend on. Examples:
   - "Plan-X step 4 is blocked until Plan-Y ships at Tier 8" — when the Tier 8 assumption changes in Plan-Y, the dependent gating-prose in Plan-X may be invalidated even though no shared literal string changed.
   - "ADR-022 selects pnpm over npm for engines pinning" — if Plan-001 implicitly assumes npm-compatible install behavior, the assumption is now stale.
2. Read referenced docs adversarially. Ask: "given my edit, does any claim in this dependent doc become false / stale / misleading?"
3. Report findings with `catalog_row: cross-doc`. For each, propose a concrete fix in the dependent doc.

Output: the JSON object specified by the orchestrator's schema. Be conservative — `info` for plausible-but-not-certain drift, `warning` for likely drift, `error` only for confirmed false claims.
```

### Phase 2 — Aggregate + dedup

When all subagents return:

1. Concatenate findings into one list.
2. Dedup by `(file, line, description)` — multiple subagents may surface the same issue from different angles; collapse and annotate with each subagent's catalog row in a `[CAT-NN, CAT-MM]` prefix.
3. If a subagent returned `NEEDS_CONTEXT` or `BLOCKED`, surface that to the user verbatim with the subagent's `narrative`. Do NOT silently drop a non-`DONE` exit state.
4. Sort: severity (`error` > `warning` > `info`), then catalog row, then file path.

### Phase 3 — Present + (optionally) apply fixes

#### Default mode

Print the aggregated report. Group by catalog row. For each finding:

- `[CAT-NN] [severity] file:line — description`
- If `suggested_fix` is present, show it as a code block.

Exit when the user has reviewed.

#### `--with-fixes` mode

Each subagent worked in its own git worktree (via the `Agent` tool's `isolation: "worktree"`). Subagents wrote unstaged file edits and did NOT run `git`.

For each subagent that returned findings:

1. Inside that subagent's worktree, run `git diff` (working tree vs. HEAD) to extract the proposed change as a unified patch.
2. Present the patch to the author with the catalog-row label and the finding(s) it addresses.
3. **If the author approves**: apply the patch to the main checkout via `git apply --whitespace=nowarn <patch>`. Stage the result. Continue to the next subagent's patch.
4. **If the author rejects**: skip; close the worktree (`git worktree remove <path>` — this is safe because the subagent did not commit).
5. **If applying produces a conflict** (two subagents touched the same file and their patches collide): surface the conflict to the author with the failing patch and the prior accepted patches; let the author choose to merge manually, drop one patch, or re-dispatch with a narrower scope.

After all approved patches are applied:

- Re-run the deterministic doc-corpus checks one more time on the merged state (same commands as Phase 0 step 3) to verify regressions did not slip in.
- Stage as a single commit on the current branch with a message of the form:

  ```
  docs(repo): apply ripple-check findings from /ripple-check audit

  Subagents that contributed: A (CAT-01), C (CAT-05), E (cross-doc).
  Findings applied: <count>; rejected: <count>.

  Refs: failure-mode-catalog.md
  ```

## Telemetry and the catalog feedback loop

Each invocation writes a transient log to `.agents/tmp/ripple-check/<short-sha>-<timestamp>.md` (gitignored, transient — `.agents/tmp/` is gitignored at repo root per AGENTS.md):

- Diff scope (HEAD / target rev / file count).
- Subagents dispatched (which signals fired which subagents).
- Subagent verdicts (counts of findings by severity, exit state).
- Whether the deterministic layer had already caught any of the findings (signal vs noise — informs hook-sharpening).
- Mode (default / `--with-fixes`) and outcome (approved / rejected / partial).

**Surface-forward step (load-bearing).** Per AGENTS.md's surface-forward-then-delete pattern, the transient log is not the feedback loop on its own. When a subagent finds something the deterministic layer DID NOT catch:

1. If the finding fits an existing `CAT-NN` row, the orchestrator (or the author) appends a one-row entry to that row's `Known Gaps` field in `docs/operations/failure-mode-catalog.md` with the date, the structural action that was missed, and a one-line reproduction of the finding.
2. If the finding does not fit any existing row, the orchestrator surfaces the gap to the author with a recommendation to either tighten an existing row's structural-action definition or propose a new `CAT-NN` row in a separate doc PR. Adding a row is itself a corpus edit and goes through normal review.

Once the catalog edit is staged, the transient log can be deleted. The `.agents/tmp/` directory is gitignored and per-commit-deleted; the catalog edit is the durable surface-forward.

Without this step, the telemetry is documentation theater — the gitignored log dies at the end of the session and the next hook-sharpening pass has nothing to read.

## What this skill does NOT do

- **It does not perform heading-move-with-rewrite atomically.** The skill audits AFTER the heading change is staged (Subagent B verifies post-edit state); it does not stage the move on the author's behalf.
- **It does not enforce CAT-08** (outbound HTTP / file-link breakage). `lychee` already covers that at CI; running a subagent for it would duplicate effort.
- **It does not run from CI.** It is non-deterministic and relies on parallel subagent dispatch. Required-checks must be deterministic; the skill is author-invoked only.
- **It does not bound diff size.** A 10k-line diff will produce a long invocation; the orchestrator does not refuse. Authors should split large diffs into reviewable PRs before invoking; this is hygiene, not a skill-level guard.

## Anti-patterns this skill exists to prevent

1. **Recalling "canonicalization sweep" memory for a path move but not for an archival or rename.** This is the PR-#27 round 1 indexing failure. The catalog is keyed on **structural action**, not surface label, so this skill walks the action key.
2. **Reading a staged diff for "is the edit correct in isolation" without asking "what claims elsewhere become false because of this edit".** This is the PR-#27 round 2 inverse-question failure. Subagents A–E each hold one inverse question.
3. **Treating green pre-commit as proof of completeness.** The skill surfaces audit-layer findings the hooks cannot enforce; those findings are the residual class explicitly named in the catalog's "Detection-layer matrix".
4. **Author blindness.** The author reads what they MEANT; an isolated-context subagent reads what they WROTE. Up to five fresh-reader perspectives in parallel are not equivalent to five sequential adversarial passes by the author.
5. **Running the skill on an empty or partial working tree.** If the author has work-in-progress edits that are not yet staged or saved, the skill audits an inconsistent state. Stage (or save and reload) the full intended change set before invoking. The skill operates on `git diff HEAD`; what is not in the diff is invisible to it.

## Composition with the static hooks

The skill is layered ON TOP OF the static hooks; it does not replace them.

|  | Static hooks (lefthook + CI) | `/ripple-check` skill |
| --- | --- | --- |
| Runs on | every `git commit`, every PR + push to `develop`/`main` | author-invoked |
| Determinism | bit-for-bit reproducible | probabilistic |
| CI parity | yes (`docs-corpus-gate` is the required-check aggregator) | no (cannot run from GH Actions; non-determinism would break required-checks) |
| Catches | CAT-01, CAT-03, CAT-04, CAT-05 (narrow), CAT-06, CAT-08 | residuals: CAT-05 (broad), CAT-07, cross-doc coherence |
| Cost | $0 | $0.50–3.00 per invocation, 30–120s wall-clock |

If you skip static hooks: regression slips whenever the skill ritual is skipped. If you skip the skill: residuals stay residuals (acceptable but worse). Use both.

## When to invoke

- Always before `git push` on a PR that touches any `.md` file under `docs/`, ADRs, plans, specs, schemas, or root-level instruction files (`README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`).
- After any heading move, archival, or in-place text edit.
- After adding or removing items in a set referenced by quantifying claims (Mermaid graphs, tables, lists).
- Before marking a plan-readiness audit complete.
- When Codex review surfaces a finding the static hooks should have caught — run with `--with-fixes` and surface-forward the missed pattern to the catalog as a Known Gap (see Telemetry above).

## When NOT to invoke

- Routine code edits inside `packages/*` that don't touch `.md` files and don't rename anything registered in `canonical-paths.json` — the static hooks already cover the doc-cite surface.
- When the static hooks have caught a deterministic finding and you have a one-line fix — fix and re-stage; the skill is for residuals, not for already-known issues.
- During exploratory editing — the skill is most valuable BEFORE commit on a stable change set, not during draft.
