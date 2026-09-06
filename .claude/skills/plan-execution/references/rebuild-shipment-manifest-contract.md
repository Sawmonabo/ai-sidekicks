# rebuild-shipment-manifest Contract

`scripts/rebuild-shipment-manifest.mjs` is a recovery tool that rebuilds a plan's `### Shipment Manifest` block from `gh` PR history. It is intentionally separate from `post-merge-housekeeper.mjs` so that script's Plan Invariant I-3 (no git/network imports) stays local and unbroken.

## When to use

1. **Backfill** — a plan pre-dates the housekeeper's structured-manifest write path. Plan-001 / Plan-007 fall into this category; their pre-existing prose Progress Log content gets migrated to a `### Notes` subsection while this script seeds the `### Shipment Manifest` block from `gh` PR history.
2. **Recovery** — `post-merge-housekeeper.mjs` crashed mid-Phase-E and the on-disk manifest drifted from git history. The orchestrator's resume diagnostic (in `references/state-recovery.md`) routes here when the manifest is missing entries for already-merged PRs.
3. **Cross-validation** — operator wants to verify a hand-curated manifest matches `gh` ground truth. Run with `--dry-run` and diff against the current plan-file YAML.

## CLI

```bash
node --experimental-strip-types \
  .claude/skills/plan-execution/scripts/rebuild-shipment-manifest.mjs \
  --plan NNN [--dry-run] [--force]
```

