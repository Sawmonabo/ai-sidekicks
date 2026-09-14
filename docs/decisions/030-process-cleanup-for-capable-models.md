# ADR-030: Process Cleanup for Capable Models

| Field         | Value                            |
| ------------- | -------------------------------- |
| **Status**    | `accepted`                       |
| **Type**      | `Type 1 (two-way door)`          |
| **Domain**    | Engineering Process, Tooling     |
| **Date**      | 2026-09-14                       |
| **Author(s)** | Sawmon Abo, Claude (AI-assisted) |
| **Reviewers** | Sawmon Abo                       |

> **Type guidance:** this is a two-way door. Every deleted checker sits in git history and can be restored in an afternoon. Sections marked [T2] are skipped.

---

## Context

The process, the checkers, and the instruction files in this repository were built between 2026-04 and 2026-09 for models that needed step lists and machine checks. A model that could not be trusted to notice a stale citation needed a citation parser; a model that would skip a precondition needed a gate that refused to run without one. So the repository grew one.

Measured on 2026-09-14, before this cleanup:

- About 55,800 lines of harness tooling under `.claude/` and `tools/` — `git ls-files '.claude/**' 'tools/**' | xargs wc -l` reported 55,799 — and 54 % of that was tests of the tooling rather than tooling.
- A 24 KB plan template.
- A 27-minute CI run.
- A session preamble of roughly 12,000 tokens before any work began.
- Codex review rounds with no cap.

The tooling was not broken. It was built for a reader that no longer sits at this keyboard, and its cost is paid on every commit by the reader that does.

## Problem Statement

How much of this process still earns its cost, now that the models doing the work read the whole repository and notice what a parser was built to notice?

### Trigger

The harness had grown to the point where the checkers cost more attention than the defects they caught. Nothing failed; the ratio did.

---

## Decision

We will delete the process machinery that exists only to compensate for a model that cannot read, and keep the checks that catch what no reader can see.

**Removed.** Branch protection on `develop` (it stays on `main`). The Shipment Manifest. The readiness gate. The four-state document status. The doc-first rule. The lane taxonomy. The citation grammar and its checkers. The ripple-check and CLAUDE.md-audit skills. The housekeeping PR. The pre-commit type check.

**Kept.** Secret scanning. The worktree occupancy check. The commit lock. The fail-closed test runner. One table check. The Codex gate script, with an advisory mode. A four-check preflight.

**Shrunk.** `CLAUDE.md`, `AGENTS.md`, and `CONTRIBUTING.md` are cut to facts and prohibitions — what is true about this repository, and what you must not do. Nothing that restates how to be a competent engineer.

Citations become markdown links, checked by lychee.

### Thesis — Why This Option

Every kept item catches something a careful reader cannot: a secret that looks like a token, a worktree that another process is standing in, two agents committing at once, a test runner that reports green on a glob that matched nothing, a column that does not sum, a review that has not actually happened yet, a phase that already shipped.

Every removed item catches something a careful reader already sees, and charges for it on every commit. A citation parser tells you a heading moved; so does a broken markdown link, using a standard tool that needs no maintenance. A four-state status field tells you a document is not finished; so does reading it.

The 54 % figure is the clearest signal. More than half the harness was tests of the harness — work that protects the checker rather than the product, and grows whenever the checker does.

---

## Alternatives Considered

### Option A: Delete the compensating machinery, keep the machine-only checks (Chosen)

- **What:** the split above.
- **Steel man:** it cuts the cost that is paid every day and keeps the checks whose failures are genuinely invisible. The line is drawable: can a careful reader of the diff see this defect? If yes, the checker is redundant; if no, it stays.
- **Weaknesses:** the line is a judgment call, and a judgment call can be made wrong. Some defect class we have not thought of may be sitting behind a deleted checker.

### Option B: Keep everything and tune the slow parts (Rejected)

