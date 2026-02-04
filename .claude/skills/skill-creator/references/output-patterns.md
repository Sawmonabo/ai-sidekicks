# Output Patterns

<output-patterns>

Use these patterns when skills need to produce consistent, high-quality output.

<template-pattern>
## Template Pattern

Provide templates for output format. Match the level of strictness to your needs.

**Strict template** (for API responses, data formats):

<example>
```markdown
## Report structure

ALWAYS use this exact template structure:

# [Analysis Title]

## Executive summary
[One-paragraph overview of key findings]

## Key findings
- Finding 1 with supporting data
- Finding 2 with supporting data
- Finding 3 with supporting data

## Recommendations
1. Specific actionable recommendation
2. Specific actionable recommendation
```
</example>

**Flexible template** (when adaptation is useful):

<example>
```markdown
## Report structure

Here is a sensible default format, but use your best judgment:

# [Analysis Title]

## Executive summary
[Overview]

## Key findings
[Adapt sections based on what you discover]

## Recommendations
[Tailor to the specific context]

Adjust sections as needed for the specific analysis type.
```
</example>
</template-pattern>

<examples-pattern>
## Examples Pattern

For skills where output quality depends on seeing examples, provide input/output pairs:

<example>
```markdown
## Commit message format

Generate commit messages following these examples:

**Example 1:**
Input: Added user authentication with JWT tokens
Output:
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware

**Example 2:**
Input: Fixed bug where dates displayed incorrectly in reports
Output:
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation

Follow this style: type(scope): brief description, then detailed explanation.
```
</example>

Examples help Claude understand the desired style and level of detail more clearly than descriptions alone.
</examples-pattern>

<combined-patterns>
## Combining Patterns

For complex skills, combine templates with examples:

```markdown
## Output Format

Use this structure:

# [Title]
## Summary
[2-3 sentences]

## Details
[Bulleted findings]

### Example

**Input**: Analyze Q4 sales data
**Output**:
# Q4 Sales Analysis
## Summary
Q4 showed 15% growth over Q3, driven primarily by enterprise accounts.

## Details
- Enterprise revenue: $2.1M (+23%)
- SMB revenue: $800K (+5%)
- Churn rate decreased to 2.1%
```
</combined-patterns>

</output-patterns>
