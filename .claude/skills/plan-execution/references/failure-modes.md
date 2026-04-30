# Failure Modes

Subagent exit-state taxonomy and routing rules. Four observed exit states; each subagent ends its response with `RESULT: <STATE>` on its own line.

## DONE

The subagent completed the task as briefed.

- Implementer / contract-author: all `target_paths` written; tests pass for the target package; no blocking concerns.
- Reviewer: no POLISH or ACTIONABLE findings (VERIFICATION narrative may be present, but VERIFICATION is reasoning, not a finding — see § Findings Discipline below).
- Plan-analyst: DAG validates against all rules.

**Verify before trusting.** A `DONE` tag without a corresponding diff (implementer) or finding-list assessment (reviewer) is a hallucination — re-dispatch with the contract restated.

## DONE_WITH_CONCERNS

The subagent completed but flagged concerns. Routing depends on which role surfaced the concerns:

| Role | What it means | Routing |
| --- | --- | --- |
| **Plan-analyst** | DAG validates but analyst flagged ambiguities resolved in-DAG | Read concerns; proceed with DAG; carry concerns to PR body Review Notes |
| **Contract-author / Implementer** | "I shipped, but I want to flag X" — implementer's own caveats | Continue to per-task reviewers; carry concerns into PR body Review Notes |
| **Reviewer (any of the 3)** | Findings exist with severity labels | Route per the Findings Discipline section in SKILL.md |

## NEEDS_CONTEXT

The subagent has a question requiring information not in their brief.

**Examples:**

- Plan-analyst: "Plan PR #4 lists `session_directory_service.ts` but doesn't say whether `joinSession` is idempotent. The spec is silent. Need user input."
- Implementer: "Plan says to use `pnpm@9` but `package.json` declares `pnpm@8.15`. Which is canonical?"
- Spec-reviewer: "Plan and Spec-NNN disagree on field X — plan says `string`, spec says `string | null`. Source of truth?"
- Code-quality-reviewer: "Helper looks duplicated in two files. Intentional (different concerns) or accidental?"
- Code-reviewer: "Function returns `null` on empty input — contracted behavior, or should it throw?"

**Routing options for the orchestrator:**

1. **Answer in-context and re-dispatch.** If you can answer from your own context (the plan, the spec, prior sessions, the conversation), re-prompt the subagent with the answer appended.
2. **Surface to the user.** If you don't know, ask. State the subagent's question precisely; do not paraphrase. Wait for the user before re-dispatching.

**Anti-pattern:** Guessing. A guessed answer that's wrong wastes more time than a 30-second clarification.

**User response forms (after surfacing).** When the user replies, the orchestrator ingests one of three forms:

- **In-chat clarification** — short answer in the conversation (e.g., "X is idempotent", "use the V1 surface, not V1.1"). Append the user's exact phrasing to the subagent's brief and re-dispatch the same subagent.
- **Plan / spec / ADR amendment** — the user (or the orchestrator on the user's instruction) edits the governing doc. Re-dispatch the analyst from scratch — the new dispatch reads the amended doc directly. Do NOT also append the in-chat exchange (that double-sources the same answer and confuses precedence).
- **Pointer to existing canonical content** — the user names a doc section the subagent missed (e.g., "see Spec-024 § Idempotency"). Append the pointer + the relevant excerpt to the brief and re-dispatch.

If the user's response is ambiguous (they answer the question but don't say which form they intend), default to in-chat clarification: append their phrasing and re-dispatch. If a downstream NEEDS_CONTEXT surfaces the same gap, that's the signal a doc amendment is needed.

## BLOCKED

The subagent cannot proceed. Strongest negative signal.

**Examples:**

- Plan-analyst: "Plan PR #4 internally contradicts itself — the goal section says X but the implementation steps say Y. Cannot decompose."
- Implementer: "Cannot install `@types/node` — peer-dep conflict. Plan didn't anticipate. Need user input on resolution strategy."
- Spec-reviewer: "Diff implements the V1.1 deferred surface from Spec-024, not the V1 surface the plan section asks for. Critical drift."
- Code-quality-reviewer: "Zero tests for new behavior. Task AC explicitly calls for tests. Unshippable as-is."
- Code-reviewer: "Race condition in connection-pool init — under concurrent load this will deadlock. Reproduces in a 5-line test."

