# Failure Modes

Subagent exit-state taxonomy and routing rules. Per ADR-024, four modes are observed in practice; this file defines each and how the parent skill responds.

Subagents end their response with `RESULT: <MODE>` on its own line. The parent (this skill) parses that line and routes accordingly.

## DONE

The subagent completed the task as briefed. All deliverables are committed (implementer) or all checks passed (reviewer).

**Routing:**
- After implementer DONE → dispatch reviewers (Step 5 of SKILL.md).
- After both reviewers DONE → mark PR ready and watch CI (Step 6).
- After CI green → squash-merge (Step 7).

**Verify before trusting:** Read `git log` (implementer) or the reviewer's report body (reviewer). A `DONE` tag without a corresponding diff or finding list is a hallucination and should be re-dispatched.

## DONE_WITH_CONCERNS

The subagent completed the task but flagged issues that don't block the next step but the human should see.

**Examples:**
- Implementer: "Implemented option A from the plan, but option B may scale better at >10k items. Plan didn't specify the threshold; flagging for review."
- Spec-reviewer: "Diff matches the plan, but the plan's wording on edge case X is ambiguous and could be read two ways. Suggest clarifying the plan in a follow-up."
- Code-quality-reviewer: "Acceptable, but the new helper duplicates a similar helper in `packages/contracts/src/util.ts`. Could dedupe in a future cleanup PR."

**Routing:**
- Continue to the next workflow step (same as `DONE`).
- Carry the concerns forward into the PR body under a "Review notes" section before squash-merge.
- If multiple PRs accumulate concerns about the same area, that's a signal to open a `BL-NNN` backlog item to address them in a dedicated PR.

**Do not** silently drop concerns. Surface them.

## NEEDS_CONTEXT

The subagent has a question that requires information not in their brief.

**Examples:**
- Implementer: "Plan says to use `pnpm@9` but the workspace's existing `package.json` declares `pnpm@8.15`. Which is canonical?"
- Spec-reviewer: "Plan task and Spec-NNN disagree on field X's type — plan says `string`, spec says `string | null`. Which is the source of truth?"
- Code-quality-reviewer: "I see a similar helper duplicated in two files. Is this intentional (different concerns) or accidental (should be deduped)?"

**Routing:**
- The parent skill (you) has two options:
  1. **Answer in-context and re-dispatch.** If you can answer from your own context (the plan, the spec, prior sessions, the conversation), do that — re-prompt the subagent with the answer appended to the original brief.
  2. **Surface to the user.** If you don't know, ask the user. State the subagent's question precisely; do not paraphrase. Wait for the user's answer before re-dispatching.

**Anti-pattern:** Guessing. If you don't have context, ask. A guessed answer that's wrong wastes more time than the user's 30-second clarification.

## BLOCKED

The subagent cannot proceed. This is the strongest negative signal.

**Examples:**
- Implementer: "Cannot install `@types/node` because pnpm reports a peer-dep conflict. The plan didn't anticipate this. Need user input on resolution strategy."
- Spec-reviewer: "Diff implements the wrong feature — it builds the V1.1 deferred surface from Spec-024, not the V1 surface the plan section asks for. This is critical drift."
- Code-quality-reviewer: "The diff has zero tests for new behavior. The plan task explicitly calls for tests. This is unshippable."

**Routing:**
- Halt the current workflow step.
- Surface to the user immediately. Include:
  - The subagent role.
  - The exact blocker.
  - What would unblock (the subagent's own suggestion if they gave one).
  - Your recommendation (continue, abort, change approach).

**Do not** dispatch the next subagent. Do not squash-merge. Wait for user direction.

## How to read the subagent's response

The `RESULT: <MODE>` line is at the *end* of the subagent's response. Everything before it is the report — read it first to understand the *why* behind the tag.

If the subagent omits the tag, treat the response as `NEEDS_CONTEXT` — they didn't follow the contract, so re-prompt with the contract restated.

If the subagent's tag contradicts their report (e.g., body says "I couldn't get the tests to pass" but tag says `RESULT: DONE`), trust the body. Re-dispatch with a note that the tag must match the actual outcome.

## Routing matrix

| Implementer | Spec-Reviewer | Code-Quality-Reviewer | Action |
|-------------|---------------|------------------------|--------|
| DONE | DONE | DONE | Mark PR ready → CI → squash-merge |
| DONE | DONE_WITH_CONCERNS | DONE | Same as above; surface concerns in PR body |
| DONE | DONE | DONE_WITH_CONCERNS | Same as above |
| DONE | BLOCKED | * | Loop to implementer with spec-reviewer findings |
| DONE | * | BLOCKED | Loop to implementer with code-quality findings |
| DONE_WITH_CONCERNS | * | * | Continue; carry implementer concerns forward |
| NEEDS_CONTEXT | — | — | Resolve question, re-dispatch implementer |
| BLOCKED | — | — | Halt, surface to user |

`*` = any mode. `—` = not yet dispatched.

## When to amend this file

If a fifth failure mode appears (e.g., an `INCONCLUSIVE` mode where the subagent genuinely can't tell whether they succeeded), edit this file and ADR-024 in the *same* PR. Don't let a new mode accumulate as ad-hoc handling — name it, document it, and route it explicitly.
