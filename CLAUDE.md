# AI Sidekicks

Collection of Claude Code skills, agents, and documentation.

## Project Structure

```
ai-sidekicks/
├── .claude/
│   ├── skills/          # Claude Code skills (portable)
│   ├── agents/          # Custom subagents (portable)
│   ├── rules/           # Project rules (portable)
│   ├── settings.json    # Base settings (portable)
│   └── tmp/             # Runtime files (gitignored)
├── docs/claude/         # Claude Code documentation
├── prompts/             # Prompt templates
├── install.sh           # Config installation script
└── CLAUDE.md
```

## Portable Configuration

This repo serves as a portable Claude Code configuration. Use `install.sh` to apply it:

```bash
# Install as user config (~/.claude)
./install.sh

# Install to a project
cd /path/to/project && /path/to/ai-sidekicks/install.sh --project

# Check installation status
./install.sh --status
```

### What Gets Installed

| Component | Method | Reason |
|-----------|--------|--------|
| `skills/` | Symlink | Always use latest version |
| `agents/` | Symlink | Always use latest version |
| `rules/` | Symlink | Always use latest version |
| `settings.json` | Copy | Allow local customization |

### Local Overrides

Create `.claude/settings.local.json` for machine-specific settings (gitignored):

```json
{
  "permissions": {
    "allow": ["Bash(docker:*)"]
  }
}
```

## File Naming Convention

Modern markdown conventions (2025-2026):

| File Type | Convention | Example |
|-----------|------------|---------|
| Index files | `index.md` (lowercase) | `docs/claude/index.md` |
| Documentation | `lowercase-kebab-case.md` | `structure-guide.md` |
| Root README | `README.md` (uppercase) | Repository root only |
| Special files | `UPPERCASE.md` | `CHANGELOG.md`, `LICENSE`, `CLAUDE.md` |

**Why lowercase for docs?**
- MkDocs and Docusaurus use `index.md` (lowercase) by convention
- Lowercase kebab-case is URL-friendly and consistent across platforms
- Uppercase reserved for "special" root-level files that platforms auto-recognize

**Reference**: [MkDocs](https://www.mkdocs.org/user-guide/writing-your-docs/), [Docusaurus](https://docusaurus.io/docs/create-doc)
