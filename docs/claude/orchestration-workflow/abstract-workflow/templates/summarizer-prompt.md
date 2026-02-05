# Summarizer Prompt Template

This template is used by the orchestrator to consolidate multiple evaluator reports into a final summary with averaged scores and consensus analysis.

---

```markdown
---
title: "Summarizer: Consolidate {{EVALUATOR_COUNT}} evaluator reports"
timestamp: "{{TIMESTAMP}}"
subagent_type: general-purpose
run_in_background: false
---

## Your Role
Principal report synthesizer. Consolidate {{EVALUATOR_COUNT}} independent evaluator reports into a final summary.

## Input Reports

Read all evaluator reports:
{{EVALUATOR_REPORT_PATHS}}

## Your Task

Create a comprehensive summary that includes:

1. **Individual Report Assessments** - Show each evaluator's scores and recommendations
2. **Average Scores** - Calculate the arithmetic mean of all evaluators' scores for each solution
3. **Consensus Analysis** - Did evaluators agree? Where did they differ?
4. **Final Recommendation** - Based on averaged scores and consensus

## Required Calculations

For each solution ({{SOLUTION_LIST}}), calculate:
- Average Weighted Total = (Eval1 + Eval2 + ... + EvalN) / N
- Round to 2 decimal places

## Output Format

Write your consolidated report to:
`{{OUTPUT_PATH}}`

Use this format:

```markdown
# Final Evaluation Summary

## Executive Summary
[2-3 sentences on overall findings and consensus]

---

## Individual Evaluator Reports

### Evaluator 1
| Criterion | Weight | {{SOLUTION_HEADERS}} |
|-----------|--------|{{SOLUTION_DIVIDERS}}|
{{CRITERIA_ROWS}}
| **Weighted Total** | | {{WEIGHTED_TOTALS}} |

**Recommendation:** [Winner] - [Reasoning]

### Evaluator 2
[Same table format]
**Recommendation:** [Winner] - [Reasoning]

{{ADDITIONAL_EVALUATORS}}

---

## Averaged Scores

| Solution | {{EVALUATOR_HEADERS}} | **Average** |
|----------|{{EVALUATOR_DIVIDERS}}|-------------|
{{SOLUTION_AVERAGE_ROWS}}

## Criterion-Level Averages

| Criterion | Weight | {{SOLUTION_HEADERS}} |
|-----------|--------|{{SOLUTION_DIVIDERS}}|
{{CRITERION_AVERAGE_ROWS}}

---

## Consensus Analysis

### Agreement
- [Where all evaluators agreed]

### Disagreement
- [Where evaluators differed and why]

### Recommendation Tally
| Solution | Votes |
|----------|-------|
{{VOTE_TALLY_ROWS}}

---

## Final Recommendation

**Winner:** [Solution with highest average and/or most votes]

**Average Score:** X.XX/10

**Reasoning:**
[Comprehensive explanation based on all evaluations]

**Runner-up:** [Second place]

---

## Key Findings Across All Evaluators

1. [Common observation 1]
2. [Common observation 2]
3. [Common observation 3]
```

After writing the file, also output a brief summary to confirm completion.
```

---

## Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{EVALUATOR_COUNT}}` | Number of evaluators | 3 |
| `{{TIMESTAMP}}` | ISO timestamp | "2026-02-05T10:30:00Z" |
| `{{EVALUATOR_REPORT_PATHS}}` | Paths to reports | See below |
| `{{SOLUTION_LIST}}` | Solution identifiers | A, B, C, D |
| `{{OUTPUT_PATH}}` | Where to write summary | `.claude/artifacts/final-summary.md` |
| `{{SOLUTION_HEADERS}}` | Table headers | "A \| B \| C \| D" |
| `{{EVALUATOR_HEADERS}}` | Evaluator columns | "Eval 1 \| Eval 2 \| Eval 3" |

---

## Report Path Format

```markdown
1. `{{EVALUATOR_1_REPORT_PATH}}`
2. `{{EVALUATOR_2_REPORT_PATH}}`
3. `{{EVALUATOR_3_REPORT_PATH}}`
```

---

## Example Output

