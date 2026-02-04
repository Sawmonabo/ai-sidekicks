# Claude Code Structure Guide

## Complete Reference for .claude Directory Structure, Skills, Hooks, Agents, and Best Practices

**Last Updated:** January 27, 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Directory Structure](#directory-structure)
   - [User-Level Structure](#user-level-structure)
   - [Project-Level Structure](#project-level-structure)
   - [Root-Level Files](#root-level-files)
3. [Skills Configuration](#skills-configuration)
   - [Skill Directory Structure](#skill-directory-structure)
   - [SKILL.md Format](#skillmd-format)
   - [Frontmatter Schema](#frontmatter-schema)
   - [Best Practices for Skills](#best-practices-for-skills)
4. [Hooks Configuration](#hooks-configuration)
   - [Hook Structure](#hook-structure)
   - [Available Hook Events](#available-hook-events)
   - [Configuration Examples](#configuration-examples)
5. [Custom Agents/Subagents](#custom-agentssubagents)
   - [Agent File Structure](#agent-file-structure)
   - [Creating Agents](#creating-agents)
   - [Using Agents in Skills](#using-agents-in-skills)
6. [CLAUDE.md Best Practices](#claudemd-best-practices)
   - [Purpose and Structure](#purpose-and-structure)
   - [Recommended Template](#recommended-template)
   - [Critical Guidelines](#critical-guidelines)
7. [Custom Commands](#custom-commands)
8. [Component Relationships & Architecture](#component-relationships--architecture)
   - [How Skills, Commands, and Agents Work Together](#how-skills-commands-and-agents-work-together)
   - [The Unified Flow](#the-unified-flow)
   - [DRY Principles & Avoiding Redundancy](#dry-principles--avoiding-redundancy)
   - [Progressive Disclosure Architecture](#progressive-disclosure-architecture)
   - [Reusable Components Strategy](#reusable-components-strategy)
   - [Practical Architecture Example](#practical-architecture-example)
9. [MCP Integration](#mcp-integration)
10. [Plugin Structure](#plugin-structure)
11. [Key Takeaways](#key-takeaways)
12. [References](#references)

---

## Overview

Claude Code uses a `.claude` directory structure to organize skills, agents, hooks, and configuration. This structure can exist at both user-level (global) and project-level (local), following a hierarchical override pattern.

**Core Philosophy**: Claude Code is intentionally low-level and unopinionated, providing close to raw model access without forcing specific workflows. This creates a flexible, customizable, scriptable, and safe power tool.

---

## Directory Structure

### User-Level Structure

Located at `~/.claude/`, this contains global configuration available across all projects:

```text
~/.claude/
├── skills/              # Personal skills available across all projects
│   └── my-skill/
│       └── SKILL.md
├── agents/              # Custom subagents available globally
│   └── my-agent.md
├── plans/               # Plan documents storage
│   └── my-plan.md
└── settings.json        # User-level configuration
```

### Project-Level Structure

Located at `.claude/` in your project root:

```text
.claude/
├── skills/              # Project-specific skills
│   └── project-skill/
│       ├── SKILL.md
│       ├── scripts/
│       ├── references/
│       └── assets/
├── agents/              # Project-specific subagents
│   └── project-agent.md
├── commands/            # Custom slash commands (prompt templates)
│   ├── debug-loop.md
│   └── analyze-logs.md
├── plans/               # Project plan documents
├── settings.json        # Project configuration (committed to git)
└── settings.local.json  # Local config (gitignored)
```

### Root-Level Files

```text
project-root/
├── .claude/             # Claude configuration directory
├── CLAUDE.md            # Project instructions (committed to git)
├── CLAUDE.local.md      # Personal instructions (gitignored)
└── .mcp.json            # MCP server configuration
```

**Configuration Hierarchy**: Settings are loaded in order of specificity:

1. User-level: `~/.claude/settings.json`
2. Project-level: `.claude/settings.json`
3. Local override: `.claude/settings.local.json`

---

## Skills Configuration

Skills are folders of instructions, scripts, and resources that Claude loads dynamically to improve performance on specialized tasks. Skills follow the **Agent Skills open standard**, which works across multiple AI tools.

### Skill Directory Structure

The recommended structure for a skill:

```text
.claude/skills/my-skill/
├── SKILL.md          # Core prompt and instructions (REQUIRED)
├── scripts/          # Executable Python/Bash scripts (optional)
├── references/       # Documentation loaded into context (optional)
└── assets/           # Templates and binary files (optional)
```

**Important**: Skills must be placed directly under `skills/` directory. Nested directories are not currently supported (flat structure only).

### SKILL.md Format

Every skill requires a `SKILL.md` file with two parts:

1. **YAML Frontmatter** (between `---` markers) - Configuration metadata
2. **Markdown Content** - Instructions Claude follows when skill is invoked

**Example**:

```yaml
---
name: code-reviewer
description: Reviews code for quality, security, and best practices. Use when asked to review code or before merging pull requests.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob
agent: general-purpose
model: sonnet
version: 1.0.0
---

# Code Review Instructions

You are a code reviewer. When invoked, analyze the code systematically and provide specific, actionable feedback.

## Review Checklist

1. **Security**: Check for common vulnerabilities (XSS, SQL injection, etc.)
2. **Performance**: Identify potential bottlenecks
3. **Best Practices**: Verify code follows project standards
4. **Testing**: Ensure adequate test coverage

## Output Format

Provide feedback in this format:

### Critical Issues
- [List any security or breaking issues]

### Improvements
- [List optimization opportunities]

### Style & Standards
- [List minor issues and suggestions]
```

### Frontmatter Schema

#### Required Fields

- **`name`**: Maximum 64 characters, lowercase letters/numbers/hyphens only, no XML tags, no reserved words
- **`description`**: Maximum 1024 characters, non-empty, no XML tags. This is the primary triggering mechanism - include both what the skill does AND specific triggers/contexts for when to use it.

#### Optional Fields

- **`disable-model-invocation`**: `true` = Only you can invoke the skill (Claude won't auto-trigger)
- **`user-invocable`**: `false` = Only Claude can invoke the skill (not available as slash command)
- **`allowed-tools`**: Comma-separated list of tools the skill can access (e.g., `Read, Grep, Bash`)
- **`agent`**: Which subagent to use (`Explore`, `Plan`, `general-purpose`, or custom agent name)
- **`context`**: Execution context (`fork` = execute in forked context with summarized results)
- **`model`**: Model to use (`sonnet`, `opus`, `haiku`)
- **`version`**: Version number for the skill

### Best Practices for Skills

1. **Clear Naming**: The folder name becomes the slash command (e.g., `my-skill/` → `/my-skill`)

2. **Specific Descriptions**: Include triggering keywords and contexts in the description:

   ```yaml
   # Good
   description: Reviews code for quality, security, and best practices. Use when asked to review code or before merging pull requests.

   # Poor
   description: Reviews code
   ```

3. **Separate Concerns**: Create separate skills for different purposes rather than one mega-skill

4. **Progressive Disclosure**: Don't load everything into context - tell Claude how to find information when needed:

   ```markdown
   See ./references/api-guidelines.md for detailed API standards
   See ./scripts/analyze.py for automated analysis tools
   ```

5. **Tool Restrictions**: Use `allowed-tools` to limit what the skill can do for safety:

   ```yaml
   allowed-tools: Read, Grep  # Read-only operations
   ```

6. **Skill Locations**:
   - `~/.claude/skills/` - Personal skills available in all projects
   - `.claude/skills/` - Project-specific skills (commit to git for team sharing)

---

## Hooks Configuration

Hooks are user-defined shell commands that execute at various points in Claude Code's lifecycle, providing deterministic control over behavior.

### Hook Structure

Hooks are configured in `settings.json` files:

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here"
          }
        ]
      }
    ]
  }
}
```

### Available Hook Events

1. **`PreToolUse`**: Runs before tool calls and can block them
2. **`PostToolUse`**: Runs after tool execution
3. **`UserPromptSubmit`**: Runs when user submits a prompt (before Claude processes it)
4. **`PermissionRequest`**: Runs when a permission dialog is shown
5. **`SessionEnd`**: Runs when Claude Code session ends

### Configuration Examples

#### Example 1: Log Bash Commands

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.command' | tee -a /tmp/bash-commands.log"
          }
        ]
      }
    ]
  }
}
```

#### Example 2: Auto-Format TypeScript Files

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit:*.ts",
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write \"${FILE_PATH}\""
          }
        ]
      }
    ]
  }
}
```

#### Example 3: Intelligent Skill Suggestion

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/suggest-skills.sh"
          }
        ]
      }
    ]
  }
}
```

**Example `suggest-skills.sh` script**:

```bash
#!/bin/bash
# Read user prompt and conversation context, suggest relevant skills

PROMPT=$(cat)

if echo "$PROMPT" | grep -qi "review\|pr\|pull request"; then
  echo "💡 Suggestion: Use /code-reviewer skill"
fi

if echo "$PROMPT" | grep -qi "test\|testing"; then
  echo "💡 Suggestion: Use /test-runner skill"
fi
```

#### Example 4: Block Dangerous Operations

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash:*rm -rf*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'BLOCKED: rm -rf is not allowed' && exit 1"
          }
        ]
      }
    ]
  }
}
```

### Configuration File Locations

- `~/.claude/settings.json` - User-level (global) hooks
- `.claude/settings.json` - Project-level hooks (committed to git)
- `.claude/settings.local.json` - Local project hooks (gitignored)

---

## Custom Agents/Subagents

Custom subagents are specialized agents with their own system prompts and tool configurations.

### Agent File Structure

Subagents are defined in Markdown files with YAML frontmatter:

**File Location**:

- `~/.claude/agents/my-agent.md` (user-level)
- `.claude/agents/my-agent.md` (project-level)

**Format**:

```yaml
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer specialized in security and performance analysis.

# Your Task

When invoked, you will:

1. Analyze the provided code for security vulnerabilities
2. Check for performance bottlenecks
3. Verify adherence to best practices
4. Provide specific, actionable feedback

# Guidelines

- Focus on critical issues first
- Provide code examples for fixes
- Explain the "why" behind each suggestion
- Be constructive and specific

# Output Format

Structure your review as:

## Security Issues
[List with severity levels]

## Performance Concerns
[List with impact estimates]

## Best Practice Violations
[List with explanations]

## Recommendations
[Prioritized action items]
```

### Creating Agents

**Interactive Method**: Use the `/agents` command for guided setup:

```bash
# In Claude Code
/agents
```

This provides an interface to:

- View all available subagents (built-in, user, project, plugin)
- Create new subagents with guided setup
- Choose "User-level" (saves to `~/.claude/agents/`) or "Project-level" (saves to `.claude/agents/`)

**Manual Method**: Create a `.md` file directly in the agents directory with the structure shown above.

### Using Agents in Skills

Reference custom agents in skill frontmatter:

```yaml
---
name: security-audit
description: Performs comprehensive security audit of the codebase
agent: code-reviewer        # Use custom agent
context: fork               # Execute in forked context
allowed-tools: Read, Grep, Glob
---

Perform a thorough security audit of all code files.
Use the code-reviewer agent to analyze each critical file.
```

**Built-in Agents**:

- `Explore` - Fast codebase exploration
- `Plan` - Software architecture planning
- `general-purpose` - General task execution
- `Bash` - Command execution specialist

---

## CLAUDE.md Best Practices

### Purpose and Structure

`CLAUDE.md` is persistent memory for Claude Code, automatically read at the start of each session. It contains project-specific instructions you'd otherwise repeat in every prompt.

**Key Principle**: Keep it concise and use progressive disclosure. Frontier LLMs can follow ~150-200 instructions with reasonable consistency.

### Recommended Template

Structure your `CLAUDE.md` using the **What, Why, How** framework:

```markdown
# Project Name

Brief one-sentence description of the project.

## What (Tech Stack)

- **Framework**: Next.js 14 with App Router
- **Database**: PostgreSQL with Prisma ORM
- **Styling**: Tailwind CSS + shadcn/ui components
- **Testing**: Jest + React Testing Library
- **Deployment**: Vercel

## Why (Purpose & Architecture)

This is an e-commerce platform that handles high-volume transactions.

**Key Design Decisions**:
- Server components by default for performance
- API routes follow RESTful conventions
- Database queries use Prisma for type safety

## How (Workflows & Commands)

### Development Commands

    npm run dev          # Start development server
    npm test             # Run test suite
    npm run build        # Production build
    npm run lint         # Run ESLint
    npm run type-check   # TypeScript validation

### Development Workflow

1. **Branch Strategy**: Create feature branch from `main`
2. **TDD Approach**: Write tests first, then implement
3. **Code Review**: All PRs require one approval
4. **Commit Messages**: Use conventional commits format

### Project Structure

    src/
    ├── app/          # Next.js app router pages
    ├── components/   # React components (grouped by feature)
    ├── lib/          # Business logic and utilities
    ├── hooks/        # Custom React hooks
    └── types/        # TypeScript type definitions

### Coding Standards

- Use functional components with hooks
- Keep components under 200 lines
- Extract complex logic to custom hooks or lib functions
- Use absolute imports: `@/components/...`

### Testing Guidelines

- Unit test all business logic in `lib/`
- Integration test API routes
- E2E test critical user flows
- Minimum 80% coverage required

## Additional Resources

**Detailed Documentation**:

- API Guidelines: `./docs/api-guidelines.md`
- Database Schema: `./docs/database-schema.md`
- Component Library: `./docs/components.md`

**When you need to**:

- Add new API route → See `./docs/api-guidelines.md`
- Modify database → See `./docs/database-schema.md`
- Create component → See `./docs/components.md` and `./src/components/README.md`

```

### Critical Guidelines

**1. Keep It Concise**: Include only universally applicable information

- ✅ "Run tests: `npm test`"
- ❌ "To run tests, you can use npm test which will execute Jest test runner..."

**2. Progressive Disclosure**: Reference external docs instead of including everything

```markdown
# Good
See ./docs/api-guidelines.md for API standards

# Bad
[Paste 1000 lines of API documentation here]
```

**3. Specific Commands**: Always provide exact commands, not descriptions

```markdown
# Good
npm run build && npm run deploy

# Bad
Build the project and then deploy it
```

**4. Output Preferences** (Optional): Control Claude's verbosity

```markdown
## Output Preferences
- Plan output: maximum 200 words
- Heading hierarchy: up to h3 only
- Always include file names and line numbers
- End plans with 1-3 specific questions
```

**5. Location & Scope**:

- Place at repo root (most common)
- Can add scoped `CLAUDE.md` in subdirectories for local rules
- Use `CLAUDE.local.md` for personal instructions (gitignored)

**6. Team Sharing**:

- Commit `CLAUDE.md` to git for team-wide instructions
- Keep it updated as project evolves
- Document team-specific conventions and preferences

---

## Custom Commands

Custom commands are prompt templates stored as Markdown files that become available as slash commands.

### Structure

**Location**: `.claude/commands/`

**Example**: `.claude/commands/debug-loop.md`

```markdown
---
name: debug-loop
description: Start an interactive debugging session
---

Start a debugging session for the issue described below.

For each iteration:
1. Analyze the error
2. Form a hypothesis
3. Test the hypothesis
4. Repeat until resolved

Issue: {cursor}
```

### Usage

After creating command files:

1. Type `/` in Claude Code to see available commands
2. Commands are automatically available to all team members when committed to git
3. Can include placeholders like `{cursor}` for dynamic content

---

## Component Relationships & Architecture

Understanding how skills, commands, agents, and hooks work together is crucial for building a reusable, DRY-compliant Claude Code configuration.

### How Skills, Commands, and Agents Work Together

#### **Skills**

- **What they are**: Self-contained capabilities that Claude discovers automatically by matching your request to skill descriptions
- **Auto-invoked**: Claude reads the conversation, matches context to skill descriptions, and loads them autonomously
- **Specialized prompt templates**: Inject domain-specific instructions into the conversation context
- **Can leverage agents**: Skills can specify `context: fork` with an `agent:` field to run in a subagent (Explore, Plan, general-purpose, or custom agents from `.claude/agents/`)
- **Can invoke commands**: Agents executing skills can invoke commands as part of their workflow
- **Follow progressive disclosure**: Load information only as needed (table of contents → chapters → appendix)

**Example skill with agent**:

```yaml
---
name: security-audit
description: Performs comprehensive security audit. Use when asked about security vulnerabilities or before production deployment.
agent: general-purpose
context: fork
allowed-tools: Read, Grep, Glob
---

Perform a thorough security audit of all code files.
Focus on OWASP Top 10 vulnerabilities.
```

#### **Commands**

- **What they are**: User-invoked reusable prompt templates (slash commands like `/review`)
- **Explicit invocation**: Unlike skills, commands require the user to type `/command-name`
- **Relationship to skills**: A file at `.claude/commands/review.md` and a skill at `.claude/skills/review/SKILL.md` both create `/review` and work identically
- **Key difference**: Commands require explicit user invocation, skills are auto-discovered and invoked by Claude
- **Can leverage agents**: Commands can invoke subagents for planning/execution

**Decision guide**:

- **Use Skills** when: Claude should auto-discover and invoke autonomously based on context
- **Use Commands** when: You want explicit user control over invocation
- **Don't duplicate**: Having both creates redundancy

#### **Agents**

- **What they are**: Standalone specialized workers with their own context, tools, and instructions
- **Not nested**: Agents aren't nested in skills—they're independent executors
- **Can execute skills**: When an agent runs, it can use skills as reference material or execute skill workflows
- **Can invoke commands**: Agents can invoke commands as part of their execution
- **Relationship**: Agents are the **workers** that execute both skills and commands

**Built-in Agents**:

- `Explore` - Fast codebase exploration
- `Plan` - Software architecture planning
- `general-purpose` - General task execution
- `Bash` - Command execution specialist

**Custom Agent Example**:

```yaml
---
name: test-runner
description: Specialized in running tests and analyzing results
tools: Read, Bash, Grep
model: sonnet
---

You are a testing specialist. When invoked, you will:
1. Identify the test framework in use
2. Run appropriate test commands
3. Analyze failures and provide actionable feedback
4. Suggest fixes for failing tests
```

#### **Hooks**

- **What they are**: Scripts configured in `settings.json` that intercept events (PreToolUse, PostToolUse, UserPromptSubmit, PermissionRequest, SessionEnd)
- **Relationship**: Independent from skills/commands/agents—they intercept tool calls and can block/modify behavior
- **Gatekeepers**: Hooks act as gatekeepers that can validate, log, or prevent actions
- **Use cases**: Logging, auto-formatting, blocking dangerous operations, suggesting skills

### The Unified Flow

```text
User Request → Claude (main)
                  ↓
        ┌─────────┼─────────┐
        ↓         ↓         ↓
    Skill¹    Command²   Hook³
        ↓         ↓         ↓
      Agent → Execute → Scripts

¹ Auto-discovered by Claude based on context
² Explicitly invoked by user (/command-name)
³ Intercepts and can block/modify actions
```

**Flow Explanation**:

1. **User makes a request** to Claude
2. **Claude (main agent)** processes the request and determines the approach:
   - **Skills**: Claude automatically discovers relevant skills by matching the request context to skill descriptions
   - **Commands**: User explicitly invokes with `/command-name`
   - **Hooks**: Intercept tool calls at various lifecycle events
3. **Agents execute the work**:
   - Skills can fork execution to specialized agents (built-in or custom)
   - Commands can invoke subagents for structured workflows
   - Agents can execute both skills and commands as parallel workers
4. **Scripts are invoked**: Skills and agents can call scripts from their directories
5. **Hooks intercept**: PreToolUse hooks can block dangerous operations, PostToolUse hooks can auto-format, etc.

**Key Relationships**:

- **Agents are workers** that execute skills and commands
- **Skills and commands are playbooks** that define what work to do
- **Hooks are gatekeepers** that intercept and control actions
- **CLAUDE.md is persistent memory** that provides context to all components

### DRY Principles & Avoiding Redundancy

To follow Don't Repeat Yourself (DRY) principles in your `.claude` configuration:

#### **1. Avoid Skills/Commands Duplication**

**❌ BAD - Redundant**:

```text
.claude/
├── commands/
│   └── review.md        # Creates /review
└── skills/
    └── review/
        └── SKILL.md     # Also creates /review
```

**✅ GOOD - Single source**:

```text
.claude/
└── skills/
    └── review/
        ├── SKILL.md     # Creates /review, auto-invoked
        ├── scripts/
        └── references/
```

**Decision Matrix**:

| Scenario                                    | Use Skill    | Use Command                |
|---------------------------------------------|--------------|----------------------------|
| Claude should auto-invoke based on context  | Yes          | No                         |
| User wants explicit control                 | No           | Yes                        |
| Complex workflow with scripts/references    | Yes          | Can use, but skills better |
| Simple prompt template                      | Either works | Yes                        |

#### **2. CLAUDE.md as Single Source of Truth**

**Purpose**: Eliminate repeated instructions across sessions

```markdown
# CLAUDE.md - Single source of project context

## Coding Standards
- Use functional components with hooks
- Keep components under 200 lines
- Extract logic to custom hooks

## Commands
npm test        # Run tests
npm run build   # Production build

## Workflows
1. Create feature branch from main
2. Write tests first (TDD)
3. Run tests before committing
```

**Anti-pattern**: Repeating these instructions in every prompt or in multiple skills

#### **3. Reusable Scripts Across Skills**

**✅ GOOD - Shared scripts directory**:

```text
.claude/
├── scripts/               # Shared scripts
│   ├── analyze.py
│   └── format.sh
└── skills/
    ├── code-review/
    │   └── SKILL.md      # References ../scripts/analyze.py
    └── refactor/
        └── SKILL.md      # Also references ../scripts/analyze.py
```

Skills can reference shared scripts:

```markdown
# In SKILL.md
See ../scripts/analyze.py for code analysis tools
```

#### **4. Progressive Disclosure - Don't Inline Everything**

**❌ BAD - Everything in SKILL.md**:

```yaml
---
name: api-guidelines
---

# API Guidelines
[3000 lines of API documentation pasted here]
```

**✅ GOOD - Progressive disclosure**:

```yaml
---
name: api-guidelines
---

# API Guidelines

See ./references/rest-api.md for REST API standards
See ./references/graphql.md for GraphQL standards
See ./references/auth.md for authentication patterns

When you need specific guidance, read the relevant reference file.
```

#### **5. Custom Agents for Reusable Workflows**

**✅ GOOD - Reusable agent**:

```text
.claude/
├── agents/
│   └── security-reviewer.md   # Reusable security agent
└── skills/
    ├── pre-commit-check/
    │   └── SKILL.md            # Uses security-reviewer agent
    └── pr-review/
        └── SKILL.md            # Also uses security-reviewer agent
```

Both skills reference the same agent:

```yaml
---
name: pr-review
agent: security-reviewer
context: fork
---
```

#### **6. Data-Driven Flywheel**

Continuously refine based on actual usage:

```text
Bugs/Issues → Improved CLAUDE.md/Skills → Better Agent Performance
     ↑                                              ↓
     └──────────────────────────────────────────────┘
```

**Process**:

1. Monitor what goes wrong or requires repeated prompting
2. Extract patterns into CLAUDE.md or new skills
3. Agent performance improves with better context
4. Fewer bugs, clearer workflows
5. Continue refining

### Progressive Disclosure Architecture

Progressive disclosure is the core design principle for scalable Agent Skills—like a well-organized manual with a table of contents, specific chapters, and detailed appendices.

**Structure**:

```text
SKILL.md (Table of Contents - Always loaded)
    ↓
./references/ (Chapters - Loaded when needed)
    ↓
./scripts/ (Appendix - Called when required)
```

**Example**:

```text
.claude/skills/api-development/
├── SKILL.md              # High-level guide (always loaded)
├── references/
│   ├── rest-api.md       # Load when working with REST
│   ├── graphql.md        # Load when working with GraphQL
│   └── websocket.md      # Load when working with WebSocket
└── scripts/
    ├── validate-api.py   # Call when validation needed
    └── generate-docs.sh  # Call when docs generation needed
```

**SKILL.md (Table of Contents)**:

```yaml
---
name: api-development
description: Guides API development following project standards. Use when creating or modifying API endpoints.
allowed-tools: Read, Edit, Bash
---

# API Development Guide

This skill helps you develop APIs following our standards.

## When to use this skill
- Creating new API endpoints
- Modifying existing endpoints
- Validating API responses

## Available References

**REST APIs**: See ./references/rest-api.md
**GraphQL**: See ./references/graphql.md
**WebSocket**: See ./references/websocket.md

## Available Scripts

**Validation**: Run `python scripts/validate-api.py <endpoint>`
**Documentation**: Run `bash scripts/generate-docs.sh`

## Quick Standards

- Use HTTP status codes correctly (200, 201, 400, 404, 500)
- Always validate input
- Include error messages in responses
- Document all endpoints

For detailed standards, read the appropriate reference file above.
```

**Benefits**:

- ✅ Claude loads only the context needed for the current task
- ✅ Reduces token usage significantly
- ✅ Faster processing and response times
- ✅ Easier to maintain and update individual sections
- ✅ Scales to large, complex projects

### Reusable Components Strategy

Build your `.claude` configuration as a layered architecture:

```text
Layer 1: CLAUDE.md (Persistent context for all sessions)
           ↓
Layer 2: Skills (Reusable auto-invoked playbooks)
           ↓
Layer 3: Agents (Specialized workers that execute skills)
           ↓
Layer 4: Scripts (Called by skills/agents for automation)
           ↓
Layer 5: Hooks (Intercept and control all actions)
```

**Design Principles**:

1. **CLAUDE.md**: Universal project context
   - Tech stack
   - Coding standards
   - Development workflows
   - Links to detailed docs

2. **Skills**: Specialized capabilities
   - Domain-specific (e.g., security, testing, API development)
   - Auto-invoked based on context
   - Reference external files for details
   - Can fork to specialized agents

3. **Agents**: Task executors
   - Reusable across multiple skills
   - Focused on specific domains
   - Custom tool configurations

4. **Scripts**: Automation
   - Shared across skills
   - Called when needed
   - Keep in central `/scripts` or skill-specific directories

5. **Hooks**: Governance
   - Validate operations
   - Auto-format code
   - Block dangerous commands
   - Log activities

### Practical Architecture Example

Here's a complete, DRY-compliant architecture:

```text
project-root/
├── CLAUDE.md                           # Persistent memory
├── .claude/
│   ├── settings.json                   # Hooks configuration
│   ├── scripts/                        # Shared scripts
│   │   ├── security-scan.py
│   │   └── test-runner.sh
│   ├── agents/
│   │   ├── security-specialist.md      # Reusable security agent
│   │   └── test-specialist.md          # Reusable test agent
│   └── skills/
│       ├── security-review/
│       │   ├── SKILL.md                # Uses security-specialist agent
│       │   ├── references/
│       │   │   ├── owasp-top-10.md
│       │   │   └── auth-patterns.md
│       │   └── scripts/ -> ../../scripts/  # Symlink to shared scripts
│       ├── test-coverage/
│       │   ├── SKILL.md                # Uses test-specialist agent
│       │   └── references/
│       │       └── test-standards.md
│       └── performance-audit/
│           ├── SKILL.md                # Uses general-purpose agent
│           └── references/
│               └── benchmarks.md
└── .mcp.json                           # External tools
```

**How it works together**:

1. **User**: "Review this code for security issues"

2. **Claude (main)**:
   - Reads CLAUDE.md for project context
   - Auto-discovers `security-review` skill based on description match

3. **security-review skill**:
   - Forks execution to `security-specialist` agent
   - Provides high-level instructions
   - References `./references/owasp-top-10.md` for details

4. **security-specialist agent**:
   - Executes the security review
   - Calls `../../scripts/security-scan.py` for automated checks
   - Returns results to main Claude

5. **PostToolUse hook**:
   - Intercepts any file edits
   - Auto-formats code with prettier

6. **Result**: User gets comprehensive security review without redundant configuration

**Key Benefits**:

- ✅ No duplication: Security agent reused across multiple skills
- ✅ DRY scripts: Shared scripts directory
- ✅ Progressive disclosure: References loaded only when needed
- ✅ Clear separation: Each component has a single responsibility
- ✅ Maintainable: Update security standards in one place
- ✅ Scalable: Easy to add new skills that leverage existing agents/scripts

---

## MCP Integration

Model Context Protocol (MCP) allows Claude to connect to external tools and services.

### Configuration

Create `.mcp.json` in your project root (commit to git):

```json
{
  "mcpServers": {
    "puppeteer": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
    },
    "sentry": {
      "command": "npx",
      "args": ["-y", "@anthropics/mcp-server-sentry"],
      "env": {
        "SENTRY_AUTH_TOKEN": "${SENTRY_AUTH_TOKEN}"
      }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

### Important Warning

⚠️ **Don't enable all MCPs at once**: Your 200k context window can shrink to 70k with too many tools enabled.

**Best Practice**: Only enable MCP servers you actively need for your current work.

---

## Plugin Structure

For advanced use cases, Claude Code supports plugins with the following structure:

```text
.claude-plugin/
├── plugin.json       # Plugin metadata
├── commands/         # Plugin commands
├── agents/           # Plugin agents
├── skills/           # Plugin skills
├── hooks/            # Plugin hooks
└── .mcp.json         # External tool configuration
```

**plugin.json Example**:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Custom plugin for team workflows",
  "author": "Your Team"
}
```

---

## Key Takeaways

### Claude Code Directory Structure

- ✅ **Flat structure**: Skills must be placed directly under `skills/` (no nesting)
- ✅ **Three levels**: User (`~/.claude/`), Project (`.claude/`), Local (`.claude/*.local.*`)
- ✅ **Commit pattern**: Commit `CLAUDE.md` and `.claude/settings.json`, gitignore `*.local.*`

### Component Relationships

- ✅ **Skills**: Auto-invoked capabilities that Claude discovers by matching context to descriptions
- ✅ **Commands**: User-invoked prompt templates (explicit `/command` invocation)
- ✅ **Agents**: Standalone workers that execute skills and commands
- ✅ **Hooks**: Gatekeepers that intercept and can block/modify tool calls
- ✅ **CLAUDE.md**: Persistent memory providing context to all components

### DRY Principles

- ✅ **No duplication**: Don't create both `.claude/commands/review.md` and `.claude/skills/review/SKILL.md`
- ✅ **Reusable agents**: Create custom agents that multiple skills can reference
- ✅ **Shared scripts**: Use central scripts directory, reference from skills
- ✅ **Progressive disclosure**: Reference external files instead of inlining everything
- ✅ **Data-driven flywheel**: Bugs → Improved CLAUDE.md/Skills → Better performance

### Skills

- ✅ **Naming**: Folder name = command name (e.g., `my-skill/` → `/my-skill`)
- ✅ **Description**: Primary trigger mechanism - be specific and include keywords
- ✅ **Separation**: Create separate skills for different purposes
- ✅ **Tools**: Use `allowed-tools` to restrict capabilities for safety
- ✅ **Can leverage agents**: Use `agent:` and `context: fork` to run in specialized agents
- ✅ **Auto-discovery**: Claude loads skills based on context match

### Commands

- ✅ **User-invoked**: Require explicit `/command-name` invocation
- ✅ **vs Skills**: Same structure, different invocation mechanism
- ✅ **When to use**: When you want explicit user control over execution
- ✅ **Don't duplicate**: Choose either skill or command, not both

### Agents

- ✅ **Built-in**: Explore, Plan, general-purpose, Bash
- ✅ **Custom**: Store in `~/.claude/agents/` or `.claude/agents/`
- ✅ **Usage**: Reference in skill frontmatter with `agent:` field
- ✅ **Standalone**: Not nested in skills—they execute skills and commands
- ✅ **Reusable**: Multiple skills can use the same agent

### CLAUDE.md

- ✅ **Concise**: ~150-200 instructions maximum
- ✅ **Progressive**: Reference external docs, don't inline everything
- ✅ **Specific**: Provide exact commands, not descriptions
- ✅ **Structure**: Use What, Why, How framework
- ✅ **Single source of truth**: Eliminates repeated instructions across sessions

### Hooks

- ✅ **Events**: PreToolUse, PostToolUse, UserPromptSubmit, PermissionRequest, SessionEnd
- ✅ **Blocking**: PreToolUse hooks can block dangerous operations
- ✅ **Automation**: PostToolUse for auto-formatting, linting, etc.
- ✅ **Independent**: Separate from skills/commands/agents architecture
- ✅ **Gatekeepers**: Intercept and validate all tool calls

### MCP

- ✅ **Selective**: Only enable MCPs you actively need
- ✅ **Context**: Too many MCPs reduce available context window (200k → 70k)
- ✅ **Sharing**: Commit `.mcp.json` for team-wide tools

### Agent Skills Standard

- ✅ **Portable**: Skills work across multiple AI tools
- ✅ **Extensions**: Claude Code extends standard with invocation control, subagents, dynamic context

### Unified Architecture

```text
User Request → Claude (main) → CLAUDE.md context
                  ↓
        ┌─────────┼─────────┐
        ↓         ↓         ↓
    Skills¹   Commands²  Hooks³
        ↓         ↓         ↓
      Agents → Execute → Scripts

¹ Auto-discovered  ² User-invoked  ³ Intercept actions
```

---

## References

### Official Documentation

- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills)
- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Create Custom Subagents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Skill Authoring Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

### Best Practices & Guides

- [Claude Code: Best Practices for Agentic Coding](https://www.anthropic.com/engineering/claude-code-best-practices)
- [The Complete Guide to CLAUDE.md](https://www.builder.io/blog/claude-md-guide)
- [Writing a Good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- [Claude Code Customization Guide](https://alexop.dev/posts/claude-code-customization-guide-claudemd-skills-subagents/)
- [Claude Skills and CLAUDE.md: 2026 Guide for Teams](https://www.gend.co/blog/claude-skills-claude-md-guide)
- [My 7 Essential Claude Code Best Practices](https://www.eesel.ai/blog/claude-code-best-practices)
- [Mastering the Vibe: Claude Code Best Practices That Actually Work](https://dinanjana.medium.com/mastering-the-vibe-claude-code-best-practices-that-actually-work-823371daf64c)
- [Creating the Perfect CLAUDE.md for Claude Code](https://dometrain.com/blog/creating-the-perfect-claudemd-for-claude-code/)

### Understanding Component Relationships

- [Understanding Claude Code: Skills vs Commands vs Subagents vs Plugins](https://www.youngleaders.tech/p/claude-skills-commands-subagents-plugins)
- [When to Use Claude Code Skills vs Commands vs Agents](https://danielmiessler.com/blog/when-to-use-skills-vs-commands-vs-agents)
- [Commands vs Skills vs Agents in Claude Code: What Nobody Explains](https://prosperinai.substack.com/p/claude-code-commands-skills-agents)
- [Claude Skills, Commands, Agents: Toward a Unified Mission](https://dongliang.medium.com/claude-skills-commands-agents-toward-a-unified-mission-29b87e385729)
- [How to Use Claude Code: A Guide to Slash Commands, Agents, Skills, and Plug-Ins](https://www.producttalk.org/how-to-use-claude-code-features/)

### Community Resources

- [Anthropic Skills Repository](https://github.com/anthropics/skills)
- [Claude Code Showcase - Comprehensive Configuration Example](https://github.com/ChrisWiles/claude-code-showcase)
- [Everything Claude Code](https://github.com/affaan-m/everything-claude-code)
- [Awesome Claude Code - Curated List](https://github.com/hesreallyhim/awesome-claude-code)
- [Awesome Claude Code - Visual Directory](https://awesomeclaude.ai/awesome-claude-code)
- [Claude HowTo - Visual Example-Driven Guide](https://github.com/luongnv89/claude-howto)
- [Claude Config - Comprehensive Framework](https://github.com/Aurealibe/claude-config)
- [Ultimate Guide to Extending Claude Code](https://gist.github.com/alirezarezvani/a0f6e0a984d4a4adc4842bbe124c5935)

### Engineering Deep Dives

- [Equipping Agents for the Real World with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Building Agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Claude Agent Skills: A First Principles Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/)

### Articles & Tutorials

- [Claude Code Explained: CLAUDE.md, /command, SKILL.md, hooks, subagents](https://avinashselvam.medium.com/claude-code-explained-claude-md-command-skill-md-hooks-subagents-e38e0815b59b)
- [How to Create Claude Code Skills: The Complete Guide](https://websearchapi.ai/blog/how-to-create-claude-code-skills)
- [Claude Code Hooks: A Practical Guide to Workflow Automation](https://www.datacamp.com/tutorial/claude-code-hooks)
- [How I Use Every Claude Code Feature](https://blog.sshh.io/p/how-i-use-every-claude-code-feature)
- [A Guide to Claude Code 2.0 and Getting Better at Using Coding Agents](https://sankalp.bearblog.dev/my-experience-with-claude-code-20-and-how-to-get-better-at-using-coding-agents/)
- [Cooking with Claude Code: The Complete Guide](https://www.siddharthbharath.com/claude-code-the-complete-guide/)
- [Shipyard Claude Code CLI Cheatsheet](https://shipyard.build/blog/claude-code-cheat-sheet/)
- [ClaudeLog - Docs, Guides, Tutorials & Best Practices](https://claudelog.com/)

---

**Document Version**: 2.0
**Last Updated**: January 27, 2026
**Maintained By**: Based on Anthropic official documentation and community best practices

**Changelog**:

- v2.0 (January 27, 2026): Added Component Relationships & Architecture section with detailed explanations of how skills, commands, agents, and hooks work together; added DRY principles and avoiding redundancy guidelines; expanded references with 2026 sources
- v1.0 (January 21, 2026): Initial comprehensive guide
