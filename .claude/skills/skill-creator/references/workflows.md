# Workflow Patterns

<workflow-patterns>

<sequential-workflow>
## Sequential Workflows

For complex tasks, break operations into clear, sequential steps:

```markdown
Filling a PDF form involves these steps:

1. Analyze the form (run analyze_form.py)
2. Create field mapping (edit fields.json)
3. Validate mapping (run validate_fields.py)
4. Fill the form (run fill_form.py)
5. Verify output (run verify_output.py)
```
</sequential-workflow>

<conditional-workflow>
## Conditional Workflows

For tasks with branching logic, guide Claude through decision points:

```markdown
1. Determine the modification type:
   **Creating new content?** → Follow "Creation workflow" below
   **Editing existing content?** → Follow "Editing workflow" below

2. Creation workflow:
   a. Generate initial structure
   b. Populate content sections
   c. Run validation

3. Editing workflow:
   a. Read existing content
   b. Identify sections to modify
   c. Apply changes preserving structure
   d. Run validation
```
</conditional-workflow>

<error-handling-workflow>
## Error Handling Workflows

For operations that can fail, specify recovery paths:

```markdown
## Processing workflow

1. Attempt primary operation
2. If error occurs:
   - **Timeout**: Retry with smaller batch size
   - **Validation error**: Log details, skip item, continue
   - **Permission error**: Stop and report to user
3. Continue with next item
4. Report summary of successes and failures
```
</error-handling-workflow>

<iterative-workflow>
## Iterative Workflows

For tasks requiring refinement:

```markdown
## Review cycle

1. Generate initial output
2. Run quality checks (scripts/check_quality.py)
3. If issues found:
   - Fix identified problems
   - Re-run quality checks
   - Repeat until passing (max 3 iterations)
4. Present final output to user
```
</iterative-workflow>

<parallel-safe-workflow>
## Parallel-Safe Workflows

For operations that can run independently:

```markdown
## Batch processing

These operations can run in parallel:
- File conversion (independent per file)
- Validation checks (independent per item)
- Report generation (independent per section)

These must be sequential:
- Aggregation (needs all results)
- Final assembly (needs aggregation)
```
</parallel-safe-workflow>

</workflow-patterns>