| Flag | Purpose |
| --- | --- |
| `--plan NNN` | **Required.** 3-digit plan number. The script searches `docs/plans/NNN-*.md` for the target file. |
| `--dry-run` | Emit the rebuilt YAML to `stdout`; do NOT touch the plan file. Use first to preview before committing changes. Stdout is a pure YAML stream (comment lines only besides the block) safe to redirect and diff; all per-PR diagnostics (`skipped …`, `reused …`, `included …`) AND the CLI's final summary line (`N entries emitted …`) go to `stderr`. |
| `--force` | Skip entries whose `pr` field already exists in the plan's manifest. Without `--force`, the script halts (exit 4) on collision rather than risk silent overwrites. Note: `--force` currently does NOT replace existing entries in-place; it only suppresses the collision halt and proceeds with a no-op `appendManifestEntry` for the colliding PRs. |
| `--include-body-matches` | Treat body-only search matches as candidates instead of skipping them. For fresh backfills of pre-title-mandate history (e.g. Plan-001's PR #6/#8/#9/#10, whose squash titles carry no `Plan-NNN` token) — the operator MUST confirm each included body-only candidate is a lane-1 shipment, not a lane-2 enhancement or passing mention. Because pre-mandate squash text usually lacks parseable `Phase`/`T`-markers, candidates that fail `validateEntry` do NOT exit 5: dry-run emits them as a commented `# Operator confirmation needed` YAML block (editable by hand, each with its `^ unresolved:` field list); write mode never writes them and reports the count. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success — entries appended (write mode) or YAML emitted (dry-run mode). |
| 1 | Arg-validation failure — missing or malformed `--plan`. |
| 2 | gh runner failure — `gh` not installed, auth error, or network error. |
| 3 | Plan file not found at `docs/plans/NNN-*.md`, or its manifest block is unparseable. |
| 4 | Manifest write conflict — entries exist for one or more PRs. Pass `--force` to skip. |
| 5 | Validation failure — at least one proposed entry failed `validateEntry()` from `lib/manifest.mjs` (typically a missing merge SHA on a queued-and-reverted PR). Pass `--force` to skip the failed entries. |
| 6 | Fetch saturation — `gh pr list --limit FETCH_LIMIT` returned exactly `FETCH_LIMIT` matches, so the result MAY be truncated and manifest completeness cannot be guaranteed. Raise `FETCH_LIMIT` in the script (currently 1000) or migrate to gh-api-with-pagination. This is the loud-failure replacement for the silent truncation that the manifest refactor eliminated from the preflight hot path. |
| 7 | Per-PR file-list reconciliation failure — the paginated file list for a PR did not match the authoritative `changedFiles` count, or that count was absent. The list comes from `gh api repos/{owner}/{repo}/pulls/<N>/files --paginate --jq '.[].filename'`, which walks every page; GitHub documents that this endpoint's responses "include a maximum of 3000 files", and a walk that hits that ceiling simply stops with no in-band signal. Any disagreement in either direction halts rather than commit a `files:` array that does not describe the PR. (`gh pr view --json files` is NOT used for the list: it compiles to a single `pullRequest.files(first: 100)` GraphQL page, which is what used to halt this tool on ordinary 200-800-file Plan-023 PRs.) |

## Behavior

1. **Resolve plan file.** `docs/plans/NNN-*.md` (single match required; ambiguous matches halt with exit 3).
2. **Fetch merged PRs.** `gh pr list --state merged --search "Plan-NNN in:title,body" --json number --limit FETCH_LIMIT` (currently 1000). The `in:title,body` qualifier constrains the GitHub search to PR titles and bodies; without it, the default search also matches review comments and discussion threads, so an unrelated merged PR that mentions "Plan-NNN" in passing would land in the result set and produce a wrong-phase/wrong-task entry. When the result hits the ceiling (`length === FETCH_LIMIT`), the script halts with exit 6 — see "Exit codes" — because `gh pr list` truncates silently. Plans currently sit well under 100 matches; 1000 mirrors the original preflight ceiling that the hot-path manifest refactor eliminated, so the cold-path recovery script inherits the same anti-silent-truncation discipline.
3. **Per-PR fetch.** For each PR number, two commands: `gh pr view <N> --json title,body,mergedAt,mergeCommit,changedFiles` for metadata, and `gh api repos/{owner}/{repo}/pulls/<N>/files --paginate --jq '.[].filename'` for the file list (gh substitutes `{owner}`/`{repo}` from the current repository). The metadata read deliberately does not request `files` — the GraphQL page would only be a second, shorter answer to a question the paginated walk answers in full. The newline-separated paths are parsed into the `[{ path }]` shape the entry builder consumes and reconciled against `changedFiles`; any mismatch, in either direction, is exit 7.

   **Ratified non-shipments.** Before the title probe, any PR listed in the plan manifest's optional `non_shipment_prs: [...]` key is skipped outright with a `skipped (ratified non-shipment): …` line on `stderr` and costs no `gh` round-trip. The operator has already asserted that PR shipped no task of this plan (see `lib/manifest.mjs` §`non_shipment_prs`), and preflight Gate 6 has stopped demanding an entry for it — proposing one here would invite them to undo their own ratification. A PR listed in BOTH `non_shipment_prs` and `shipped[]` is a contradiction the parser rejects (`reason: invalid_non_shipment_prs`), so this skip can never silently drop a recorded shipment from the `--dry-run` stream.

   **Candidate precision.** The `in:title,body` search is deliberately broad-recall for the operator, but only PRs whose **title** carries the `Plan-NNN` token (case-insensitive, matching GitHub search semantics) enter entry synthesis by default — body-only matches print informational `skipped (no title token)` lines on `stderr`. The filter runs on a title-only probe (`gh pr view <N> --json title`) **before** the full per-PR fetch, so a body-only PR whose file list will not reconcile cannot trip the exit-7 halt on its way to being skipped. This mirrors preflight Gate 6's title-only population: lane-2 enhancement PRs (CONTRIBUTING.md §How Code Lands) carry `Refs: Plan-NNN` in the body by design, and synthesizing entries from them would fabricate `shipped[]` state that makes Gate 3 silently skip unshipped tasks. The token test is the `hasPlanTitleToken` predicate **imported from `preflight.mjs`**, not a local copy — the two tools must agree on the population or they deadlock, which they did on 2026-08-15 when Gate 6 halted naming a PR this tool refused to emit an entry for (see `preflight.mjs` §`hasPlanTitleToken` for the incident and the full sync contract). Two rescue paths keep real shipments in: a body-only PR **already recorded in the plan's manifest** has its on-disk entry **reused verbatim** — never re-synthesized, since legacy squash text often has no parseable markers and synthesis would degrade a known-good entry to phase 0 / empty task — and `--include-body-matches` admits the remaining body-only matches for fresh pre-mandate backfills under explicit operator confirmation (unparseable ones surface as the commented operator-confirmation block rather than exit 5).

4. **Parse heuristics.** `parsePhaseFromPr` and `parseTaskFromPr` extract the phase number and task ID(s) from title/body (title wins). Recognized shapes:
   - **Phase:** `Phase N`, `phase N`, `PN`, `PN.M` (`P5.1` → phase 5).
   - **Task:** `T-NNN-N-N` / `T-NNNp-N-N` (audit-runbook style, plan id inline — always safe to capture); `TN.M` (Plan-001 phase-task style — does NOT carry the plan id, so capture is gated by a same-text Plan-${plan} reference; texts with no Plan-NNN ref or with mixed Plan-NNN refs surface as ambiguity for operator confirmation rather than auto-mapping). The cross-plan defense blocks citations like "see Plan-001 T5.1 for context" in a Plan-024 PR from leaking into Plan-024's manifest (the Codex P2 finding on PR #35).
5. **Build entries.** Each PR produces a manifest-entry candidate with `phase`, `task`, `pr`, `sha` (7-char abbrev), `merged_at` (`YYYY-MM-DD`), `files` (sorted), and a `notes` block citing the PR + listing any auto-detected ambiguities (missing phase, missing task ID, missing SHA, missing date).
6. **Validate.** Each candidate runs through `validateEntry` from `lib/manifest.mjs`. On failures: halt with exit 5 unless `--force` is set.
7. **Emit or write.**
   - `--dry-run`: print the YAML block (`manifest_schema_version: 1` + any parsed `non_shipment_prs: [...]` + `shipped: [...]`) to `stdout`, followed by commented blocks for `--force`-skipped validation failures and (under `--include-body-matches`) unparseable operator-confirmation candidates. Diagnostics stream to `stderr`, keeping stdout parseable. The `non_shipment_prs` round-trip is load-bearing: dropping the key while pasting the stream back would silently re-arm every Gate 6 halt it suppresses. The emitted YAML carries no comments, so re-add the ratification rationale comment by hand when replacing a whole block.
   - default: read the plan file, apply `appendManifestEntry` per validated entry (idempotent — repeated calls with the same PR are no-ops), write back. Reused entries are exempt from the exit-4 collision halt (they collide with themselves by construction); operator-confirmation candidates are never written.

## Heuristic limits + operator confirmation

The script intentionally surfaces ambiguity rather than guessing:

- **Phase or task missing from title/body.** The `notes` field records the gap (`"Operator confirmed: phase not in title/body; no task-id in title/body — phase-level entry."`). Operator MUST review before committing.
- **Multi-task PRs.** When two or more distinct task IDs appear, the entry uses array form (Plan-007 PR #19's `task: [T-007p-3-1, T-007p-3-2, T-007p-3-4]` shape).
- **Missing merge SHA.** A PR queued and later reverted may have null `mergeCommit` — that entry fails `validateEntry` (exit 5 without `--force`).
- **Body-only candidates under `--include-body-matches`.** Validation failures on these never exit 5 — they emit as the commented `# Operator confirmation needed` block in dry-run output, one entry per candidate with its `^ unresolved:` field list, for the operator to hand-edit and move into `shipped[]`.
- **Unreconcilable file lists under `--include-body-matches`.** A body-only candidate whose file list does not reconcile — past the endpoint's 3000-file ceiling, or a walk that came back short — does NOT exit 7, so one such PR cannot abort a whole backfill: the candidate rebuilds from a files-free fetch with `files: []` and is unconditionally routed to the operator-confirmation block, its `^ unresolved:` line naming the mismatch. The default (tokened) path keeps the exit-7 halt.

## Plan Invariant I-3 boundary

`post-merge-housekeeper.mjs` is mechanically constrained to import only `node:fs`/`path`/`process` (asserted by an `I-3 invariant` test in `__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs`). This rebuild script is excluded from that invariant by design — it lives in the same directory but has no shared callers, so its `child_process` import doesn't poison the housekeeper's no-git contract.

## Cross-validation pattern (manifest backfill)

The Plan-001 + Plan-007 backfill workflow:

1. Hand-curate manifest entries inline in the plan file (operator-controlled).
2. Run `node rebuild-shipment-manifest.mjs --plan 001 --dry-run` and compare against the hand-curated entries.
3. Discrepancies indicate either (a) a script heuristic gap (parser misses a phase/task pattern) or (b) an operator-confirmation field that the script auto-derived correctly. Resolve in favor of script output unless the operator has independent grounds.

This is the pattern used to validate the Plan-001/Plan-007 backfill's hand-curated entries against this script's `--dry-run` output.
