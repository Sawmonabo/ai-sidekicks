# ripple-check failure modes

Operational edge cases the orchestrator may hit. These fire on a minority of invocations; SKILL.md does not inline them so the always-on body stays compact. Read this file when one of the conditions below applies.

<a id="empty-diff"></a>

## Empty diff

`/ripple-check` invoked with no staged or working-tree changes (and no `--target=<rev>` override that produces a non-empty diff).

**Cause.** The author invoked the skill before staging any edits, or all edits were stashed.

**Behavior.** Halt with a one-sentence message: "No diff to audit. Stage your edits (or pass `--target=<rev>` for a branch audit) and re-invoke." Do NOT dispatch any subagents — they would have nothing to look at and would burn parallel cost on an empty input.

## Subagent returns `NEEDS_CONTEXT`

A subagent could not complete because input was insufficient (e.g., `canonical-paths.json` is missing a referenced field, or a referenced file does not exist).

**Behavior.** Surface the subagent's `narrative` verbatim to the author with the catalog row it was assigned. Do NOT silently treat it as `DONE`. Recommend the author resolve the gap (add the registry entry, restore the file) and re-invoke. The other subagents in the same dispatch batch may have returned cleanly — their findings still aggregate; only the `NEEDS_CONTEXT` subagent is reported as incomplete.

## Subagent returns `BLOCKED`

A subagent encountered a corpus convention it cannot disambiguate (e.g., two prior fixes that conflict, an ambiguous canonical form).

**Behavior.** Surface verbatim with the catalog row. The author adjudicates. The skill is non-deterministic and not branch-protected — `BLOCKED` is a stop signal for the author, not for the merge.

<a id="with-fixes-mode-worktree-cleanup"></a>

## With-fixes mode worktree cleanup

The `Agent` tool's `isolation: "worktree"` mode (the substrate for `/ripple-check --with-fixes`) auto-cleans the worktree IF the subagent made no file changes. If the subagent wrote edits, the worktree path and branch are returned in the result and the orchestrator MUST clean them up.

**Procedure for each `--with-fixes` subagent that returned findings:**

1. Inside the worktree, run `git diff` (working tree vs. HEAD) to extract the proposed change as a unified patch.
2. Present the patch to the author.
3. **If approved:** apply to the main checkout via `git apply --whitespace=nowarn <patch>`. Stage the result.
4. **If rejected:** skip the patch. Either way, after handling the patch:

   ```bash
   git worktree remove .worktrees/<task-id>
   git branch -D <worktree-branch>
   ```

   This is safe because the subagent did NOT commit (per the no-`git` contract inlined in each subagent's system prompt at `.claude/agents/ripple-check-<role>.md`; subagent definitions also intentionally omit the `Bash` tool so `git` is mechanically unavailable to them). If `git branch -D` complains the branch isn't merged, that's expected — discard.

<a id="patch-conflict-between-two-with-fixes-subagents"></a>

## Patch conflict between two with-fixes subagents

Two subagents in the same dispatch batch produced patches that touch the same lines.

**Behavior.** Apply the first subagent's patch (the orchestrator's natural ordering: A → B → C → D → E). When the second subagent's patch fails to apply with a conflict:

1. Surface the conflict to the author with both patches inline and the catalog rows that drove each.
2. Let the author choose: (a) merge manually (the author edits the conflicted file, the orchestrator stages the result), (b) drop the second patch, (c) re-dispatch the second subagent with the first patch already applied as input (the orchestrator constructs a fresh `Agent` dispatch with the post-first-patch diff as the new hunks payload in the `prompt` parameter).

Do NOT silently drop a conflicting patch — the second subagent's finding is real and deserves explicit adjudication.

## Static hook fires during Phase 0 step 3

The deterministic doc-corpus runner (`tools/docs-corpus/bin/pre-commit-runner.ts`) or `lychee` reports a violation.

**Behavior.** Catalog the violations as already-known issues. Do NOT dispatch a subagent for the same finding — the static layer is the source of truth for the deterministic 80% and a subagent on the same axis would duplicate effort. Mark those issues resolved-by-hook in the aggregated report; the subagents that DO dispatch are scoped to the residual classes the hooks cannot enforce.

If the static hook itself fails (e.g., `node` is missing, the runner errors), halt with the hook's stderr verbatim. The skill cannot proceed without a reliable deterministic baseline — running subagents on top of an unverified baseline produces noisy findings and pollutes the surface-forward feedback loop.

## Subagent returned a malformed JSON object

The subagent's final message is not parseable as the JSON schema inlined in its system prompt at `.claude/agents/ripple-check-<role>.md`.

**Behavior.** Surface the parse error to the author with the subagent's raw final message. Do NOT attempt to repair the JSON — silently fixing schema drift hides a contract violation. Re-dispatch the subagent ONCE with an explicit "your previous response failed schema validation: <error>; return only the JSON object as the final message" instruction. If the second attempt also fails, halt and surface to author — this is a model regression worth investigating, not a runtime hiccup to paper over.

## Subagent ran `git` despite the contract

The subagent's worktree (in `--with-fixes` mode) shows commits, or `git status` is clean despite the subagent claiming findings.

**Behavior.** Discard the subagent's commits via `git reset --hard HEAD@{1}` (or whichever ref predates its first commit) inside the worktree. Surface to the author that the subagent violated the no-git rule. Re-dispatch ONCE with the contract restated explicitly. If the second attempt also runs `git`, halt — the contract is the load-bearing boundary and must hold for the orchestrator to function.

This is a structural concern, not a stylistic one — the orchestrator's diff-extraction step (`git diff` working tree vs. HEAD) only sees uncommitted changes, so subagent commits are invisible to the apply step. Silent loss of work is the failure mode being prevented.
