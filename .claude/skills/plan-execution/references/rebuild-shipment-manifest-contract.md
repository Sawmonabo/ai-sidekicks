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
| `--dry-run` | Emit the rebuilt YAML to `stdout`; do NOT touch the plan file. Use first to preview before committing changes. |
| `--force` | Skip entries whose `pr` field already exists in the plan's manifest. Without `--force`, the script halts (exit 4) on collision rather than risk silent overwrites. Note: `--force` currently does NOT replace existing entries in-place; it only suppresses the collision halt and proceeds with a no-op `appendManifestEntry` for the colliding PRs. |

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
| 7 | Per-PR file-list truncation — `gh pr view <N> --json files,changedFiles` returned fewer file entries than `changedFiles` reports. `gh pr view` issues a single `pullRequest.files(first: 100)` GraphQL query with no internal pagination, so PRs above the 100-file ceiling silently truncate. The script halts rather than commit a partial `files:` array to the shipment manifest. Long-term fix: migrate `fetchPrDetails` to `gh api` with cursor pagination. AI Sidekicks PRs currently sit well under 100 files. |

## Behavior

1. **Resolve plan file.** `docs/plans/NNN-*.md` (single match required; ambiguous matches halt with exit 3).
2. **Fetch merged PRs.** `gh pr list --state merged --search "Plan-NNN in:title,body" --json number --limit FETCH_LIMIT` (currently 1000). The `in:title,body` qualifier constrains the GitHub search to PR titles and bodies; without it, the default search also matches review comments and discussion threads, so an unrelated merged PR that mentions "Plan-NNN" in passing would land in the result set and produce a wrong-phase/wrong-task entry. When the result hits the ceiling (`length === FETCH_LIMIT`), the script halts with exit 6 — see "Exit codes" — because `gh pr list` truncates silently. Plans currently sit well under 100 matches; 1000 mirrors the original preflight ceiling that the hot-path manifest refactor eliminated, so the cold-path recovery script inherits the same anti-silent-truncation discipline.
3. **Per-PR fetch.** For each PR number, `gh pr view <N> --json title,body,mergedAt,mergeCommit,files`.
4. **Parse heuristics.** `parsePhaseFromPr` and `parseTaskFromPr` extract the phase number and task ID(s) from title/body (title wins). Recognized shapes:
   - **Phase:** `Phase N`, `phase N`, `PN`, `PN.M` (`P5.1` → phase 5).
   - **Task:** `T-NNN-N-N` / `T-NNNp-N-N` (audit-runbook style, plan id inline — always safe to capture); `TN.M` (Plan-001 phase-task style — does NOT carry the plan id, so capture is gated by a same-text Plan-${plan} reference; texts with no Plan-NNN ref or with mixed Plan-NNN refs surface as ambiguity for operator confirmation rather than auto-mapping). The cross-plan defense blocks citations like "see Plan-001 T5.1 for context" in a Plan-024 PR from leaking into Plan-024's manifest (the Codex P2 finding on PR #35).
5. **Build entries.** Each PR produces a manifest-entry candidate with `phase`, `task`, `pr`, `sha` (7-char abbrev), `merged_at` (`YYYY-MM-DD`), `files` (sorted), and a `notes` block citing the PR + listing any auto-detected ambiguities (missing phase, missing task ID, missing SHA, missing date).
6. **Validate.** Each candidate runs through `validateEntry` from `lib/manifest.mjs`. On failures: halt with exit 5 unless `--force` is set.
7. **Emit or write.**
   - `--dry-run`: print the YAML block (`manifest_schema_version: 1` + `shipped: [...]`) to `stdout`.
   - default: read the plan file, apply `appendManifestEntry` per validated entry (idempotent — repeated calls with the same PR are no-ops), write back.

## Heuristic limits + operator confirmation

The script intentionally surfaces ambiguity rather than guessing:

- **Phase or task missing from title/body.** The `notes` field records the gap (`"Operator confirmed: phase not in title/body; no task-id in title/body — phase-level entry."`). Operator MUST review before committing.
- **Multi-task PRs.** When two or more distinct task IDs appear, the entry uses array form (Plan-007 PR #19's `task: [T-007p-3-1, T-007p-3-2, T-007p-3-4]` shape).
- **Missing merge SHA.** A PR queued and later reverted may have null `mergeCommit` — that entry fails `validateEntry` (exit 5 without `--force`).

## Plan Invariant I-3 boundary

`post-merge-housekeeper.mjs` is mechanically constrained to import only `node:fs`/`path`/`process` (asserted by an `I-3 invariant` test in `__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs`). This rebuild script is excluded from that invariant by design — it lives in the same directory but has no shared callers, so its `child_process` import doesn't poison the housekeeper's no-git contract.

## Cross-validation pattern (Commit 5 of cozy-crafting-hummingbird)

The Plan-001 + Plan-007 backfill workflow:

1. Hand-curate manifest entries inline in the plan file (operator-controlled).
2. Run `node rebuild-shipment-manifest.mjs --plan 001 --dry-run` and compare against the hand-curated entries.
3. Discrepancies indicate either (a) a script heuristic gap (parser misses a phase/task pattern) or (b) an operator-confirmation field that the script auto-derived correctly. Resolve in favor of script output unless the operator has independent grounds.

This is the pattern used to validate Commit 5's hand-curated entries against this script's `--dry-run` output.
