# Parallel Evaluator Prompt Template

This template is used when launching multiple independent evaluators in parallel for high-confidence recommendations.

The key difference from the standard evaluator is that each parallel evaluator:
- Has fresh context (no knowledge of other evaluators)
- Works independently
- Cannot influence other evaluators' assessments

---

```markdown
---
title: "Evaluator {{EVALUATOR_NUMBER}}: Compare all {{SOLUTION_COUNT}} solutions"
timestamp: "{{TIMESTAMP}}"
subagent_type: general-purpose
run_in_background: false
---

## Your Role
Independent code evaluator. You are **Evaluator {{EVALUATOR_NUMBER}}** of {{TOTAL_EVALUATORS}} independent evaluators assessing the same solutions.

**Critical**: You have NO knowledge of other evaluators' assessments. Evaluate based solely on the code and requirements.

## Input

### Solutions to Evaluate
{{SOLUTION_DEFINITIONS}}

### Original Requirements
`{{TASK_SPECIFICATION_PATH}}`

## Your Task

1. **Read all {{SOLUTION_COUNT}} implementations** thoroughly
2. **Read the original requirements** to understand success criteria
3. **Evaluate each solution** against the criteria below
4. **Provide specific code examples** to support your analysis
5. **Make a clear recommendation** with detailed reasoning

## Evaluation Criteria

{{EVALUATION_CRITERIA}}

## Deliverable

Write your evaluation report to:
`{{REPORT_OUTPUT_PATH}}`

Use this format:

```markdown
# Evaluator {{EVALUATOR_NUMBER}} Report

## Scores

| Criterion | Weight | {{SOLUTION_HEADERS}} |
|-----------|--------|{{SOLUTION_DIVIDERS}}|
{{CRITERIA_ROWS}}
| **Weighted Total** | 100% | {{WEIGHTED_TOTAL_PLACEHOLDERS}} |

## Recommendation
**Winner:** [Solution ID]
**Reasoning:** [2-3 sentences explaining the choice]

## Issue Verification
| Issue | {{SOLUTION_HEADERS}} |
|-------|{{SOLUTION_DIVIDERS}}|
{{ISSUE_VERIFICATION_ROWS}}

## Detailed Analysis

### Solution A ({{APPROACH_NAME}})

**Approach:** [Brief description of approach]

**Strengths:**
- [Strength 1 with code reference]
- [Strength 2 with code reference]

**Weaknesses:**
- [Weakness 1 with code reference, line numbers]
- [Weakness 2 with code reference, line numbers]

**Code Quality Issues:**
- [Issue with specific line reference]

### Solution B ({{APPROACH_NAME}})
[Same format]

{{ADDITIONAL_SOLUTIONS}}

## Feature Comparison

| Feature | {{SOLUTION_HEADERS}} |
|---------|{{SOLUTION_DIVIDERS}}|
{{FEATURE_COMPARISON_ROWS}}

## Key Observations

- **Solution A**: [Notable strength] / [Notable weakness]
- **Solution B**: [Notable strength] / [Notable weakness]
{{ADDITIONAL_OBSERVATIONS}}

## Technical Deep Dive

[Include specific code analysis with line numbers and explanations]
```

## Permissions
You have full permissions to read all files needed for evaluation.

## Constraints
- Evaluate objectively based on criteria weights
- Cite specific code examples with line numbers
- Do not assume what other evaluators might conclude
- Focus on verifiable facts, not assumptions
- Be thorough but concise

Proceed with independent evaluation now.
```

---

## Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{EVALUATOR_NUMBER}}` | This evaluator's number | 1, 2, 3 |
| `{{TOTAL_EVALUATORS}}` | Total number of evaluators | 3 |
| `{{SOLUTION_COUNT}}` | Number of solutions | 4 |
| `{{TIMESTAMP}}` | ISO timestamp | "2026-02-05T10:30:00Z" |
| `{{SOLUTION_DEFINITIONS}}` | Solution paths and details | See evaluator-prompt.md |
| `{{TASK_SPECIFICATION_PATH}}` | Original requirements | `.claude/tasks/spec.md` |
| `{{EVALUATION_CRITERIA}}` | Weighted scoring criteria | See evaluation-rubric.md |
| `{{REPORT_OUTPUT_PATH}}` | Where to write report | `.claude/tmp/eval-1/report.md` |
| `{{SOLUTION_HEADERS}}` | Table column headers | "A \| B \| C \| D" |

---

## Why Parallel Evaluators?

### Single Evaluator Limitations

| Risk | Impact |
|------|--------|
| Individual bias | Favors certain coding styles |
| Missed defects | Single perspective may overlook issues |
| No confidence interval | Can't assess evaluation reliability |

### Parallel Evaluator Benefits

| Benefit | How It Helps |
|---------|--------------|
| Consensus validation | Agreement increases confidence |
| Bias detection | Disagreement highlights subjective areas |
| Variance analysis | High variance signals problems |
| Robust recommendation | Multiple perspectives reduce error |

### Reference Implementation Results

```
Solution C: 8.95, 9.10, 9.15 → Average: 9.07, Variance: 0.20 ✓ (consistent)
Solution D: 8.95, 8.10, 8.55 → Average: 8.53, Variance: 0.85 ⚠ (inconsistent)
```

High variance for D indicated integration issues that weren't obvious from code review alone.

---

## Orchestrator Usage

Launch all evaluators in parallel:

```python
# Launch 3 parallel evaluators
for evaluator_num in [1, 2, 3]:
    spawn_task(
        description=f"Evaluator {evaluator_num}: Compare all 4 solutions",
        prompt=parallel_evaluator_template.format(
            EVALUATOR_NUMBER=evaluator_num,
            TOTAL_EVALUATORS=3,
            SOLUTION_COUNT=4,
            REPORT_OUTPUT_PATH=f".claude/tmp/evaluators/eval-{evaluator_num}/report.md",
            # ... other placeholders
        ),
        run_in_background=False  # Wait for all to complete
    )
```

After all complete, launch the summarizer to consolidate reports.

---

## Recommended Configuration

| Scenario | Evaluators | Rationale |
|----------|------------|-----------|
| Low stakes | 1 | Single evaluation sufficient |
| Medium stakes | 2 | Tie-breaker available |
| High stakes | 3 | Consensus + variance analysis |
| Critical | 5 | High statistical confidence |

For most multi-agent orchestrations, **3 evaluators** provides the best balance of confidence and cost.

---

## Report Quality Requirements

Each evaluator report should:

1. **Be independently reproducible** - Another reader should reach similar conclusions from the code
2. **Cite specific evidence** - Every claim backed by code reference with line numbers
3. **Follow the rubric** - Scores map clearly to rubric definitions
4. **Explain reasoning** - Not just what the score is, but why
5. **Acknowledge uncertainty** - Flag areas where evaluation is subjective