**Routing:**

- Halt the current workflow step.
- Surface to the user immediately. Include:
  - Subagent role + task id (Phase C/D specifies which task; Phase A is plan-level).
  - Exact blocker (quote the subagent).
  - What would unblock (the subagent's own suggestion if given).
  - Your recommendation (continue, abort, change approach).

Do **not** dispatch the next subagent. Do **not** advance to the next DAG level. Do **not** squash-merge. Wait for user direction.

---

## Findings Discipline

**Three labels: VERIFICATION / POLISH / ACTIONABLE.** Reviewers (spec / quality / code) tag every finding with exactly one label. The orchestrator routes them differently. The three-label scheme replaces the prior binary OBSERVATION/ACTIONABLE scheme — see § Why three labels (history) below.

### VERIFICATION — narrative, not a finding

The reviewer is showing their work: tracing the call stack and confirming no race; reading neighboring code and confirming idiom match; reading the cited Spec-NNN row and confirming the diff implements it; reading the I-NNN-M invariant and confirming the diff preserves it.

This is reasoning, not a finding. Reviewers fold VERIFICATION into a `## Verification narrative` section at the top of their report. The orchestrator does NOT re-dispatch the implementer for VERIFICATION; there is nothing to fix.

If a reviewer surfaces VERIFICATION as a numbered/bulleted finding entry (severity stamp + suggested fix), it is mislabeled — almost always a POLISH-or-VERIFICATION confusion. When in doubt, the orchestrator treats it as VERIFICATION and asks the user only if a substantive fix actually surfaces from re-reading.

### POLISH — fix in-PR

Real improvement that does not block correctness or contract: citation drift (an I-NNN-M / Spec-NNN row referenced but undefined / unresolvable), comment that drifted from code, tighter naming, missing JSDoc tag, redundant defensive check, idiom mismatch with neighboring file, a tripwire comment that would prevent a plausible future regression, an under-cited cite traceable via a less-obvious route, a missing one-line test assertion the AC implies but doesn't strictly require.

Routing: re-dispatch the implementer with the consolidated ACTIONABLE+POLISH list (across all three reviewers); implementer addresses each entry; orchestrator re-runs the review pipeline. Loop until the next reviewer pass returns no POLISH or ACTIONABLE.

The PR is the cheapest moment to fix POLISH — context is loaded, mental model is hot. Deferring POLISH to a follow-up PR pays a context-reload cost and risks the polish rotting in the backlog. Under AI-implementer economics (per `feedback_review_label_framework.md`), the round-trip cost is tokens, not human attention; fix-in-PR is the right default.

### ACTIONABLE — round-trip immediately, must fix to merge

The finding cannot ship as-is.

Examples:

- **Spec**: missing required behavior, ADR violation, wrong field shape, missing AC test, citation that names a non-existent ID (citation-discipline violation per `feedback_citations_in_downstream_docs`), invariant cite that doesn't preserve the I-NNN-M property, premature abstraction on `blocked_on` surfaces.
- **Quality**: silent failure, type unsoundness on exported API, test that doesn't exercise behavior, dead code that misleads readers, test fixture that passes-by-accident.
- **Code**: bug, regression, race condition, security boundary violation, edge case the AC implies, resource-lifecycle leak.

Routing: same as POLISH (ACTIONABLE+POLISH consolidated list re-dispatched to the implementer). The distinction between ACTIONABLE and POLISH is signal for the user when the round-trip cap fires — see § Round-trip cap rationale below.

### ACTIONABLE deferral discipline

The default for ACTIONABLE is fix-in-PR. Deferring ACTIONABLE via Path A (file BL-NNN, ship as-is) is permitted only on these grounds — surface and verify each before presenting a defer recommendation to the user:

1. **Scope creep across plan/PR boundary.** The fix requires changes in territory the current PR does not own (e.g., a Phase 3 PR cannot land Phase 5 contract changes). Phase-2-on-a-Phase-3-PR is borderline — surface the trade-off explicitly with file paths, do not silently absorb.
2. **Genuinely tracked.** A BL-NNN with exit criteria, or a separate accepted plan/spec/ADR, already exists today. Cite it by id. An informal `BLOCKED-ON-CN` marker in a file header, a `TODO`/`FIXME` comment, or "future amendment will…" prose does NOT count as tracked — those markers ARE the discipline violation when ACTIONABLE is flagged on a surface guarded only by them.

**Anti-pattern: mismatched-heuristic deferral.** Do not borrow heuristics from abstraction-extraction concerns to justify deferring ACTIONABLE leak/defect/lifecycle-gap fixes:

- **Rule-of-three** governs _extracting helpers from concrete duplication_. It does NOT govern _closing a lifecycle gap on an existing interface_ (e.g., adding `onCancel` to a stream type that already has `next`/`complete`/`cancel` is API completion, not extraction). When a reviewer flags ACTIONABLE on a single-consumer surface, the right question is "is this a defect on an existing surface?" — not "do we have three consumers yet?"
- **Premature-abstraction risk** applies to _new abstractions_. Completing the lifecycle of an interface that already exists does not introduce a new abstraction.
- **Bounded-leak / "not catastrophic"** is a cost description, not a justification. Under AI-implementer economics (per `feedback_review_label_framework.md`), the PR is the cheapest moment to fix; "bounded by X" softens the framing without changing the rule.

When in doubt, present without a recommendation that softens ACTIONABLE. Lead with the concrete cost of fix-in-PR (file paths, scope creep into adjacent phase, test surface) and let the user choose. Recommendations biased toward defer-ACTIONABLE that fail audits 1 and 2 are framework violations.

History: this anti-pattern surfaced on Plan-007 PR #19 Round 6 F5 (2026-04-29). The orchestrator argued rule-of-three to defer an upstream-watcher leak whose fix was actually one optional method on an existing contract. User caught the framing error in one sentence; recant cost was a wasted A/B presentation cycle. See `feedback_actionable_deferral_discipline` memory.

### Why three labels (history)

The earlier project rule was "all findings round-trip regardless of severity." Plan-001 PR #4 demonstrated the failure mode — R5/R6/R9 spiraled on cosmetic feedback (the `feedback_cosmetic_review_spiral` memory). The first fix introduced binary OBSERVATION/ACTIONABLE: ACTIONABLE round-trips, OBSERVATION aggregates to a post-merge polish list.

That binary scheme was copied from human-team review workflows where round-trip cost is human reviewer attention (expensive). Under AI-implementer economics, that calculus does not apply — round-trip cost is tokens, lifetime cost of unfixed cleanliness compounds, the PR is the cheapest moment to fix. Plan-007 PR #19 surfaced the failure mode of the binary scheme: 10 of 11 OBSERVATIONs in the Round-3 review were verification statements (reviewers showing their work, no fix needed), conflated with 1 real polish finding (citation drift) bucketed identically as "skip." See `feedback_review_label_framework.md`.

The three-label scheme separates the two concerns: VERIFICATION is reasoning (no-op), POLISH is fix-in-PR (eliminates the binary's "skip-and-rot" failure mode), ACTIONABLE is unchanged.

If a reviewer returns findings WITHOUT severity labels, that's a contract violation. Re-dispatch with the contract restated. Default ambiguous findings between VERIFICATION and POLISH to VERIFICATION — surfacing "I checked X" as a finding when nothing needs to change is the failure mode that produced the Plan-001 PR #4 cosmetic spiral.

### Round-trip cap rationale

Both Phase C (per-task) and Phase D (PR scope) cap implementer→reviewer round-trips at 3. After the 3rd round, the orchestrator halts and surfaces the consolidated unresolved findings to the user. Why 3 specifically — and why not "until convergence":

- 3 rounds is enough to fix surface bugs and absorb a clarification round on top. If the disagreement persists past round 3, fix-attempts aren't reducing the finding count toward zero — the disagreement is structural (reviewer and implementer have divergent specs) and another round is unlikely to converge it.
- "Continue until convergence" is the v1 rule that produced the Plan-001 PR #4 cosmetic spiral (R1→R9). Surfacing forces the human decision the structural disagreement actually requires (ship the residual ACTIONABLE/POLISH as-is, manual intervention on the diff, or abort) instead of grinding through more rounds with the same priors.
- The cap is the structural backstop the three-label discipline was designed for. The label scheme reduces the rate of cosmetic round-trips (VERIFICATION is no-op; POLISH is bounded fixable surface); the cap bounds the worst case when the discipline didn't suffice.

User decision menu when the cap fires: ship as-is (POLISH or ACTIONABLE residual lands as a follow-up PR), manual fix on the diff, or abort the task / PR. The orchestrator does not auto-pick — the choice is the user's. The ACTIONABLE-vs-POLISH distinction in the residual list is the signal for what's at stake: residual ACTIONABLE means a real merge-blocker the user must adjudicate; residual POLISH means cleanliness deferred (which is the binary scheme's failure mode the framework was meant to prevent — surface it as a known cost, not a new normal).

---

## Routing Rules (precedence top → bottom)

These rules apply in order. The first matching rule wins. Rule numbers are global across phases — rule 9 and rule 14 are referenced by number from SKILL.md and from this file's caps discussion. The markdownlint disable below preserves that convention; restarting at 1 after each heading would break the cross-references.

<!-- markdownlint-disable MD029 -->

### Phase A — Plan analyst

1. **Plan-analyst `BLOCKED`** → halt; surface to user with the contradiction.
2. **Plan-analyst `NEEDS_CONTEXT`** → halt; surface gaps to user (do NOT auto-fill — see CLAUDE.md doc-first discipline).
3. **Plan-analyst `DONE` or `DONE_WITH_CONCERNS`** → validate the DAG against the rules in SKILL.md Phase A. If validation fails, re-dispatch the analyst with the specific failures. If validates, write DAG to PR body and proceed to Phase B.

### Phase B / C — Per-task implementer + reviewer pipeline

4. **Contract-author / Implementer `BLOCKED`** → graceful drain (let any in-flight worktree-mode peers finish); halt; surface to user. Reviewers are NOT dispatched for the BLOCKED task.
5. **Contract-author / Implementer `NEEDS_CONTEXT`** → resolve the question (answer in-context or surface to user); re-dispatch the same subagent with the answer appended.
6. **Contract-author / Implementer `DONE` or `DONE_WITH_CONCERNS`** → dispatch all 3 reviewers in parallel for this task. Implementer's own concerns are carried forward into the PR body Review Notes, NOT back into the implementer.
7. **Any reviewer `BLOCKED`** → halt; surface to user with the reviewer's findings + the diff. User decides: re-dispatch implementer with findings, abort the task, change approach.
8. **Any reviewer `NEEDS_CONTEXT`** → resolve the question; re-dispatch only the asking reviewer.
9. **Any reviewer `DONE_WITH_CONCERNS` (POLISH and/or ACTIONABLE findings)** → consolidate POLISH+ACTIONABLE findings across all 3 reviewers; re-dispatch the implementer with the consolidated list; re-dispatch all 3 reviewers after the implementer's fix is staged. **Cap: 3 round-trips per task** ([rationale above](#round-trip-cap-rationale)). After the 3rd round, halt the task, surface the consolidated unresolved findings + the implementer's most recent diff to the user, and wait for direction (ship as-is — residual POLISH/ACTIONABLE lands in a follow-up PR, exception not norm; manual fix; or abort the task). The ACTIONABLE-vs-POLISH distinction in the residual list is the user signal for what's at stake.
10. **All 3 reviewers `DONE`** (no POLISH or ACTIONABLE findings; VERIFICATION narrative may be present in their reports but is not a finding) → orchestrator commits the task to the PR branch (sequential mode) or marks the task done in DAG (worktree mode); advance to the next task at this level. VERIFICATION narrative stays in the reviewer's report; do NOT hoist it into the PR body Review Notes.

### Phase B level boundary

11. **All tasks at the level returned `DONE`** → if more levels remain, advance to next level. If this was the last level, advance to Phase D.
12. **Any task at the level halted with `BLOCKED`** → after graceful drain finishes, halt the orchestrator and surface the consolidated result-set (DONE + DONE_WITH_CONCERNS + BLOCKED tasks) to user.

### Phase D — Final review pipeline

13. **All 3 final reviewers `DONE`** (no POLISH or ACTIONABLE findings; VERIFICATION narrative may be present but is not a finding) → advance to Phase E (Progress Log + CI + squash-merge).
14. **Any final reviewer `DONE_WITH_CONCERNS` (POLISH and/or ACTIONABLE findings)** → re-dispatch the implementer of the last-touching task with the consolidated POLISH+ACTIONABLE list; re-dispatch all 3 final reviewers after the fix is committed. **Cap: 3 round-trips at PR scope** ([rationale above](#round-trip-cap-rationale)). After the 3rd round, halt and surface to the user (ship as-is — residual POLISH/ACTIONABLE lands in a follow-up PR, exception not norm; manual intervention on the diff; or abort the PR).
15. **Any final reviewer `BLOCKED`** → halt; surface to user with findings.
16. **Any final reviewer `NEEDS_CONTEXT`** → resolve; re-dispatch only the asking reviewer.

### Phase E — CI

17. **CI green** → squash-merge.
18. **CI red on lint/format/test** → dispatch a one-task implementer to fix; run a per-task review pipeline on that fix; mark PR ready and re-watch CI.
19. **CI red on infrastructure issue (GitHub Actions outage, unrelated environment failure)** → halt; surface to user.

<!-- markdownlint-enable MD029 -->

---

## Graceful Drain Protocol (Worktree Mode)

When a worktree-mode task at a level returns `BLOCKED` while peer tasks are still running, the orchestrator does NOT abort the peers (LLM subagents have no abort signal — they finish whenever they finish anyway). Instead:

1. Note the BLOCKED task internally; do not dispatch its reviewers.
2. Wait for all peer tasks to return their `RESULT:`.
3. Collect all results (DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT) for the level.
4. For peer tasks that returned DONE/DONE_WITH_CONCERNS, you MAY proceed to dispatch their per-task reviewer pipelines if the level's BLOCKED task is independent (no `depends_on` from peers to the BLOCKED task). This salvages peer work.
5. If peer reviewer pipelines clear, commit those tasks to the PR branch (merge their task branches). Their work is preserved.
6. Halt the orchestrator at the level boundary; surface the BLOCKED task and the consolidated peer results to the user.

The user then decides:

- Provide context to unblock and re-dispatch the BLOCKED task's implementer.
- Abort the level (revert merged peer commits if they make no sense without the BLOCKED task's work).
- Re-decompose the DAG (re-dispatch plan-analyst with the new constraint).

Sequential mode never has this problem (only one task in flight at a time).

---

## Reading subagent responses

The `RESULT:` tag is at the **end** of the response. Everything before it is the report — read it first to understand the _why_ behind the tag.

**Tag missing.** Treat as `NEEDS_CONTEXT` — they didn't follow the contract. Re-prompt with the contract restated.

**Tag contradicts body.** Body says "tests didn't pass" but tag says `RESULT: DONE`. Trust the body. Re-dispatch with a note that the tag must match the actual outcome.

**Tag matches body but body is thin.** E.g., reviewer says `RESULT: DONE` with one sentence "looks good." Re-dispatch — they didn't actually review. Real `DONE` from a reviewer should reference at least which files they read and which checks they ran.

**Subagent ran git.** Check the implementer/contract-author report for `git commit` / `git push` / `git branch` mentions. If present, contract violation. Recover by:

1. `git status` and `git log -1` to see the stray commit; `git log @{u}..HEAD` (and `git log HEAD..@{u}`) to determine whether it was already pushed.
2. If a stray commit that was NOT pushed: `git reset HEAD~1 --soft` recovers the diff to staged state.
3. If the commit WAS pushed: `git reset HEAD~1 --soft` locally, then `git push --force-with-lease` to overwrite the remote PR branch. Force-push is acceptable on a PR branch the orchestrator owns; it is NEVER acceptable on `develop` or `main`. `--force-with-lease` (rather than `--force`) aborts safely if a collaborator pushed to the same branch between the subagent's push and yours.
4. Re-dispatch the subagent with the contract restated; discard their suggested commit message and re-derive it from the recovered diff.

---

## When to amend this file

If a fifth exit state appears (e.g., `INCONCLUSIVE` — subagent genuinely can't tell whether they succeeded), or if the VERIFICATION/POLISH/ACTIONABLE discipline produces unproductive iteration spirals on real PRs, edit this file. Don't let new modes accumulate as ad-hoc handling — name them, document them, route them explicitly.
