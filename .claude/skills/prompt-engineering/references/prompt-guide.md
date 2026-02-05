# Prompt Engineering Guide

## Table of Contents

1. [Claude Model Behavior](#part-1-claude-model-behavior)
2. [Extended Thinking](#part-2-extended-thinking)
3. [Prompt Components](#part-3-prompt-components)
4. [Component Combinations](#part-4-component-combinations)
5. [Subagent Orchestration](#part-5-subagent-orchestration)
6. [Best Practices](#part-6-best-practices)
7. [XML Tag Reference](#part-7-xml-tag-reference)
8. [Pattern Quick Reference](#part-8-pattern-quick-reference)
9. [Customization Tips](#part-9-customization-tips)

---

## Part 1: Claude Model Behavior

Claude models (Opus, Sonnet, Haiku) are trained for precise instruction following. Understanding their behavior is essential for effective prompts.

### Explicit Instruction Following

Claude follows instructions precisely - no more, no less. If you want
comprehensive output, say so explicitly.

#### Basic (gets minimal result):
```text
Create a dashboard
```

#### Explicit (gets comprehensive result):
```text
Create an analytics dashboard. Include as many relevant features
and interactions as possible. Go beyond the basics.
```

### Thinking Word Sensitivity

When extended thinking is DISABLED, the word "think" can cause issues.

**Replacements:**
| Avoid | Use Instead |
|-------|-------------|
| think | consider, evaluate, assess |
| think through | reason through, work through |
| think step by step | consider step by step |
| think about | examine, analyze |

**Example:**
```markdown
<!-- Instead of -->
<instructions>Think through this problem step by step.</instructions>

<!-- Use -->
<instructions>Consider this problem step by step.</instructions>
```

### Tool Usage Patterns

Claude is conservative with tool calls. Provide explicit direction:

```markdown
<!-- Vague - Claude may not act -->
<instructions>Can you look into the authentication issue?</instructions>

<!-- Explicit - Claude will act -->
<instructions>
1. Read the files in src/auth/ using the read tool
2. Search for "login" errors in the logs
3. Identify the root cause and propose a fix
</instructions>
```

### Communication Style

Claude is more concise and direct. Match this in your prompts:
- Remove hedging language ("maybe", "perhaps", "you might want to")
- Use direct imperatives ("Analyze", "Create", "Review")
- Specify length if longer output is needed

---

## Part 2: Extended Thinking

Extended thinking provides Claude with internal reasoning budget for complex tasks.

### When to Use

| Good Fit | Poor Fit |
|----------|----------|
| Multi-step mathematical proofs | Simple factual queries |
| Complex code architecture decisions | Straightforward formatting |
| Nuanced policy analysis | Low-latency requirements |
| Tasks requiring verification | Basic classification |

### Prompting Techniques

**Prefer high-level goals over step-by-step instructions:**

```markdown
<!-- Less effective for extended thinking -->
<instructions>
1. First, identify the variables
2. Then, set up the equation
3. Next, solve for x
</instructions>

<!-- More effective -->
<instructions>
Solve this math problem thoroughly. Consider multiple approaches
and verify your solution. Show your complete reasoning.
</instructions>
```

**Let Claude determine its reasoning approach** - the model's creativity often exceeds prescribed steps.

### Budget Management

- Start with minimum: 1024 tokens
- Increase incrementally based on task complexity
- Use batch processing for budgets >32K tokens

### Multishot with Extended Thinking

Use `<scratchpad>` or `<reasoning>` in examples to demonstrate thinking patterns:

```markdown
<examples>
<example>
<input>What is 15% of 80?</input>
<scratchpad>
Convert 15% to decimal: 0.15
Multiply: 0.15 × 80 = 12
</scratchpad>
<output>12</output>
</example>
</examples>
```

### Verification Prompts

Ask Claude to verify before completing:
```markdown
<instructions>
Before declaring complete, verify your solution with test cases:
- Edge case 1: [description]
- Edge case 2: [description]
Fix any issues you find.
</instructions>
```

---

## Part 3: Prompt Components

Ten components for building prompts. Use minimal sets for simple tasks, full framework for complex ones.

### 1. Role Definition

Establishes expertise level. Use principal-level indicators.

```markdown
<role>
You are a principal security engineer with deep expertise in
application security and threat modeling. You've conducted
hundreds of security reviews for production systems.
</role>
```

**Principal indicators:** principal, staff, distinguished, chief, "deep expertise in", "10+ years"

### 2. Context Setting

Background information Claude needs.

```markdown
<context>
## Environment
Production API serving 1M+ daily requests, 99.9% uptime requirement.

## Users
Backend developers with varying experience levels.

## Constraints
Must maintain backward compatibility for 6 months.
</context>
```

### 3. Task Instructions

Clear directions with action verbs.

```markdown
<instructions>
# Your Task
Review the provided code for security vulnerabilities.

## Requirements
1. Identify all OWASP Top 10 vulnerabilities
2. Provide specific line numbers for each issue
3. Suggest concrete fixes with code examples

## Process
1. Read the entire codebase first
2. Analyze each file systematically
3. Prioritize findings by severity
</instructions>
```

**Action verbs:** analyze, create, review, implement, identify, compare, evaluate

### 4. Input Specification

Marks user-provided data.

```markdown
<input>
{{USER_CODE}}
</input>
```

**Reference explicitly:**
```markdown
Using the code in <input> tags, identify all SQL injection vulnerabilities.
```

### 5. Constraints & Rules

Boundaries stated positively.

```markdown
<constraints>
## Required Behaviors
- Provide specific line numbers for all findings
- Include working code fixes, not just descriptions

## Boundaries
- Keep total response under 500 words
- Focus on security issues only, not style

## If Uncertain
State assumptions clearly and ask for clarification.
</constraints>
```

### 6. Output Format

Response structure.

```markdown
<output_format>
## Summary
[1-2 sentence overview]

## Critical Issues
| Issue | Location | Fix |
|-------|----------|-----|
| [name] | line X | [code] |

## Recommendations
[Prioritized action items]
</output_format>
```

**For structured data:**
```markdown
<output_format>
Return as JSON:
{
  "summary": "string",
  "findings": [{"issue": "string", "severity": "high|medium|low", "line": number}]
}
</output_format>
```

### 7. Examples (Few-shot)

2-3 diverse demonstrations.

```markdown
<examples>
<example>
<input>Review: def get_user(id): return db.query(f"SELECT * FROM users WHERE id = {id}")</input>
<output>
## Critical Issues
1. **SQL Injection** (Line 1)
   - String interpolation allows arbitrary SQL
   - Fix: `db.query("SELECT * FROM users WHERE id = ?", [id])`
</output>
</example>
</examples>
```

**Best practices:**
- Include edge cases
- Show realistic scenarios
- Align perfectly with instructions

### 8. Success Criteria

Definition of done.

```markdown
<success_criteria>
Your response is successful when:
- All security vulnerabilities are identified with severity
- Each issue has a specific, working code fix
- Response is organized by severity (critical → low)
</success_criteria>
```

### 9. Error Handling

Edge case guidance.

```markdown
<error_handling>
If code is incomplete or unclear:
1. State what information is missing
2. Provide analysis based on available code
3. Note assumptions made

If no issues found:
1. Confirm thorough review was conducted
2. Highlight positive security practices observed
</error_handling>
```

### 10. Thinking Structure

Reasoning scaffolds. **Avoid `<thinking>` if extended thinking is disabled, unless explicitly asked to do so.**

```markdown
<analysis_protocol>
Before responding:
1. Analyze the input in <analysis> tags
2. Plan your approach in <planning> tags
3. Provide your response in <answer> tags
</analysis_protocol>
```

---

## Part 4: Component Combinations

### Minimal (Simple Tasks)
```markdown
<role>[Brief principal role]</role>
<instructions>[Clear task]</instructions>
<output_format>[Structure]</output_format>
```

### Standard (Most Tasks)
```markdown
<role>[Principal role with expertise]</role>
<context>[Background]</context>
<instructions>[Detailed steps]</instructions>
<constraints>[Boundaries]</constraints>
<output_format>[Structure]</output_format>
<examples>[1-2 examples]</examples>
```

### Comprehensive (Complex Tasks)
All 10 components as needed.

---

## Part 5: Subagent Orchestration

Claude has strong native subagent orchestration capabilities. Use subagents for context management and role specialization.

### When to Use Subagents

| Use Subagents | Don't Use Subagents |
|---------------|---------------------|
| Task requires fresh context | Simple, focused tasks |
| Specialized roles needed | Tight coupling required |
| Parallel independent work | Continuous state needed |
| Long-running tasks | Quick interactions |
| Previous context polluted | Context is clean and relevant |

### Context Isolation Benefits

Each subagent starts with a fresh context window:
- No pollution from previous failed attempts
- Focused on specific subtask
- Can process large inputs independently

### Role Specialization Patterns

Define clear roles for each agent:

```markdown
<agents>
  <researcher>
  Focus: Gather information and document findings
  Context: Start fresh, explore codebase
  Output: Structured research notes
  </researcher>

  <implementer>
  Focus: Write code based on research findings
  Context: Receives research notes only
  Output: Working implementation
  </implementer>

  <reviewer>
  Focus: Validate implementation against requirements
  Context: Receives requirements + implementation
  Output: Review findings and approval
  </reviewer>
</agents>
```

### Delegation Patterns

**Explicit delegation:**
```markdown
<instructions>
This task has three phases. Spawn a subagent for each:
1. Research agent: Explore the codebase and document patterns
2. Implementation agent: Write the feature using documented patterns
3. Review agent: Verify the implementation
</instructions>
```

**Natural delegation:**
Claude can recognize when tasks benefit from subagents and delegate proactively. To enable:
- Ensure subagent tools are available
- Don't over-constrain the approach
- Let Claude orchestrate naturally

### State Handoff Pattern

Pass only essential state between agents. Use descriptive tag names to identify the target:

```markdown
<implementer_handoff>
## Task Definition
[What the next agent needs to accomplish]

## Key Findings
[Essential discoveries from previous agent]

## Constraints
[What NOT to do]

## Success Criteria
[How to verify completion]
</implementer_handoff>
```

**Naming pattern:** When handing off to different agents, use descriptive names:
- `<researcher_handoff>` - handoff to research agent
- `<implementer_handoff>` - handoff to implementation agent
- `<reviewer_handoff>` - handoff to review agent

**Avoid passing:**
- Full conversation history
- Irrelevant context
- Failed attempts (unless debugging)

---

## Part 6: Best Practices

### Positive Framing

| Negative | Positive |
|----------|----------|
| Don't be verbose | Keep responses under 200 words |
| Never use jargon | Use plain language |
| Avoid speculation | State only verified facts |

### Action Verbs

Use explicit verbs in instructions:
- **Analysis:** analyze, evaluate, assess, compare, identify
- **Creation:** create, write, implement, design, build
- **Review:** review, verify, validate, check, audit

### Context Motivation

Explain WHY to improve Claude's performance:

```markdown
<instructions>
Review this authentication code for security vulnerabilities.

Why this matters: This code protects user accounts containing
financial data. A vulnerability here could expose millions of
users to fraud.
</instructions>
```

### Prefill Technique

Start Claude's response to enforce format:

```text
User: Classify this customer feedback
Assistant: <classification>
```

This guarantees the output starts with your specified structure.

---

## Part 7: XML Tag Reference

### Tag Categories

| Category | Tags | Purpose |
|----------|------|---------|
| Structural | `<role>`, `<context>`, `<instructions>`, `<constraints>`, `<output_format>` | Prompt organization |
| Thinking | `<analysis>`, `<planning>`, `<reasoning>`, `<scratchpad>`, `<answer>` | Reasoning scaffolds |
| Data | `<input>`, `<document>`, `<code>`, `<data>`, `<file>` | Content containers |
| Examples | `<examples>`, `<example>` | Few-shot demonstrations |

**Note:** Avoid `<thinking>` when extended thinking is disabled.

### Naming Conventions

- **Do:** lowercase, descriptive (`<security_findings>`, `<output_format>`)
- **Don't:** CamelCase (`<SecurityFindings>`), abbreviations (`<sf>`)

### Nesting Pattern

```markdown
<examples>
  <example>
    <input>User query</input>
    <output>Expected response</output>
  </example>
</examples>
```

### Reference Tags Explicitly

```markdown
<instructions>
Using the code in <input> tags, identify all vulnerabilities.
Based on the context in <context>, prioritize by business impact.
</instructions>
```

### Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| No tags | Ambiguous boundaries | Use XML to separate sections |
| "the above code" | Vague reference | "the code in `<input>` tags" |
| Over-nesting | Hard to parse | Flatten to 2-3 levels max |

---

## Part 8: Pattern Quick Reference

| Use Case | Pattern | Key Components |
|----------|---------|----------------|
| Simple task | RTF | role, task, format |
| Code review | CIE + constraints | context, instructions, examples, constraints |
| API design | PGC + examples | persona, goal, constraints, examples |
| System prompt | Full framework | All 10 components |
| Complex analysis | Extended thinking | High-level goals, verification |
| Multi-step workflow | Subagent orchestration | Agent roles, handoff, coordination |

---

## Part 9: Customization Tips

1. **Adjust expertise level** for your domain
   - "principal security engineer" vs "principal data scientist"

2. **Add domain context** specific to your use case
   - Industry regulations, team standards, tech stack

3. **Include real examples** from your actual scenarios
   - The more realistic, the better Claude performs

4. **Modify output format** for your workflow
   - JSON for APIs, markdown for docs, structured text for reports

5. **Tune constraints** based on needs
   - Stricter for production, looser for exploration

6. **Start minimal, add complexity**
   - Begin with RTF, add components only as needed

---

## Sources

- [Prompt Engineering Overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview)
- [Claude 4 Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)
- [Extended Thinking Tips](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/extended-thinking-tips)
- [XML Tags Guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/use-xml-tags)

---

*Last Updated: January 2026*
