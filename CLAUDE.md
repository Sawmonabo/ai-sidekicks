@AGENTS.md

## Claude Code

- `.claude/settings.json` wires the `WorktreeCreate` and `WorktreeRemove` hooks to `.claude/hooks/worktree.sh`, which creates worktrees under `.worktrees/` and refuses to remove an occupied one unless `WORKTREE_REMOVE_ALLOW_OCCUPIED=1` is set.
- `.claude/rules/coding-standards.md` loads when you open code under `packages/`, `apps/`, `tools/`, or `.claude/hooks/`. `.claude/skills/` holds skills you invoke by name.
