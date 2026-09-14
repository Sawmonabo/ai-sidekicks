# preflight

`node .claude/skills/plan-execution/scripts/preflight.mjs <docs/plans/NNN-*.md> <phase>` answers four questions the plan file cannot answer about itself. Exit 0 when all four pass, 1 naming the first failure, 2 on a usage error.

## 1. The plan is marked ready

The plan's `**Status**` cell must read `ready`, `approved`, or `completed`. A `draft` plan is one nobody has finished writing, and dispatching it wastes an implementer on a phase whose shape will change. To make it pass: finish the plan and change the status cell, or accept that you are building against a draft and skip the check.

## 2. The phase section exists

There must be a `### Phase <n>` heading in the plan. A phase number with no section usually means a typo in the number, or a phase that was renumbered. To make it pass: use the number the plan actually uses.

## 3. The phase is not already in git history

Commit subjects carry the `Plan-NNN Phase N` token, because a squash merge inherits the PR title. The check reads `git log --format=%s` and matches that token, so a phase that already merged is caught before a second PR is opened for it. Only subjects are searched: a commit body routinely names a plan it does not ship, and searching bodies would report every phase as shipped. To make it pass: pick an unshipped phase, or, if the earlier PR shipped only part of the phase, note that and go on.

## 4. The phase's preconditions shipped

The phase section's `Precondition:` line is scanned for `Plan-MMM Phase K` tokens, and each one must appear in a commit subject by the same rule as check 3. `Precondition: none.` passes. To make it pass: build the named phase first, or edit the precondition line if it names work that is no longer required.

## What it does not do

It does not read the phase's tasks, judge whether the plan is any good, or block anything. It is a check, not a gate: when a failure does not apply to what you are doing, say so and continue.
