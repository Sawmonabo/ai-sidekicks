---
name: ripple-check
description: Use when about to push or stage doc-corpus changes that other docs cite — heading move / rename / archival, Mermaid / table / list set-membership change, line-citation drift suspicion, identifier or path rename, plan-readiness audit pre-merge, or a Codex finding suggesting the static hooks missed a residual semantic class. Audits the residual the deterministic hooks (lychee, path-canonical-ripple, mermaid-set-coherence, cite-target-existence) cannot enforce. Author-invoked only — never runs from CI.
---

# ripple-check

An author-invoked orchestrator that fans out adversarial corpus-regression review across the failure-mode catalog. Layered on top of the static pre-commit + CI hooks; covers the residual classes those hooks cannot enforce. Each invocation dispatches up to 5 narrowly-scoped subagents in parallel, aggregates findings, and (optionally) applies proposed fixes through per-subagent git worktrees.

The catalog at [`docs/operations/failure-mode-catalog.md`](../../../docs/operations/failure-mode-catalog.md) is the single source of truth for what corpus regressions exist. This skill walks the catalog at runtime — adding a new failure pattern means adding a catalog row, not editing this skill.

## Your role: orchestrator

You are the orchestrator. You do not write findings yourself — you decompose the diff, dispatch subagents in parallel, parse their JSON, dedup findings, and (optionally) apply fixes. Five subagent roles — A through E — are _your_ subagents. Each is defined as a Claude Code subagent at [`.claude/agents/ripple-check-<role>.md`](../../agents/); you dispatch each via the `Agent` tool with `subagent_type: "ripple-check-<role>"`. Their system prompts (auto-loaded by the runtime at dispatch time) inline a shared output schema and behavioral contract; you parse the JSON object each returns to route findings.

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

### `--target=<rev>` — composes with the above

Override the diff source. Default is `git diff HEAD` ∪ `git diff --cached` (working tree + staged against current HEAD). Useful for auditing an open PR before push: `--target=develop` audits everything on the current branch since it diverged from `develop`. Combine with `--with-fixes` if desired.

## Procedure

### Phase 0 — Establish scope

