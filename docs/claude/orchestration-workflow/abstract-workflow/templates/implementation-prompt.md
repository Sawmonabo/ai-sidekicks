# Implementation Subagent Prompt Template

This template is used by the orchestrator to create implementation tasks for each subagent after their plan is approved.

---

```markdown
---
title: "Subagent {{ID}}: Implement {{TASK_NAME}}"
timestamp: "{{TIMESTAMP}}"
subagent_type: general-purpose
run_in_background: false
---

## Your Role
You are **Subagent {{ID}}** implementing {{TASK_NAME}}.

## Your Assigned Plan
Your approved implementation plan is at:
`{{APPROVED_PLAN_PATH}}`

## Task Instructions
Follow the task template at:
`{{TASK_TEMPLATE_PATH}}`

## Your Subagent ID
Use `{{ID_LOWERCASE}}` as your subagent identifier in all branch names and paths.

## Critical Instructions

### 1. Git Worktree Setup (DO FIRST)
```bash
cd {{REPOSITORY_PATH}}
git checkout {{BASE_BRANCH}} 2>/dev/null || true
mkdir -p .claude/tmp/worktrees
git worktree add -b "{{BRANCH_PREFIX}}-{{ID_LOWERCASE}}-$(date +%Y%m%d-%H%M%S)" ".claude/tmp/worktrees/{{WORKTREE_PREFIX}}-{{ID_LOWERCASE}}" {{BASE_BRANCH}}
cd .claude/tmp/worktrees/{{WORKTREE_PREFIX}}-{{ID_LOWERCASE}}
```

### 2. Implement Your Plan
- Read your approved plan thoroughly
- Implement in the order specified in your plan
- Test each change before proceeding
- Follow the coding standards specified

### 3. Required Deliverables
1. Modified files in your worktree
2. All tests passing
3. Quality checks passing ({{QUALITY_CHECKS}})
4. Git commit with descriptive message
5. Git notes documenting your work

### 4. Git Notes (REQUIRED)
After your commit, add git notes:
```bash
git notes add -m "Subagent {{ID}} implementation notes..." HEAD
```
See the git notes template for required content.

### 5. Report Back
When complete, provide:
- Branch name and commit SHA
- Test results for all scenarios
- Full git notes content
- Summary of changes made

## Permissions
You have FULL permissions to:
- Create git worktrees and branches
- Read and write files in your worktree
- Run bash commands
- Run quality checks
- Create commits and git notes

## Constraints
- Work ONLY in your worktree - never modify the main repo
- Keep changes local - do NOT push to remote
- Follow your approved plan
- Document all implementation decisions

Proceed with implementation now.
```

---

## Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{ID}}` | Subagent identifier (uppercase) | A, B, C |
| `{{ID_LOWERCASE}}` | Subagent identifier (lowercase) | a, b, c |
| `{{TASK_NAME}}` | Brief task description | "install.sh fixes" |
| `{{TIMESTAMP}}` | ISO timestamp | "2026-02-05T10:30:00Z" |
| `{{APPROVED_PLAN_PATH}}` | Path to approved plan | `.claude/tmp/plans/subagent-a.md` |
| `{{TASK_TEMPLATE_PATH}}` | Path to task template | `.claude/tasks/impl-task.md` |
| `{{REPOSITORY_PATH}}` | Full repo path | `/home/user/project` |
| `{{BASE_BRANCH}}` | Branch to base work on | main, develop |
| `{{BRANCH_PREFIX}}` | Branch naming prefix | fix/api-refactor |
| `{{WORKTREE_PREFIX}}` | Worktree directory prefix | api-refactor |
| `{{QUALITY_CHECKS}}` | Required checks | shellcheck, eslint, pytest |

---

## Implementation Task Template

This is the task template referenced by `{{TASK_TEMPLATE_PATH}}`:

```markdown
# Implementation Task: {{TASK_NAME}}

## Overview
This task proceeds directly to implementation - planning is complete.

## Your Assigned Plan
Read your implementation plan at the path provided by the orchestrator.

## Phase 1: Setup Git Worktree (REQUIRED)

Create an isolated worktree for your work:

```bash
cd {{REPOSITORY_PATH}}
git checkout {{BASE_BRANCH}} 2>/dev/null || true

# Create worktree with unique branch
BRANCH_NAME="{{BRANCH_PREFIX}}-{{ID_LOWERCASE}}-$(date +%Y%m%d-%H%M%S)"
WORKTREE_PATH=".claude/tmp/worktrees/{{WORKTREE_PREFIX}}-{{ID_LOWERCASE}}"

mkdir -p .claude/tmp/worktrees
git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" {{BASE_BRANCH}}

cd "$WORKTREE_PATH"
```

**CRITICAL**: All work MUST happen in your worktree.

## Phase 2: Implement Your Plan

1. **Read Current Code**: Study existing implementation
2. **Make Changes Incrementally**: Follow your plan's order
3. **Test Each Change**: Verify before proceeding
4. **Handle Edge Cases**: Implement error handling

### Implementation Guidelines
- Use clear naming conventions
- Quote all variable expansions (for shell scripts)
- Add comments for non-obvious logic
- Handle edge cases gracefully

## Phase 3: Verify Implementation

Run all tests from your testing strategy:

### Required Verifications
{{VERIFICATION_CHECKLIST}}

### Quality Checks
```bash
{{QUALITY_CHECK_COMMANDS}}
```

## Phase 4: Commit and Document

### Commit Your Changes
```bash
git add {{FILES_TO_COMMIT}}
git commit -m "{{COMMIT_MESSAGE_PREFIX}}: {{COMMIT_DESCRIPTION}}

{{COMMIT_BODY}}

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Add Git Notes (REQUIRED)
```bash
git notes add -m "$(cat <<'EOF'
## Subagent {{ID}} Implementation Notes

### Changes Made
[List of modifications]

### Decisions Made
[Key implementation decisions]

### Testing Results
[Test results summary]

### Trade-offs
[Trade-offs considered]
EOF
)" HEAD
```

## Phase 5: Report Results

```markdown
## Implementation Complete

### Branch Details
- Branch: [branch name]
- Worktree: [worktree path]
- Commit: [SHA]

### Changes Made
- [List of files modified]
- Lines changed: [N]

### Test Results
| Test | Result |
|------|--------|
| [Test 1] | PASS/FAIL |
| [Test 2] | PASS/FAIL |

### Git Notes
[Full git notes content]
```

## Success Criteria
1. All requirements implemented
2. All tests passing
3. Quality checks passing
4. Git commit created
5. Git notes added
6. Summary report provided
```

---

## Orchestrator Usage

The orchestrator spawns implementation subagents in parallel after plan approval:

```python
# Pseudocode for parallel implementation launch
for subagent_id in approved_subagents:
    spawn_task(
        description=f"Subagent {subagent_id}: Implement {task_name}",
        prompt=implementation_template.format(
            ID=subagent_id,
            ID_LOWERCASE=subagent_id.lower(),
            APPROVED_PLAN_PATH=f".claude/tmp/plans/subagent-{subagent_id.lower()}.md",
            REPOSITORY_PATH=repo_path,
            # ... other placeholders
        ),
        run_in_background=False  # Or True for parallel execution
    )
```
