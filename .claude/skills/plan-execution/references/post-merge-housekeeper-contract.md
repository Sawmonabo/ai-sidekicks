# post-merge-housekeeper Contract

The plan-execution housekeeper subagent and its companion script (`scripts/post-merge-housekeeper.mjs`) implement Phase E's auto-housekeeping per Spec [docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md](../../../../docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md).

## Manifest schema

```json
{
  "generated_at": "2026-05-03T14:32:11Z",
  "pr_number": 30,
  "plan": "024",
  "phase": "1",
  "task_id": null,
  "script_exit_code": 0,

  "// — written by script —": "",
  "matched_entry": {
    "ns_id": "NS-01",
    "heading": "### NS-01: Plan-024 Phase 1 — Rust crate scaffolding",
    "shape": "single-pr",
    "file": "docs/architecture/cross-plan-dependencies.md",
    "heading_line": 342
  },
  "mechanical_edits": {
    "status_flip": {
      "ns_id": "NS-01",
      "from_line": "- Status: `todo`",
      "to_line": "- Status: `completed` (resolved 2026-05-03 via PR #30 — <TODO subagent prose>)",
      "computed_via": "single-pr direct flip"
    },
    "prs_block_ticks": [],
    "mermaid_class_swap": {
      "ns_id": "NS-01",
      "from": ":::ready",
      "to": ":::completed",
      "node_line": 285
    },
    "plan_checklist_ticks": [
      { "file": "docs/plans/024-rust-pty-sidecar.md", "phase": "1", "items_ticked": 5 }
    ]
  },
  "schema_violations": [],
  "verification_failures": [],
  "affected_files": [
    "docs/architecture/cross-plan-dependencies.md",
    "docs/plans/024-rust-pty-sidecar.md"
  ],
  "semantic_work_pending": [
    "compose_status_completion_prose",
    "ready_set_re_derivation",
    "line_cite_sweep",
    "set_quantifier_reverification",
    "ns_auto_create_evaluation",
    "unannotated_referenced_files_check"
  ],
  "warnings": [],
  "_script_stage": {
    "// IMMUTABLE script-stage snapshot — see §_script_stage immutability —": "",
    "affected_files": [
      "docs/architecture/cross-plan-dependencies.md",
      "docs/plans/024-rust-pty-sidecar.md"
    ],
    "schema_violations": [],
    "verification_failures": [],
    "semantic_work_pending": [
      "compose_status_completion_prose",
      "ready_set_re_derivation",
      "line_cite_sweep",
      "set_quantifier_reverification",
      "ns_auto_create_evaluation",
      "unannotated_referenced_files_check"
    ]
  },

  "// — written by subagent (null/empty until subagent fills) —": "",
  "subagent_completed_at": null,
  "semantic_edits": {},
  "concerns": [],
  "result": null
}
```

For multi-PR shape, `matched_entry.shape` is `"multi-pr"`, `mechanical_edits.status_flip.computed_via` is `"prs-matrix recompute"` with the matrix-row that fired, and `mechanical_edits.prs_block_ticks` carries the per-tick details.

Stage 1 (script) writes the file with subagent fields stubbed. Stage 2 (subagent) reads, fills in its fields (including replacing the `<TODO subagent prose>` placeholders in `Status:` lines via direct file edits, then echoing the composed prose into `semantic_edits.completion_prose`), writes back.

## Exit codes

```
Exit codes:  0  success
                   --candidate-ns mode: candidate verified + mechanical edits applied
                   --auto-create  mode: next free NS-NN reserved + manifest stub written
                                        (subagent composes the new entry's body in stage 2)
             1  --candidate-ns NS-XX not found in §6 (orchestrator misdispatch — halt)
             2  candidate verification failed (Type-signature / file-overlap / plan-identity
                   mismatch — halt BLOCKED via subagent surfacing of `verification_failures`)
             3  plan §Done Checklist not found / already fully ticked
             4  candidate is multi-PR shape but `--task <task-id>` arg missing (--candidate-ns mode only)
             5  schema violation: candidate has malformed `PRs:` block / missing required
                   sub-field (--candidate-ns) OR auto-create would duplicate an existing
                   heading title (--auto-create) — subagent dispatched to surface as BLOCKED
             ≥6 crash / IO error / arg-validation failure
```

**Dispatch / halt routing.** The orchestrator does NOT dispatch the housekeeper subagent on every exit code. The mapping is encoded in `lib/housekeeper-orchestrator-helpers.mjs` → `decideHousekeeperRouting({ scriptExitCode })` and pinned by 10 unit tests in `scripts/__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs`. SKILL.md Phase E step 4 calls the helper and switches on the returned `action`:

