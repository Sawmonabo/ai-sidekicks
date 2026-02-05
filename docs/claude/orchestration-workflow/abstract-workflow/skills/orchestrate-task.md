# Skill: orchestrate-task

A skill that invokes the multi-agent orchestration workflow for any task.

---

## Skill Definition

```yaml
name: orchestrate-task
description: |
  Orchestrate multiple parallel subagents to solve a complex task.
  Implements the parallel-divergent development with convergent evaluation pattern.

  Usage:
  - /orchestrate-task <task-spec-path> [options]
  - /orchestrate-task --help

  Options:
  - --subagents N    Number of subagents (default: 2)
  - --evaluators N   Number of parallel evaluators (default: 3)
  - --no-merge       Skip merge phase even if suggested
  - --auto-approve   Auto-approve plans (use with caution)

  Examples:
  - /orchestrate-task .claude/tasks/api-refactor.md
  - /orchestrate-task ./spec.md --subagents 3
  - /orchestrate-task ./spec.md --evaluators 5 --no-merge

version: "1.0.0"
author: "ai-sidekicks"
tags:
  - orchestration
  - multi-agent
  - parallel
  - evaluation

inputs:
  task_spec_path:
    type: string
    required: true
    description: Path to task specification file
  subagent_count:
    type: integer
    default: 2
    description: Number of parallel subagents
  evaluator_count:
    type: integer
    default: 3
    description: Number of parallel evaluators for final assessment
  skip_merge:
    type: boolean
    default: false
    description: Skip merge phase
  auto_approve:
    type: boolean
    default: false
    description: Auto-approve planning phase
```

---

## Skill Implementation

```markdown
<skill-implementation>
## Orchestration Workflow

You are now operating as an orchestration engineer. Execute the multi-agent orchestration workflow.

### Step 1: Read Task Specification

Read the task specification at: `{{task_spec_path}}`

Identify:
- Problem statement
- Requirements (numbered list)
- Constraints
- Success criteria

### Step 2: Configure Workflow

- Subagents: {{subagent_count}}
- Evaluators: {{evaluator_count}}
- Skip merge: {{skip_merge}}
- Auto-approve: {{auto_approve}}

### Step 3: Execute Phases

#### Phase 1: Planning
Launch {{subagent_count}} subagents in parallel to create plans.
Use planning prompt template from: `docs/claude/orchestration-workflow/abstract-workflow/templates/planning-prompt.md`

#### Phase 2: Plan Comparison
Present all plans side-by-side.
{{#if auto_approve}}
Auto-approving plans (--auto-approve flag set).
{{else}}
Request explicit user approval before proceeding.
{{/if}}

#### Phase 3: Implementation
Launch approved subagents to implement their plans.
Each subagent works in isolated git worktree.
Use implementation prompt template from: `docs/claude/orchestration-workflow/abstract-workflow/templates/implementation-prompt.md`

#### Phase 4: Evaluation
Launch evaluator to compare all implementations.
Use evaluator prompt template from: `docs/claude/orchestration-workflow/abstract-workflow/templates/evaluator-prompt.md`

#### Phase 5: Merge Decision
{{#if skip_merge}}
Skipping merge phase (--no-merge flag set).
{{else}}
If evaluation suggests merging best features:
- Present merge recommendation to user
- If approved, launch merge subagent
{{/if}}

#### Phase 6: Final Evaluation
Launch {{evaluator_count}} parallel evaluators with fresh context.
Use parallel evaluator prompt template from: `docs/claude/orchestration-workflow/abstract-workflow/templates/parallel-evaluator-prompt.md`

Launch summarizer to consolidate reports.
Use summarizer prompt template from: `docs/claude/orchestration-workflow/abstract-workflow/templates/summarizer-prompt.md`

### Step 4: Present Results

Provide final deliverable:
- Averaged scores across evaluators
- Consensus analysis
- Final recommendation with rationale
- Next steps

### Workflow Templates Location
All templates at: `docs/claude/orchestration-workflow/abstract-workflow/templates/`

### Reference Implementation
For detailed examples, see: `docs/claude/orchestration-workflow/index.md`
</skill-implementation>
```

---

## Example Usage

### Basic Usage

```
/orchestrate-task .claude/tasks/refactor-api.md
```

This will:
1. Read the task spec
2. Launch 2 parallel subagents for planning
3. Present plans for approval
4. Launch subagents for implementation
5. Evaluate solutions
6. (Optional) Merge best features
7. Final evaluation with 3 parallel evaluators
8. Present summarized recommendation

### With Options

```
/orchestrate-task .claude/tasks/auth-system.md --subagents 3 --evaluators 5
```

This will:
- Use 3 parallel subagents for more diverse solutions
- Use 5 parallel evaluators for higher confidence

### Skip Merge

```
/orchestrate-task ./spec.md --no-merge
```

Useful when you want direct comparison without attempting to merge solutions.

---

## Task Specification Format

The task specification file should include:

```markdown
# Task: [Task Name]

## Context
[Background and project information]

## Problem Statement
[What needs to be solved]

## Requirements
1. [Requirement 1]
2. [Requirement 2]
3. [Requirement 3]

## Constraints
- [Constraint 1]
- [Constraint 2]

## Success Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Evaluation Criteria (Optional)
If not provided, uses default criteria:
- Correctness (25%)
- Safety (20%)
- Code Quality (20%)
- Feature Completeness (15%)
- Robustness (10%)
- Backwards Compatibility (10%)
```

---

## Integration with Claude Code

Add to your project's `.claude/skills/` directory or reference via MCP server:

```yaml
# .claude/skills/orchestrate-task.yaml
name: orchestrate-task
# ... skill definition
```

Then invoke with:
```
/orchestrate-task <path>
```
