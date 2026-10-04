---
name: plan-execution
description: Build one phase of a docs/plans/NNN plan as one PR — analyst, implementer, one reviewer, Codex check; naming a plan is not a trigger.
---

# plan-execution

Use this when you want a plan phase built as a pull request with a fixed shape. It is one way to work, not the required one. Normal development does not need it: a request that merely names a plan is ordinary work per [CONTRIBUTING.md](../../../CONTRIBUTING.md).

## What a phase PR is

One branch off `develop`, one PR, the phase's tasks as commits, `Plan-NNN Phase N` in the PR title so [`preflight.mjs`](scripts/preflight.mjs) can find it later.

The title token is the only durable record that the phase shipped. A squash merge inherits the PR title as the commit subject, and the subject is what the preflight check reads. Put the token in the title before you open the PR, not after.

## Before dispatch

Run:

```bash
node .claude/skills/plan-execution/scripts/preflight.mjs docs/plans/NNN-*.md <phase>
```

It checks four things (see [`references/preflight.md`](references/preflight.md)). Fix what it names, or decide it does not apply and go on — it is a check that answers four questions the plan file cannot, not a gate.

## Roles ([`references/roles.md`](references/roles.md))

- **plan-analyst** turns the phase section into a task list: task, files, done-when. No YAML, no ids.
- **implementer** builds one task, runs that package's tests, proposes a commit message. Subagents do not run git; the orchestrator commits.
- **code-reviewer** reviews the diff of one task and reports every finding with a severity. The orchestrator fixes every finding, nitpicks included. Trivial or docs-only tasks skip review.

Dispatch one implementer per task. Tasks that touch disjoint files can run in parallel; tasks that share a file run in order.

## Loop

For each task: implement → tests green → review → fix every finding → commit.

After the last task:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Then push and open the PR. If the run was long, one fresh-context reviewer over the whole diff is allowed; three are not.

Commit messages follow the repo convention: `type(scope): subject`, one commit per task, no governance identifiers in product code.

## Codex check ([`references/codex-gate.md`](references/codex-gate.md))

```bash
node .claude/skills/plan-execution/scripts/codex-gate.mjs <pr> --advisory
```

On a `develop` PR this reports the Codex verdict and open threads. Read them; fix every finding; two rounds, then decide. On a `main` PR run it without `--advisory` and merge only on `merge_ok=1`.

## Done when

CI has reported, Codex has been read, the PR is merged by the user (or by you when told), the branch is deleted.
