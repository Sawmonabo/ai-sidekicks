# Skill: evaluate-solutions

A skill that invokes the evaluation phase of the orchestration workflow to compare existing solutions.

---

## Skill Definition

```yaml
name: evaluate-solutions
description: |
  Compare multiple existing solutions using the orchestration evaluation framework.
  Useful when you already have implementations and need objective comparison.

  Usage:
  - /evaluate-solutions <spec-path> --solutions <path1> <path2> [path3...]
  - /evaluate-solutions --help

  Options:
  - --solutions      Paths to solutions (2-5 required)
  - --evaluators N   Number of parallel evaluators (default: 3)
  - --criteria       Path to custom evaluation criteria
  - --output         Output path for final report

  Examples:
  - /evaluate-solutions ./spec.md --solutions ./v1/app.js ./v2/app.js
  - /evaluate-solutions ./spec.md --solutions ./a ./b ./c --evaluators 5

version: "1.0.0"
author: "ai-sidekicks"
tags:
  - evaluation
  - comparison
  - multi-agent

inputs:
  spec_path:
    type: string
    required: true
    description: Path to requirements specification
  solutions:
    type: array
    required: true
    min_items: 2
    max_items: 5
    description: Paths to solutions to compare
  evaluator_count:
    type: integer
    default: 3
    description: Number of parallel evaluators
  criteria_path:
    type: string
    required: false
    description: Path to custom evaluation criteria
  output_path:
    type: string
    required: false
    description: Path for final report output
```

---

## Skill Implementation

```markdown
<skill-implementation>
## Solution Evaluation Workflow

You are now operating as an evaluation orchestrator. Compare the provided solutions objectively.

### Step 1: Read Inputs

Read the requirements specification at: `{{spec_path}}`

Solutions to compare:
{{#each solutions}}
- Solution {{@index}}: `{{this}}`
{{/each}}

{{#if criteria_path}}
Custom criteria at: `{{criteria_path}}`
{{else}}
Using default evaluation criteria.
{{/if}}

### Step 2: Configure Evaluation

- Solutions: {{solutions.length}}
- Evaluators: {{evaluator_count}}
- Output: {{output_path}}

### Step 3: Launch Parallel Evaluators

For each evaluator (1 to {{evaluator_count}}):

1. Spawn evaluator subagent with fresh context
2. Provide:
   - All solution paths
   - Requirements specification
   - Evaluation criteria with rubrics
3. Require:
   - Score matrix for all criteria
   - Specific code examples for claims
   - Clear recommendation with reasoning

Use parallel evaluator template from:
`docs/claude/orchestration-workflow/abstract-workflow/templates/parallel-evaluator-prompt.md`

### Step 4: Consolidate Results

Launch summarizer to:
1. Read all {{evaluator_count}} evaluator reports
2. Calculate averaged scores
3. Analyze consensus/disagreement
4. Produce final recommendation

Use summarizer template from:
`docs/claude/orchestration-workflow/abstract-workflow/templates/summarizer-prompt.md`

### Step 5: Present Results

Provide:
- Individual evaluator scores
- Averaged scores table
- Consensus analysis
- Final recommendation
- Score variance analysis (high variance = uncertainty)

{{#if output_path}}
Write full report to: `{{output_path}}`
{{/if}}

### Default Evaluation Criteria

{{#unless criteria_path}}
| Criterion | Weight |
|-----------|--------|
| Correctness | 25% |
| Safety | 20% |
| Code Quality | 20% |
| Feature Completeness | 15% |
| Robustness | 10% |
| Backwards Compatibility | 10% |
{{/unless}}

### Reference
See evaluation rubric details at:
`docs/claude/orchestration-workflow/abstract-workflow/templates/evaluation-rubric.md`
</skill-implementation>
```

---

## Example Usage

### Compare Two Implementations

```
/evaluate-solutions ./requirements.md --solutions ./impl-a/src ./impl-b/src
```

Output:
```markdown
# Evaluation Summary

## Scores

| Solution | Eval 1 | Eval 2 | Eval 3 | Average |
|----------|--------|--------|--------|---------|
| A | 7.50 | 7.25 | 7.60 | **7.45** |
| B | 8.25 | 8.40 | 8.15 | **8.27** |

## Recommendation

**Winner:** Solution B (8.27/10)

**Reasoning:** Solution B scores higher across all criteria, particularly in:
- Safety (9/10 avg vs 7/10) - includes input validation
- Code Quality (8.5/10 avg vs 7/10) - better organization
...
```

### Compare Multiple Approaches

```
/evaluate-solutions ./spec.md --solutions ./json-approach ./xml-approach ./binary-approach --evaluators 5
```

Useful for comparing fundamentally different approaches to the same problem.

### Custom Criteria

```
/evaluate-solutions ./spec.md --solutions ./v1 ./v2 --criteria ./my-criteria.md
```

Where `my-criteria.md` contains:
```markdown
## Evaluation Criteria

### Performance (30%)
...

### Memory Efficiency (25%)
...
```

---

## When to Use This Skill

| Scenario | Use evaluate-solutions |
|----------|----------------------|
| Have existing implementations to compare | Yes |
| Want to add evaluation to manual work | Yes |
| Need objective comparison for team decision | Yes |
| Starting from scratch | No - use /orchestrate-task |
| Single implementation review | No - use standard code review |

---

## Integration with Full Workflow

This skill runs Phase 6 (Final Evaluation) of the orchestration workflow independently.

If you want the full workflow including planning and implementation phases, use `/orchestrate-task` instead.

Typical workflow:
1. Manual implementation of multiple approaches
2. `/evaluate-solutions` to objectively compare
3. Select winner based on report
