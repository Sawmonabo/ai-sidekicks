#!/usr/bin/env python3
"""Guard Bash commands with ask/deny decisions based on pattern matching."""

import json
import os
import re
import shlex
import sys

# Hard block — irreversible or security-critical, no prompt.
# NOTE: These match the command string, so `grep "DROP TABLE" migrations/` via
# Bash would also be blocked. In practice the Grep tool is used for search.
DENY_PATTERNS = [
    (r"DROP\s+(TABLE|DATABASE|SCHEMA)", "Destructive SQL operation"),
    (r"TRUNCATE\s+TABLE", "Destructive SQL operation"),
    (r"docker\s+run\s+.*--privileged", "Privileged container execution"),
]

# Prompt user to confirm — dangerous but sometimes intentional.
# Tuples are (pattern, reason) or (pattern, reason, exclude_pattern).
# If exclude_pattern matches the command, the ask is skipped.
ASK_PATTERNS = [
    (
        r"git\s+push\s+.*(-f\b|--force(?!-with-lease|-if-includes))",
        "Force push (use --force-with-lease instead)",
    ),
    (r"git\s+reset\s+--hard", "Hard reset discards uncommitted work"),
    (r"git\s+checkout\s+(--\s+)?\.(\s|$)", "Discards all unstaged changes"),
    (r"git\s+restore\s+(--\s+)?\.(\s|$)", "Discards all unstaged changes"),
    (
        r"git\s+clean\s+.*-[dfxX]",
        "Deletes untracked files",
        r"-[a-zA-Z]*n\b|--dry-run",
    ),
    (r"git\s+branch\s+.*-D\b", "Force-deletes a branch"),
    (
        r"rm\s+(-[rf]+\s+)*-[rf]+\s+(\.\.?/?|~/?|/\*?|\*)(\s|$)",
        "Destructive rm on broad target",
    ),
    (r"chmod\s+777", "World-writable permissions"),
    (
        r"curl\s.*\|\s*(sudo\s+)?((ba|z|da)?sh|python[3]?)",
        "Pipe-to-shell execution",
    ),
    (
        r"wget\s.*\|\s*(sudo\s+)?((ba|z|da)?sh|python[3]?)",
        "Pipe-to-shell execution",
    ),
]

_WORKTREE_ALLOWED_DIR = ".worktrees"
_WORKTREE_FLAGS_WITH_ARG = {"-b", "-B", "--reason"}


def _extract_worktree_target(tokens):
    """Scan tokens for `git worktree {add|move}`; return (subcmd, target) or (None, None)."""
    for i in range(len(tokens) - 2):
        if (
            tokens[i].lower() == "git"
            and tokens[i + 1].lower() == "worktree"
            and tokens[i + 2].lower() in ("add", "move")
        ):
            subcmd = tokens[i + 2].lower()
            rest = tokens[i + 3 :]
            positionals = []
            skip_next = False
            for tok in rest:
                if skip_next:
                    skip_next = False
                    continue
                if tok in ("&&", "||", ";", "|"):
                    break
                if tok in _WORKTREE_FLAGS_WITH_ARG:
                    skip_next = True
                    continue
                if tok == "--":
                    continue
                if tok.startswith("-"):
                    continue
                positionals.append(tok)
            if subcmd == "add" and positionals:
                return subcmd, positionals[0]
            if subcmd == "move" and len(positionals) >= 2:
                return subcmd, positionals[1]
            return None, None
    return None, None


def _check_worktree_path(command):
    """Deny `git worktree add/move` outside .worktrees/. Fails open on parse errors."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    subcmd, target = _extract_worktree_target(tokens)
    if target is None:
        return None
    cwd = os.getcwd()
    allowed = os.path.normpath(os.path.join(cwd, _WORKTREE_ALLOWED_DIR))
    abs_target = os.path.normpath(os.path.abspath(target))
    if abs_target == allowed:
        return (
            "Worktree path must include a <name> subdirectory; "
            "use `.worktrees/<name>` instead of `.worktrees`."
        )
    if not abs_target.startswith(allowed + os.sep):
        retry = f"git worktree {subcmd} .worktrees/<name>"
        if subcmd == "add":
            retry += " -b worktree-<name>"
        return (
            f"Worktrees must live under .worktrees/<name>/ at the repo root "
            f"(target '{target}' resolves outside .worktrees/). "
            f"Retry with `{retry}`."
        )
    return None


tool_input = os.environ.get("CLAUDE_TOOL_INPUT", "{}")
try:
    data = json.loads(tool_input)
    command = data.get("command", "")
except (json.JSONDecodeError, AttributeError):
    sys.exit(0)

for pattern, reason in DENY_PATTERNS:
    if re.search(pattern, command, re.IGNORECASE):
        print(  # noqa: T201 — hook output to stdout is required
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": reason,
                    }
                }
            )
        )
        sys.exit(0)

_worktree_reason = _check_worktree_path(command)
if _worktree_reason:
    print(  # noqa: T201 — hook output to stdout is required
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": _worktree_reason,
                }
            }
        )
    )
    sys.exit(0)

_EXCLUDE_INDEX = 2

for entry in ASK_PATTERNS:
    pattern, reason = entry[0], entry[1]
    exclude = entry[_EXCLUDE_INDEX] if len(entry) > _EXCLUDE_INDEX else None
    if re.search(pattern, command, re.IGNORECASE):
        if exclude and re.search(exclude, command, re.IGNORECASE):
            continue
        print(  # noqa: T201 — hook output to stdout is required
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "ask",
                        "permissionDecisionReason": reason,
                    }
                }
            )
        )
        sys.exit(0)
