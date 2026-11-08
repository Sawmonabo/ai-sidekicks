@AGENTS.md

## Claude Code

- `.claude/settings.json` wires the `WorktreeCreate` and `WorktreeRemove` hooks to `.claude/hooks/worktree.sh`, which creates worktrees under `.worktrees/` and refuses to remove an occupied one unless `WORKTREE_REMOVE_ALLOW_OCCUPIED=1` is set.
- A `CLAUDE.md` in a subdirectory, and every file it imports with `@`, loads on demand and is cut at 40,000 characters on a 200K context window (Claude Code's memory documentation, "Claude ignores the end of my subdirectory CLAUDE.md"); `crates/AGENTS.md` and `apps/desktop/AGENTS.md` stay under that, measured with `wc -m`.
- `.claude/skills/` holds skills you invoke by name.
- `.claude/agents/` holds the role agents a lead dispatches by name (`architect`, `implementer`, `researcher`, `reviewer`), each file setting its own model and effort, beside the plan-execution orchestrator's three internal agents.
- `.claude/marketplace/` is a plugin marketplace holding `typescript-native-lsp`, which runs the workspace's TypeScript 7 language server (`tsc --lsp --stdio`) for code intelligence; `.claude/settings.json` enables it in place of the official `typescript-lsp`, whose `typescript-language-server` needs a `tsserver.js` the TypeScript 6 compatibility package does not ship. `extraKnownMarketplaces` registers the marketplace by a path relative to the main checkout, so a worktree loads the same plugin, and it applies once the folder is trusted. The server starts only in a checkout with `pnpm install` run.
