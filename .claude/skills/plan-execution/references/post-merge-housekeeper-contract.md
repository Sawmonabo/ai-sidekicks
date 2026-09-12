# post-merge-housekeeper Contract

`scripts/post-merge-housekeeper.mjs` runs in Phase E after the feature PR squash-merges. It proposes the plan's own `### Shipment Manifest` YAML entry for that PR and writes it into a JSON manifest; the orchestrator enriches the proposal with the DAG's audit-derived fields and performs the plan-file write. The script edits no document and shells out to nothing.

## Manifest schema

Written to `.agents/tmp/housekeeper-manifest-PR<N>.json`:

```json
{
  "generated_at": "2026-05-03T00:00:00Z",
  "pr_number": 30,
  "plan": "024",
  "phase": "1",
  "task_id": "T-022-1-1",
  "script_exit_code": 0,
  "proposed_manifest_entry": {
    "phase": 1,
    "task": "T-022-1-1",
    "pr": 30,
    "sha": "abc1234",
    "merged_at": "2026-05-03",
    "files": ["packages/runtime-daemon/src/index.ts"],
    "verifies_invariant": [],
    "spec_coverage": []
  }
}
```

## Proposed shipment-manifest entry

`proposed_manifest_entry` is the script's draft of the `### Shipment Manifest` YAML entry the orchestrator appends to the plan body. The schema mirrors the `lib/manifest.mjs` validator (`MANIFEST_SCHEMA_VERSION = 1`):

