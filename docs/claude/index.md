# Claude Code Documentation

> Comprehensive guides for Claude Code configuration, logging, and best practices.

**Last Updated:** February 3, 2026

---

## Contents

| Guide | Description |
|-------|-------------|
| [Portable Setup](portable-setup.md) | Git-controlled configuration setup with symlinks, multi-machine sync, and conflict resolution |
| [Structure Guide](structure-guide.md) | Complete reference for `.claude` directory structure, skills, hooks, agents, and best practices |
| [Logging Guide](logging.md) | How to monitor agents, tools, models, and prompts with verbose mode, debug flags, and OpenTelemetry |

---

## Quick Links

### Getting Started

- **Portable Setup**: See [Portable Setup → Installation](portable-setup.md#installation)
- **Project Setup**: See [Structure Guide → Directory Structure](structure-guide.md#directory-structure)
- **First Skill**: See [Structure Guide → Skills Configuration](structure-guide.md#skills-configuration)
- **CLAUDE.md**: See [Structure Guide → CLAUDE.md Best Practices](structure-guide.md#claudemd-best-practices)

### Debugging & Monitoring

- **Quick Debug**: `claude --verbose` or `claude --debug`
- **Full Telemetry**: See [Logging Guide → OpenTelemetry](logging.md#opentelemetry-logging)

### Component Reference

| Component | Purpose | Location |
|-----------|---------|----------|
| Skills | Auto-invoked capabilities | `.claude/skills/` |
| Commands | User-invoked prompts | `.claude/commands/` |
| Agents | Specialized workers | `.claude/agents/` |
| Hooks | Event interceptors | `settings.json` |
| CLAUDE.md | Persistent memory | Project root |

---

## External Resources

- [Claude Code Official Docs](https://docs.anthropic.com/en/docs/claude-code)
- [Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Anthropic Skills Repository](https://github.com/anthropics/skills)
