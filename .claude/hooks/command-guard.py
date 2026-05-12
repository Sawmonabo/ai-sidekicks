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
# Git globals that accept a separate-token value (space-separated form, e.g.
# `git -C path worktree add ...` or `git --namespace foo worktree add ...`).
# Anything not in this set is treated as a no-arg/bool global. The
# `--flag=value` form is one token after shlex.split so it doesn't need
# separate handling. Enumerating value-takers is load-bearing: if we
# under-consume (treat a value-taker as bool), the parser lands on the
# value (e.g. `foo`) instead of the subcommand (`worktree`), misses the
# invocation, and allows what should be a bypass. Over-consuming a real
# bool global would shift detection in the opposite direction, also a
# bypass — so we enumerate from `git --help` rather than guessing.
_GIT_GLOBAL_WITH_SEP_ARG = {
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--list-cmds",
    "--attr-source",
}
_SHELL_OPS = frozenset({"&&", "||", ";", "|", "&", "(", ")"})


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


def _normalize_shell_operators(command):
    """Insert whitespace around shell control operators outside quoted strings,
    so `shlex.split` tokenizes them as standalone separators. Without this,
    `cd /tmp;git worktree add ...` produces a glued `/tmp;git` token. Also
    converts unquoted newlines to `;` — shlex eats `\\n` as whitespace, which
    would glue commands across lines into one token stream and let a second
    `git worktree add` slip past the strict-shape check."""
    out = []
    i = 0
    in_single = False
    in_double = False
    n = len(command)
    while i < n:
        c = command[i]
        if c == "'" and not in_double:
            in_single = not in_single
            out.append(c)
            i += 1
            continue
        if c == '"' and not in_single:
            in_double = not in_double
            out.append(c)
            i += 1
            continue
        if in_single or in_double:
            out.append(c)
            i += 1
            continue
        if c == "\n":
            out.append(" ; ")
            i += 1
            continue
        if command[i : i + 2] in ("&&", "||"):
            out.append(" " + command[i : i + 2] + " ")
            i += 2
            continue
        if c in ";|&()":
            out.append(" " + c + " ")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _has_unquoted_subshell(command):
    """Detect `$(` or backtick outside quoted strings — both are command
    substitution and indicate complex shell shape that we refuse to parse."""
    in_single = False
    in_double = False
    i = 0
    while i < len(command):
        c = command[i]
        if c == "'" and not in_double:
            in_single = not in_single
        elif c == '"' and not in_single:
            in_double = not in_double
        elif not in_single and not in_double:
            if c == "`":
                return True
            if c == "$" and i + 1 < len(command) and command[i + 1] == "(":
                return True
        i += 1
    return False


def _consume_git_globals(tokens, start_idx):
    """Consume git global options after `git`. Permissive about unknown flags:
    any leading `-X` or `--flag[=value]` is treated as a no-arg global unless
    it's a known with-separated-arg flag (see _GIT_GLOBAL_WITH_SEP_ARG).

    Returns (index_past_globals, c_paths) where c_paths is the ordered list
    of `-C <path>` values — git applies them cumulatively against an evolving
    cwd, so the caller must walk them in order rather than keeping only the
    last one."""
    i = start_idx
    c_paths = []
    while i < len(tokens):
        tok = tokens[i]
        if not tok.startswith("-"):
            break
        if tok in _GIT_GLOBAL_WITH_SEP_ARG:
            if tok == "-C" and i + 1 < len(tokens):
                c_paths.append(tokens[i + 1])
            i += 2
            continue
        i += 1
    return i, c_paths


def _extract_worktree_target(args, subcmd):
    """Walk tokens after `worktree add|move`; return target path or None."""
    positionals = []
    skip_next = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
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


def _has_git_worktree_invocation(tokens):
    """Scan tokens for a real `git [globals]* worktree (add|move)` invocation.

    Used to gate strict-shape enforcement so that commands which only *mention*
    the word `worktree` as a data token (e.g., `echo worktree add`) are not
    treated as worktree invocations and rejected for failing the shape."""
    n = len(tokens)
    for i in range(n):
        if tokens[i].lower() != "git":
            continue
        j, _ = _consume_git_globals(tokens, i + 1)
        if (
            j + 1 < n
            and tokens[j].lower() == "worktree"
            and tokens[j + 1].lower() in ("add", "move")
        ):
            return True
    return False


