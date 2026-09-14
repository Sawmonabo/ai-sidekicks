# Docs edit checklist

Read this once before landing a change that renames, moves, or deletes something a document refers to. Each item is a way a docs edit has silently broken another document in this repo.

1. **Renamed a path, identifier, or heading?** Grep the repo for the old spelling (`git grep -nF '<old>'`) and fix every hit in the same commit. Headings: the link form is `file.md#slug`; `lychee` verifies it in CI.
2. **Moved or deleted a heading?** Every link into it must point at the new place. Run `lychee --offline --no-progress --config .lychee.toml './**/*.md'` before pushing.
3. **Added or removed a member of a listed set** (a table row, a diagram node, an enumerated list)? Re-read every sentence that counts or quantifies that set ("all four", "none of these") and fix the number or the claim.
4. **A table with a total row?** Re-add the column from its source rows at edit time; never carry a total forward.
5. **A checker or formatter said "clean"?** That proves only what it scans. Prettier rewrites malformed tables and italics into different malformed text and stays green; read the rendered diff.

Related: `CLAUDE.md` §Docs, `docs/operations/repo-and-worktree-recovery.md`.
