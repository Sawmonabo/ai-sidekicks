@AGENTS.md

## Claude Code

- `.claude/settings.json` wires the `WorktreeCreate` and `WorktreeRemove` hooks to `.claude/hooks/worktree.sh`, which creates worktrees under `.worktrees/` and refuses to remove an occupied one unless `WORKTREE_REMOVE_ALLOW_OCCUPIED=1` is set.
- `.claude/skills/` holds skills you invoke by name.
