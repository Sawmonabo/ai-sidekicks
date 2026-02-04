# Troubleshooting

<troubleshooting>
## Interview Phase Issues

| Problem | Cause | Resolution |
|---------|-------|------------|
| Vague answers | User unsure of requirements | Ask for a concrete example: "Walk me through a specific use case" |
| Conflicting requirements | Multiple stakeholders or use cases | Surface the conflict explicitly, ask user to prioritize |
| Scope creep | Expanding during interview | Capture extras as "future enhancements", focus on MVP |
| No clear trigger | Skill purpose is too broad | Ask: "What specific phrase would you type to invoke this?" |

## Validation Gate Failures

| Gate | Common Error | Fix |
|------|--------------|-----|
| **Syntax** | Invalid YAML frontmatter | Check colons have spaces after, quotes around special chars, proper indentation |
| **Syntax** | Missing required field | Add `name` and `description` to frontmatter |
| **Syntax** | Invalid name format | Use lowercase hyphen-case only: `my-skill` not `MySkill` or `my_skill` |
| **Semantic** | Second-person in body | Rewrite "You should run..." → "Run..." (imperative voice) |
| **Semantic** | Unresolved TODOs | Search for `[TODO` and complete or remove all placeholders |
| **Budget** | SKILL.md too large | Move detailed content to `references/` and link to it |
| **Budget** | Reference file too large | Split into multiple focused files by topic |
| **Integrity** | Referenced file not found | Create the missing file or remove the reference |
| **Integrity** | Self-reference detected | Remove any `/skill-creator` references from skill-creator itself |

## Packaging Issues

| Problem | Cause | Resolution |
|---------|-------|------------|
| Package script fails | Validation errors | Run `validate_skill.py` first, fix all errors |
| Large package size | Too many assets | Review assets/, remove unused files |
| Import errors | Missing dependencies | Check script imports, add fallbacks for optional deps |

## Post-Deployment Issues

| Problem | Cause | Resolution |
|---------|-------|------------|
| Skill doesn't trigger | Description lacks trigger phrases | Add explicit "Use when..." and example phrases |
| Wrong skill triggers | Description too generic | Make description more specific to intended use case |
| Inconsistent outputs | High degrees of freedom | Add output format template or examples |
| Works on Opus, fails on Haiku | Instructions too complex | Simplify, break into smaller steps, add examples |

## Runtime Issues

| Problem | Cause | Resolution |
|---------|-------|------------|
| Skill produces wrong output | Instructions misunderstood | Add explicit examples of expected output; test with smaller scope first |
| Script fails during execution | Missing dependencies or env issues | Test script manually outside skill; add error handling and clear error messages |
| Reference file not loaded | Claude didn't determine it was needed | Add explicit "Read references/file.md before..." instruction in SKILL.md |
| Context too large | Too many resources loaded at once | Use conditional loading; only reference files needed for specific tasks |
| Output format varies | No template provided | Add strict template pattern; use "ALWAYS use this exact format" |
| Skill runs but misses steps | Multi-step instructions unclear | Number steps explicitly; add checklist format; use `<critical>` tags for must-do items |
| Unexpected behavior on specific model | Model capability differences | Test on all target models; add model-specific guidance if needed |

### Debugging Steps

1. **Isolate the issue**: Test with minimal input to identify where behavior diverges
2. **Check context loading**: Verify references are being read by asking Claude what files it loaded
3. **Review instruction clarity**: Ensure steps are explicit and numbered, not implied
4. **Test incrementally**: Run skill phases separately to identify which step fails
5. **Add logging**: Include "Before proceeding, confirm you have..." checkpoints in instructions
</troubleshooting>
