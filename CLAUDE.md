@AGENTS.md

## Claude Code

- The `WorktreeCreate` and `WorktreeRemove` hooks in `.claude/settings.json` run `.claude/hooks/worktree.sh`: new worktrees land under `.worktrees/<name>/`, and a removal refuses while another session is working there (rule 4).
- `.claude/rules/` holds rules loaded into every session; `coding-standards.md` is the naming rule of rule 11.
