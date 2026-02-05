# Quick Start: Orchestration Workflow

Copy and customize this template to run your own multi-agent orchestration.

---

## Step 1: Create Task Specification

Create `.claude/tasks/my-task-spec.md`:

```markdown
# Task: [Your Task Name Here]

## Context

[Describe the project, current state, and why this task is needed]

## Problem Statement

[What specific problem needs to be solved?]

## Requirements

1. **[Requirement Name]**
   - [Specific detail]
   - [Specific detail]

2. **[Requirement Name]**
   - [Specific detail]

3. **[Requirement Name]**
   - [Specific detail]

## Constraints

- [Technical constraint]
- [Process constraint]
- [Resource constraint]

## Success Criteria

- [ ] [Measurable criterion 1]
- [ ] [Measurable criterion 2]
- [ ] [Measurable criterion 3]

## Evaluation Criteria

| Criterion | Weight |
|-----------|--------|
| Correctness | 25% |
| Safety | 20% |
| Code Quality | 20% |
| Feature Completeness | 15% |
| Robustness | 10% |
| Backwards Compatibility | 10% |
```

---

## Step 2: Create Orchestration Prompt

Copy this prompt and customize the marked sections:

```xml
<role>
You are a principal orchestration engineer coordinating parallel subagents.
</role>

<context>
## Mission
Orchestrate 2 parallel subagents working on the same task. Act as gatekeeper for all decisions.

## Task Specification
<!-- CUSTOMIZE: Update path -->
Read task spec at: `.claude/tasks/my-task-spec.md`

## Web Access Policy
Subagents may use web search for official documentation only.
</context>

<instructions>
## Phase 1: Planning

1. Launch 2 subagents in parallel
2. Each creates a detailed implementation plan
3. Present plans side-by-side
4. Await user approval

## Phase 2: Implementation

1. Confirm user approval
2. Launch subagents to implement their plans
3. Each works in isolated git worktree
4. Track progress and relay questions

## Phase 3: Evaluation

1. Spawn evaluator subagent
2. Compare implementations objectively
3. Present recommendation
</instructions>

<constraints>
- Launch subagents in parallel for planning
- Each subagent uses isolated git worktree
- All questions relay through orchestrator to user
- Quality checks must pass before evaluation
</constraints>

<output_format>
When complete, present:
- Solution comparison
- Evaluator recommendation with scores
- Next steps
</output_format>
```

---

## Step 3: Run Orchestration

Paste the orchestration prompt to Claude and follow the workflow:

1. **Orchestrator reads task spec** → Confirms understanding
2. **Planning phase** → Two parallel plans created
3. **Your approval** → Review and approve plans
4. **Implementation phase** → Solutions developed in worktrees
5. **Evaluation phase** → Objective comparison
6. **Final recommendation** → Winner selected

---

## Common Customizations

### Add More Subagents

Change "2 parallel subagents" to "3 parallel subagents" and add:

```xml
<phase_1_handoff>
...same prompt for each subagent...
</phase_1_handoff>
```

### Add Merge Phase

After initial evaluation, add:

```xml
## Phase 4: Merge (Optional)

If evaluation suggests combining features:
1. Present merge recommendation
2. If approved, spawn merge subagent
3. Re-evaluate merged solution
```

### Add Parallel Evaluators

Change evaluation to:

```xml
## Phase 3: Final Evaluation

1. Spawn 3 evaluators in parallel (fresh context each)
2. Each independently scores all solutions
3. Summarizer consolidates reports
4. Present averaged scores and consensus
```

### Custom Evaluation Criteria

Replace default criteria:

```markdown
| Criterion | Weight |
|-----------|--------|
| Performance | 30% |
| Security | 25% |
| Maintainability | 20% |
| Scalability | 15% |
| Documentation | 10% |
```

---

## Checklist

Before starting:
- [ ] Task specification complete
- [ ] Requirements are specific and testable
- [ ] Constraints are clear
- [ ] Success criteria are measurable
- [ ] Evaluation weights sum to 100%

During workflow:
- [ ] Review each plan carefully before approving
- [ ] Monitor implementation progress
- [ ] Answer subagent questions promptly
- [ ] Review evaluation rationale, not just scores

After workflow:
- [ ] Verify winner against requirements
- [ ] Check git notes for implementation details
- [ ] Consider suggestions from losing solutions