1. **Resolve the target diff.**
   - Default: `git diff HEAD` ∪ `git diff --cached`.
   - With `--target=<rev>`: `git diff <rev>...HEAD`.
   - If the resolved diff is empty, halt with a one-sentence message and do NOT dispatch any subagents (see [`references/failure-modes.md` § Empty diff](references/failure-modes.md#empty-diff)).
2. **Extract structural signals from the diff** — renamed paths, deleted / added / edited headings, added / removed Mermaid graph nodes / table rows / list bullets, modified `:NNN` citations, modified `[text](url)` links.
3. **Run the deterministic doc-corpus checks once locally**, scoped to the staged `.md` files. Run the runner directly (not the full lefthook chain — `lefthook run pre-commit` also fires `lint-staged`, `gitleaks`, and `commitlint`, which are unrelated to corpus regression and can false-stop the skill mid-flight):

   ```bash
   node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts <staged-md-files>
   lychee --offline --no-progress --config .lychee.toml <staged-md-files>
   ```

   Catalog whatever they surface and mark those issues resolved before dispatching subagents — there is no point dispatching for issues the deterministic layer already caught.

4. **Map the residual diff signals to subagents.** Use this lookup; dispatch only the subagents whose signals are present (typical invocations dispatch 1–3, full sweeps dispatch 5):

   | Diff signal | Subagent | `subagent_type` |
   | --- | --- | --- |
   | A literal-path string was renamed | **Subagent A** (CAT-01 / CAT-02) | `ripple-check-path-identifier` |
   | An exported identifier (function / type / SQL column / migration filename) was renamed | **Subagent A** (CAT-01 / CAT-02) | (same as above) |
   | An H1–H6 heading was deleted / added / moved between files | **Subagent B** (CAT-03 / CAT-04) | `ripple-check-heading-move` |
   | An H1–H6 heading text was edited in place (slug change) | **Subagent B** (CAT-03 / CAT-04) | (same as above) |
   | A Mermaid graph node, table row, or list bullet was added or removed | **Subagent C** (CAT-05 broad) | `ripple-check-set-quantifier` |
   | The staged file is cited from elsewhere by `<file>:NNN` | **Subagent D** (CAT-06 / CAT-07) | `ripple-check-line-cite` |
   | Any modified `.md` file is referenced by other docs | **Subagent E** (cross-doc coherence) | `ripple-check-cross-doc` |

   CAT-08 (outbound HTTP / file-link breakage) is fully covered by `lychee` at CI; no subagent fires for it.

### Phase 1 — Parallel subagent dispatch

Dispatch the queued subagents in a **single message** with multiple `Agent` tool calls so they run concurrently. The dispatch is deterministic — the runtime auto-loads each agent's system prompt from [`.claude/agents/ripple-check-<role>.md`](../../agents/) when you pass the matching `subagent_type`. You do NOT read the agent file or substitute placeholders.

For each subagent:

- Construct the `prompt` parameter as a plain text payload containing the runtime data the agent expects (its `## Inputs` section in `.claude/agents/ripple-check-<role>.md` is the source of truth). At minimum: the modified-file list and the diff hunks scoped to the agent's axis. Axis-specific additions: registry path (A), recent lychee output (B, optional), confirmation that `mermaid-set-coherence` already passed (C), the inbound `<file>:NNN` cite list (D), the list of dependent docs (E).
- Pass hunks, not the full repo — context discipline is load-bearing for parallel cost and signal-to-noise.
- The shared output schema and behavioral contract are inlined into each agent's system prompt. Do NOT restate the schema in the dispatch prompt.
- For `--with-fixes` mode, pass `isolation: "worktree"` to each `Agent` call. Subagents in worktree mode write file edits but do **not** run `git` (their definitions intentionally omit the `Bash` tool); the orchestrator extracts the diff in Phase 3.

Example dispatch (default mode):

```
Agent({
  subagent_type: "ripple-check-path-identifier",
  prompt: "Modified files:\n  docs/architecture/cross-plan-dependencies.md\n\nDiff hunks:\n<diff content>\n\nRegistry: tools/docs-corpus/canonical-paths.json"
})
```

### Phase 2 — Aggregate + dedup

When all subagents return:

1. Concatenate findings into one list.
2. Dedup by `(file, line, description)` — multiple subagents may surface the same issue from different angles; collapse and annotate with each subagent's catalog row in a `[CAT-NN, CAT-MM]` prefix.
3. If a subagent returned `NEEDS_CONTEXT` or `BLOCKED`, surface that to the user verbatim with the subagent's `narrative`. Do NOT silently drop a non-`DONE` exit state. (Operational details: [`references/failure-modes.md`](references/failure-modes.md) § the corresponding sections.)
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
3. **If approved**: apply the patch to the main checkout via `git apply --whitespace=nowarn <patch>`. Stage the result. Continue to the next subagent's patch.
4. **If rejected**: skip; close the worktree per [`references/failure-modes.md` § With-fixes mode worktree cleanup](references/failure-modes.md#with-fixes-mode-worktree-cleanup).
5. **If applying produces a conflict** (two subagents touched the same file and their patches collide): see [`references/failure-modes.md` § Patch conflict between two with-fixes subagents](references/failure-modes.md#patch-conflict-between-two-with-fixes-subagents).

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

Layered ON TOP of the static hooks; does not replace them. For the per-layer comparison (runs-on, latency, determinism, cost), see [`docs/operations/failure-mode-catalog.md` § Detection-layer matrix](../../../docs/operations/failure-mode-catalog.md#detection-layer-matrix) — the catalog owns the canonical breakdown across all four layers (pre-commit hook / CI workflow / `/ripple-check` skill / audit prompt).

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

## Reference Files

Read these when the workflow step calls for them:

- [`references/failure-modes.md`](references/failure-modes.md) — operational edge cases: empty diff, `NEEDS_CONTEXT` / `BLOCKED` exit states, `--with-fixes` worktree cleanup, patch conflicts between subagents, malformed JSON recovery, no-git contract violation recovery.

## Subagent definitions

The five subagents live as Claude Code agent definitions, not as prompt files this skill reads. The runtime auto-loads each agent's system prompt at dispatch time when you call `Agent({subagent_type: "ripple-check-<role>", ...})`. You do NOT need to read the agent files yourself; they are listed here for reference and for authors maintaining the skill:

- [`.claude/agents/ripple-check-path-identifier.md`](../../agents/ripple-check-path-identifier.md) — Subagent A (CAT-01 / CAT-02 path & identifier ripple).
- [`.claude/agents/ripple-check-heading-move.md`](../../agents/ripple-check-heading-move.md) — Subagent B (CAT-03 / CAT-04 heading move & slug change).
- [`.claude/agents/ripple-check-set-quantifier.md`](../../agents/ripple-check-set-quantifier.md) — Subagent C (CAT-05 broad — table / list / prose-enumeration set-quantifier residual).
- [`.claude/agents/ripple-check-line-cite.md`](../../agents/ripple-check-line-cite.md) — Subagent D (CAT-06 / CAT-07 line-citation drift, semantic case).
- [`.claude/agents/ripple-check-cross-doc.md`](../../agents/ripple-check-cross-doc.md) — Subagent E (audit-layer cross-document narrative coherence).

Each agent's system prompt inlines the shared output schema (the JSON object the orchestrator parses) and the behavioral contract (default-mode read-only vs `--with-fixes` worktree-isolated, no-`git` rule). The contract is intentionally duplicated across agents — defense-in-depth (no shared file dependency) and the agents cannot read each other's definitions at dispatch time.

Note: `.claude/agents/` files are NOT live-reloaded mid-session. Adding or editing an agent definition requires a Claude Code restart before the runtime picks it up.
