---
description: Output directory conventions for all agents and skills
---

# Output Directory Structure

All generated files MUST go under `.claude/tmp/` relative to the **project root**.

## Path Resolution

Before writing to `.claude/tmp/`, determine the project root by:

1. Finding the nearest parent directory containing `.claude/`
2. Or if a git repository, use the git repository root: `git rev-parse --show-toplevel`

All paths are relative to this root, regardless of current working directory.

Example: If working in `project/src/components/` and project root is `project/`:
- Correct: `project/.claude/tmp/cache/analysis/`
- Wrong: `project/src/components/.claude/tmp/cache/analysis/`

## Directory Layout

```text
.claude/tmp/
├── cache/                   # Persistent artifacts (survives sessions)
│   ├── analysis/           # Code analysis, dependency graphs
│   ├── summaries/          # Module/file summaries
│   └── indexes/            # Symbol tables, search indexes
├── sessions/<session-id>/  # Per-session data
│   ├── scratchpad/         # Temp working files
│   ├── subagents/          # Subagent outputs
│   ├── websearch/          # Cached search results
│   ├── plans/              # Planning documents
│   └── artifacts/          # Session-specific outputs
├── worktrees/<branch>/     # Git worktree scratch space
└── logs/<date>.log         # Debug logs
```

## Rules

1. **Never use system `/tmp`** - Always use `.claude/tmp/`
2. **Never write outside `.claude/tmp/`** for generated content
3. **Use descriptive kebab-case filenames**: `auth-flow-analysis.md` not `output-1.md`
4. **Session ID**: First 8 chars of session UUID or date-based `YYYY-MM-DD`
5. **Create directories as needed**
6. **No timestamps in directory paths** - use file metadata or headers if needed
7. **Log files**: Use `YYYY-MM-DD.log` format

## Path References

| Use Case | Path |
|----------|------|
| Temp working files | `.claude/tmp/sessions/${SESSION}/scratchpad/` |
| Subagent output | `.claude/tmp/sessions/${SESSION}/subagents/${AGENT_NAME}/` |
| Web search cache | `.claude/tmp/sessions/${SESSION}/websearch/` |
| Planning docs | `.claude/tmp/sessions/${SESSION}/plans/` |
| Session artifacts | `.claude/tmp/sessions/${SESSION}/artifacts/` |
| Persistent analysis | `.claude/tmp/cache/analysis/` |
| Cached summaries | `.claude/tmp/cache/summaries/` |
| Search indexes | `.claude/tmp/cache/indexes/` |
| Worktree scratch | `.claude/tmp/worktrees/${BRANCH}/` |
| Debug logs | `.claude/tmp/logs/` |