| Field | Source | Notes |
| --- | --- | --- |
| `phase` | `--phase` flag (script) | Coerced to integer; a non-numeric phase (Tier-A style) makes the script return `proposed_manifest_entry: null`. |
| `task` | `--task` flag (script) | String form; legacy multi-task PRs use array form (Plan-006 PR #19). |
| `pr` | positional `<PR#>` (script) | Integer. |
| `sha` | `--squash-sha` flag (orchestrator-supplied) | Abbreviated hex (7+ chars). Source: `git rev-parse --short HEAD` in Phase D.5 step 5. |
| `merged_at` | `--merged-at` flag (orchestrator-supplied) | ISO date `YYYY-MM-DD`. Source: `gh pr view <PR#> --json mergedAt -q .mergedAt \| cut -dT -f1`. |
| `files` | `--touched-files-path` file contents (orchestrator-supplied) | Array; defaults to `[]` when the caller didn't supply one. |
| `verifies_invariant` | Always `[]` at script stage | Audit-derived; the orchestrator merges in the DAG-task value via `enrichEntryWithDag` (lib/housekeeper-orchestrator-helpers.mjs). |
| `spec_coverage` | Always `[]` at script stage | Same — DAG-task merge at manifest-append time. |

**Graceful degradation.** If the orchestrator omits `--squash-sha` or `--merged-at`, or the run carries no plan / phase / task identity, the script emits `proposed_manifest_entry: null` rather than a partial entry. The orchestrator's `extractProposedEntry` helper returns null in that case, and the manifest-append step halts with a configuration gap surfaced to the user — never a silent no-op manifest write.

**Ownership boundary.** The script does NOT touch the plan file's `### Shipment Manifest` block (no git imports, no plan-file writes — pinned by the `I-3 invariant` test in `__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs`). The script proposes; the orchestrator enriches and writes via `appendManifestEntry` from `scripts/lib/manifest.mjs`.

**Idempotency.** `appendManifestEntry` is keyed on the `pr` field — re-running the append with the same proposed entry is a no-op (per `__tests__/manifest.test.mjs § appendManifestEntry: idempotency on pr`).

## Exit codes

```
Exit codes:  0  success — manifest written
             ≥6 crash / IO error / arg-validation failure
```

**Proceed / halt routing.** The mapping is encoded in `lib/housekeeper-orchestrator-helpers.mjs` → `decideHousekeeperRouting({ scriptExitCode })` and pinned by unit tests in `scripts/__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs`. Phase E calls the helper and switches on the returned `action`:

| Exit | `action` | `exitClass` | Rationale |
| --- | --- | --- | --- |
| 0 | `proceed` | — | success — continue to the manifest-entry append |
| ≥6 | `halt` | `script-crash` | crash / IO / arg-validation — operator inspects stderr |
| (other) | `halt` | `unknown-exit-code` | defensive fallback — default-deny posture |

**Why a helper, not prose.** Encoding the mapping in a tested helper rather than re-deriving it from prose each Phase E run prevents prose-to-runtime drift, and makes future audit scripts delegate to the same source.

## Recovery diagnostic

If a session ends or the orchestrator crashes mid-pipeline, recovery on the next invocation walks **git first, manifest second**:

```
Resume diagnostic (run on Phase E re-entry):

1. Is the housekeeping commit present?
   git log --oneline -1 --grep="^chore(repo): housekeeping for PR #<N>"
   ├── YES + pushed: skip to "merge if not merged"
   ├── YES + unpushed: skip to "git push"
   └── NO: continue to step 2

2. Is the manifest present at .agents/tmp/housekeeper-manifest-PR<N>.json?
   ├── NO: re-run the script (idempotent — overwrites the prior manifest)
   └── YES: route per decideHousekeeperRouting on script_exit_code (0 proceeds,
            non-zero halts), then append the shipment-manifest entry
```

The script is **idempotent on its own output** — re-running it with the same flags overwrites the manifest with the same content.

## Housekeeping commit landing

The orchestrator lands the housekeeping commit via its own gated squash-merge PR — never via direct push to `develop`. This preserves the SKILL.md § Hard rules → "Invocation as durable authorization" rule ("Direct push to `develop` or `main` outside the PR-merge mechanism is NOT authorized — squash-merge through PR is the only authorized landing path") end-to-end and gives the housekeeping diff the same CI gate (lychee + docs-corpus + lint) that feature PRs receive.

**Branch naming.** `housekeeping/PR<N>` where `<N>` is the merged feature-PR number. Strict format — the orchestrator's Phase E hard-codes this shape and downstream tooling (resume diagnostic; future audit scripts) keys off it.

**PR title.** Identical to the housekeeping commit subject:

```
chore(repo): housekeeping for PR #<N>
```

**PR body.** Auto-generated stub:

```
Auto-generated by /plan-execution Phase E for PR #<N>.
```

**Merge mechanics.** Auto-merge is DISABLED on this repository — `gh pr merge --auto` fails with `Auto merge is not allowed for this repository (enablePullRequestAutoMerge)` (verified PR #119). The orchestrator instead waits for required checks (`gh pr checks <housekeeping-pr#> --watch --interval 10`), then polls `gh pr view <housekeeping-pr#> --json mergeStateStatus,headRefOid` until `mergeStateStatus` reads `CLEAN` (required checks `ci-gate` + `docs-corpus-gate` green + zero unresolved threads under `required_conversation_resolution`), and merges the head that same poll observed: `gh pr merge <housekeeping-pr#> --squash --delete-branch --match-head-commit <headRefOid>`. Executable form: SKILL.md § Phase E — Post-merge housekeeping. Typical wall-clock: 2-3 min on a doc-only diff.

Both fields come out of ONE `gh pr view` call, and the sha pin is not optional. `CLEAN` is a claim about a moment, not about a commit: read at poll time it says nothing about what HEAD is at merge time, so a push landing in that window lands an unchecked housekeeping HEAD on `develop`. `--match-head-commit` makes GitHub refuse that merge outright instead of relying on the orchestrator to notice. Fetching the sha in a second call reopens the very window the flag exists to close — pin the `headRefOid` the CLEAN read returned, never a freshly-read HEAD. A rejected pin is the guard working, not a flake: the branch moved mid-poll, so re-poll rather than re-fire.

**CI failure on housekeeping PR.** Halt Phase E and surface to the user. Phase E does NOT auto-fix housekeeping CI failures — they almost always mean a `### Shipment Manifest` entry whose YAML broke the manifest schema parser or whose embedded fields broke a docs-corpus invariant, and that needs user adjudication.
