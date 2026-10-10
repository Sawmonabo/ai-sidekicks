@AGENTS.md

## Claude Code

- `.claude/settings.json` wires the `WorktreeCreate` and `WorktreeRemove` hooks to `.claude/hooks/worktree.sh`, which creates worktrees under `.worktrees/` and refuses to remove an occupied one unless `WORKTREE_REMOVE_ALLOW_OCCUPIED=1` is set.
- `.claude/skills/` holds skills you invoke by name.
- `.claude/marketplace/` is a plugin marketplace holding `typescript-native-lsp`, which runs the workspace's TypeScript 7 language server (`tsc --lsp --stdio`) for code intelligence; `.claude/settings.json` enables it in place of the official `typescript-lsp`, whose `typescript-language-server` needs a `tsserver.js` the TypeScript 6 compatibility package does not ship. A marketplace path must be absolute, so register it once per machine: `claude plugin marketplace add <repository>/.claude/marketplace`. The server answers only in a checkout with `pnpm install` run.
