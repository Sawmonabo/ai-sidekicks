# Planning Subagent Prompt Template

This template is used by the orchestrator to create planning tasks for each subagent.

---

```markdown
---
title: "Subagent {{ID}}: Create implementation plan for {{TASK_NAME}}"
timestamp: "{{TIMESTAMP}}"
subagent_type: general-purpose
run_in_background: false
---

## Your Role
You are **Subagent {{ID}}** working on a planning task for {{TASK_NAME}}.

## Base Task Specification
Read and analyze the task specification at:
`{{TASK_SPECIFICATION_PATH}}`

Also read the current implementation (if applicable):
`{{CURRENT_IMPLEMENTATION_PATH}}`

## Your Task
Analyze the requirements and produce a detailed implementation plan.

## Deliverable
A comprehensive plan including:

### 1. Problem Analysis
For each requirement/issue:
- Root cause identification (with specific line numbers if fixing existing code)
- Why the current state is problematic
- Impact on users/system

### 2. Proposed Solution Architecture
- Overall design approach
- Function/module decomposition
- Data structures and formats
- Integration points

### 3. Modifications Required
- What files/sections need changes
- New components to add
- Existing components to modify
- Dependencies to consider

### 4. Testing Strategy
- How you'll verify each change
- Edge cases to test
- Integration testing approach
- Backwards compatibility testing

### 5. Risk Assessment
- What could go wrong
- Mitigations for each risk
- Fallback approaches
- Rollback plan

## Research Guidance
You may use web search to research:
{{RESEARCH_TOPICS}}

Use only official documentation (2025-2026 preferred). Avoid forums and unverified sources.

## Constraints
- Do NOT implement anything yet
- Do NOT modify any files
- Do NOT create any commits
- This is PLANNING ONLY - produce a detailed written plan
- Be specific with line numbers, function names, and file paths

## Output Format
Write your plan to:
`{{PLAN_OUTPUT_PATH}}`

Structure your plan with clear markdown headers for each section above.

## Plan Quality Requirements
Your plan should be detailed enough that:
1. Another engineer could implement it without additional clarification
2. The approach can be objectively evaluated
3. Risks and trade-offs are explicit
4. Testing criteria are measurable
```

---

## Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{ID}}` | Subagent identifier | A, B, C, etc. |
| `{{TASK_NAME}}` | Brief task name | "API refactoring" |
| `{{TIMESTAMP}}` | ISO timestamp | "2026-02-05T10:30:00Z" |
| `{{TASK_SPECIFICATION_PATH}}` | Path to base spec | `/project/.claude/tasks/spec.md` |
| `{{CURRENT_IMPLEMENTATION_PATH}}` | Existing code path | `/project/src/api.ts` |
| `{{RESEARCH_TOPICS}}` | Allowed research | "GraphQL best practices, Apollo docs" |
| `{{PLAN_OUTPUT_PATH}}` | Where to write plan | `/project/.claude/tmp/plans/subagent-a.md` |

---

## Plan Output Structure

```markdown
# Implementation Plan: {{TASK_NAME}}
## Subagent {{ID}}

### Executive Summary
[2-3 sentences describing approach]

---

### 1. Problem Analysis

#### Requirement 1: [Name]
- **Current State:** [What exists now]
- **Root Cause:** [Why it's a problem, lines X-Y]
- **Impact:** [Effect on users/system]

#### Requirement 2: [Name]
...

---

### 2. Proposed Solution Architecture

#### Overall Approach
[Describe the design philosophy]

#### Component Design
| Component | Purpose | Location |
|-----------|---------|----------|
| [Name] | [Purpose] | [Path] |

#### Data Structures
```
[Format definition]
```

---

### 3. Modifications Required

#### New Files
- `path/to/new.ts` - [Purpose]

#### Modified Files
- `path/to/existing.ts`
  - Lines X-Y: [Change description]
  - Add function: [Function name]

---

### 4. Testing Strategy

| Test Scenario | Verification Method | Expected Result |
|---------------|---------------------|-----------------|
| [Scenario 1] | [How to test] | [Pass criteria] |
| [Scenario 2] | [How to test] | [Pass criteria] |

#### Edge Cases
1. [Edge case 1]
2. [Edge case 2]

---

### 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| [Risk 1] | Low/Med/High | Low/Med/High | [Mitigation] |
| [Risk 2] | Low/Med/High | Low/Med/High | [Mitigation] |

#### Fallback Plan
[What to do if primary approach fails]

---

### Trade-offs Considered

| Decision | Alternative | Why This Choice |
|----------|-------------|-----------------|
| [Decision 1] | [Alternative] | [Reasoning] |
```

---

## Orchestrator Usage

The orchestrator spawns planning subagents in parallel:

```python
# Pseudocode for parallel planning launch
for subagent_id in ['A', 'B', 'C']:
    spawn_task(
        description=f"Subagent {subagent_id}: Create implementation plan",
        prompt=planning_template.format(
            ID=subagent_id,
            TASK_SPECIFICATION_PATH=task_spec_path,
            PLAN_OUTPUT_PATH=f".claude/tmp/plans/subagent-{subagent_id.lower()}.md"
        ),
        run_in_background=False  # Wait for completion before comparison
    )
```

After all plans are collected, the orchestrator presents them side-by-side for user approval.
