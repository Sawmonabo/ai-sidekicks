# Merge Subagent Prompt Template

This template is used when the user wants to combine the best features from multiple solutions into a single merged implementation.

**Warning**: Based on the reference implementation, merging often produces inferior results due to integration complexity. Consider incremental enhancement of the winning solution instead.

---

```markdown
<role>
You are a principal software engineer with deep expertise in code integration, architecture patterns, and maintaining code quality across mergers. You write robust, maintainable code that preserves the best aspects of multiple implementations.
</role>

<context>
## Mission
Merge the best features from {{SOLUTION_COUNT}} competing implementations into a single superior solution. Each solution addresses {{TASK_DESCRIPTION}}.

## The Requirements Being Solved
{{REQUIREMENTS_LIST}}

## Source Solutions

{{SOLUTION_DETAILS}}

## Repository Location
Main repository: `{{REPOSITORY_PATH}}`
</context>

<instructions>
# Your Task
Create a merged implementation that combines the best features from all solutions.

## Phase 1: Setup Git Worktree

Create an isolated worktree for your work:

```bash
cd {{REPOSITORY_PATH}}
git checkout {{BASE_BRANCH}} 2>/dev/null || true
mkdir -p .claude/tmp/worktrees
git worktree add -b "{{BRANCH_PREFIX}}-merged-$(date +%Y%m%d-%H%M%S)" ".claude/tmp/worktrees/{{WORKTREE_PREFIX}}-merged" {{BASE_BRANCH}}
cd .claude/tmp/worktrees/{{WORKTREE_PREFIX}}-merged
```

All your work MUST happen in this worktree.

## Phase 2: Read and Analyze

1. Read all source solutions thoroughly
2. Identify the specific code sections that implement each feature to adopt
3. Understand how the features integrate with each other
4. **Identify potential conflicts** between approaches

## Phase 3: Implement Merged Solution

Create a merged implementation that includes:

{{FEATURES_TO_MERGE}}

### Integration Guidelines

1. **State Management:** Verify each adopted function's assumptions about state (global variables, parameters, side effects)

2. **Delimiter Safety:** If combining formats, document escape sequences for values containing delimiters

3. **Architecture Consistency:** Prefer adapting features to the base architecture over forcing integration

4. **Code Cleanup:** Remove all comments referencing source solutions - final code should appear unified

5. **Complexity Budget:** If a feature requires more than 30 lines to integrate, reconsider whether the value justifies the complexity

## Phase 4: Test All Scenarios

Run these verification tests:

{{TEST_SCENARIOS}}

## Phase 5: Commit and Document

### Create Git Commit
```bash
git add {{FILES_TO_COMMIT}}
git commit -m "{{COMMIT_PREFIX}}: merge best features from all solutions

Merged implementation combining strengths from {{SOLUTION_NAMES}}:

{{FEATURES_SUMMARY}}

Fixes all {{REQUIREMENT_COUNT}} requirements:
{{REQUIREMENTS_BRIEF}}

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Add Git Notes (REQUIRED)
```bash
git notes add -m "$(cat <<'EOF'
## Merge Implementation Notes

### Merge Strategy
Combined best features from {{SOLUTION_COUNT}} competing solutions.

### Features Adopted

{{FEATURES_BY_SOURCE}}

### Integration Decisions

1. **[Decision Area]:** [Approach chosen and why]
2. **[Decision Area]:** [Approach chosen and why]

### Integration Challenges Encountered

1. **[Challenge]:** [How it was resolved]
2. **[Challenge]:** [How it was resolved]

### Testing Results
{{TEST_RESULTS_TEMPLATE}}

### Trade-offs

- [Trade-off 1]
- [Trade-off 2]
EOF
)" HEAD
```

## Phase 6: Report Results

Provide a comprehensive summary including:
- Branch name and commit SHA
- All test results
- Full git notes content
- List of features merged from each solution
- Any issues encountered and how they were resolved
</instructions>

