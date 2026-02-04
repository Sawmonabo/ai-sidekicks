---
name: skill-creator
description: Create effective Claude Code skills through a guided interview process. Use when users want to create a new skill, update an existing skill, or need help designing skill architecture. Triggers on requests like "create a skill", "make a new skill", "build a skill for X", "help me design a skill", "/skill-creator", "new slash command", "write a skill", or mentions of SKILL.md structure and skill development.
---

# Skill Creator

Create effective, context-efficient skills through structured requirements gathering, then generate validated skill packages.

## What is a Skill?

Skills are modular, self-contained packages that extend Claude's capabilities with specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific domains—transforming Claude from a general-purpose agent into a specialized one.

**Skills provide:**
- **Specialized workflows** — Multi-step procedures for specific domains
- **Tool integrations** — Instructions for working with specific file formats or APIs
- **Domain expertise** — Company-specific knowledge, schemas, business logic
- **Bundled resources** — Scripts, references, and assets for complex tasks

<principles>
## Core Principles

### Concise is Key

The context window is a public good. Skills share context with system prompt, conversation history, other skills' metadata, and the user request. Only add what Claude doesn't already know.

**Default assumption**: Claude is already very smart. Challenge each line: "Does Claude really need this?" and "Does this justify its token cost?"

**Use** concise examples over verbose explanations.

### Degrees of Freedom

Match specificity to task fragility. Think of Claude exploring a path: a narrow bridge with cliffs needs guardrails (low freedom), while an open field allows many routes (high freedom).

| Freedom | Format | Use When |
|---------|--------|----------|
| High | Text instructions | Multiple valid approaches, decisions depend on context |
| Medium | Pseudocode/parameters | Preferred pattern exists, some variation acceptable |
| Low | Exact scripts | Operations are fragile, consistency critical, specific sequence required |
</principles>

## Skill Anatomy

Every skill consists of a required SKILL.md file and optional bundled resources:

```text
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter metadata (required)
│   │   ├── name: (required)
│   │   └── description: (required)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (Python/Bash/etc.)
    ├── references/       - Documentation loaded into context as needed
    └── assets/           - Files used in output (templates, icons, fonts, etc.)
```

### SKILL.md (required)

Every SKILL.md consists of:

- **Frontmatter** (YAML): Contains `name` and `description` fields. These are the only fields Claude reads to determine when the skill gets used, thus it is very important to be clear and comprehensive in describing what the skill is, and when it should be used.
- **Body** (Markdown): Instructions and guidance for using the skill. Only loaded AFTER the skill triggers (if at all).

<constraints>
#### Frontmatter Fields

**Required fields:**

| Field | Constraints |
|-------|-------------|
| `name` | Lowercase hyphen-case (`^[a-z0-9-]+$`), max 64 chars, no leading/trailing/consecutive hyphens. Valid: `pdf-editor`, `bigquery`. Invalid: `PDF-Editor`, `my_skill` |
| `description` | Max 1024 chars. PRIMARY trigger mechanism—include what it does, when to use, trigger phrases |

**Description best practices** — the description is the PRIMARY trigger mechanism. Include:
1. **What it does**: Core functionality in 1-2 sentences
2. **When to use**: Specific scenarios, file types, or tasks
3. **Trigger phrases**: Natural language patterns that should invoke it

**Optional fields:**

| Field | Description |
|-------|---------|
| `argument-hint` | Hint shown during autocomplete (e.g., `[issue-number]`) |
| `disable-model-invocation` | `true` prevents Claude from auto-loading; user must invoke via `/name` |
| `user-invocable` | `false` hides from `/` menu; use for background knowledge |
| `allowed-tools` | Tools Claude can use without permission when skill is active |
| `model` | Model to use when skill is active (haiku, sonnet, opus) |
| `context` | Set to `fork` to run in isolated subagent context |
| `agent` | Subagent type when `context: fork` (Explore, Plan, general-purpose, or custom) |
| `hooks` | Lifecycle hooks scoped to this skill |
</constraints>

<examples>
**Good description**:
```yaml
description: Create and edit PDF documents including form filling, page manipulation, and text extraction. Use when working with PDF files for merging, splitting, rotating pages, filling forms, or extracting content.
```

**Bad description**:
```yaml
description: PDF stuff
```
</examples>

#### Body Writing Style

