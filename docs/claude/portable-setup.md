# Portable Configuration Guide

> Manage your Claude Code configuration as a git-controlled, portable setup that works across machines.

**Last Updated:** February 3, 2026

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Installation](#installation)
  - [User Installation](#user-installation)
  - [Project Installation](#project-installation)
  - [Check Status](#check-status)
- [Configuration Files](#configuration-files)
  - [settings.json (Portable)](#settingsjson-portable)
  - [settings.local.json (Machine-Specific)](#settingslocaljson-machine-specific)
- [How Symlinks Work](#how-symlinks-work)
- [Conflict Resolution](#conflict-resolution)
  - [Precedence Order](#precedence-order)
  - [Common Conflicts](#common-conflicts)
- [Disabling the Setup](#disabling-the-setup)
- [Workflow](#workflow)
- [Troubleshooting](#troubleshooting)

---

## Overview

This repository provides a **portable Claude Code configuration** that you can:

1. **Version control** - Track all skills, agents, rules, and settings in git
2. **Share across machines** - Clone the repo and run `install.sh` on any machine
3. **Keep in sync** - Symlinks ensure changes propagate immediately
4. **Customize per-machine** - Use `settings.local.json` for machine-specific paths

## Architecture

The portable setup uses **symlinks** to connect your user config (`~/.claude/`) to this git-controlled repository:

```text
~/.claude/                              ai-sidekicks/.claude/
├── skills/ ─────────────────────────► ├── skills/            (symlink)
├── agents/ ─────────────────────────► ├── agents/            (symlink)
├── rules/  ─────────────────────────► ├── rules/             (symlink)
├── settings.json                      ├── settings.json      (copied)
├── settings.local.json                ├── settings.local.json.example
└── [runtime files...]                 └── tmp/               (gitignored)
```

For complete details on the `.claude` directory structure, skills, agents, and hooks, see the [Structure Guide](structure-guide.md).

## Installation

### User Installation

Install to `~/.claude` (applies to all projects):

```bash
cd /path/to/ai-sidekicks
./install.sh
```

**What happens:**
- `skills/`, `agents/`, `rules/` are symlinked to the repo
- `settings.json` is copied (not symlinked) so you can customize
- Existing directories are backed up to `*.bak`

### Project Installation

Install to a specific project's `.claude` directory:

```bash
cd /path/to/my-project
/path/to/ai-sidekicks/install.sh --project
```

This creates symlinks in `my-project/.claude/` pointing to ai-sidekicks.

### Check Status

See what's installed and where:

```bash
./install.sh --status
```

Example output:
```bash
        o
       .-.
    .--┴-┴--.
    | O   O |   AI-SIDEKICKS
    | ||||| |   >> portable ai configuration
    '--___--'

    [■■■■■■■■■■] SCANNING...

    Location: /home/user/.claude
      skills → /home/user/repos/ai-sidekicks/.claude/skills (symlink)
      agents → /home/user/repos/ai-sidekicks/.claude/agents (symlink)
      rules → /home/user/repos/ai-sidekicks/.claude/rules (symlink)

    Location: /home/user/repos/my-project/.claude
      skills (standalone copy)
      agents (not installed)
      rules (not installed)
```

## Configuration Files

### settings.json (Portable)

The base configuration tracked in git. Contains settings that work on any machine:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "companyAnnouncements": ["Welcome message here"],
  "plansDirectory": "./.claude/tmp/plans",
  "permissions": {
    "allow": [
      "Bash(python:*)",
      "Bash(npm run:*)",
      "WebSearch",
      "Skill(my-skill)"
    ],
    "ask": [],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)"
    ]
  }
}
```

**What belongs here:**
- Tool permissions (generic commands like `python`, `npm`, `git`)
- Skill permissions
- Deny rules for sensitive files
- Company announcements
- Plans directory path

### settings.local.json (Machine-Specific)

Create this file for machine-specific settings. It's gitignored and merges with `settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Read(/home/myuser/repos/**)",
      "Bash(/path/to/project/.claude/scripts/*:*)"
    ],
    "additionalDirectories": [
      "/home/myuser/.claude/plans"
    ]
  }
}
```

**What belongs here:**
- Paths containing your username
- Project-specific script permissions
- Additional directories with absolute paths
- Machine-specific environment variables

**To create from template:**
```bash
cp .claude/settings.local.json.example ~/.claude/settings.local.json
# Edit with your machine-specific paths
```

## How Symlinks Work

When you run `./install.sh`, it creates symbolic links:

```bash
# What the installer does:
ln -s /path/to/ai-sidekicks/.claude/skills ~/.claude/skills
ln -s /path/to/ai-sidekicks/.claude/agents ~/.claude/agents
ln -s /path/to/ai-sidekicks/.claude/rules  ~/.claude/rules
```

**Benefits:**
- Edit skills in the repo → changes apply immediately everywhere
- `git pull` updates → your config updates automatically
- No manual syncing required

**Verification:**
```bash
ls -la ~/.claude/skills
# Output: skills -> /path/to/ai-sidekicks/.claude/skills
```

## Conflict Resolution

### Precedence Order

Claude Code merges settings in this order (highest priority first):

| Priority | Location | Scope | Shared? |
|----------|----------|-------|---------|
| 1 | Managed settings | Enterprise IT | Yes |
| 2 | CLI arguments | Session | No |
| 3 | `.claude/settings.local.json` | Project + machine | No |
| 4 | `.claude/settings.json` | Project | Yes |
| 5 | `~/.claude/settings.local.json` | User + machine | No |
| 6 | `~/.claude/settings.json` | User | No |

### Common Conflicts

**Scenario 1: Different permissions in user vs project**

```text
~/.claude/settings.json:         "allow": ["Bash(npm:*)"]
project/.claude/settings.json:   "deny": ["Bash(npm:*)"]
```

Result: Project deny wins (more specific scope).

**Scenario 2: Same key in settings.json and settings.local.json**

```text
settings.json:       "plansDirectory": "./plans"
settings.local.json: "plansDirectory": "/home/me/my-plans"
```

Result: `settings.local.json` value wins (higher priority).

**Scenario 3: Array merging (permissions)**

```text
settings.json:       "allow": ["Bash(npm:*)"]
settings.local.json: "allow": ["Bash(docker:*)"]
```

Result: Both are allowed (arrays merge).

## Disabling the Setup

### Remove Symlinks (Keep Standalone Copies)

```bash
./install.sh --unlink
```

This converts symlinks back to standalone directories by copying the current content.

### Complete Removal

```bash
# Remove symlinks entirely
rm ~/.claude/skills ~/.claude/agents ~/.claude/rules

# Restore from backup if needed
mv ~/.claude/skills.bak ~/.claude/skills
```

### Temporarily Bypass

Use a project-specific `.claude/settings.json` to override user settings:

```json
{
  "permissions": {
    "allow": [],
    "deny": ["Skill(*)"]
  }
}
```

## Workflow

### Daily Usage

1. **Start Claude** - Skills/agents from your repo are automatically available
2. **Edit a skill** - Make changes in `ai-sidekicks/.claude/skills/`
3. **Test immediately** - Changes apply without reinstalling
4. **Commit** - `git add && git commit` to track changes

### New Machine Setup

```bash
# 1. Clone the repo
git clone https://github.com/Sawmonabo/ai-sidekicks.git

# 2. Run installer
cd ai-sidekicks
./install.sh

# 3. Create local settings
cp .claude/settings.local.json.example ~/.claude/settings.local.json
# Edit with your machine-specific paths

# 4. Verify
./install.sh --status
```

### Updating

```bash
cd /path/to/ai-sidekicks
git pull
# Done! Symlinks mean changes are already active
```

## Troubleshooting

### Skills not showing up

1. **Check symlink exists:**
   ```bash
   ls -la ~/.claude/skills
   ```

2. **Verify target exists:**
   ```bash
   ls /path/to/ai-sidekicks/.claude/skills/
   ```

3. **Check SKILL.md format:**
   Each skill needs a valid `SKILL.md` with proper frontmatter. See [Structure Guide → Skills Configuration](structure-guide.md#skills-configuration).

### Permission denied errors

Your `settings.local.json` may have incorrect paths:

```bash
# Check the paths exist
cat ~/.claude/settings.local.json | grep -o '"[^"]*"' | xargs -I {} test -e {} && echo "OK: {}" || echo "MISSING: {}"
```

### Changes not taking effect

1. **Restart Claude** - Some settings require a restart
2. **Check precedence** - A project `settings.json` may override user settings
3. **Validate JSON:**
   ```bash
   python -m json.tool ~/.claude/settings.json
   ```

### Broken symlinks after moving repo

If you move the ai-sidekicks repo, symlinks break:

```bash
# Re-run installer from new location
cd /new/path/to/ai-sidekicks
./install.sh
```

---

## See Also

- [Structure Guide](structure-guide.md) - Complete `.claude` directory reference
- [Logging Guide](logging.md) - Debug and monitor Claude Code
- [Claude Code Settings Reference](https://code.claude.com/docs/en/settings) - Official settings documentation
