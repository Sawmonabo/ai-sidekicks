---
title: "Summarizer: Consolidate 3 evaluator reports"
timestamp: "2026-02-05T03:11:00.414Z"
subagent_type: general-purpose
prompt_length: 3083
run_in_background: false
---

## Your Role
Principal report synthesizer. Consolidate three independent evaluator reports into a final summary.

## Input Reports

Read all three evaluator reports:
1. `/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/subagents/evaluator-1/report.md`
2. `/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/subagents/evaluator-2/report.md`
3. `/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/subagents/evaluator-3/report.md`

## Your Task

Create a comprehensive summary that includes:

1. **Individual Report Assessments** - Show each evaluator's scores and recommendations
2. **Average Scores** - Calculate the arithmetic mean of all three evaluators' scores for each solution
3. **Consensus Analysis** - Did evaluators agree? Where did they differ?
4. **Final Recommendation** - Based on averaged scores and consensus

## Required Calculations

For each solution (A, B, C, D), calculate:
- Average Weighted Total = (Eval1 + Eval2 + Eval3) / 3
- Round to 2 decimal places

## Output Format

Write your consolidated report to:
`/home/sabossedgh/repos/ai-sidekicks/.claude/tmp/sessions/2026-02-04/artifacts/final-evaluation-summary.md`

Use this format:

```markdown
# Final Evaluation Summary

## Executive Summary
[2-3 sentences on overall findings and consensus]

---

## Individual Evaluator Reports

### Evaluator 1
| Criterion | Weight | A | B | C | D |
|-----------|--------|---|---|---|---|
| Correctness | 25% | X | X | X | X |
| Safety | 20% | X | X | X | X |
| Code Quality | 20% | X | X | X | X |
| Feature Completeness | 15% | X | X | X | X |
| Robustness | 10% | X | X | X | X |
| Backwards Compat | 10% | X | X | X | X |
| **Weighted Total** | | **X.XX** | **X.XX** | **X.XX** | **X.XX** |

**Recommendation:** [Winner] - [Reasoning]

### Evaluator 2
[Same table format]
**Recommendation:** [Winner] - [Reasoning]

### Evaluator 3
[Same table format]
**Recommendation:** [Winner] - [Reasoning]

---

## Averaged Scores

| Solution | Eval 1 | Eval 2 | Eval 3 | **Average** |
|----------|--------|--------|--------|-------------|
| A | X.XX | X.XX | X.XX | **X.XX** |
| B | X.XX | X.XX | X.XX | **X.XX** |
| C | X.XX | X.XX | X.XX | **X.XX** |
| D | X.XX | X.XX | X.XX | **X.XX** |

## Criterion-Level Averages

| Criterion | Weight | A (avg) | B (avg) | C (avg) | D (avg) |
|-----------|--------|---------|---------|---------|---------
| Correctness | 25% | X.XX | X.XX | X.XX | X.XX |
| Safety | 20% | X.XX | X.XX | X.XX | X.XX |
| Code Quality | 20% | X.XX | X.XX | X.XX | X.XX |
| Feature Completeness | 15% | X.XX | X.XX | X.XX | X.XX |
| Robustness | 10% | X.XX | X.XX | X.XX | X.XX |
| Backwards Compat | 10% | X.XX | X.XX | X.XX | X.XX |

---

## Consensus Analysis

### Agreement
- [Where all 3 evaluators agreed]

### Disagreement
- [Where evaluators differed and why]

### Recommendation Tally
| Solution | Votes |
|----------|-------|
| A | X |
| B | X |
| C | X |
| D | X |

---

## Final Recommendation

**Winner:** [Solution with highest average and/or most votes]

**Average Score:** X.XX/10

**Reasoning:**
[Comprehensive explanation based on all three evaluations]

**Runner-up:** [Second place]

---

## Key Findings Across All Evaluators

1. [Common observation 1]
2. [Common observation 2]
3. [Common observation 3]
```

After writing the file, also output a brief summary to confirm completion.
