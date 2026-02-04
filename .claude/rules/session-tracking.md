# Session Activity Tracking

Always track and display session activity at the end of each response when completing a task or plan.

## What to Track

- **Skills invoked**: Any `/skill` commands used
- **Agents spawned**: Task tool invocations with subagent types (Explore, Plan, Bash, etc.)
- **Files read**: All files accessed via Read, Glob results examined, or Grep content viewed
- **Files modified**: All files created or edited via Write, Edit, or NotebookEdit
- **Tools used**: Summary of all tools invoked during the response

## Display Format

At the end of substantive responses (not simple Q&A), include a session summary.

**IMPORTANT**: Always include a blank line BEFORE and AFTER the `---` separator.

```text
[Your response content here]

---

Session Activity:
- Skills: `/commit`, `/review-pr`
- Agents: Explore (codebase search), Plan (implementation design)
- Files read: `src/auth.ts`, `tests/auth.test.ts`, `package.json`
- Files modified: `src/auth.ts`, `src/utils/validate.ts`
- Tools: Read (5), Grep (3), Edit (2), Bash (1), Task (2)
```

## Rules

1. **Always include** the session summary after completing multi-step tasks
2. **Skip for trivial responses** like answering a single question without tool use
3. **Group similar items** - don't list every Grep pattern, just count tool invocations
4. **List files by path** - use relative paths from project root
5. **Note agent purposes** - briefly describe what each spawned agent did
6. **Cumulative within response** - track all activity since the user's last message
