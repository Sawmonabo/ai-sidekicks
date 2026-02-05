# Evaluator Prompt Template

This template is used by the orchestrator to create evaluation tasks that compare multiple solutions.

---

```markdown
---
title: "Evaluator: Compare {{SOLUTION_COUNT}} implementations of {{TASK_NAME}}"
timestamp: "{{TIMESTAMP}}"
subagent_type: general-purpose
run_in_background: false
---

## Your Role
Principal code evaluator. Review {{SOLUTION_COUNT}} competing implementations of the same task and determine which is superior.

## Input

{{SOLUTION_DEFINITIONS}}

### Original Requirements
`{{TASK_SPECIFICATION_PATH}}`

## Your Task

1. **Read all implementations** thoroughly
2. **Read the original requirements** to understand success criteria
3. **Evaluate each solution** against the criteria below
4. **Provide specific code examples** to support your analysis
5. **Make a clear recommendation** with detailed reasoning

## Evaluation Criteria

Assess each solution on:

{{EVALUATION_CRITERIA}}

## Deliverable

Provide your evaluation in this format:

```markdown
# Evaluation Report

## Executive Summary
[2-3 sentences on overall findings]

## Solution Comparison Matrix

| Criterion | Weight | {{SOLUTION_HEADERS}} |
|-----------|--------|{{SOLUTION_DIVIDERS}}|
{{CRITERIA_ROWS}}
| **Weighted Total** | 100% | {{WEIGHTED_TOTAL_PLACEHOLDERS}} |

## Detailed Analysis

{{SOLUTION_ANALYSIS_SECTIONS}}

## Requirement-by-Requirement Comparison

| Requirement | {{SOLUTION_HEADERS}} |
|-------------|{{SOLUTION_DIVIDERS}}|
{{REQUIREMENT_ROWS}}

## Recommendation

**Recommended Solution:** [{{SOLUTION_OPTIONS}}]

**Reasoning:**
[Detailed explanation with specific examples]

## Suggested Improvements
[Any improvements the winning solution could adopt from the others]
```

## Permissions
You have full permissions to read all files needed for evaluation.

## Constraints
- Evaluate objectively based on criteria weights
- Cite specific code examples for all claims
- Do not let solution order bias your evaluation
- Focus on verifiable facts, not assumptions

Proceed with comprehensive evaluation now.
```

---

## Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{SOLUTION_COUNT}}` | Number of solutions | 3, 4 |
| `{{TASK_NAME}}` | Brief task name | "install.sh fixes" |
| `{{TIMESTAMP}}` | ISO timestamp | "2026-02-05T10:30:00Z" |
| `{{SOLUTION_DEFINITIONS}}` | Solution details | See below |
| `{{TASK_SPECIFICATION_PATH}}` | Original spec path | `.claude/tasks/spec.md` |
| `{{EVALUATION_CRITERIA}}` | Weighted criteria | See below |
| `{{SOLUTION_HEADERS}}` | Table headers | "A \| B \| C" |
| `{{SOLUTION_OPTIONS}}` | Choice options | "A, B, or C" |

---

## Solution Definition Format

```markdown
### Solution A ({{APPROACH_NAME}})
- **Location:** `{{SOLUTION_PATH}}`
- **Branch:** `{{BRANCH_NAME}}`
- **Plan:** `{{PLAN_PATH}}`
- **Approach:** {{APPROACH_DESCRIPTION}}
- **Stats:** {{LINES_CHANGED}} insertions, {{LINES_DELETED}} deletions

### Solution B ({{APPROACH_NAME}})
...
```

---

## Evaluation Criteria Format

```markdown
### 1. {{CRITERION_NAME}} (Weight: {{WEIGHT}}%)
{{CRITERION_DESCRIPTION}}
{{SCORING_RUBRIC}}

### 2. {{CRITERION_NAME}} (Weight: {{WEIGHT}}%)
...
```

### Example Criteria (Generic)

```markdown
### 1. Correctness (Weight: 25%)
- Does it meet ALL requirements?
- Are there any bugs or logic errors?
- Does it handle expected inputs correctly?

### 2. Safety (Weight: 20%)
- Does it protect existing data?
- Does it handle edge cases (missing files, permissions, invalid input)?
- Are destructive operations guarded?

### 3. Code Quality (Weight: 20%)
- Is it readable and maintainable?
- Are functions well-organized?
- Does it pass quality checks (linting, type checking)?
- Are comments helpful?

### 4. Robustness (Weight: 15%)
- Does it handle errors gracefully?
- Does it recover from invalid states?
- Are operations atomic where appropriate?

### 5. Backwards Compatibility (Weight: 10%)
- Does it work with existing systems/data?
- Is there a migration path?
- Does it preserve expected behavior?

### 6. Feature Completeness (Weight: 10%)
- Does it implement all requested features?
- Are optional enhancements included?
```

### Example Criteria (With Rubrics)

```markdown
### 1. Correctness (Weight: 25%)
Does it meet ALL requirements?

**Rubric:**
- 10/10: All requirements met with no bugs
- 8/10: All requirements met with minor issues
- 6/10: Most requirements met (80%+)
- 4/10: Half of requirements met
- 2/10: Few requirements met
- 0/10: Does not address requirements
```

---

## Output Structure

```markdown
# Evaluation Report

## Executive Summary
Solution C provides the most complete implementation with the best code quality. While Solution A has innovative features, its approach creates maintenance burden. Solution B is functional but lacks important safety features.

## Solution Comparison Matrix

| Criterion | Weight | A | B | C |
|-----------|--------|---|---|---|
| Correctness | 25% | 8/10 | 7/10 | 9/10 |
| Safety | 20% | 7/10 | 6/10 | 9/10 |
| Code Quality | 20% | 6/10 | 8/10 | 9/10 |
| Robustness | 15% | 7/10 | 7/10 | 8/10 |
| Backwards Compat | 10% | 8/10 | 8/10 | 9/10 |
| Feature Complete | 10% | 5/10 | 6/10 | 10/10 |
| **Weighted Total** | 100% | **6.85** | **7.00** | **8.95** |

## Detailed Analysis

### Solution A Analysis

**Strengths:**
- [Strength 1 with code example]
- [Strength 2 with code example]

**Weaknesses:**
- [Weakness 1 with code example]
- [Weakness 2 with code example]

**Code Quality Issues:**
- Line X: [Issue description]

### Solution B Analysis
...

### Solution C Analysis
...

## Requirement-by-Requirement Comparison

| Requirement | A | B | C |
|-------------|---|---|---|
| Req 1 | FIXED | FIXED | FIXED |
| Req 2 | FIXED | PARTIAL | FIXED |
| Req 3 | PARTIAL | FIXED | FIXED |

## Recommendation

**Recommended Solution:** C

**Reasoning:**
Solution C scores highest across all criteria with a weighted total of 8.95/10. Specific advantages include:
1. [Reason 1 with evidence]
2. [Reason 2 with evidence]
3. [Reason 3 with evidence]

While Solution A's [feature] is innovative, the implementation complexity (see lines X-Y) creates maintenance concerns that outweigh the benefits.

## Suggested Improvements
The winning solution could adopt:
- From A: [Feature] - would add [benefit]
- From B: [Feature] - would improve [aspect]
```

---

## Orchestrator Usage

```python
# Single evaluator
spawn_task(
    description="Evaluator: Compare 3 implementations",
    prompt=evaluator_template.format(
        SOLUTION_COUNT=3,
        SOLUTION_DEFINITIONS=solution_defs,
        EVALUATION_CRITERIA=criteria,
        # ... other placeholders
    )
)
```