def _has_symlink_in_path(target_abs, allowed_abs):
    """Walk path components of target_abs starting at allowed_abs. Return the
    path of the first symlinked component encountered (including allowed_abs
    itself), else None.

    `normpath` + `startswith` is purely lexical, so a symlink anywhere along
    the path (e.g., `.worktrees/link -> /tmp`) could redirect a worktree
    outside the repo while still passing the prefix check. Non-existent
    components return False from `islink`, so the not-yet-created leaf
    doesn't trigger a false positive."""
    if os.path.islink(allowed_abs):
        return allowed_abs
    try:
        rel = os.path.relpath(target_abs, allowed_abs)
    except ValueError:
        return None
    if rel == "." or rel.startswith(".."):
        return None
    cur = allowed_abs
    for p in rel.split(os.sep):
        cur = os.path.join(cur, p)
        if os.path.islink(cur):
            return cur
    return None


def _build_shape_deny():
    return (
        "git worktree add/move must run directly from the repo root as a "
        "single command — no leading commands, no chains (`;`, `&&`, `||`, `|`, `&`), "
        "no subshells, no command substitution. "
        "Retry with `git worktree add .worktrees/<name> -b worktree-<name>` "
        "(or `git worktree move ...`) as the entire command."
    )


def _check_worktree_path(command):
    """
    Strict-shape check for `git worktree add|move`.

    Required shape (the whole command, no leading commands or chains):

        git [-C <path>]? [other-globals]* worktree (add|move) <target> [flags]*

    When the command contains a real `git worktree add|move` invocation but
    doesn't match this shape — chains, subshells, command substitution,
    leading commands — DENY with a teaching message. The threat model is
    non-adversarial (agent mistakes); forcing the simple shape eliminates
    whole classes of bypass at once rather than chasing each parser edge case.

    Mere data tokens that happen to spell `worktree add` (e.g.,
    `echo worktree add`) are NOT denied — the strict shape only kicks in
    once a real `git ... worktree (add|move)` invocation is detected.

    Containment check on <target>: must resolve under
    <repo_root>/.worktrees/<name>/. `-C <path>` flags are applied
    cumulatively against an evolving cwd to match git's documented
    semantics. Also denies when any path component under `.worktrees/`
    (including `.worktrees/` itself) is a symlink, since a lexical
    containment check would otherwise let a symlinked component redirect
    new worktrees outside the repo.

    Fails open on shlex parse errors and outside-git-repo invocations so a
    parser bug never blocks an otherwise-legitimate Bash call.
    """
    if not re.search(r"\bworktree\b", command, re.IGNORECASE):
        return None

    normalized = _normalize_shell_operators(command)
    try:
        tokens = shlex.split(normalized)
    except ValueError:
        return None

    has_subshell = _has_unquoted_subshell(command)
    has_invocation = _has_git_worktree_invocation(tokens)

    if not has_invocation:
        # No actual `git worktree (add|move)` in the tokens. Only deny if a
        # subshell could be hiding one we can't see (e.g., `$(git worktree
        # add ../escape)`); otherwise this is a data mention like `echo
        # worktree add` or a different subcommand like `git worktree list`.
        if has_subshell:
            return _build_shape_deny()
        return None

    if has_subshell:
        return _build_shape_deny()

    if any(t in _SHELL_OPS for t in tokens):
        return _build_shape_deny()

    if not tokens or tokens[0].lower() != "git":
        return _build_shape_deny()

    j, c_paths = _consume_git_globals(tokens, 1)
    if j >= len(tokens) or tokens[j].lower() != "worktree":
        return _build_shape_deny()
    if j + 1 >= len(tokens) or tokens[j + 1].lower() not in ("add", "move"):
        return None  # git worktree list / lock / etc. — not our target

    subcmd = tokens[j + 1].lower()
    target = _extract_worktree_target(tokens[j + 2 :], subcmd)
    if target is None:
        return None  # git will reject malformed input itself

    repo_root = _repo_root()
    if repo_root is None:
        return None

    allowed = os.path.normpath(os.path.join(repo_root, _WORKTREE_ALLOWED_DIR))

    # Apply `-C` paths cumulatively (git semantics: each non-absolute -C is
    # interpreted relative to the preceding one; absolute -C resets the chain;
    # empty -C is a no-op).
    effective_cwd = repo_root
    for c_path in c_paths:
        effective_cwd = _resolve_path(c_path, effective_cwd)

    abs_target = _resolve_path(target, effective_cwd)

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

    symlink_component = _has_symlink_in_path(abs_target, allowed)
    if symlink_component:
        return (
            f"Worktree path contains a symlinked component "
            f"`{symlink_component}` that could redirect new worktrees "
            f"outside `.worktrees/`. Remove the symlink and retry."
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