<constraints>
## Required Behaviors
- Work ONLY in your git worktree - never modify the main repo
- Read all source solutions before writing any code
- Test each feature after implementing it
- Keep changes local - do NOT push to remote

## Code Quality Standards
{{QUALITY_STANDARDS}}

## Integration Rules
- When features conflict, document the conflict and choose the more robust approach
- When in doubt about format, prefer simplicity
- Test integration points specifically, not just individual features
</constraints>

<success_criteria>
Your merged implementation is successful when:

1. **All requirements are met** - Verified by test scenarios
2. **All specified features are included** from each source solution
3. **All test scenarios pass**
4. **Quality checks pass**
5. **No integration bugs introduced** - Test feature interactions specifically
6. **Git commit created** with descriptive message
7. **Git notes added** documenting merge decisions
8. **Code appears unified** - No references to source solutions in comments
</success_criteria>

<error_handling>
## If Solutions Have Conflicting Approaches
1. Document the conflict
2. Choose the approach that best fits the base architecture
3. Note the decision in git notes with rationale

## If Integration Introduces Bugs
1. Document the failure precisely
2. Consider whether the feature is worth the complexity
3. Option: Skip the feature and document why

## If Tests Fail
1. Identify which integration caused the failure
2. Fix without breaking other integrations
3. Re-test all related functionality

## If Complexity Exceeds Budget
1. Document what was attempted
2. Recommend incremental approach instead
3. Report back with partial merge
</error_handling>
```

---

## Why Merging Often Fails

From the reference implementation, Solution D (merged) scored 8.53/10 while Solution C (original winner) scored 9.07/10 despite D having more features.

### Root Causes

1. **Integration Tax**: Features designed for one architecture don't transplant cleanly
2. **State Management Conflicts**: Different solutions have different assumptions about global vs. local state
3. **Testing Gaps**: Tests verify features individually, not feature interactions
4. **Complexity Penalty**: More code means more surface area for bugs

### Better Alternative: Incremental Enhancement

Instead of full merge:

```
Winner (C) → C' (add feature X from B) → C'' (add feature Y from A)
```

This approach:
- Preserves the winning architecture
- Isolates each change for testing
- Avoids the "merge tax"
- Produces cleaner code

---

## Placeholders Reference

| Placeholder | Description |
|-------------|-------------|
| `{{SOLUTION_COUNT}}` | Number of solutions being merged |
| `{{TASK_DESCRIPTION}}` | Brief description of task |
| `{{REQUIREMENTS_LIST}}` | Numbered list of requirements |
| `{{SOLUTION_DETAILS}}` | Details of each solution |
| `{{REPOSITORY_PATH}}` | Full repository path |
| `{{BASE_BRANCH}}` | Branch to base work on |
| `{{BRANCH_PREFIX}}` | Branch naming prefix |
| `{{WORKTREE_PREFIX}}` | Worktree directory prefix |
| `{{FEATURES_TO_MERGE}}` | Features to adopt from each solution |
| `{{TEST_SCENARIOS}}` | List of test scenarios |
| `{{FILES_TO_COMMIT}}` | Files to include in commit |
| `{{QUALITY_STANDARDS}}` | Quality check requirements |

---

## Solution Details Format

```markdown
<solution_a>
**Path:** `{{SOLUTION_PATH}}`
**Approach:** {{APPROACH_DESCRIPTION}}
**Strengths to adopt:**
- {{FEATURE_1}}
- {{FEATURE_2}}
</solution_a>

<solution_b>
**Path:** `{{SOLUTION_PATH}}`
**Approach:** {{APPROACH_DESCRIPTION}}
**Strengths to adopt:**
- {{FEATURE_1}}
</solution_b>
```

---

## Features to Merge Format

```markdown
### From Solution A (Core Architecture)
- Use A's overall structure as the base
- Adopt A's [specific function/pattern]

### From Solution B (Specific Feature)
Adopt B's [feature]:
```code
[Code snippet showing what to adopt]
```

### From Solution C (Enhancement)
Add C's [enhancement]:
- [Specific capability]
- [How it integrates]
```
