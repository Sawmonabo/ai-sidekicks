# Token Budget Optimization Guide

<context>
## Why Optimization Matters

The context window is shared between system prompt (~2,500 tokens), tool definitions (~15,000 tokens), conversation history, skill metadata, active skill body, and user request. Every token in your skill competes with tokens needed for the actual task.
</context>

<instructions>

## Optimization Techniques

### 1. Prefer Examples Over Explanations

<example>
**Before (67 tokens)**:
```markdown
When creating commit messages, you should follow the conventional
commits specification which requires a type, optional scope, and
description. The type should be one of feat, fix, docs, style,
refactor, test, or chore. The scope is optional and describes
the section of the codebase affected.
```

**After (34 tokens)**:
```markdown
## Commit format
`type(scope): description`

Examples:
- `feat(auth): add OAuth login`
- `fix(api): handle null response`
```
</example>

### 2. Use Tables for Structured Data

<example>
**Before (45 tokens)**:
```markdown
The name field must be a string with lowercase letters, digits,
and hyphens only. It cannot start or end with a hyphen and cannot
contain consecutive hyphens. Maximum length is 64 characters.
```

**After (28 tokens)**:
```markdown
| Field | Rule |
|-------|------|
| name | `^[a-z0-9-]+$`, no leading/trailing `-`, max 64 |
```
</example>

### 3. Link Instead of Inline

<example>
**Before**:
```markdown
[500 tokens of API documentation inline]
```

**After**:
```markdown
See `references/api.md` for endpoint details.
```
</example>

### 4. Eliminate Redundancy

- **Omit** explanations of concepts Claude already knows
- **Write** information in one location only
- **Omit** contextual information unless it affects task execution

### 5. Use Hierarchical References

For large domains, split by topic:

```text
references/
├── overview.md      # 200 tokens - always read first
├── api-auth.md      # 400 tokens - if auth needed
├── api-queries.md   # 600 tokens - if querying
└── api-mutations.md # 500 tokens - if mutating
```

Claude reads overview.md, then only the specific reference needed.

### 6. Large File Strategies

For reference files >10k words, include grep patterns in SKILL.md:

```markdown
## Schema Reference
Full schema: `references/schema.md`

**Quick lookup patterns:**
- User fields: `grep "## User" references/schema.md`
- Order fields: `grep "## Order" references/schema.md`
```
</instructions>

<constraints>
## Budget Thresholds

**Single source of truth**: `scripts/lib/config.py`

```bash
python3 scripts/lib/config.py  # View current thresholds
```

**Quick estimate**: Characters ÷ 4 ≈ tokens (or run `scripts/validate_skill.py <path>`)

### Enforcement

| Component | Enforcement |
|-----------|-------------|
| SKILL.md body | Errors if exceeded |
| Single reference | Warnings only |
| Total skill | Errors if exceeded |

<example>
**Valid skill** (large reference, under total budget):
```
SKILL.md:        2,000 tokens
reference.md:    3,000 tokens  # Would warn, but doesn't block
─────────────────────────────
Total:           5,000 tokens  # Under 8,000 budget = PASS
```
</example>

### Environment Override

```bash
SKILL_TOTAL_BUDGET=10000 scripts/validate_skill.py my-skill
```

### Common Causes of Budget Violations

1. **SKILL.md too large**: Move detailed content to references/
2. **Total exceeds budget**: Not all references need loading simultaneously
3. **Verbose explanations**: Replace with examples
4. **Redundant content**: Information should live in ONE place
</constraints>
