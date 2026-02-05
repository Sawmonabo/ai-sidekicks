# Evaluation Rubric Template

This template helps create specific, measurable evaluation criteria that enable objective comparison of solutions.

---

## Why Rubrics Matter

Vague criteria lead to subjective evaluations:

| Vague | Specific |
|-------|----------|
| "Is it safe?" | "Does it have --dry-run mode for previewing changes?" |
| "Good code quality" | "Functions are < 50 lines, single responsibility" |
| "Handles errors" | "Validates input, provides actionable error messages" |

Specific rubrics enable:
- **Reproducible evaluations** - Different evaluators reach similar scores
- **Fair comparisons** - Solutions judged on same criteria
- **Actionable feedback** - Clear what needs improvement

---

## Standard Rubric Template

```markdown
## Evaluation Criteria

### 1. {{CRITERION_NAME}} (Weight: {{WEIGHT}}%)

**Description:** {{CRITERION_DESCRIPTION}}

**What to evaluate:**
- {{EVALUATION_POINT_1}}
- {{EVALUATION_POINT_2}}
- {{EVALUATION_POINT_3}}

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | {{PERFECT_SCORE_DEFINITION}} |
| 8/10 | {{GOOD_SCORE_DEFINITION}} |
| 6/10 | {{ACCEPTABLE_SCORE_DEFINITION}} |
| 4/10 | {{POOR_SCORE_DEFINITION}} |
| 2/10 | {{VERY_POOR_SCORE_DEFINITION}} |
| 0/10 | {{FAILURE_DEFINITION}} |

**Evidence required:**
- {{EVIDENCE_TYPE_1}}
- {{EVIDENCE_TYPE_2}}
```

---

## Standard Criteria Set

### 1. Correctness (Weight: 25%)

**Description:** Does the solution correctly implement all requirements?

**What to evaluate:**
- Each requirement is addressed
- Implementation matches specification
- No logic errors or bugs
- Edge cases handled correctly

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | All requirements met with no bugs |
| 8/10 | All requirements met with minor issues |
| 6/10 | Most requirements met (80%+) |
| 4/10 | Half of requirements met |
| 2/10 | Few requirements met |
| 0/10 | Does not address requirements |

**Evidence required:**
- List each requirement with FIXED/PARTIAL/MISSING status
- Cite code locations for each fix
- Identify any bugs with line numbers

---

### 2. Safety (Weight: 20%)

**Description:** Does the solution protect existing data and handle errors safely?

**What to evaluate:**
- Destructive operations are guarded
- Input is validated
- Existing data is preserved
- Failure modes are graceful

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | Has dry-run/preview, validates all input, preserves existing data, graceful failures |
| 8/10 | Missing one of the above |
| 6/10 | Missing two of the above |
| 4/10 | Only basic safety (e.g., preserves existing data) |
| 2/10 | Minimal safety considerations |
| 0/10 | Could cause data loss |

**Evidence required:**
- Identify safety features present
- Check for unguarded destructive operations
- Verify existing data handling

---

### 3. Code Quality (Weight: 20%)

**Description:** Is the code readable, maintainable, and well-organized?

**What to evaluate:**
- Function organization and naming
- Code style consistency
- Comments where needed
- Linting/quality check compliance
- Appropriate abstraction level

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | Excellent organization, consistent style, passes all quality checks, appropriate comments |
| 8/10 | Good organization with minor style issues |
| 6/10 | Acceptable but could be better organized |
| 4/10 | Poorly organized or inconsistent |
| 2/10 | Difficult to read or maintain |
| 0/10 | Unmaintainable |

**Evidence required:**
- Quality check results (linting, type checking)
- Examples of good/bad organization
- Function size and complexity assessment

---

### 4. Feature Completeness (Weight: 15%)

**Description:** Does the solution implement all requested features?

**What to evaluate:**
- Required features present
- Optional/enhanced features
- Feature implementation quality

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | All required features + valuable enhancements |
| 8/10 | All required features, no enhancements |
| 6/10 | Most required features (80%+) |
| 4/10 | Half of required features |
| 2/10 | Few required features |
| 0/10 | Missing most features |

**Evidence required:**
- Feature checklist with present/absent status
- Quality assessment of each feature

---

### 5. Robustness (Weight: 10%)

**Description:** Does the solution handle unexpected situations gracefully?

