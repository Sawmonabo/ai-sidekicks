# AI-SIDEKICKS

```
        o
       .-.
    .--┴-┴--.
    | O   O |   AI-SIDEKICKS
    | ||||| |   >> portable ai configuration
    '--___--'
```

A portable, version-controlled configuration system for [Claude Code](https://claude.ai/code). Manage your skills, agents, and settings across machines with a single git repository.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Skills](#skills)
- [Agents](#agents)
- [Configuration](#configuration)
- [Documentation](#documentation)

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/Sawmonabo/ai-sidekicks.git

# Install to your user config
cd ai-sidekicks
./install.sh

# Verify installation
./install.sh --status
```

For detailed installation options, see the [Portable Setup Guide](docs/claude/portable-setup.md#installation).

---

## Architecture

```mermaid
graph LR
    subgraph "Your Machine"
        A["~/.claude/"]
        A1["skills/"]
        A2["agents/"]
        A3["rules/"]
        A4["settings.json"]
    end

    subgraph "ai-sidekicks repo"
        B[".claude/"]
        B1["skills/"]
        B2["agents/"]
        B3["rules/"]
        B4["settings.json"]
    end

    A1 -->|symlink| B1
    A2 -->|symlink| B2
    A3 -->|symlink| B3
    A4 -.->|copied| B4
```

| Component | Method | Reason |
|-----------|--------|--------|
| `skills/` | Symlink | Always use latest version |
| `agents/` | Symlink | Always use latest version |
| `rules/` | Symlink | Always use latest version |
| `settings.json` | Copy | Allow local customization |

For details on how symlinks work and conflict resolution, see the [Portable Setup Guide](docs/claude/portable-setup.md#how-symlinks-work).

---

## Project Structure

```
ai-sidekicks/
├── .claude/
│   ├── skills/           # Claude Code skills (portable)
│   ├── agents/           # Custom subagents (portable)
│   ├── rules/            # Project rules (portable)
│   ├── settings.json     # Base settings (portable)
│   └── tmp/              # Runtime files (gitignored)
├── docs/claude/          # Claude Code documentation
├── install.sh            # Config installation script
├── CLAUDE.md             # Project instructions for Claude
└── README.md
```

For complete directory structure details, see the [Structure Guide](docs/claude/structure-guide.md).

---

## Skills

| Skill | Description |
|-------|-------------|
| [skill-creator](.claude/skills/skill-creator/SKILL.md) | Create effective Claude Code skills through guided interviews |
| [prompt-engineering](.claude/skills/prompt-engineering/SKILL.md) | Create production-grade prompts using hybrid markdown + XML |
| [context-engineering](.claude/skills/context-engineering/SKILL.md) | Understand context components and constraints in agent systems |
| [git](.claude/skills/git/SKILL.md) | Advanced git workflows for worktrees and commit metadata |
| [agent-evaluation](.claude/skills/agent-evaluation/SKILL.md) | Evaluate and improve Claude Code commands and agents |

```mermaid
flowchart TD
    A[User invokes skill] --> B{Skill exists?}
    B -->|Yes| C[Load SKILL.md]
    B -->|No| D[Error: skill not found]
    C --> E[Parse frontmatter]
    E --> F[Execute instructions]
    F --> G{References needed?}
    G -->|Yes| H[Load reference files]
    G -->|No| I[Complete task]
    H --> I
```

---

## Agents

| Agent | Description |
|-------|-------------|
| [agent-creator](.claude/agents/agent-creator.md) | Create new agent definitions |
| [code-simplifier](.claude/agents/code-simplifier.md) | Simplify and refine code for clarity |
| [plugin-validator](.claude/agents/plugin-validator.md) | Validate plugin configurations |
| [prompt-reviewer](.claude/agents/prompt-reviewer.md) | Review and improve prompts |
| [skill-reviewer](.claude/agents/skill-reviewer.md) | Review skill implementations |

---

## Configuration

```mermaid
flowchart TB
    A["1. Managed settings (Enterprise)"] --> B
    B["2. CLI arguments"] --> C
    C["3. Project settings.local.json"] --> D
    D["4. Project settings.json"] --> E
    E["5. User settings.local.json"] --> F
    F["6. User settings.json"]

    style A fill:#ff6b6b
    style B fill:#ffa502
    style C fill:#ffd93d
    style D fill:#6bcb77
    style E fill:#4d96ff
    style F fill:#9b59b6
```

For configuration details and local overrides, see:
- [Portable Setup Guide - Configuration](docs/claude/portable-setup.md#configuration-files)
- [Portable Setup Guide - Precedence Order](docs/claude/portable-setup.md#precedence-order)

---

## Documentation

| Document | Description |
|----------|-------------|
| [Portable Setup Guide](docs/claude/portable-setup.md) | Complete portable configuration system guide |
| [Structure Guide](docs/claude/structure-guide.md) | Detailed `.claude` directory reference |
| [Logging Guide](docs/claude/logging.md) | Debug and monitor Claude Code |
| [Index](docs/claude/index.md) | Documentation index |
