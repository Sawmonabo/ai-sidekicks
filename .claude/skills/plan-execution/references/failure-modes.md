# Failure Modes

Subagent exit-state taxonomy and routing rules. Four observed exit states; each subagent ends its response with `RESULT: <STATE>` on its own line.

## DONE

The subagent completed the task as briefed. All deliverables are committed (implementer) or all checks passed cleanly (reviewer).

**Verify before trusting.** A `DONE` tag without a corresponding diff (implementer) or finding-list assessment (reviewer) is a hallucination — re-dispatch with the contract restated.

## DONE_WITH_CONCERNS

The subagent completed but flagged concerns. Routing depends on which role surfaced the concerns:

| Role                        | What it means                                                                             | Routing                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Implementer**             | "I shipped, but I want to flag X" — implementer's own caveats about their own work        | Continue to reviewers; carry implementer concerns into the PR body under "Review notes" so they're visible at merge time      |
| **Reviewer** (any of the 3) | "The diff has issues that should be addressed" — reviewer findings on someone else's code | Round-trip to implementer with the findings; implementer addresses every item; reviewers re-run after each implementer commit |

This is the project's **all-findings-round-trip rule**: any reviewer finding — regardless of severity, regardless of whether the reviewer called it blocking — must be addressed by the implementer before merge. There is no "informational nit" pass-through. The trade-off is more iteration loops per PR, accepted in exchange for higher merge quality.

## NEEDS_CONTEXT

The subagent has a question requiring information not in their brief.

**Examples:**

- Implementer: "Plan says to use `pnpm@9` but `package.json` declares `pnpm@8.15`. Which is canonical?"
- Spec-reviewer: "Plan and Spec-NNN disagree on field X — plan says `string`, spec says `string | null`. Source of truth?"
- Code-quality-reviewer: "Helper looks duplicated in two files. Intentional (different concerns) or accidental (should dedupe)?"
- Code-reviewer: "Function returns `null` on empty input — is that the contracted behavior, or should it throw?"

**Routing options for the orchestrator (you):**

1. **Answer in-context and re-dispatch.** If you can answer from your own context (the plan, the spec, prior sessions, the conversation), re-prompt the subagent with the answer appended to their original brief.
2. **Surface to the user.** If you don't know, ask. State the subagent's question precisely; do not paraphrase. Wait for the user before re-dispatching.

**Anti-pattern:** Guessing. If you don't have context, ask. A guessed answer that's wrong wastes more time than a 30-second clarification.

## BLOCKED

The subagent cannot proceed. Strongest negative signal.

**Examples:**

- Implementer: "Cannot install `@types/node` — peer-dep conflict. Plan didn't anticipate. Need user input on resolution strategy."
- Spec-reviewer: "Diff implements the V1.1 deferred surface from Spec-024, not the V1 surface the plan section asks for. Critical drift."
- Code-quality-reviewer: "Zero tests for new behavior. Plan task explicitly calls for tests. Unshippable as-is."
- Code-reviewer: "Race condition in connection-pool init — under concurrent load this will deadlock. Reproduces in a 5-line test."

**Routing:**

- Halt the current workflow step.
- Surface to the user immediately. Include:
  - Subagent role.
  - Exact blocker (quote the subagent).
  - What would unblock (the subagent's own suggestion if given).
  - Your recommendation (continue, abort, change approach).

Do **not** dispatch the next subagent. Do **not** squash-merge. Wait for user direction.

---

## Routing rules (precedence top → bottom)

These rules apply in order. The first matching rule wins.

1. **Implementer `BLOCKED`** → halt; surface to user. Reviewers are NOT dispatched.
2. **Implementer `NEEDS_CONTEXT`** → resolve the question (answer in-context or surface to user); re-dispatch implementer.
3. **Implementer `DONE` or `DONE_WITH_CONCERNS`** → dispatch all 3 reviewers in parallel. Implementer's own concerns are carried forward into the PR body, not back into the implementer.
4. **Any reviewer `BLOCKED`** → halt; surface to user with the reviewer's findings + the diff. User decides whether to re-dispatch implementer with findings, abort the PR, or change approach.
5. **Any reviewer `NEEDS_CONTEXT`** → resolve the question; re-dispatch only the asking reviewer (others have already returned).
6. **Any reviewer `DONE_WITH_CONCERNS`** → loop back to implementer with the consolidated findings from all reviewers. Implementer addresses every finding; commit; re-dispatch all reviewers.
7. **All 3 reviewers `DONE`** → mark PR ready; wait for CI; squash-merge when CI green.

Note: rule (6) and rule (4) both result in implementer rework. The difference: BLOCKED requires user authorization to continue (the reviewer is asserting the diff is unshippable); DONE_WITH_CONCERNS is the normal review-iteration loop and the orchestrator drives it without user intervention.

## Reading subagent responses

The `RESULT:` tag is at the **end** of the response. Everything before it is the report — read it first to understand the _why_ behind the tag.

**Tag missing.** Treat as `NEEDS_CONTEXT` — they didn't follow the contract. Re-prompt with the contract restated.

**Tag contradicts body.** Body says "tests didn't pass" but tag says `RESULT: DONE`. Trust the body. Re-dispatch with a note that the tag must match the actual outcome.

**Tag matches body but body is thin.** E.g., reviewer says `RESULT: DONE` with one sentence "looks good." Re-dispatch — they didn't actually review. Real `DONE` from a reviewer should reference at least which files they read and which checks they ran.

## When to amend this file

If a fifth exit state appears (e.g., `INCONCLUSIVE` — subagent genuinely can't tell whether they succeeded), or if the all-findings-round-trip rule produces unproductive iteration spirals on real PRs, edit this file and ADR-024 in the _same_ PR. Don't let new modes accumulate as ad-hoc handling — name them, document them, route them explicitly.
