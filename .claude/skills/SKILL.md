---
name: skills-index
description: Index of available skills for Claude Code agent development
---

# Available Skills

This directory contains skills for building effective Claude Code agents, prompts, and workflows.

## Skills

| Skill | Description |
|-------|-------------|
| [agent-evaluation](./agent-evaluation/SKILL.md) | Evaluate and improve Claude Code commands, skills, and agents. Use when testing prompt effectiveness, validating context engineering choices, or measuring improvement quality. |
| [context-engineering](./context-engineering/SKILL.md) | Understand the components, mechanics, and constraints of context in agent systems. Use when writing, editing, or optimizing commands, skills, or sub-agent prompts. |
| [prompt-engineering](./prompt-engineering/SKILL.md) | Create production-grade prompts for Claude using hybrid markdown + XML approach. Use when crafting system prompts, skill instructions, agent definitions, or structured prompts. |
| [skill-creator](./skill-creator/SKILL.md) | Create effective Claude Code skills through a guided interview process. Use when creating new skills, updating existing skills, or designing skill architecture. |

## Skill Categories

### Development
- **skill-creator**: Build new skills with proper structure and validation
- **prompt-engineering**: Craft optimized prompts using best practices

### Quality & Testing
- **agent-evaluation**: Test and validate agent/skill effectiveness with LLM-as-judge patterns
- **context-engineering**: Optimize context usage and manage degradation

## Usage

Skills are auto-invoked by Claude based on context matching in the description field.
They can also be explicitly invoked via `/skill-name` commands.
