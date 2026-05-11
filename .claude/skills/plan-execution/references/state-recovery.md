# State Recovery

Resumption protocol when a Claude session ends mid-PR (compaction, crash, or explicit handoff).

## Why this matters

State lives in three artifacts with strict separation of role:

| Artifact | Role | Durability |
| --- | --- | --- |
| **PR description (YAML DAG block)** | Static decomposition of the PR | Cross-session (lives on origin) |
| **TaskCreate** | Live in-session dispatch state | In-session only |
| **Branch commits** | Built code | Cross-session (lives on origin) |

Canonicality precedence: **branch commits > YAML DAG > TaskCreate > PR description prose**. On resume, branch commits are read first; the DAG tells you what was planned; TaskCreate state is reconstructed from branch + DAG.

Do not assume TaskCreate state survived. Do not trust the PR description prose (outside the YAML DAG block) as authoritative — it can lag the branch.

## Resumption Checklist

When the user says `resume Plan-NNN` or `continue Plan-NNN`, or when you find yourself on a `feat/plan-NNN-*` branch with an open draft PR at session start:

### 1. Read the branch

```bash
git branch --show-current
git log --oneline develop..HEAD
git status --short
git worktree list
```

The current branch tells you which plan + (typically) which PR. The commit log tells you how far implementation progressed. `git status` tells you whether there's uncommitted work — if there is, **decide whether to commit it before proceeding**, do not silently discard. `git worktree list` tells you whether worktree-mode tasks are in flight.

### 2. Read the PR

```bash
gh pr view --json number,title,isDraft,statusCheckRollup,reviews,body
```

Confirm:

- PR exists and matches the branch.
- Draft vs ready (ready means CI is the next gate; draft means we're still implementing or reviewing).
- CI status (green / pending / failed).
- The PR body contains the YAML DAG block (or the `pending-analysis` placeholder, meaning Phase A didn't complete in the prior session).

### 3. Extract the DAG

If the PR body has a populated `## Task DAG` YAML block, parse it. The DAG tells you:

- All planned tasks (`tasks[]`).
- The dispatch order (`levels[]`).
- The dispatch mode per task (`sequential` or `worktree`).
- Which task is which file (`target_paths`).

If the DAG is the `pending-analysis` placeholder, prior session halted before or during Phase A. Resume from Phase A.

### 4. Match commits to tasks

For each commit on the branch (`git log --oneline develop..HEAD`):

- Read the commit message + diff.
- Match the commit's touched files to a DAG task's `target_paths`.
- The commit's existence on the branch means that task is **complete and reviewed** (the orchestrator only commits tasks after their per-task review pipeline cleared).

This gives you the set of `DONE_AND_COMMITTED` tasks. The remaining tasks (in DAG but not yet committed) are pending.

### 5. Identify in-flight worktree tasks

If `git worktree list` shows `.worktrees/<task-id>/` directories, those tasks were in flight when the prior session ended. Inspect each worktree:

```bash
cd .worktrees/<task-id>
git log --oneline ../<PR-branch>..HEAD
git status --short
```

If the worktree has commits and no uncommitted changes, the task's implementer completed but per-task reviewers may not have run. If the worktree has uncommitted changes, the implementer was mid-edit when the session ended — surface to user (don't auto-stash).

### 6. Read TaskList (best effort)

```
TaskList()
```

If the prior session's TaskCreate state survived (rare, but happens when the session compacted rather than ended), it tells you which subagent dispatch was last in flight. If empty, that's fine — the branch + DAG + worktrees tell you the state.

### 7. Re-read the plan section

Read the plan section for this PR (`docs/plans/NNN-*.md` PR #M). Confirm the DAG you extracted in step 3 still matches the plan (no plan amendment since dispatch). If the plan was amended, surface to user — the DAG may need re-analysis.

### 8. Decide the resume point

Match the combined state to a workflow phase:

| State | Resume from |
| --- | --- |
| Branch has only the scaffold commit; PR DAG is `pending-analysis` | Phase A — dispatch plan-analyst |
| Branch has only the scaffold commit; PR DAG is populated | Phase B level 0 — dispatch first task's implementer (or contract-author) |
| Branch has commits matching all tasks in level N; level N+1 not started | Phase B level N+1 — dispatch next-level tasks |
| Branch has commits for some tasks at level N; other tasks at level N pending | Phase B level N — dispatch missing tasks (sequential: continue the level; worktree: check worktrees first) |
| Worktrees exist for level N tasks with commits but no merges into PR branch | Phase C — dispatch per-task reviewer pipelines for the worktree tasks; merge after they clear |
| Worktrees exist with uncommitted changes | **Surface to user.** Implementer was mid-edit; don't auto-stash. |
| All DAG tasks committed; no `### Shipment Manifest` entry for this PR on the plan; PR draft | Phase D — final review pipeline |
| Final review evidence in branch (review-fix commits after Phase D) | Phase D — re-dispatch final reviewers (they round-tripped) |
| Plan body's `### Shipment Manifest` block has an entry for this PR (matching `pr:` field); PR is `ready`, CI pending | Phase E — wait for CI |
| PR is `ready`, CI green, not merged | Phase E — squash-merge |
| Branch deleted, PR merged | Phase F — next PR or done |

If the state doesn't match any row (e.g., merge conflicts, broken history, divergent DAG vs commits), surface to user. Do not auto-resolve.

### 9. Confirm the resume to the user

Report in 1-2 sentences: _"Resuming Plan-NNN PR #M at <phase name> — branch is at <commit SHA short>, <count> of <total> DAG tasks committed, CI is <status>, next action is <action>."_ Then proceed unless the user redirects.

## Edge Cases

### Uncommitted changes on the PR branch (sequential mode)

`git status --short` shows modified files in the PR-branch working directory.

- If they map to a DAG task's `target_paths`, that task's implementer was mid-execution when the session ended. The diff is the implementer's partial output. Surface to user: re-dispatch from scratch (discard partial), or commit + dispatch reviewers (treat partial as complete)?
- If they don't map to any DAG task's `target_paths`, something went off-script. Surface to user.
- Local-only artifacts (`.DS_Store`, editor swap files): leave alone, they're gitignored.

### Uncommitted changes in a worktree

Same as above but the diff lives in `.worktrees/<task-id>/`. Surface to user — don't auto-stash, and don't auto-discard.

### Branch has diverged from `develop`

`git log develop..HEAD` shows commits, but `git log HEAD..develop` also shows commits (merges happened on `develop` since this branch was cut).

- Run `git pull origin develop --rebase` to bring the branch up to date.
- If conflicts arise, surface to user — do not auto-resolve. Conflicts indicate a cross-plan dependency surface that needs human judgment.

### PR is closed but branch exists

Someone (or you in a prior session) closed the PR without merging. Do not silently re-open. Ask the user whether to re-open, retire the branch, or open a fresh PR.

### TaskCreate state contradicts branch state

E.g., TaskList says "T3 implementer DONE" but the branch has no commit matching T3's `target_paths`. Trust the branch. Update TaskCreate to match. Re-dispatch T3.

### DAG in PR body conflicts with branch commits

E.g., DAG says T2 produces `foo.ts` and `bar.ts`, but the commit on the branch matching T2 only contains `foo.ts`. Surface to user — possible scenarios: implementer was BLOCKED mid-task and committed partial; user manually amended the branch; DAG was wrong. Don't auto-reconcile.

### Worktree exists for a task already committed to PR branch

`git worktree list` shows `.worktrees/T3` but a commit matching T3 is already on the PR branch. The worktree was orphaned (orchestrator forgot to clean up). Safe to remove:

```bash
git worktree remove .worktrees/T3
git branch -d <PR-branch>-T3
git push origin --delete <PR-branch>-T3 2>/dev/null  # may fail if remote branch already deleted
```

## What Durable State Means

**Durable across sessions:**

- Git commits on the branch (origin and local in sync).
- Files in the working tree that have been committed.
- The PR (number, title, body — including the YAML DAG block — draft/ready status, reviews, comments).
- Worktrees on local filesystem (lost if local FS is wiped, but recoverable from the task branch on origin).
- This skill file.

**Not durable across sessions:**

- TaskCreate task list.
- Conversation context.
- In-flight subagent dispatches (interrupted subagents don't resume; they're re-dispatched from scratch).
- Anything in `.agents/tmp/` (gitignored, deleted at commit time per AGENTS.md).

> **Note (deferred drift; tracked as BL-109):** the assertion above that `.agents/tmp/` is "deleted at commit time per AGENTS.md" describes intended behavior, NOT what `lefthook.yml` currently enforces — the pre-commit chain has no prune job. Reconciliation (add the lefthook job OR reword this doc) is tracked as [BL-109](../../../../docs/backlog.md#bl-109-reconcile-agentstmp-lifecycle-drift-between-state-recoverymd-and-lefthookyml). Per spec §9.3 this is explicitly out of the housekeeper plan's scope.

- Working-tree changes not yet committed.

When in doubt, commit. A `chore: WIP — implementer in flight` commit is cheap durability insurance and gets squashed at the end anyway. Do NOT use this pattern as a default — it's an emergency-only tool when a session is about to end mid-task.

## Resuming a Phase A Halt (NEEDS_CONTEXT)

If the prior session halted in Phase A with the plan-analyst returning `NEEDS_CONTEXT` and the user provided clarification, on resume:

1. Re-read the user's clarification from conversation history.
2. Confirm the clarification has been folded into the plan body (or note that it's only in conversation context — that's OK; the orchestrator will pass it to the analyst).
3. Re-dispatch the plan-analyst with the original brief plus the user's clarification appended.
4. Validate the new DAG; proceed to Phase B if valid.

If the plan body was amended in response to the clarification, the new analyst dispatch will read the amended plan directly.

## Resuming a Phase E housekeeping halt

Phase E (post-merge housekeeping; see SKILL.md § Phase E) halts when:

- The candidate-lookup over §6 returns 2+ matches → `NEEDS_CONTEXT` halt with both candidates surfaced
- The script's mechanical-stage exits ≥1 (NS not found / verification failed / no checklist / multi-PR no task-id / schema violation / arg validation) → see `references/post-merge-housekeeper-contract.md` § Exit codes
- The subagent returns DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED → routed per `references/failure-modes.md`

Recovery diagnostic — run in this order:

1. **Did the housekeeping commit land?** `git log --oneline -1` on the local `develop` branch — if the latest commit is `chore(repo): housekeeping for PR #<N> — NS-XX ...`, housekeeping completed and Phase E is DONE; resume the next plan-execution from Phase A.
2. **Is the manifest present?** `ls .agents/tmp/housekeeper-manifest-PR<N>.json` (the squash-merge PR number). If absent, the script never wrote it — re-run `node post-merge-housekeeper.mjs` with the same args from the orchestrator's last log entry.
3. **What does `manifest.result` say?** `jq .result .agents/tmp/housekeeper-manifest-PR<N>.json`:
   - `null` → script-stage halt (read `manifest.script_exit_code` + `manifest.schema_violations`)
   - `"DONE"` → housekeeping succeeded; the only remaining work is Phase E step 6-8 (Progress Log + commit + push); finish those manually
   - `"DONE_WITH_CONCERNS"` → read `manifest.concerns`; for each `kind`, follow the routing rule in `references/failure-modes.md`
   - `"NEEDS_CONTEXT"` → read `manifest.concerns[].context_request`; surface to the user; re-dispatch with the requested context
   - `"BLOCKED"` → read `manifest.concerns[].blocker`; cannot proceed; user must decide

### Candidate-lookup rules (verbatim from SKILL.md § Phase E step 1; mirrored here per spec §4.3.5)

The script's `--candidate-ns` mode is dispatched only after orchestrator-side candidate-lookup returns exactly one match. The four heading-only matching rules (no body parsing) are:

- **Rule 1 — Plan + Phase match:** Diff touches `docs/plans/<NNN>-<slug>.md` AND commit message cites `Phase <N>` → match `### NS-NN: Plan-<NNN> Phase <N> — ...` (case-insensitive on "Phase"). The plan-NN and phase-N must both appear in the heading; `Phase 5 Lane A` matches `Phase 5` (lane suffix is a Phase-5 sub-scope).
- **Rule 2 — Plan + task-id match:** Commit message cites `T<phase>.<sub>` (e.g., `T5.1`) or `T-NNN-N-N` (e.g., `T-001-5-1`) → match `### NS-NN: Plan-<NNN> Phase <N> ...` whose `PRs:` block contains a row matching the task-id. Requires reading the `PRs:` block, but only to disambiguate among Phase-matching candidates.
- **Rule 3 — Plan + Tier-K match:** Diff is a plan-readiness audit (matches `docs/plans/<tier-K>-<...>.md` shape) → match `### NS-NN..NS-MM: Tier <K>-<L> plan-readiness audits` via the lower-endpoint `tier-K` form. The task-arg form is `tier-3` (per Plan §Decisions-Locked D-4); range merges always use the lower endpoint, so `tier-3-9` is REJECTED at arg-parse.
- **Rule 4 — No-match fallback:** If rules 1-3 produce zero matches, the orchestrator drops to `--auto-create` (which reserves the next free NS-NN with stub fields). If the orchestrator's intent was to MATCH (not create), surface NEEDS_CONTEXT halt with the rule-1/2/3 attempts so the user can disambiguate.

If a Phase E halt's `manifest.script_exit_code === 1` (no NS match), trace which rule should have matched and why it didn't — typo'd Plan-NN, missing `PRs:` block row, lookup-rule-3 lower-endpoint mismatch, etc. The fixture `11-tier-range-audit` (Plan §Decisions-Locked D-7 row 11) is the canonical rule-3 test case to consult for shape comparison.

Full contract: [`post-merge-housekeeper-contract.md`](post-merge-housekeeper-contract.md).