| Exit | `action` | `exitClass` | Rationale |
| --- | --- | --- | --- |
| 0 | `dispatch` | `subagent-handled` | success — subagent completes semantic work |
| 1 | `halt` | `orchestrator-misdispatch` | NS-XX not in §6 — orchestrator dispatched with bad flags |
| 2 | `dispatch` | `subagent-handled` | verification failed — subagent surfaces `verification_failures` as BLOCKED |
| 3 | `dispatch` | `subagent-handled` | no checklist to tick — semantic work (set-quantifier reverification etc.) still applies |
| 4 | `halt` | `orchestrator-misdispatch` | multi-PR shape, `--task` arg missing — orchestrator dispatch bug |
| 5 | `dispatch` | `subagent-handled` | schema_violations — subagent surfaces as BLOCKED |
| ≥6 | `halt` | `script-crash` | crash / IO / arg-validation — script-stage failure, operator inspects stderr |
| (other) | `halt` | `unknown-exit-code` | defensive fallback — default-deny posture |

**Why a helper, not prose.** An unconditional dispatch routes a script-stage crash or orchestrator misdispatch into the subagent, where the LLM is forced to interpret a malformed/absent manifest and emit a `RESULT:` tag based on hallucinated state — incorrect routing + wasted round-trips. Encoding the mapping in a tested helper (rather than re-deriving it from prose each Phase E run) prevents the prose-to-runtime drift this bug class exploits, follows the same encoding-in-code pattern the validator's preservation/iteration checks use (move enforcement OUT of prose, INTO validators with unit tests), and makes future audit scripts delegate to the same source.

## Validation invariants

**Validation invariants (orchestrator):**

