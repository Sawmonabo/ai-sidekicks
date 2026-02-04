# TODO - Updates and Future Improvements

## Prompt Engineering Skill - Pending Updates

### TODO: Add Clarification Protocol

Add a new section to SKILL.md after the Workflow section:

#### Clarification Protocol

When encountering ambiguity or uncertainty about requirements, approach, or implementation:

**Action**: STOP and ask the user for clarification. Never guess or assume.

Use the AskUserQuestion tool with specific, concrete options when possible:
- Frame questions with 2-4 distinct choices
- Include descriptions explaining the implications of each choice
- Add "(Recommended)" to the suggested option if one is clearly better

```markdown
### Examples of when to ask:
<examples>
- Target audience unclear (developers vs end-users vs executives)
- Output format not specified (structured XML vs conversational)
- Scope ambiguous (single prompt vs multi-prompt workflow)
- Domain expertise level unknown (novice vs expert persona)
- Success criteria undefined
</examples>
```

**Never assume** the user's intent. A clarifying question takes seconds; fixing a misaligned prompt wastes significant effort.

---

### TODO: Add Output Location Requirement

Add a new section to SKILL.md specifying where prompts should be saved:

#### Output Location

All created prompts MUST be saved to:
```text
/tmp/claude-designed-prompts/
```

### TODO: Updates SKILL.md to Enhance Progressive Disclosure

Leverage semantic search based off of the user's request to find the most relevant references to include in the prompt such as:

```markdown
<examples>
  <example>
    - User requests: "Create a prompt for orchestrating|subagents ... "
    - Relevant references: "orchestration.md", "subagents.md",
    <reference-topics>
      - orchestration of subagents
      - subagents
      - subagent communication
      - subagent coordination
      - subagent collaboration
      - subagent cooperation
      - subagent competition
      - subagent conflict
      - subagent cooperation
      - subagent cooperation
      - permission management
      - context management
      - context sharing
      - context synchronization
      - context consistency
      - context isolation
      - context pollution
      - context leakage
      - context contamination
    </reference-topics>
  </example>
  <example>
    - User requests: "Create a prompt for ... research|websearch|webfetch ... "
    - Relevant references: "research.md", "websearch.md", "webfetch.md"

  </example>
  <example>
    - User requests: "Create a prompt for a new user onboarding flow"
    - Relevant references: "onboarding.md", "user-flow.md", "welcome-email.md"
  </example>
</examples>
```

### TODO: Leverage scratchpad for iteration and debugging

Leverage the scratchpad for iteration and debugging purposes such as:

```markdown
<scratchpad>
  - Iteration 1
  - Iteration 2
  - Iteration 3
</scratchpad>
```

---

## Example from claude usage

```bash
python3 validate_skill.py .. 2>&1 > /tmp/claude-1000/-home-sabossedgh-repos/109f5d59-bb94-4a28-9144-45de1e90aed3/scratchpad/actual_output.txt; cat /tmp/claude-1000/-home-sabossedgh-repos/109f5d59-bb94-4a28-9144-45de1e90aed3/scratchpad/actual_output.txt                                                                
Capture actual table output to scratchpad    
```

**Naming convention**: `<descriptive-name>-prompt.md`

**Final summary MUST include**:
```text
Prompt saved to: /tmp/claude-designed-prompts/<filename>.md
```

Create the directory if it does not exist before writing.

---

### TODO: Update Workflow Section

Update the Workflow section to include these steps:

1. **Understand**: Task, audience, success criteria
2. **Clarify**: If ANY ambiguity exists, ask user before proceeding
3. **Choose pattern**: Simple → RTF | Standard → CIE | Complex → Full framework
4. **Draft**: Start with role, add context, write explicit instructions
5. **Validate (Required)**: Run validator script - prompts are not complete until validated
6. **Save**: Write prompt to output directory and report path in summary

---

### Implementation Notes

- These updates ensure prompts are created with user alignment (clarification) and proper artifact management (output location)
- The clarification protocol prevents wasted effort from misaligned prompts
- The output location provides a consistent, discoverable location for generated prompts