- **Use imperative voice**: "Run the script" not "You should run"
- **Use** examples: Show, don't tell
- **Write** concisely: Every line must justify its token cost
- **Link, don't duplicate**: Reference detailed docs, don't inline them

#### XML Tag Convention

Use semantic XML tags to structure skill content for clear model parsing:

| Tag Type | Convention | Example |
|----------|------------|---------|
| Container sections | Plural | `<examples>`, `<constraints>`, `<instructions>` |
| Single items within containers | Singular | `<example>` inside `<instructions>` |
| Standalone sections | Descriptive | `<context>`, `<avoid>`, `<troubleshooting>` |
| Must-not-violate rules | `<critical>` | Wrap constraints that must never be violated |

#### Body Template

```yaml
---
name: skill-name
description: What this skill does and when to use it.
---

# Skill Title

## Overview
[1-2 sentences on purpose]

## Quick Start
[Most common use case with example]

## [Main Workflow/Tasks]
[Core instructions]

## Resources
[Links to scripts/, references/, assets/ as needed]
```

### Bundled Resources (optional)

#### Scripts (`scripts/`)

Executable code (Python/Bash/etc.) for tasks that require deterministic reliability or are repeatedly rewritten.

- **Include when**: The same code is being rewritten repeatedly or deterministic reliability is needed
- **Examples**: `scripts/rotate_pdf.py`, `scripts/validate_schema.py`, `scripts/deploy.sh`
- **Benefits**: Token efficient, deterministic, may be executed without loading into context
- **Note**: Scripts may still need to be read by Claude for patching or environment-specific adjustments

#### References (`references/`)

Documentation and reference material intended to be loaded as needed into context to inform Claude's process and thinking.

- **Include when**: Claude should reference documentation while working
- **Examples**: `references/schema.md` for database schemas, `references/api.md` for API specs, `references/policies.md` for company policies
- **Use cases**: Database schemas, API documentation, domain knowledge, company policies, detailed workflow guides
- **Benefits**: Keeps SKILL.md lean, loaded only when Claude determines it's needed
- **Best practice**: If files are large (>10k words), include grep search patterns in SKILL.md
- **Avoid duplication**: Information should live in either SKILL.md or references files, not both. Keep only essential procedural instructions in SKILL.md; move detailed reference material to references files.

#### Assets (`assets/`)

Files not intended to be loaded into context, but rather used within the output Claude produces.

- **Include when**: The skill needs files that will be used in the final output
- **Examples**: `assets/logo.png` for brand assets, `assets/template.pptx` for PowerPoint templates, `assets/frontend-template/` for HTML/React boilerplate
- **Use cases**: Templates, images, icons, boilerplate code, fonts, sample documents that get copied or modified
- **Benefits**: Separates output resources from documentation, enables Claude to use files without loading them into context

<avoid>
## What NOT to Include

**Skills are consumed by machines, not humans.** Never create auxiliary documentation files.

**Prohibited files** (delete if present):
- README.md, CHANGELOG.md, INSTALLATION.md, CONTRIBUTING.md
- QUICK_REFERENCE.md, SETUP.md, USAGE.md
- Any documentation about the skill creation process itself

**Development artifacts** (never commit):
- Test files, build artifacts, IDE configuration
- `__pycache__/`, `.vscode/`, `.idea/`

**Content anti-patterns**:
- Duplicate content across files — link to references instead
- Generic knowledge Claude already has — don't explain JSON or Git basics
- Version history or changelogs — non-actionable token waste
- Verbose explanations — prefer examples over paragraphs
- Commented-out code or unresolved TODOs — remove before packaging
- Setup instructions or prerequisites — the skill should just work
</avoid>

## Progressive Disclosure

Skills use a three-level loading system to manage context efficiently:

1. **Metadata (name + description)** — Always in context (~100 words)
2. **SKILL.md body** — Loaded when skill triggers (<5k words)
3. **Bundled resources** — Loaded as needed by Claude (scripts can execute without loading into context)

**Include** only essential information in SKILL.md body and keep under 500 lines to minimize context bloat. Split content into separate files when exceeding 400 lines. When splitting, reference files from SKILL.md and describe clearly when to read them.

**Key principle:** When a skill supports multiple variations, frameworks, or options, keep only the core workflow and selection guidance in SKILL.md. Move variant-specific details into separate reference files.

### Pattern 1: High-level guide with references