- After script: `mechanical_edits` populated per `script_exit_code` (exit 1 → `matched_entry` and `status_flip` may be absent; exit 3 → `plan_checklist_ticks` may be empty; exit 5 → `schema_violations` non-empty + edits aborted). `semantic_work_pending` non-empty. `result === null`.
- After subagent: `result !== null`. Every item in `semantic_work_pending` appears in EITHER `semantic_edits.<item-key>` OR `concerns[]` with `addressing: <item-key>` matching the exact pending-item key (waived when `result === "BLOCKED"` or `"NEEDS_CONTEXT"`, since the subagent halted before completing semantic work). Every entry in `schema_violations` appears in `concerns` with matching `kind` (the violation's own kind verbatim — typically `"schema_violation"` for missing-required-field shapes, but the script also emits singletons like `"auto_create_title_seed_underivable"` with no `field`/`ns_id`), plus matching `field` and `ns_id` when the violation carries them, AND `result === "BLOCKED"`. When `verification_failures` is non-empty (script exit-2 halt path — Type-signature / file-overlap / plan-identity mismatch or `multi_pr_task_not_in_block`), `result === "BLOCKED"` (mirrors the schema_violations rule — surfacing alone is insufficient; the BLOCKED state is load-bearing for the orchestrator's halt/routing-path determinism). No `<TODO subagent prose>` placeholders remain in any file under `affected_files`. `affected_files` ⊇ files actually edited (subagent did not sprawl outside declared scope; extensions to `affected_files` are documented in `concerns` with `kind: affected_files_extension`; deletion of a declared file is a contract violation surfaced by the validator's missing-file gap).

If validation fails, orchestrator halts Phase E and surfaces the gap (script-stage failure) OR round-trips to the subagent (subagent-stage failure).

### `_script_stage` immutability

`manifest._script_stage` is the script-embedded immutable snapshot of the four arrays the subagent could otherwise empty to bypass preservation/iteration enforcement: `affected_files`, `schema_violations`, `verification_failures`, `semantic_work_pending`. The script writes this field at script-stage; the validator reads it at subagent-stage as the **A2 design** snapshot source — the orchestrator does NOT need to plumb the four `scriptXXX` params at every callsite for checks #7/#9/#10/#11 to enforce. Per-field precedence: explicit `scriptXXX` param > `manifest._script_stage[field]` > `null` (legacy fallback).

**Subagent contract:** `_script_stage` is **READ-ONLY**. The subagent rewrites the manifest end-to-end but MUST preserve `_script_stage` byte-for-byte — touching it (removing the key, replacing with a non-object, swapping any of the four fields for non-array values) is itself a bypass attempt and surfaces in the validator's gap-collection path as a structural-tampering gap. The structural check fires whenever ANY `scriptXXX` param is null (the validator-relies-on-snapshot path); when ALL four `scriptXXX` are passed (orchestrator-explicit-plumbing), the snapshot source is external and the structural check is skipped.

## Recovery diagnostic

If a session ends or the orchestrator crashes mid-pipeline, recovery on next invocation walks **git first, manifest second**:

```
Resume diagnostic (run on Phase E re-entry):

1. Is the housekeeping commit present?
   git log --oneline -1 --grep="^chore(repo): housekeeping for PR #<N>"
   ├── YES + pushed: skip to "merge if not merged"
   ├── YES + unpushed: skip to "git push"
   └── NO: continue to step 2

2. Is the manifest present at .agents/tmp/housekeeper-manifest-PR<N>.json?
   ├── NO: re-run script (idempotent — overwrites prior manifest)
   └── YES: continue to step 3

3. Read manifest.result:
   ├── null: re-dispatch subagent (manifest is script-only)
   ├── DONE | DONE_WITH_CONCERNS: skip to "Append Progress Log → git add + commit"
   ├── NEEDS_CONTEXT | BLOCKED: surface to user (same as fresh halt)
   └── any other value: treat as malformed, halt
```

The script is **idempotent on its own output**. Re-dispatching the subagent against an existing manifest is safe because the subagent rewrites the manifest entirely from re-reading file state.

## Completion-rule matrix

The script computes the entry's `Status:` from the `PRs:` block deterministically. Status emits use the canonical backticked-atomic-plus-prose format (per NS-12 precedent at line 454):

| `PRs:` block state | Upstream blocked-on cite present? | Computed `Status:` line emitted by script |
| --- | --- | --- |
| Absent (single-PR entry) | n/a (not affected by housekeeper at this layer) | ``- Status: `completed` (resolved YYYY-MM-DD via PR #<N> — <subagent prose>)`` |
| All ticks unchecked | no | `` - Status: `todo` `` |
| All ticks unchecked | yes | `` - Status: `blocked` `` |
| ≥1 checked, ≥1 unchecked | no | ``- Status: `in_progress` (last shipped: PR #<N>, YYYY-MM-DD)`` |
| ≥1 checked, ≥1 unchecked | yes | ``- Status: `blocked` (overrides — see Upstream: blocked even after partial PRs landed)`` |
| All ticks checked | n/a | ``- Status: `completed` (resolved YYYY-MM-DD via PR #<N> — last sub-task; <subagent prose>)`` |

The matrix is exhaustive and total. The script never needs to interpret prose to choose a `Status:` atomic value or framing. The completion rule is exercised by Layer 1 fixture tests (§8.1) — every cell of the matrix gets a fixture.

**Script vs subagent split for the prose annotation.** The script emits the atomic + structural prose (date, PR#, last-shipped reference). The `<subagent prose>` slot is filled in by the subagent stage, which has the context (manifest + diff + cross-plan implications) to compose a one-line resolution narrative matching NS-12's tone. The script writes a placeholder string `<TODO subagent prose>` that the subagent replaces; manifest-stage validation requires the placeholder to be absent before commit.

## File-reference extraction heuristic

Several semantic stages (set-quantifier reverification, line-cite sweep, ready-set re-derivation) need to know which files an NS entry references. There is no structured `Files:` sub-field. The subagent extracts file references from the `References:` and `Summary:` sub-fields using this documented heuristic:

1. **From `References:`:** parse markdown links matching `\[([^\]]+)\]\((\.\./[^)]+\.md)\)(:\d+(-\d+)?)?` to extract relative doc paths and optional line cites. Also parse bare-path tokens matching `[a-zA-Z0-9_./\-]+\.(md|ts|js|mjs|sql|rs|toml|json|ya?ml)(:\d+(,\d+)*(-\d+)?)?` to catch repo-root-relative source-file cites (e.g. `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts:24,35,59` from NS-11).
2. **From `Summary:`:** apply the same bare-path regex AND the directory-path regex from step 2a below. 2a. **Directory-path extraction.** Apply a separate directory-path regex `[a-zA-Z0-9_./\-]+/` (alphanumeric + `_./\-` ending in `/`) to References + Summary. This catches directory references that have no extension (e.g., `packages/runtime-daemon/src/pty/` from NS-05/07 Summary, `apps/desktop/src/renderer/src/session-bootstrap/` from NS-06 Summary, `.github/workflows/` from a hypothetical NS Summary). Directory paths are tagged separately from file paths in the extracted-references set; the file-overlap check (§5.1 step 3) treats them as **prefix-matchers** (any diff-touched file under the directory counts as overlap), where file paths require **exact match**.
3. **Brace-expansion handling.** The corpus uses bash-style brace expansion in path literals — NS-01 Summary (`cross-plan-dependencies.md`:349) contains `packages/sidecar-rust-pty/{Cargo.toml,Cargo.lock,src/{main,framing,protocol,pty_session}.rs,tests/{framing_roundtrip,protocol_roundtrip,spawn_smoke}.rs}` (a single token expanding to 9 paths). When the bare-path regex (or directory regex) matches a token containing `{...,...}`, the subagent expands it via the bash brace-expansion algorithm (recursive comma-split inside outermost braces, Cartesian-product against the surrounding literal) and treats each expanded path as a separate reference. Brace-expansion failures (unbalanced braces, empty alternatives) are surfaced in `concerns` with `kind: brace_expansion_malformed` rather than silently producing wrong paths.
4. **Filesystem resolution filter.** Filter false positives by requiring the path to resolve to a real filesystem entry when checked against the working-copy filesystem (subagent has `Read` + `Glob`). **File paths must resolve to an existing file**; **directory paths must resolve to an existing directory** (trailing `/` is normalized away during the resolve check). Brace-expanded paths are resolved individually. Paths the implementer is creating in this PR exist in the working copy at verify-time because the housekeeper runs on the PR branch with all implementation commits applied (per §6 data flow).
5. **Deduplicate** across both sources; preserve order of first appearance for stable output. File and directory references are deduped within their respective sets.

   **Scoping note: only `References:` and `Summary:` are scanned.** `Upstream:`, `Type:`, `Status:`, `Priority:`, and `Exit Criteria:` sub-fields are NOT extraction sources, even when they happen to contain source-path tokens. Corpus precedent: NS-04's `Upstream:` field at `cross-plan-dependencies.md`:377 names `packages/contracts/src/pty-host.ts` + `packages/runtime-daemon/src/session/spawn-cwd-translator.ts` inline — these are deliberately discarded by the heuristic. Authors who want source paths surfaced for file-overlap MUST place them in `References:` or `Summary:`.

6. **Subagent surfaces unresolvable paths in `concerns`.** If a path matches the regex but doesn't resolve (post-expansion), that's either a typo or a stale cite — both worth a `concerns` entry with `kind: unresolvable_file_reference` (the kind label uses `file_reference` for both files and directories — the distinction is recorded in the entry's `path_kind` field).

## Status format

NS-12 precedent (cross-plan-dependencies.md:454):

> `- Status: \`completed\` (resolved YYYY-MM-DD via PR #<N> — <one-line resolution narrative>)`

The atomic value is backticked (`` `completed` ``); the parenthetical resolution prose is one line, the same shape NS-12 uses inline. The script writes `<TODO subagent prose>` as a placeholder; the subagent replaces it with composed prose matching NS-12 tone.

## Housekeeping commit landing

The orchestrator lands the housekeeping commit via its own auto-merge PR — never via direct push to `develop`. This preserves the SKILL.md hard rule (line 45: "Never push to `develop` or `main` directly") end-to-end and gives the housekeeping diff the same CI gate (lychee + docs-corpus + lint) that feature PRs receive.

**Branch naming.** `housekeeping/PR<N>` where `<N>` is the merged feature-PR number. Strict format — the orchestrator's Phase E step 7 hard-codes this shape and downstream tooling (resume diagnostic; future audit scripts) keys off it.

**PR title.** Identical to the housekeeping commit subject:

```
chore(repo): housekeeping for PR #<N> — NS-XX <flip-or-create>
```

This means the squash-commit subject on `develop` after auto-merge matches what the subagent's manifest suggested — Phase E's commit-message contract holds across both branch-side and develop-side history.

**PR body.** Auto-generated stub with required cross-references:

```
Auto-generated by /plan-execution Phase E for PR #<N>.

Refs: NS-XX (or NS-NN..NS-MM for range entries; comma-list for multi-NS).

<concerns_block — only if subagent returned DONE_WITH_CONCERNS>
```

**Auto-merge mechanics.** `gh pr merge <housekeeping-pr#> --auto --squash --delete-branch` queues the squash-merge to fire when required CI checks return SUCCESS. The orchestrator then polls via `gh pr checks <housekeeping-pr#> --watch --interval 10` until the PR transitions to `merged`. Typical wall-clock: 2-3 min on a doc-only diff.

**CI failure on housekeeping PR.** Halt Phase E and surface to user. Phase E does NOT auto-fix housekeeping CI failures because they almost always indicate one of: (a) a §6-catalog cite that the script-stage `affected_files` superset check missed; (b) a malformed Status: line the subagent composed; (c) a Progress Log entry that broke a docs-corpus invariant. All three cases need user adjudication — the housekeeping subagent has already returned DONE/DONE_WITH_CONCERNS by this point and is not re-dispatchable for CI-driven failures.

## Canonical Subagent Prompt Template

The script's `buildHousekeeperPrompt` helper (in `lib/housekeeper-orchestrator-helpers.mjs`) emits this prompt verbatim to the `plan-execution-housekeeper` subagent at Phase E dispatch time. The Layer 2 snapshot test in `scripts/__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs` (Task 4.8 step 1) pins the script's emitted prompt against this fenced block — drift in either direction fails CI (per Plan §Decisions-Locked D-1: this contract is canonical; the script reproduces it verbatim, with `<manifest-path>` / `PR #<N>` / `exit code: <N>` substituted at render time).

```
You are the plan-execution-housekeeper subagent. Phase E auto-housekeeping for PR #<N> ran with exit code: <N>. Manifest: <manifest-path>.

Your responsibilities (per Spec §5.4 / §6.2):

1. Compose completion-prose — replace every `<TODO subagent prose>` placeholder in the manifest's `mechanical_edits.status_flip.to_line` (and in any `semantic_edits` field the script left stubbed) with one-line resolution narratives matching the NS-12 precedent shape. Use the merged-commit context (PR title, body, file diff) to ground each narrative.

2. Re-derive set-quantifier claims — read ONLY `docs/architecture/cross-plan-dependencies.md` §6 prose paragraphs (the `## 6. Active Next Steps DAG` section's intro/closing prose plus inline narrative between NS entries; per Plan §Decisions-Locked D-2). For any quantifying claim invalidated by the merge (e.g. "ready set shares no files with X" / "all Y are Z" / "no W in the list does Q"), surface the invalidation in `concerns[]` with `kind: "set_quantifier_drift"`.

3. AUTO-CREATE body — if `manifest.auto_create !== null`, compose the new NS entry's body (Type / Status / Priority / Upstream / References / Summary / Exit Criteria sub-fields) per the AUTO-CREATE allocation rules in spec §5.4.

4. Reconcile schema_violations — every entry in `manifest.schema_violations` MUST surface in `manifest.concerns[]` with the violation's own `kind` verbatim (the script emits `"schema_violation"` for `PRs:` block / missing-required-field shapes and singleton kinds like `"auto_create_title_seed_underivable"` for AUTO-CREATE seed failures), plus matching `field` and `ns_id` when the violation carries them. A single generic concern cannot absorb multiple distinct-kind violations. The script halted with exit ≥1 if any are present; the subagent's job is to surface them, not silently fix them.

5. Reconcile semantic_work_pending — every item in `manifest.semantic_work_pending` MUST be paired to either (a) a `semantic_edits.<item-key>` entry containing the composed output, or (b) a `concerns[]` entry whose `addressing` field equals the exact item key verbatim (e.g. `{kind: "deferred_for_followup", addressing: "set_quantifier_reverification"}`). The validator pairs each pending item via this `addressing` key — `kind` is the subagent's choice; only `addressing` is the match key. Exception: when returning `BLOCKED` or `NEEDS_CONTEXT` (subagent halted before completing semantic work), per-item pairing is waived and the validator skips this check.

6. Bound your edits to `manifest.affected_files` — out-of-scope edits trigger an orchestrator round-trip per `references/failure-modes.md` rule 20 (sprawl routing). To justify a scope expansion, add a `concerns` entry `{kind: affected_files_extension, addressing: <reason>}` and extend `affected_files`.

7. Write back the updated manifest (overwrite `<manifest-path>`) plus any direct file edits via the Edit tool.

8. Return one of the four canonical exit-states (per Plan Invariant I-2): DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. No new exit-state.

Hard rules:
- Do NOT introduce new exit-states.
- Do NOT edit files outside `manifest.affected_files`.
- Do NOT leave `<TODO subagent prose>` placeholders intact.
- Do NOT read NS catalog item BODIES; the §6-prose-only constraint applies to the set-quantifier reverification surface (responsibility #2).
- Do NOT confuse design-spec §6 ("Data flow") with `cross-plan-dependencies.md` §6 ("Active Next Steps DAG"); D-2 routes to the latter.
- Do NOT touch `manifest._script_stage`. It is the script-embedded immutable snapshot of the four arrays the validator enforces preservation/iteration on (`affected_files`, `schema_violations`, `verification_failures`, `semantic_work_pending`); when you rewrite the manifest, copy `_script_stage` through verbatim. Removing the key, replacing it with a non-object, or swapping any of its four fields for non-array values is itself a bypass attempt and surfaces in the validator as a structural-tampering gap.
```