**What to evaluate:**
- Error handling for edge cases
- Recovery from invalid states
- Atomic operations where appropriate
- Graceful degradation

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | Comprehensive error handling, atomic operations, graceful degradation |
| 8/10 | Good error handling with minor gaps |
| 6/10 | Basic error handling |
| 4/10 | Minimal error handling |
| 2/10 | Errors cause problems |
| 0/10 | No error handling |

**Evidence required:**
- Error handling patterns identified
- Edge case coverage assessment
- Atomic operation usage

---

### 6. Backwards Compatibility (Weight: 10%)

**Description:** Does the solution work with existing systems and data?

**What to evaluate:**
- Works with existing installations
- Migration path for legacy systems
- API compatibility (if applicable)
- Data format compatibility

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | Full compatibility + automatic migration |
| 8/10 | Full compatibility, manual migration |
| 6/10 | Mostly compatible with workarounds |
| 4/10 | Significant compatibility issues |
| 2/10 | Breaking changes with no migration |
| 0/10 | Incompatible |

**Evidence required:**
- Legacy system handling code
- Migration path documentation
- Breaking change identification

---

## Domain-Specific Criteria

### Performance (for performance-critical applications)

**Description:** Does the solution meet performance requirements?

**What to evaluate:**
- Response time / execution speed
- Memory usage
- Algorithmic complexity
- Caching effectiveness

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | Exceeds all performance targets |
| 8/10 | Meets all performance targets |
| 6/10 | Meets most targets, minor issues |
| 4/10 | Performance concerns in key areas |
| 2/10 | Significant performance problems |
| 0/10 | Unacceptable performance |

---

### Security (for security-sensitive applications)

**Description:** Does the solution follow security best practices?

**What to evaluate:**
- Input validation and sanitization
- Authentication/authorization
- Secure data handling
- Vulnerability prevention (OWASP top 10)

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | Comprehensive security measures, no vulnerabilities |
| 8/10 | Strong security with minor improvements possible |
| 6/10 | Basic security, some gaps |
| 4/10 | Security concerns in key areas |
| 2/10 | Significant security issues |
| 0/10 | Major vulnerabilities |

---

### Testability (for test-focused evaluations)

**Description:** How well can the solution be tested?

**What to evaluate:**
- Unit test coverage
- Integration test support
- Mock-ability of dependencies
- Test isolation

**Scoring rubric:**
| Score | Definition |
|-------|------------|
| 10/10 | >90% coverage, well-isolated, fully mockable |
| 8/10 | >80% coverage, good isolation |
| 6/10 | >60% coverage, some isolation issues |
| 4/10 | Limited testability |
| 2/10 | Difficult to test |
| 0/10 | Untestable |

---

## Customizing Weights

### Default Weights (General Purpose)

| Criterion | Weight |
|-----------|--------|
| Correctness | 25% |
| Safety | 20% |
| Code Quality | 20% |
| Feature Completeness | 15% |
| Robustness | 10% |
| Backwards Compatibility | 10% |
| **Total** | **100%** |

### Adjust Based on Context

| Context | Increase Weight For |
|---------|---------------------|
| Production deployment | Safety, Robustness |
| Rapid prototype | Feature Completeness, Correctness |
| Long-lived codebase | Code Quality, Backwards Compatibility |
| Security-sensitive | Safety (+ add Security criterion) |
| Performance-critical | Add Performance criterion |

---

## Calculating Weighted Total

```
Weighted Total = Σ (Score × Weight)
             = (Correctness × 0.25) + (Safety × 0.20) + ...
```

**Example:**
```
Solution C:
- Correctness: 9/10 × 0.25 = 2.25
- Safety: 9/10 × 0.20 = 1.80
- Code Quality: 9/10 × 0.20 = 1.80
- Feature Completeness: 10/10 × 0.15 = 1.50
- Robustness: 9/10 × 0.10 = 0.90
- Backwards Compat: 9/10 × 0.10 = 0.90

Weighted Total = 2.25 + 1.80 + 1.80 + 1.50 + 0.90 + 0.90 = 9.15/10
```

---

## Usage in Evaluator Prompts

Include the rubric in your evaluator prompt:

```markdown
## Evaluation Criteria

Assess each solution on:

### 1. Correctness (Weight: 25%)
Does it meet ALL requirements?
- 10/10: All requirements met with no bugs
- 8/10: All requirements met with minor issues
- 6/10: Most requirements met (80%+)
...

### 2. Safety (Weight: 20%)
...
```

This ensures evaluators have explicit scoring definitions, leading to more consistent and reproducible evaluations.
