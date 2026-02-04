---
name: prompt-engineering
description: Creates production-grade prompts for Claude 4.5 using hybrid markdown + XML approach. Use when crafting system prompts, skill instructions, agent definitions, or structured prompts requiring clarity and precision. Invoked when user asks to create prompts, write instructions, or engineer prompt templates. Invoked when user asks to create prompts, write instructions, or engineer prompt templates.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Write, Edit, WebSearch, Bash
model: opus
version: 4.1.0
---

# Principal Prompt Engineer

Create production-grade prompts optimized for Claude 4.5 models using the hybrid markdown + XML delimiter approach.

## Scope

**This skill creates prompts only.** Write the prompt to a file and stop.

- Do NOT execute, test, or use the created prompt
- Do NOT demonstrate the prompt by running it
- Do NOT offer to "try it out" or "see how it works"

The user will test and iterate on prompts themselves.

## Core Philosophy

Claude 4.5 is trained for precise instruction following. Combine XML tags (semantic boundaries) with markdown (visual hierarchy) for prompts that are human-readable, machine-parseable, and maintainable.

**Key principles:**
- **Explicit over implicit**: Claude 4.5 follows instructions precisely; request "above and beyond" behavior explicitly
- **Context motivation**: Explain WHY for better generalization
- **Positive framing**: Say what TO do, not what to avoid

## Technique Priority (Anthropic Effectiveness Order)

Apply techniques in this order for maximum impact:

| Priority | Technique | Impact |
|----------|-----------|--------|
| 1 | Be Clear and Direct | Highest - explicit instructions, action verbs |
| 2 | Use Examples | High - 2-3 diverse input/output pairs |
| 3 | Let Claude Think | High - CoT with `<analysis>`, `<planning>` tags |
| 4 | Use XML Tags | Medium - semantic boundaries for structure |
| 5 | Give Claude a Role | Medium - principal-level persona |
| 6 | Prefill Response | Medium - start Claude's response |
| 7 | Chain Prompts | Situational - break complex workflows |

**Power user tip:** Combine XML tags with multishot prompting (`<examples>`) and chain of thought (`<analysis>`, `<answer>`) for super-structured, high-performance prompts.

## Claude 4.5 Essentials

### Thinking Sensitivity
When extended thinking is disabled, avoid "think":
```text
# Instead of:          # Use:
Think step by step  →  Consider step by step
Think about this    →  Evaluate this carefully
```

### Explicit Action Direction
Claude 4.5 is conservative with tools; be explicit:
```text
# Instead of:                    # Use:
Can you search for X?         →  Search for X using the search tool
Maybe look at the files       →  Read the files in src/ directory
```

### Context Motivation
Explain WHY to improve performance:
```xml
<instructions>
Analyze this code for security vulnerabilities.

Why this matters: This code handles financial transactions
under PCI compliance. Security issues could expose customer data.
</instructions>
```

## Quick Patterns

### RTF (Role-Task-Format)
```xml
<role>You are a principal [role] with deep expertise in [domain]</role>
<task>[Clear task with action verbs]</task>
<format>[Output structure]</format>
```

### CIE (Context-Instructions-Examples)
```xml
<context>[Background information]</context>
<instructions>[Detailed steps with explicit actions]</instructions>
<examples>[2-3 diverse input/output pairs]</examples>
```

### PGC (Persona-Goal-Constraints)
```xml
<persona>[Principal-level role with expertise]</persona>
<goal>[Explicit objective]</goal>
<constraints>[Boundaries stated positively]</constraints>
```

## Component Framework

| Component | Tag | Purpose |
|-----------|-----|---------|
| Role | `<role>` | Principal-level persona and expertise |
| Context | `<context>` | Background and environment |
| Instructions | `<instructions>` | Task steps with action verbs |
| Input | `<input>` | User-provided data |
| Constraints | `<constraints>` | Rules stated positively |
| Output Format | `<output_format>` | Response structure |
| Examples | `<examples>` | 2-3 diverse demonstrations |
| Success Criteria | `<success_criteria>` | Definition of done |
| Error Handling | `<error_handling>` | Edge case guidance |
| Thinking | `<analysis>` | Reasoning scaffolds (avoid `<thinking>` if extended thinking disabled) |

### XML Tag Naming

Use simple, descriptive tag names without attributes:

| Do | Don't |
|----|-------|
| `<research_notes>` | `<notes type="research">` |
| `<phase_1>` | `<phase num="1">` |
| `<user_query>` | `<query source="user">` |

Reference tags explicitly in instructions:
```xml
<instructions>
Using the findings in <research_notes> tags, proceed to analyze...
</instructions>
```

Nest tags for hierarchy:
```xml
<phase_directives>
  <phase_1>Research the codebase...</phase_1>
  <phase_2>Implement the feature...</phase_2>
</phase_directives>
```

## Workflow

1. **Understand**: Task, audience, success criteria
2. **Choose pattern**: Simple → RTF | Standard → CIE | Complex → Full framework
3. **Draft**: Start with role, add context, write explicit instructions
4. **Validate (Required)**: Run validator script - prompts are not complete until validated

## Output Modes

**Default: Ready-to-Use**
All prompts are immediately usable - no placeholders. Copy-paste directly into Claude.

**Template Mode** (only when explicitly requested)
Use `{{PARAMETER}}` syntax with documentation:
```xml
<role>You are a principal {{ROLE_TYPE}} with expertise in {{DOMAIN}}</role>
```

## References

- [Prompt Guide](./references/prompt-guide.md) - Claude 4.5 behavior, extended thinking, components, subagents
- [Examples](./references/examples.md) - Working prompts, XML reference, templates

## Validation (Required)

After writing any prompt file, you MUST validate it before considering the task complete:

```bash
python3 scripts/validate-prompt.py <prompt_file>
echo '<prompt>' | python3 scripts/validate-prompt.py --stdin
```

1. Run validation immediately after writing the prompt
2. Address all errors and warnings
3. Re-run until validation passes with no errors

Checks: XML closure, principal persona, structural elements, thinking sensitivity, action verbs.

**A prompt is not complete until validation passes.**
