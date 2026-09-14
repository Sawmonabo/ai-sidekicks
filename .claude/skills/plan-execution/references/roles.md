# roles

Three subagent contracts. Each is dispatched by the orchestrator, does one job, and returns prose. None of them runs git.

## plan-analyst

**Input:** the plan file and one phase number.

**Output:** a task list. Each task names what to build, the files it touches, and how you know it is done. Prose, not YAML; no task ids, no dependency graph, no acceptance-criteria grammar — if two tasks touch the same file, say so in a sentence.

**Judgment it owns:** how finely to split the phase. A task should be one implementer's worth of work with a test that proves it. Splitting below that buys nothing and costs a dispatch.

## implementer

**Input:** one task from the analyst's list, and the files it names.

**Output:** the code, that package's tests passing, and a proposed commit message in `type(scope): subject` form.

**Rules:** stay inside the task's files. Run the tests for the package you touched, not the whole repo — the orchestrator runs the full suite once at the end. Do not run `git add`, `git commit`, `git push`, or any branch operation; the orchestrator commits, so that one agent owns the history. If the task turns out to be wrong or impossible as written, say so and stop rather than building something adjacent.

## code-reviewer

**Input:** the diff of one task, and the task it was meant to satisfy.

**Output:** every finding with a severity — `high`, `medium`, `low` — and the file and line it is about. No verdict tag, no pass/fail: the orchestrator decides what to fix.

**Scope:** correctness first, then the things the tests cannot see — a case the diff does not handle, a guard that is looser than it reads, a name that means the wrong thing. Skip review entirely for a trivial or docs-only task; a review that reports nothing on a one-line change is a dispatch spent for no information.

## What the orchestrator keeps

Deciding which findings to fix, committing, pushing, opening the PR, reading the Codex output, and deciding when a round of fixing is finished. None of that is delegated.