```markdown
# Final Evaluation Summary

## Executive Summary

All three evaluators unanimously recommend **Solution C** as the winner, with an average weighted score of **9.07/10**. Solution C provides the most complete feature set, clean code organization, and robust error handling while correctly addressing all requirements. Solution D is the runner-up but suffers from integration bugs introduced during the merge process.

---

## Individual Evaluator Reports

### Evaluator 1

| Criterion | Weight | A | B | C | D |
|-----------|--------|---|---|---|---|
| Correctness | 25% | 8/10 | 8/10 | 9/10 | 9/10 |
| Safety | 20% | 8/10 | 7/10 | 9/10 | 9/10 |
| Code Quality | 20% | 6/10 | 7/10 | 8/10 | 8/10 |
| Feature Completeness | 15% | 5/10 | 6/10 | 10/10 | 10/10 |
| Robustness | 10% | 7/10 | 7/10 | 9/10 | 9/10 |
| Backwards Compat | 10% | 8/10 | 8/10 | 9/10 | 9/10 |
| **Weighted Total** | | **7.00** | **7.20** | **8.95** | **8.95** |

**Recommendation:** C (or D as tie) - Both provide complete feature sets; C preferred for simplicity.

### Evaluator 2

| Criterion | Weight | A | B | C | D |
|-----------|--------|---|---|---|---|
| Correctness | 25% | 7/10 | 7/10 | 9/10 | 8/10 |
| Safety | 20% | 8/10 | 7/10 | 9/10 | 8/10 |
| Code Quality | 20% | 6/10 | 8/10 | 9/10 | 7/10 |
| Feature Completeness | 15% | 5/10 | 6/10 | 10/10 | 10/10 |
| Robustness | 10% | 6/10 | 7/10 | 9/10 | 8/10 |
| Backwards Compat | 10% | 8/10 | 8/10 | 9/10 | 9/10 |
| **Weighted Total** | | **6.65** | **7.15** | **9.10** | **8.10** |

**Recommendation:** C - Best code quality with no bugs found.

### Evaluator 3

| Criterion | Weight | A | B | C | D |
|-----------|--------|---|---|---|---|
| Correctness | 25% | 8/10 | 7/10 | 9/10 | 8/10 |
| Safety | 20% | 8/10 | 7/10 | 9/10 | 9/10 |
| Code Quality | 20% | 6/10 | 8/10 | 9/10 | 8/10 |
| Feature Completeness | 15% | 5/10 | 6/10 | 10/10 | 10/10 |
| Robustness | 10% | 6/10 | 7/10 | 9/10 | 8/10 |
| Backwards Compat | 10% | 7/10 | 8/10 | 9/10 | 9/10 |
| **Weighted Total** | | **6.75** | **7.15** | **9.15** | **8.55** |

**Recommendation:** C - Most complete with clean argument parsing.

---

## Averaged Scores

| Solution | Eval 1 | Eval 2 | Eval 3 | **Average** |
|----------|--------|--------|--------|-------------|
| A | 7.00 | 6.65 | 6.75 | **6.80** |
| B | 7.20 | 7.15 | 7.15 | **7.17** |
| C | 8.95 | 9.10 | 9.15 | **9.07** |
| D | 8.95 | 8.10 | 8.55 | **8.53** |

## Criterion-Level Averages

| Criterion | Weight | A (avg) | B (avg) | C (avg) | D (avg) |
|-----------|--------|---------|---------|---------|---------|
| Correctness | 25% | 7.67 | 7.33 | 9.00 | 8.33 |
| Safety | 20% | 8.00 | 7.00 | 9.00 | 8.67 |
| Code Quality | 20% | 6.00 | 7.67 | 8.67 | 7.67 |
| Feature Completeness | 15% | 5.00 | 6.00 | 10.00 | 10.00 |
| Robustness | 10% | 6.33 | 7.00 | 9.00 | 8.33 |
| Backwards Compat | 10% | 7.67 | 8.00 | 9.00 | 9.00 |

---

## Consensus Analysis

### Agreement
- **Solution C is the winner**: All three evaluators recommend C
- **All requirements fixed**: All evaluators confirmed all solutions address core requirements
- **Feature completeness gap**: All noted A and B lack advanced features (5-6/10) while C and D are complete (10/10)

### Disagreement
- **Solution D scoring**: Eval 1 scored D at 8.95, Eval 2 at 8.10, Eval 3 at 8.55 (0.85 spread indicates uncertainty)
- **Code quality for B**: Eval 1 scored 7/10, Evals 2&3 scored 8/10

### Recommendation Tally

| Solution | Votes |
|----------|-------|
| A | 0 |
| B | 0 |
| C | 3 |
| D | 0 |

---

## Final Recommendation

**Winner:** Solution C

**Average Score:** 9.07/10

**Reasoning:**
Solution C emerges as the clear winner with unanimous support and the highest average score. Key factors:
1. **Complete Feature Set** (10/10): Implements all requested features including safety features
2. **Superior Code Quality** (8.67/10 average): Best organization and maintainability
3. **Robust Error Handling**: Comprehensive validation and graceful degradation
4. **Correct Implementation**: All requirements met without introducing bugs

**Runner-up:** Solution D (8.53/10)

D's attempt to merge best features introduced integration bugs that reduced reliability. The timestamp feature is valuable but not worth the defects.

---

## Key Findings Across All Evaluators

1. **Simple formats are more robust**: Key-value manifest easier to parse than JSON in shell
2. **Feature completeness matters for safety**: --dry-run flag critical for user confidence
3. **Proper argument parsing is essential**: Positional args (B) less flexible than flag parsing (C)
4. **Merging requires careful integration**: D shows combining features can introduce new bugs
5. **Evaluator variance signals problems**: D's 0.85 score spread vs C's 0.20 spread indicates D has ambiguous qualities
```

---

## Orchestrator Usage

```python
# Launch summarizer after all evaluators complete
spawn_task(
    description="Summarizer: Consolidate 3 evaluator reports",
    prompt=summarizer_template.format(
        EVALUATOR_COUNT=3,
        EVALUATOR_REPORT_PATHS="\n".join([
            f"1. `.claude/tmp/evaluators/eval-1/report.md`",
            f"2. `.claude/tmp/evaluators/eval-2/report.md`",
            f"3. `.claude/tmp/evaluators/eval-3/report.md`"
        ]),
        OUTPUT_PATH=".claude/artifacts/final-summary.md",
        SOLUTION_LIST="A, B, C, D"
    )
)
```
