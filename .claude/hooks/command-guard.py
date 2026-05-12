#!/usr/bin/env python3
"""Guard Bash commands with ask/deny decisions based on pattern matching."""

import json
import os
import re
import shlex
import subprocess
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

# Git global options that go BEFORE the subcommand. `git -h` documents these
# as accepted between `git` and `<command>`; we must skip them when scanning
# for `worktree add|move`, otherwise `git -C <path> worktree add ...` bypasses
# the guard.
_GIT_GLOBAL_FLAGS_WITH_ARG = {
    "-C",
    "-c",
    "--exec-path",
    "--git-dir",
    "--work-tree",
    "--namespace",
}
_GIT_GLOBAL_BOOL_FLAGS = {
    "-p",
    "--paginate",
    "--no-pager",
    "--no-replace-objects",
    "--bare",
    "--html-path",
    "--man-path",
    "--info-path",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
    "--no-optional-locks",
}
_SHELL_SEPARATORS = ("&&", "||", ";", "|")


def _repo_root():
    """Absolute repo root, or None outside a git repo."""
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir and os.path.isdir(project_dir):
        return os.path.abspath(project_dir)
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def _resolve_path(target, base_cwd):
    if os.path.isabs(target):
        return os.path.normpath(target)
    return os.path.normpath(os.path.join(base_cwd, target))


def _consume_git_globals(tokens, start_idx):
    """Skip git global options after `git`; return (next_idx, override_cwd or None)."""
    i = start_idx
    override_cwd = None
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("--") and "=" in tok:
            key = tok.split("=", 1)[0]
            if key in _GIT_GLOBAL_FLAGS_WITH_ARG or key in _GIT_GLOBAL_BOOL_FLAGS:
                i += 1
                continue
            break
        if tok in _GIT_GLOBAL_FLAGS_WITH_ARG:
            if tok == "-C" and i + 1 < len(tokens):
                override_cwd = tokens[i + 1]
            i += 2
            continue
        if tok in _GIT_GLOBAL_BOOL_FLAGS:
            i += 1
            continue
        break
    return i, override_cwd


def _extract_worktree_target(args, subcmd):
    """Walk tokens after `worktree add|move`; return target path or None."""
    positionals = []
    skip_next = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
        if tok in _SHELL_SEPARATORS:
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
        return positionals[0]
    if subcmd == "move" and len(positionals) >= 2:
        return positionals[1]
    return None


def _check_worktree_path(command):
    """
    Mini-shell walker: track effective cwd through `cd <path>` and `git -C <path>`,
    then check every `git worktree add|move` target against `<repo_root>/.worktrees/`.

    Fails open on parse errors and outside-git-repo invocations so a parser bug
    never blocks an otherwise-legitimate Bash call.
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None

    repo_root = _repo_root()
    if repo_root is None:
        return None

    allowed = os.path.normpath(os.path.join(repo_root, _WORKTREE_ALLOWED_DIR))
    effective_cwd = repo_root

    i = 0
    while i < len(tokens):
        tok = tokens[i]

        # `cd <path>` updates effective cwd; bare `cd` is treated as no-op.
        if (
            tok == "cd"
            and i + 1 < len(tokens)
            and tokens[i + 1] not in _SHELL_SEPARATORS
        ):
            effective_cwd = _resolve_path(tokens[i + 1], effective_cwd)
            i += 2
            continue

        if tok in _SHELL_SEPARATORS:
            i += 1
            continue

        if tok == "git":
            j, override_cwd = _consume_git_globals(tokens, i + 1)
            git_cwd = (
                _resolve_path(override_cwd, effective_cwd)
                if override_cwd
                else effective_cwd
            )

            if (
                j + 1 < len(tokens)
                and tokens[j].lower() == "worktree"
                and tokens[j + 1].lower() in ("add", "move")
            ):
                subcmd = tokens[j + 1].lower()
                target = _extract_worktree_target(tokens[j + 2 :], subcmd)
                if target is not None:
                    abs_target = _resolve_path(target, git_cwd)
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

            # Advance past this git invocation up to the next separator.
            i = j + 1
            while i < len(tokens) and tokens[i] not in _SHELL_SEPARATORS:
                i += 1
            continue

        i += 1

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