- **What:** leave the process intact; optimize CI, cache more, trim the preamble.
- **Steel man:** it is strictly safer. No check is lost, so no defect class becomes newly invisible, and the measured pain — 27-minute CI, a 12,000-token preamble — is exactly the kind of thing caching and trimming fix. Deleting a check to make a build faster is a bad trade if the check was load-bearing, and you find out which it was only after it is gone.
- **Why rejected:** it treats the symptom. The preamble is long because there are many rules; the CI is slow because there are many checkers; the checkers have many tests because they are custom code. Tuning leaves all three causes in place and buys a one-time improvement that the next checker erases.

### Option C: Delete everything custom, run only standard tools (Rejected)

- **What:** lint, test, typecheck, secret scan. Nothing repo-specific at all.
- **Steel man:** maximum simplicity, zero maintenance, no bespoke code to test.
- **Why rejected:** four of the kept checks have no standard-tool equivalent. A test runner that exits 0 on a glob matching no files is a false green no linter catches; a worktree deleted out from under a live process breaks every later command in that session; two agents committing concurrently corrupt the index. These are real incidents this repository has had, not hypotheticals.

---

## Reversibility Assessment

- **Reversal cost:** hours per item. Every deleted checker is one `git revert` away, and none of them held state.
- **Blast radius:** the harness and the instruction files. No product code under `packages/` or `apps/` changes.
- **Migration path:** restore the file from history, re-wire its hook or CI step. Nothing was migrated away from, so nothing needs migrating back.
- **Point of no return:** none. The one thing that decays is the corpus: the longer the status words sit unread, the less true they get. That makes restoring the status machinery progressively less useful, not harder.

## Consequences

### Positive

- The cost of a commit drops to what the commit is actually worth checking.
- Heading renames are caught by lychee, a maintained standard tool, rather than by a custom parser this repository has to own and test.
- The instruction files say only what a competent engineer could not already know about this repository.

### Negative (accepted trade-offs)

- A red check can land on `develop`. It is fixed forward, and the nightly full run catches what slips. This is the deliberate trade: the develop branch becomes a place where work lands and is corrected, and `main` keeps its protection.
- Status words on existing documents are left as they are. Nothing reads them, so they are neither true nor false — just inert. Sweeping them would be a large diff bought with no check.
- The 2,283 backticked `Spec-NNN §Heading` citations became markdown links. The roughly 2,000 un-backticked prose mentions of the same form stayed prose: they have no closing delimiter, so nothing can parse them reliably; nothing parses them any more anyway; and rewriting them would be a large diff bought with no check.

### Unknowns

- Which deleted check, if any, was load-bearing. We find out by watching for the defects, which is what the trigger below is for.

## Re-evaluation trigger

If a class of defect that a deleted check used to catch recurs twice, add a standard-tool rule for it — not a custom checker. Two occurrences is the threshold because one is an accident and the point of this decision is to stop paying for checkers that catch nothing.

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `git ls-files '.claude/**' 'tools/**' \| xargs wc -l` | Primary measurement | 55,799 lines of harness tooling before the cleanup; 54 % of it tests of the tooling | this repository, 2026-09-14 |
| CI run history | Primary measurement | 27-minute wall time on the full required set | GitHub Actions, 2026-09-14 |
| [failure-mode-catalog.md](../operations/failure-mode-catalog.md) | Internal record | The incident classes behind the kept checks — false-green test runs, occupied-worktree removal, concurrent commits | this repository |

### Related ADRs

- [ADR-023 — V1 CI/CD and release automation](./023-v1-ci-cd-and-release-automation.md) — owns the branch model this decision amends by removing protection from `develop`.

## Decision Log

| Date       | Event    | Notes                                                       |
| ---------- | -------- | ----------------------------------------------------------- |
| 2026-09-14 | Proposed | Drafted from the measured harness cost                      |
| 2026-09-14 | Accepted | Two-way door; every deletion is one revert from restoration |