Keep SKILL.md focused on workflow; link to details:

```markdown
# PDF Processing

## Quick start
Extract text with pdfplumber:
[code example]

## Advanced features
- **Form filling**: See `references/forms.md` for complete guide
- **Batch processing**: See `references/batch.md` for patterns
- **API reference**: See `references/api.md` for all methods
```

Claude loads forms.md, batch.md, or api.md only when the user needs that feature.

### Pattern 2: Domain-specific organization

For skills with multiple domains, organize by domain to avoid loading irrelevant context:

```text
bigquery-skill/
├── SKILL.md (overview + navigation)
└── references/
    ├── finance.md (revenue, billing metrics)
    ├── sales.md (opportunities, pipeline)
    └── product.md (API usage, features)
```

When user asks about sales metrics, Claude only reads sales.md—not finance.md or product.md.

Similarly for multi-framework skills:

```text
cloud-deploy/
├── SKILL.md (workflow + provider selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

When user chooses AWS, Claude only reads aws.md.

### Pattern 3: Conditional details

Show basic content, link to advanced:

```markdown
# Document Processing

## Creating documents
Use python-docx for new documents. Basic example:
[simple code]

## Advanced scenarios
**For tracked changes**: See `references/redlining.md`
**For mail merge**: See `references/mail-merge.md`
```

Claude reads redlining.md only when user specifically needs tracked changes.

### Pattern Guidelines

- **Avoid deeply nested references** — Keep one level deep from SKILL.md
- **Structure files >100 lines** — Include table of contents at top so Claude sees full scope
- **Link** to existing content instead of duplicating it — Information lives in ONE place

## Token Budget

Skills share context with system prompts, conversation history, and user requests. Budget deliberately.

### Budget Allocations

| Component | Warning | Error | Notes |
|-----------|---------|-------|-------|
| SKILL.md body (tokens) | 3,000 | 4,600 | Core instructions only |
| SKILL.md body (lines) | 500 | 600 | Split when approaching limit |
| Single reference | 800 | 1,500 | Loaded on-demand |
| All references combined | 3,000 | 5,000 | User rarely needs all |
| Total skill | 6,000 | 8,000 | All components combined |

Thresholds defined in `scripts/lib/config.py` (single source of truth).

See `references/token-budget-guide.md` for optimization techniques and examples.

<instructions>
## Skill Creation Process

### Phase 1: Understand with Concrete Examples

Gather requirements through conversation. Ask 1-2 questions at a time to avoid overwhelming users.

**Key questions to explore:**

1. **Purpose & triggers**: "What should this skill do? What would a user say to trigger it?"
2. **Inputs & outputs**: "What inputs does it need? What should it produce?"
3. **Constraints**: "Are there specific rules, patterns, or limitations?"
4. **Resources**: "Would scripts, reference docs, or templates help?"
5. **Model scope**: "Should this work on Haiku/Sonnet/Opus, or Opus-only?"

Conclude this phase when the skill's functionality is clear.

<example>
**User**: "Create a skill that generates API documentation from code"

**Exploration**:
- Purpose: Analyze code files, generate OpenAPI/Swagger docs
- Triggers: "document this API", "generate API docs", "create swagger spec"
- Inputs: Python/TypeScript files with route definitions
- Outputs: OpenAPI 3.0 YAML with endpoints, parameters, schemas
- Constraints: Follow OpenAPI 3.0 spec, extract docstrings, infer types, skip private routes
- Resources: Validation script, OpenAPI schema reference, base template
- Model scope: Sonnet+ (code analysis needs reasoning)
</example>

### Phase 2: Planning

After the interview, summarize the Skill Intent:

```markdown
## Skill Intent Summary
- **Name**: [hyphen-case-name]
- **Purpose**: [1 sentence]
- **Triggers**: [phrases that invoke this skill]
- **Inputs**: [what the skill needs]
- **Outputs**: [what the skill produces]
- **Constraints**: [rules and limitations]
- **Resources**: [scripts/references/assets needed]
- **Model tier**: [all models | sonnet+ | opus-only]
```

**Identify** resources by analyzing each use case to determine what's reusable:

| Use Case | Analysis | Resource |
|----------|----------|----------|
| "Rotate this PDF" | Same rotation code each time | `scripts/rotate_pdf.py` |
| "Build me a todo app" | Same React boilerplate each time | `assets/frontend-template/` |
| "How many users logged in?" | Must rediscover BigQuery schemas | `references/schema.md` |

Get user confirmation before proceeding.

### Phase 3: Initialize

Skip this phase if iterating on an existing skill.

Run the initialization script:

```bash
scripts/init_skill.py <skill-name> --path <output-directory>
```

This creates the skill directory structure with templates.

### Phase 4: Implement

Remember: this skill is for another Claude instance. Include information that would be beneficial and non-obvious to Claude.

1. **Start with reusable resources**: Implement `scripts/`, `references/`, and `assets/` files identified in Phase 2. **Request** user input when needed (e.g., brand assets, company policies).

2. **Test scripts**: Run scripts to ensure no bugs and output matches expectations.

3. **Write SKILL.md**: Follow the structure and style guidelines in "Skill Anatomy" above. Write frontmatter first (name + description), then body.

4. **Delete unused files**: Remove example files from init_skill.py that aren't needed.

See `references/output-patterns.md` for formatting guidance.
See `references/workflows.md` for multi-step process patterns.

### Phase 5: Validate

#### 5.1 Script Testing

Test scripts manually before validation:
- [ ] Run each script in `scripts/` to verify it works
- [ ] Test with edge cases (empty input, missing files)

#### 5.2 Structural Validation

Run validation using XML output for complete, parseable results:

```bash
scripts/validate_skill.py <path/to/skill> --output=xml
```

<critical>
Always use `--output=xml` when validating. Never truncate validation output (e.g., with `head`) as this may hide errors or warnings.
</critical>

| Gate | Checks |
|------|--------|
| **Syntax** | YAML frontmatter, file structure |
| **Semantic** | Description quality, trigger clarity, voice consistency |
| **Budget** | Token limits, word counts |
| **Integrity** | Reference existence, no recursion patterns |

Fix all errors and review warnings before proceeding.

#### 5.3 Trigger Testing

Test that the skill triggers on expected phrases:

1. Install locally: Copy to `~/.claude/skills/` or project `.claude/skills/`
2. Start a new Claude Code session
3. Try each trigger phrase from the description
4. Verify the skill activates (check if instructions are being followed)

**If skill doesn't trigger:**
- Ensure description includes explicit trigger phrases
- Check for competing skills with similar descriptions
- Verify skill name and path are correct

#### 5.4 Functional Testing

Test actual functionality:

1. Run through the primary use case end-to-end
2. Test edge cases (empty input, large files, invalid data)
3. Verify scripts execute without errors
4. Check output matches expected format

#### 5.5 Model Compatibility Testing

If skill targets multiple models, test on each:

| Model | Testing Focus |
|-------|---------------|
| Haiku | Verify explicit instructions are followed |
| Sonnet | Test standard complexity tasks |
| Opus | Verify high-level guidance produces correct output |

### Phase 6: Package & Iterate

```bash
scripts/package_skill.py <path/to/skill> [output-dir]
```

Creates a `.skill` file (zip archive) for distribution.

After real usage, iterate:
1. Use the skill on actual tasks
2. Note struggles or inefficiencies
3. Update SKILL.md or resources
4. Re-validate and re-package
</instructions>

## Key Files

- `references/token-budget-guide.md` - Optimization techniques and examples
- `references/workflows.md` - Workflow patterns (sequential, conditional, error handling)
- `references/troubleshooting.md` - Common issues and fixes
- `references/output-patterns.md` - Output formatting guidance

## Reference Skills

Fetch these official Anthropic skills to see production examples of different architectures:

| Skill | Architecture | URL |
|-------|--------------|-----|
| docx | Complex (scripts + references) | `https://github.com/anthropics/skills/tree/main/docx` |
| pdf | Scripts + references | `https://github.com/anthropics/skills/tree/main/pdf` |
| pptx | Templates/assets | `https://github.com/anthropics/skills/tree/main/pptx` |

Full repository: `https://github.com/anthropics/skills`

## Final Checklist

- Run `scripts/validate_skill.py <path>` and verify all gates pass
- Test skill invocation with fresh Claude instance
- Verify trigger phrases activate skill correctly

After validation passes, output the full table format to the user:

```bash
scripts/validate_skill.py <path/to/skill>
```

Include a brief summary: skill name, purpose, token usage, and any warnings to be aware of.

See `references/troubleshooting.md` for common issues.
