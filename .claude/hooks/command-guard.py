#!/usr/bin/env python3
"""Guard Bash commands with ask/deny decisions based on pattern matching.

Two entry modes (see main()):
- no argv: PreToolUse:Bash hook — payload JSON on stdin, decision JSON on
  stdout (documented contract; legacy CLAUDE_TOOL_INPUT env is a fallback).
- `--occupancy <path>`: worktree-occupancy CLI used by worktree.sh — lists
  live processes whose cwd sits inside <path> (see _run_occupancy_cli).
"""

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
    # `(?-i:...)` keeps the flag case-sensitive under the loop's IGNORECASE:
    # `-d` is the safe merged-only delete and must not trip the ask.
    (r"git\s+branch\s+.*(?-i:-D)\b", "Force-deletes a branch"),
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

_EXCLUDE_INDEX = 2

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
    # `--exec-path` is bool-or-`=value` in git(1), not space-separated:
    # `git --exec-path /tmp status` prints the exec-path and exits without
    # running `status`. Including it here is defense-in-depth — it makes the
    # parser recognize `git --exec-path /tmp worktree add ../escape` as a
    # worktree invocation even though git itself would short-circuit.
    "--exec-path",
}
_SHELL_OPS = frozenset({"&&", "||", ";", "|", "&", "(", ")"})

# Shell/scripting wrappers whose `-c` argument is a nested command we must
# re-check. Without this, `bash -lc 'git worktree add ../escape'` slips past
# the top-level invocation gate because the outer tokens are
# `[bash, -lc, '...']` — no `git` token at the surface — so the strict-shape
# check never fires. Recursion bounded by _MAX_WRAPPER_DEPTH (cf. advisor:
# pathological `bash -c "bash -c '...'"` chains).
_WRAPPER_SHELL_BIN_NAMES = frozenset({"bash", "sh", "zsh", "ksh", "dash", "ash"})
# Wrapper shell options that consume the next token as a value (bash(1)
# `--rcfile FILE`, `-o option`, `-O shopt`; zsh shares -o/-O). Without
# walking past the value, the parser would land on it as a "first
# positional", treat the invocation as `bash <scriptfile>`, and return
# None before reaching `-c`. The `--flag=value` one-token form is handled
# by the generic `tok.startswith("--")` skip below.
_WRAPPER_SHELL_OPTS_WITH_VALUE = frozenset(
    {"--rcfile", "--init-file", "-o", "+o", "-O", "+O"}
)
_WRAPPER_SCRIPT_BIN_NAMES = frozenset(
    {"python", "python3", "python2", "node", "perl", "ruby"}
)
# Cross-runtime "next token is code" flags. Kept as a single set because the
# `-c <cmd>` form is the most common interpreter eval shape across languages
# (python -c, node --command alternative aliases, etc.); the per-runtime
# table below adds language-specific eval flags on top.
_WRAPPER_SCRIPT_ARG_FLAGS = frozenset({"-c", "--command"})
# Per-runtime eval flags. The flag's argument is the program body — not a
# script-file path — so each runtime executes it directly. Without unwrapping,
# `node -e "<inner>"` (or `perl -E '<inner>'`, etc.) hides `git worktree
# add|move` from the strict-shape check because the outer tokens are
# `[node, -e, "<inner>"]` with no `git` token at the surface. node also
# supports `-p`/`--print` which evaluate-and-print; treated as eval here.
_WRAPPER_SCRIPT_EVAL_FLAGS = {
    "python": frozenset(),
    "python3": frozenset(),
    "python2": frozenset(),
    "node": frozenset({"-e", "--eval", "-p", "--print"}),
    "perl": frozenset({"-e", "-E"}),
    "ruby": frozenset({"-e"}),
}
_ENV_BIN_NAME = "env"
# env globals that take a separate-token value (so we can skip past them when
# locating the wrapped binary). `man env`: -u/--unset, -S/--split-string,
# -C/--chdir all consume the next token.
_ENV_VALUE_FLAGS = frozenset(
    {"-u", "--unset", "-S", "--split-string", "-C", "--chdir"}
)
_EVAL_KEYWORD = "eval"
_MAX_WRAPPER_DEPTH = 4

# Substring detector for `git ... worktree (add|move)` with intervening
# characters. Used as a defense-in-depth fallback when the wrapper is an
# interpreter-language runtime (`node -e`, `python -c`, `perl -e`, `ruby -e`):
# shell-tokenization of the payload glues a quoted JS/Python string like
# `'git worktree add ../escape'` into a single token, so `_has_git_worktree_
# invocation` can't see the embedded call. The substring scan catches that.
# Both gaps cap on length to keep false positives low (no newline / semicolon
# separators allowed in the gap, so the pattern can't bridge across statement
# boundaries). The second gap (worktree → add|move) is wider than pure
# whitespace because Python/JS list literals separate them with `", "` —
# e.g., `subprocess.run(["git", "worktree", "add", "../escape"])`. Not
# applied to bash/sh wrapper payloads — those re-tokenize cleanly under
# shell rules and the recursive check is authoritative.
_GIT_WORKTREE_RE = re.compile(
    r"\bgit\b[^\n;]{0,80}\bworktree\b[^\n;]{0,8}\b(?:add|move)\b",
    re.IGNORECASE,
)

_GIT_BIN_NAME = "git"


def _is_git_token(tok):
    """True if `tok` invokes the git binary — basename match, case-insensitive.

    `tokens[i].lower() == "git"` misses `/usr/bin/git`, `./git`, or
    `~/bin/git`, all of which are valid ways to invoke git. The hook would
    treat such invocations as "no git here" and skip the strict-shape +
    containment check entirely (PR #58 Codex Round 8). Matching on basename
    instead lets path-prefixed invocations land on the same gate. The
    surrounding `_consume_git_globals` and target-extraction logic does not
    depend on the literal token — only on its position after the matched
    git — so the change is local to the gate."""
    return os.path.basename(tok).lower() == _GIT_BIN_NAME


_ALIAS_PREFIX = "alias."
# Lazy, per-Python-process cache of configured git aliases whose body targets
# `worktree (add|move)`. None = "not yet scanned"; an empty frozenset =
# "scanned, none found". Tests override by setting this module attribute
# before exercising the check.
_configured_alias_cache = None


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

    Returns (index_past_globals, c_paths, inline_aliases):
    - c_paths is the ordered list of `-C <path>` values — git applies them
      cumulatively against an evolving cwd, so the caller must walk them in
      order rather than keeping only the last one.
    - inline_aliases is the dict `NAME -> VALUE` of any `-c alias.NAME=VALUE`
      globals — these define an alias usable later in the same command
      (e.g., `git -c alias.wta='worktree add' wta ../escape`)."""
    i = start_idx
    c_paths = []
    inline_aliases = {}
    while i < len(tokens):
        tok = tokens[i]
        if not tok.startswith("-"):
            break
        if tok in _GIT_GLOBAL_WITH_SEP_ARG:
            if tok == "-C" and i + 1 < len(tokens):
                c_paths.append(tokens[i + 1])
            elif tok == "-c" and i + 1 < len(tokens):
                kv = tokens[i + 1]
                if "=" in kv:
                    key, val = kv.split("=", 1)
                    if key.startswith(_ALIAS_PREFIX):
                        inline_aliases[key[len(_ALIAS_PREFIX) :]] = val
            i += 2
            continue
        i += 1
    return i, c_paths, inline_aliases


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


def _alias_targets_worktree(expansion):
    """Return True if a git alias's body expands into `worktree (add|move)`.

    Two body shapes are recognized:
    1. Plain body (`worktree add`, `-C path worktree add ...`): tokenize and
       check for `worktree (add|move)` after any leading git globals.
    2. Shell body (`!cmd ...` — git executes via shell): tokenize the inner
       command and scan for a direct `git worktree (add|move)` invocation.

    Residuals (intentional, under the non-adversarial threat model — see
    PR #58 Round 6 §Residuals): chained aliases (A → B → worktree),
    prefix-only aliases (`alias.wt = worktree`, with `add` supplied at the
    use site), and nested shell wrappers inside a `!` alias body."""
    expansion = expansion.strip()
    # Strip one layer of outer matching quotes — nested quoting in the source
    # command (`git -c "alias.x='...'" x`) may leave them on the value.
    if (
        len(expansion) >= 2
        and expansion[0] == expansion[-1]
        and expansion[0] in ("'", '"')
    ):
        expansion = expansion[1:-1]
    try:
        toks = shlex.split(expansion)
    except ValueError:
        return False
    if not toks:
        return False
    if toks[0].startswith("!"):
        body = expansion.lstrip()[1:]
        try:
            inner = shlex.split(body)
        except ValueError:
            return True  # malformed shell body — err toward denial
        return _has_git_worktree_invocation(inner)
    j, _, _ = _consume_git_globals(toks, 0)
    return (
        j + 1 < len(toks)
        and toks[j].lower() == "worktree"
        and toks[j + 1].lower() in ("add", "move")
    )


def _scan_configured_worktree_aliases():
    """Subprocess `git config --get-regexp '^alias\\.'` and return the
    frozenset of alias names whose body targets `worktree (add|move)`.

    Pre-configured aliases (`git config --global alias.wta 'worktree add'`)
    are invisible in the Bash tokens — only `wta` appears when an agent runs
    `git wta ../escape`. Without this scan, the strict-shape check has no way
    to know `wta` expands to a worktree call.

    Bounded cost: one `git config` subprocess per hook invocation, gated by
    the quick-exit logic in `_check_worktree_path` (only runs when the
    command mentions `git` but not `worktree`). Fails open on error, matching
    the rest of this hook."""
    try:
        result = subprocess.run(
            ["git", "config", "--get-regexp", r"^alias\."],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    if result.returncode != 0:
        return frozenset()
    names = set()
    for line in result.stdout.splitlines():
        if not line.startswith(_ALIAS_PREFIX):
            continue
        parts = line.split(" ", 1)
        if len(parts) != 2:
            continue
        key, value = parts
        if _alias_targets_worktree(value):
            names.add(key[len(_ALIAS_PREFIX) :])
    return frozenset(names)


def _get_configured_worktree_aliases():
    """Lazy, memoized accessor for pre-configured worktree-targeting aliases.

    Bootstrap guard: `_scan_configured_worktree_aliases` indirectly calls back
    into this function (via `_alias_targets_worktree` → shell-alias body →
    `_has_git_worktree_invocation` → cache lookup). Setting the cache to an
    empty frozenset before the scan breaks the recursion. The cost is that
    chained aliases (`alias.a = b`, `alias.b = 'worktree add'`) won't be
    detected — accepted residual."""
    global _configured_alias_cache
    if _configured_alias_cache is None:
        _configured_alias_cache = frozenset()
        _configured_alias_cache = _scan_configured_worktree_aliases()
    return _configured_alias_cache


def _has_git_worktree_invocation(tokens):
    """Scan tokens for a real `git ... worktree (add|move)` invocation,
    including alias-mediated ones.

    Three invocation shapes match:
    1. Direct: `git [globals]* worktree (add|move)`.
    2. Inline alias: `git -c alias.X='worktree add' X ...` — alias configured
       in the same command, then invoked by name.
    3. Pre-configured alias: `git X ...` where `X` appears in the lazy-loaded
       configured-alias cache.

    Used to gate strict-shape enforcement so commands that only *mention* the
    word `worktree` as a data token (e.g., `echo worktree add`) are not
    treated as worktree invocations and rejected for failing the shape."""
    n = len(tokens)
    configured_aliases = _get_configured_worktree_aliases()
    for i in range(n):
        if not _is_git_token(tokens[i]):
            continue
        j, _, inline_aliases = _consume_git_globals(tokens, i + 1)
        if j >= n:
            continue
        head = tokens[j]
        if head.lower() == "worktree":
            if j + 1 < n and tokens[j + 1].lower() in ("add", "move"):
                return True
            continue
        if head in inline_aliases and _alias_targets_worktree(
            inline_aliases[head]
        ):
            return True
        if head in configured_aliases:
            return True
    return False


def _strip_env_prefix(tokens):
    """If tokens starts with `env` (matched on basename), advance past env's
    own opts (`-i`, `-u VAR`, `--split-string`, etc.) and `VAR=value`
    assignments, and return the sub-tokens beginning at the wrapped command.
    Else return tokens unchanged.

    `/usr/bin/env bash -c '...'` is a common shebang pattern an agent may
    type literally; without this, the wrapper-extraction logic would see
    `env` as tokens[0] and miss the inner bash."""
    if not tokens or os.path.basename(tokens[0]) != _ENV_BIN_NAME:
        return tokens
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        if tok in _ENV_VALUE_FLAGS and i + 1 < len(tokens):
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        if "=" in tok:
            i += 1
            continue
        break
    return tokens[i:]


def _extract_env_split_string(tokens):
    """If `tokens` is `env [pre-opts]* (-S|--split-string)[ =]VALUE [...]`,
    return VALUE. Else return None.

    `env -S` splits VALUE into argv and execs it (env(1), GNU coreutils),
    so VALUE itself is the wrapped command. `_strip_env_prefix` skips past
    `-S` value-takers without re-parsing them, so without this helper an
    `env -S 'git worktree add ../escape'` slips past the wrapper-recursion
    gate. Three forms are recognized:

    - `env -S VALUE` (two tokens)
    - `env --split-string VALUE` (two tokens)
    - `env --split-string=VALUE` (one token)

    Pre-`-S` `-i`, `-u VAR`, `--chdir DIR`, and `VAR=val` assignments are
    walked past so they don't shadow detection. Anything else means we're
    looking at a regular env-wrapped binary, not `-S`."""
    if not tokens or os.path.basename(tokens[0]) != _ENV_BIN_NAME:
        return None
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        if tok in ("-S", "--split-string") and i + 1 < len(tokens):
            return tokens[i + 1]
        if tok.startswith("--split-string="):
            return tok[len("--split-string=") :]
        if tok in _ENV_VALUE_FLAGS and i + 1 < len(tokens):
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        if "=" in tok:
            i += 1
            continue
        break  # first bare positional → wrapped binary, not -S
    return None


def _is_script_runtime_wrapper(tokens):
    """True iff `tokens` (after env-prefix strip) invokes an interpreter-language
    runtime from _WRAPPER_SCRIPT_BIN_NAMES — python, node, perl, ruby, etc.

    Used to gate the substring-based defense-in-depth check in
    `_check_worktree_path`: interpreter payloads can embed shell strings
    that don't surface as discrete tokens (a JS literal
    `'git worktree add ../escape'` becomes one quoted token after shell
    tokenization). Shell wrappers (`bash -c`) re-tokenize cleanly and don't
    need the fallback, so this helper returns False for them."""
    stripped = _strip_env_prefix(tokens)
    if not stripped:
        return False
    return os.path.basename(stripped[0]) in _WRAPPER_SCRIPT_BIN_NAMES


def _extract_wrapped_command(tokens):
    """If `tokens` is a known shell/scripting wrapper invocation with an
    inline command (`bash -c '...'`, `python -c '...'`, `eval '...'`),
    return the inline command string. Else return None.

    Handles:
    - bash/sh/zsh/etc. `-c <cmd>` and combined short opts (`-lc`, `-ilc`):
      bash short opts collapse, and any opt token containing `c` means
      "command follows in the next argument" (advisor flag).
    - python/node/perl/ruby `-c <cmd>`; per-runtime eval flags
      (`node -e/--eval/--eval=/-p/--print`, `perl -e/-E`, `ruby -e`).
      Indexed by basename via `_WRAPPER_SCRIPT_EVAL_FLAGS`.
    - `env -S VALUE` (split-string): VALUE is itself the wrapped command,
      extracted before `_strip_env_prefix` runs (the strip walks past -S
      without re-parsing the value).
    - `env [opts] [VAR=val]... <wrapped>` is stripped before matching.
    - `eval <args...>` joins the args back into a command string.

    Returns the inline command as a single string ready to re-feed into
    `_check_worktree_path`. The caller is responsible for depth bounding."""
    if not tokens:
        return None

    env_split = _extract_env_split_string(tokens)
    if env_split is not None:
        return env_split

    tokens = _strip_env_prefix(tokens)
    if not tokens:
        return None

    base = os.path.basename(tokens[0])

    if base == _EVAL_KEYWORD and len(tokens) >= 2:
        return " ".join(tokens[1:])

    if base in _WRAPPER_SHELL_BIN_NAMES:
        i = 1
        while i < len(tokens):
            tok = tokens[i]
            if tok == "--":
                return tokens[i + 1] if i + 1 < len(tokens) else None
            if tok in _WRAPPER_SHELL_OPTS_WITH_VALUE and i + 1 < len(tokens):
                i += 2  # consume the option AND its value
                continue
            if tok.startswith("--"):
                i += 1
                continue
            if tok.startswith("-") and len(tok) >= 2:
                # Any short-opt cluster containing `c` (e.g., `-c`, `-lc`,
                # `-ilc`) means "next arg is the command" per bash(1).
                if "c" in tok[1:]:
                    return tokens[i + 1] if i + 1 < len(tokens) else None
                i += 1
                continue
            return None  # first positional → script file, not -c form
        return None

    if base in _WRAPPER_SCRIPT_BIN_NAMES:
        eval_flags = _WRAPPER_SCRIPT_EVAL_FLAGS.get(base, frozenset())
        i = 1
        while i < len(tokens):
            tok = tokens[i]
            # Cross-runtime `-c <cmd>` / `--command <cmd>` next-token form.
            if tok in _WRAPPER_SCRIPT_ARG_FLAGS and i + 1 < len(tokens):
                return tokens[i + 1]
            # Per-runtime eval flag, next-token form (`node -e <cmd>`,
            # `perl -E <cmd>`, `node --eval <cmd>`).
            if tok in eval_flags and i + 1 < len(tokens):
                return tokens[i + 1]
            # `--flag=value` one-token form (`node --eval=<cmd>`,
            # `--command=<cmd>`). Split on the first `=` and match against
            # the same flag tables.
            if tok.startswith("--") and "=" in tok:
                flag, _, val = tok.partition("=")
                if flag in _WRAPPER_SCRIPT_ARG_FLAGS or flag in eval_flags:
                    return val
            i += 1
        return None

    return None


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


def _check_worktree_path(command, base_cwd=None, _depth=0):
    """
    Strict-shape check for `git worktree add|move`.

    base_cwd is the session cwd from the hook payload — git resolves
    relative paths (and the `-C` chain) against it, so containment must
    too. Before payload plumbing this resolved against the repo root,
    which silently allowed `git worktree add .worktrees/x` to land at
    `<cwd>/.worktrees/x` outside containment when the session cwd was a
    subdirectory. Falls back to the repo root when absent (legacy env
    input has no cwd field).

    Required shape (the whole command, no leading commands or chains):

        git [-C <path>]? [other-globals]* worktree (add|move) <target> [flags]*

    When the command contains a real `git worktree add|move` invocation but
    doesn't match this shape — chains, subshells, command substitution,
    leading commands, shell wrappers — DENY with a teaching message. The
    threat model is non-adversarial (agent mistakes); forcing the simple
    shape eliminates whole classes of bypass at once rather than chasing
    each parser edge case.

    Mere data tokens that happen to spell `worktree add` (e.g.,
    `echo worktree add`) are NOT denied — the strict shape only kicks in
    once a real `git ... worktree (add|move)` invocation is detected.

    Shell wrappers (`bash -c '...'`, `/usr/bin/env bash -c '...'`,
    `python -c '...'`, `eval '...'`) are unwrapped and the inline command
    is re-checked recursively, bounded by _MAX_WRAPPER_DEPTH. The nested
    check runs the full pipeline (subshell + shell-op + symlink + cumulative
    `-C` checks all fire inside the wrapper). Indirection through file
    reads (`bash script.sh`), stdin pipes (`xargs git worktree …`), and
    heredocs is out of scope for this Bash PreToolUse hook and accepted as
    residual risk under the non-adversarial threat model.

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
    if _depth > _MAX_WRAPPER_DEPTH:
        return None

    if not re.search(r"\bworktree\b", command, re.IGNORECASE):
        # No literal `worktree` token. A pre-configured alias may still
        # expand to one (`git wta ../escape` where the user's git config has
        # `alias.wta = 'worktree add'`). Pay the lazy `git config` subprocess
        # cost only when the command mentions `git` AND the cache is
        # non-empty AND at least one cached alias name appears as a word in
        # the command — otherwise skip parse.
        if not re.search(r"\bgit\b", command, re.IGNORECASE):
            return None
        configured = _get_configured_worktree_aliases()
        if not configured:
            return None
        alias_pattern = (
            r"\b(?:" + "|".join(re.escape(n) for n in configured) + r")\b"
        )
        if not re.search(alias_pattern, command):
            return None

    normalized = _normalize_shell_operators(command)
    try:
        tokens = shlex.split(normalized)
    except ValueError:
        return None

    nested = _extract_wrapped_command(tokens)
    if nested is not None:
        nested_deny = _check_worktree_path(nested, base_cwd, _depth + 1)
        if nested_deny is not None:
            return nested_deny
        # Defense-in-depth for interpreter-language wrappers (`node -e`,
        # `python -c`, `perl -e`, `ruby -e`): the recursive check tokenizes
        # the payload under shell rules, so a JS/Python literal like
        # `'git worktree add ../escape'` is glued into one token and
        # `_has_git_worktree_invocation` can't see it. Fall back to a
        # substring scan for `git ... worktree (add|move)` in the payload
        # when the wrapper is a script-runtime. Skipped for shell wrappers
        # (`bash -c`) because their payloads re-tokenize cleanly and the
        # recursive check is authoritative — the substring scan would
        # otherwise false-positive on data mentions like
        # `bash -c "echo 'git worktree add as text'"`.
        if _is_script_runtime_wrapper(tokens) and _GIT_WORKTREE_RE.search(
            nested
        ):
            return _build_shape_deny()
        # Nested call is clean. Fall through to also evaluate the outer
        # tokens — handles `bash -c 'echo ok' && git worktree add ../escape`
        # where the wrapper hides nothing but the chained outer call does.

    has_subshell = _has_unquoted_subshell(command)
    has_invocation = _has_git_worktree_invocation(tokens)

    if not has_invocation:
        # No actual `git worktree (add|move)` in the tokens — a data mention
        # like `echo worktree add` or a different subcommand like
        # `git worktree list`. A `$(git worktree add ...)` substitution is
        # NOT hidden from the scan: _normalize_shell_operators splits parens,
        # so its tokens surface and set has_invocation above. Only a
        # backtick-wrapped invocation stays glued and invisible — accepted
        # residual under the non-adversarial threat model; the previous
        # blanket subshell deny here false-positived on every command that
        # merely mentioned `worktree` near a backtick or `$(` (markdown in
        # heredocs, `$(git worktree list)` interpolations), which activation
        # exposed.
        return None

    if has_subshell:
        return _build_shape_deny()

    if any(t in _SHELL_OPS for t in tokens):
        return _build_shape_deny()

    if not tokens or not _is_git_token(tokens[0]):
        return _build_shape_deny()

    j, c_paths, _ = _consume_git_globals(tokens, 1)
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
    effective_cwd = base_cwd if base_cwd else repo_root
    for c_path in c_paths:
        effective_cwd = _resolve_path(c_path, effective_cwd)

    abs_target = _resolve_path(target, effective_cwd)

    if abs_target == allowed:
        return (
            "Worktree path must include a <name> subdirectory; "
            "use `.worktrees/<name>` instead of `.worktrees`."
        )

    # Symlink walk on the lexical path FIRST. This denies (with a teaching
    # message) when:
    # - `allowed` (i.e. `.worktrees/`) is itself a symlink — any worktree
    #   created under it would land wherever the symlink points
    # - any user-supplied path component is a symlink — even if its target
    #   happens to land back inside `.worktrees/`, the agent shouldn't be
    #   relying on indirection through a symlinked path
    # Running this before the containment startswith avoids ambiguity when
    # the realpath check below sees a hostile `.worktrees -> /tmp` symlink
    # collapse both sides into the same prefix.
    symlink_component = _has_symlink_in_path(abs_target, allowed)
    if symlink_component:
        return (
            f"Worktree path contains a symlinked component "
            f"`{symlink_component}` that could redirect new worktrees "
            f"outside `.worktrees/`. Remove the symlink and retry."
        )

    # Realpath-based containment. The lexical `os.path.normpath` collapses
    # `..` segments BEFORE any symlink is followed, so
    # `.worktrees/link/../wt` (where `link -> /tmp`) normpaths to
    # `.worktrees/wt` and passes a lexical startswith — while git would
    # actually create the worktree at `/tmp/../wt` = `/wt`. Realpath
    # follows symlinks left-to-right and resolves `..` AFTER each symlink
    # traversal, matching filesystem semantics. Both sides are realpath'd
    # so platform symlinks (macOS `/var -> /private/var`, Linux `/tmp ->
    # ...`) collapse symmetrically and don't cause false denies on
    # legitimate paths. The symlink-walk above already vetoed
    # user-supplied symlinks, so a hostile `.worktrees -> /tmp` can't
    # widen the prefix here.
    if os.path.isabs(target):
        raw_target = target
    else:
        raw_target = os.path.join(effective_cwd, target)
    abs_target_real = os.path.realpath(raw_target)
    allowed_real = os.path.realpath(allowed)

    if (
        abs_target_real != allowed_real
        and not abs_target_real.startswith(allowed_real + os.sep)
    ):
        retry = f"git worktree {subcmd} .worktrees/<name>"
        if subcmd == "add":
            retry += " -b worktree-<name>"
        return (
            f"Worktrees must live under .worktrees/<name>/ at the repo root "
            f"(target '{target}' resolves outside .worktrees/). "
            f"Retry with `{retry}`."
        )

    return None


# ---------------------------------------------------------------------------
# Worktree-removal occupancy guard
# ---------------------------------------------------------------------------
# Deleting a directory that is a live process's cwd breaks every subsequent
# command spawn in that process's session on macOS/Linux — Node reports the
# missing spawn-cwd as `ENOENT posix_spawn '/bin/sh'` against the executable
# (2026-07-07 incident: a cleanup session removed a worktree a live session
# occupied). Removal commands are therefore occupancy-checked: DENY with the
# occupant list unless the statement carries the explicit escape token.
#
# Unlike the rest of this hook, removal decisions fail CLOSED when the check
# itself errors: a silent fail-open would re-open the incident on exactly the
# machines where enumeration misbehaves. The escape token is the valve.

_OCCUPANCY_ESCAPE_TOKEN = "WORKTREE_REMOVE_ALLOW_OCCUPIED=1"
_LSOF_BIN = "/usr/sbin/lsof"
_OCCUPANCY_TIMEOUT_SECONDS = 10
_MAX_OCCUPANTS_LISTED = 8

# Cheap raw-text gates so non-removal commands skip tokenization, and so a
# shlex parse failure on a removal-shaped command can deny instead of
# falling open (same intent must not get opposite outcomes depending on a
# stray quote). NOT reused for interpreter payloads the way _GIT_WORKTREE_RE
# is — a data mention like `echo "git worktree remove x"` parses fine and is
# filtered by the token scan; extending the substring fallback to `remove`
# would turn every such mention into a deny.
_GIT_WORKTREE_REMOVE_RE = re.compile(
    r"\bworktree\b[^\n]{0,40}\bremove\b", re.IGNORECASE
)
_UNSAFE_TARGET_RE = re.compile(r"[$`*?\[]")
# Redirection-shaped tokens survive _normalize_shell_operators as `>`,
# `>>`, `<`, `2>`, `2>/dev/null`, `>file` (only `;|&()` get split). A bare
# operator consumes the following token as its filename.
_REDIRECTION_TOKEN_RE = re.compile(r"^\d*(>>?|<)")


class _OccupancyCheckError(Exception):
    """Live-occupant enumeration itself failed (callers fail closed)."""


def _parent_pid(pid):
    """Parent pid via `ps` (portable across darwin/linux); 0 on failure."""
    try:
        result = subprocess.run(
            ["ps", "-o", "ppid=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return int(result.stdout.strip() or 0)
    except (OSError, subprocess.SubprocessError, ValueError):
        return 0


def _own_lineage_pids():
    """This process's pid plus its full ancestor chain.

    Hooks are spawned with the session's cwd — during a legitimate harness
    auto-clean that cwd is INSIDE the worktree being removed (WorktreeRemove
    probe, 2026-07-07), so the check's own sh/bash/python lineage would
    otherwise always count as an occupant and deadlock every auto-clean.
    Sibling sessions, their background children, and daemons are never
    ancestors, so the cross-session incident class stays detectable. The
    accepted trade-off: a session removing the very worktree its own harness
    process was launched in is excluded via ancestry (documented residual)."""
    lineage = set()
    pid = os.getpid()
    while pid > 0 and pid not in lineage and len(lineage) < 32:
        lineage.add(pid)
        pid = _parent_pid(pid)
    return lineage


def _resolved_path_is_under(path, ancestor_real):
    """True if realpath(path) is ancestor_real or inside it. Boundary-aware
    (`.worktrees/ab` is NOT under `.worktrees/a`) and realpath'd on the
    probe side so platform symlinks (`/tmp` -> `/private/tmp`) and symlinked
    repo paths compare symmetrically with an already-resolved ancestor."""
    resolved = os.path.realpath(path)
    return resolved == ancestor_real or resolved.startswith(
        ancestor_real + os.sep
    )


def _parse_lsof_cwd_fields(output, target_real, excluded_pids):
    """Parse `lsof -Fpcn` field output (p<pid> / c<command> / n<path> lines,
    one cwd record per process) into (pid, command, cwd) occupant tuples."""
    occupants = []
    pid = None
    command_name = ""
    for line in output.splitlines():
        if not line:
            continue
        tag, value = line[0], line[1:]
        if tag == "p":
            try:
                pid = int(value)
            except ValueError:
                pid = None
            command_name = ""
        elif tag == "c":
            command_name = value
        elif tag == "n" and pid is not None and pid not in excluded_pids:
            if _resolved_path_is_under(value, target_real):
                occupants.append((pid, command_name, value))
    return occupants


def _occupants_darwin(target_real, excluded_pids):
    """All-process cwd enumeration via lsof. Never `+D <dir>` — that stats
    the entire tree (lsof(8) warns it may be slow) and a node_modules-bearing
    worktree would blow the timeout in exactly the realistic case; one cwd
    record per process is cheap and filtered here instead."""
    try:
        result = subprocess.run(
            [_LSOF_BIN, "-a", "-d", "cwd", "-Fpcn"],
            capture_output=True,
            text=True,
            timeout=_OCCUPANCY_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise _OccupancyCheckError(f"lsof failed: {error}")
    # lsof exits 1 both for "nothing matched" and for processes it could not
    # fully inspect — normal here. Anything else is a real failure.
    if result.returncode not in (0, 1):
        raise _OccupancyCheckError(
            f"lsof exit {result.returncode}: {result.stderr.strip()[:200]}"
        )
    return _parse_lsof_cwd_fields(result.stdout, target_real, excluded_pids)


def _occupants_linux(target_real, excluded_pids):
    """All-process cwd enumeration via /proc (also the WSL2 path)."""
    try:
        proc_entries = os.listdir("/proc")
    except OSError as error:
        raise _OccupancyCheckError(f"/proc scan failed: {error}")
    occupants = []
    for entry in proc_entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid in excluded_pids:
            continue
        try:
            cwd_path = os.readlink(f"/proc/{entry}/cwd")
        except OSError:
            continue  # exited mid-scan, kernel thread, or EACCES
        if cwd_path.endswith(" (deleted)"):
            cwd_path = cwd_path[: -len(" (deleted)")]
        if not _resolved_path_is_under(cwd_path, target_real):
            continue
        try:
            with open(f"/proc/{entry}/comm") as comm_file:
                command_name = comm_file.read().strip()
        except OSError:
            command_name = ""
        occupants.append((pid, command_name, cwd_path))
    return occupants


def _worktree_occupants(target_path, lsof_output_file=None):
    """Live processes whose cwd sits at/under target_path, minus this
    check's own spawn lineage. Raises _OccupancyCheckError when enumeration
    itself fails. lsof_output_file substitutes canned `-Fpcn` output so the
    parser is testable on any OS.

    Platforms without an enumeration path (native Windows) return empty:
    Windows itself locks a directory that is any process's cwd, so removal
    of an occupied worktree already fails at the filesystem there."""
    target_real = os.path.realpath(target_path)
    excluded_pids = _own_lineage_pids()
    if lsof_output_file is not None:
        try:
            with open(lsof_output_file) as fixture:
                return _parse_lsof_cwd_fields(
                    fixture.read(), target_real, excluded_pids
                )
        except OSError as error:
            raise _OccupancyCheckError(f"fixture read failed: {error}")
    if sys.platform == "darwin":
        return _occupants_darwin(target_real, excluded_pids)
    if sys.platform.startswith("linux"):
        return _occupants_linux(target_real, excluded_pids)
    return []


def _iter_statements(tokens):
    """Yield token slices between _SHELL_OPS separators."""
    statement = []
    for tok in tokens:
        if tok in _SHELL_OPS:
            if statement:
                yield statement
            statement = []
        else:
            statement.append(tok)
    if statement:
        yield statement


def _statement_has_escape(statement):
    """True if the escape token appears as an assignment-prefix token before
    the statement's command head — exact-token match only. A quoted mention
    (an agent echoing the deny message's remediation text) tokenizes as part
    of a larger string token or lands after the head, so narration never
    authorizes the removal. The `env VAR=1 ...` spelling is deliberately not
    recognized — the deny message prescribes the exact prefix form."""
    for tok in statement:
        if tok == _OCCUPANCY_ESCAPE_TOKEN:
            return True
        if "=" not in tok or tok.startswith("="):
            return False  # first non-assignment token is the command head
    return False


def _iter_positional_tokens(tokens, honor_double_dash):
    """Positional (non-flag) tokens, skipping redirections. A bare
    redirection operator (`>`, `2>`, `<`, `>>`) consumes the next token as
    its filename. With honor_double_dash, tokens after `--` count as
    positionals even when dash-prefixed (rm semantics); without it `--` is
    merely skipped (git worktree remove has no valued flags)."""
    past_double_dash = False
    skip_redirect_filename = False
    for tok in tokens:
        if skip_redirect_filename:
            skip_redirect_filename = False
            continue
        if _REDIRECTION_TOKEN_RE.match(tok):
            if _REDIRECTION_TOKEN_RE.fullmatch(tok):
                skip_redirect_filename = True
            continue
        if tok == "--":
            past_double_dash = True
            continue
        if tok.startswith("-") and not (honor_double_dash and past_double_dash):
            continue
        yield tok


def _build_removal_unparseable_deny(detail):
    return (
        "Worktree removals are occupancy-checked, which needs a literal "
        f"target path — could not safely parse: {detail!r}. Re-run with a "
        "literal path (`git worktree remove .worktrees/<name>`), one removal "
        "per command — no shell variables, globs, or command substitution "
        "in the target."
    )


def _build_occupied_deny(display_target, occupants):
    listing = "; ".join(
        f"PID {pid} ({command_name or 'unknown'}) cwd={cwd_path}"
        for pid, command_name, cwd_path in occupants[:_MAX_OCCUPANTS_LISTED]
    )
    return (
        f"'{display_target}' is the working directory of live process(es): "
        f"{listing}. Deleting it would break every later command spawn in "
        "those sessions (ENOENT posix_spawn '/bin/sh'). Occupancy can be "
        "transient — retry once before escalating. Otherwise exit the "
        "occupying session or kill the PIDs. To proceed anyway, re-run the "
        f"exact command prefixed with {_OCCUPANCY_ESCAPE_TOKEN} (e.g. "
        f"`{_OCCUPANCY_ESCAPE_TOKEN} git worktree remove {display_target}`)."
    )


def _build_unverifiable_deny(display_target, error):
    return (
        f"Could not verify that no live session occupies '{display_target}' "
        f"({error}); refusing the removal (occupancy checks fail closed). "
        "If you are certain it is unoccupied, re-run the exact command "
        f"prefixed with {_OCCUPANCY_ESCAPE_TOKEN}."
    )


def _extract_git_removal_target(rest, base):
    """Given statement tokens starting at a git head whose subcommand chain
    is `worktree remove`, return (abs_target, display_target, deny_reason).
    Exactly one of the pair / deny_reason is meaningful."""
    after_globals, c_paths, _ = _consume_git_globals(rest, 1)
    if (
        after_globals + 1 >= len(rest)
        or rest[after_globals].lower() != "worktree"
        or rest[after_globals + 1].lower() != "remove"
    ):
        return None, None, None
    target = next(
        _iter_positional_tokens(
            rest[after_globals + 2 :], honor_double_dash=False
        ),
        None,
    )
    if target is None:
        return None, None, None  # git rejects a target-less remove itself
    if _UNSAFE_TARGET_RE.search(target):
        return None, None, _build_removal_unparseable_deny(target)
    effective_cwd = base
    for c_path in c_paths:
        effective_cwd = _resolve_path(c_path, effective_cwd)
    abs_target = _resolve_path(os.path.expanduser(target), effective_cwd)
    return abs_target, target, None


def _collect_rm_targets(rest, base, worktrees_root, worktrees_real):
    """Removal targets of a recursive `rm` statement that land inside
    .worktrees/, resolved against the session cwd first so
    `cd .worktrees && rm -rf x` and `rm -rf ../x` from inside are caught.
    Unresolvable (glob/variable) targets that point at .worktrees textually,
    or appear while the cwd is inside it, fall back to checking the whole
    tree — cheap, since enumeration is per-process, not per-file."""
    flags = [t for t in rest[1:] if t.startswith("-") and t != "--"]
    recursive = any(
        t in ("--recursive", "-R")
        or (
            t.startswith("-")
            and not t.startswith("--")
            and any(ch in "rR" for ch in t[1:])
        )
        for t in flags
    )
    if not recursive:
        return []
    targets = []
    base_inside = _resolved_path_is_under(base, worktrees_real)
    for tok in _iter_positional_tokens(rest[1:], honor_double_dash=True):
        if _UNSAFE_TARGET_RE.search(tok):
            if ".worktrees" in tok or base_inside:
                targets.append((worktrees_root, tok))
            continue
        abs_target = _resolve_path(os.path.expanduser(tok), base)
        if _resolved_path_is_under(abs_target, worktrees_real):
            targets.append((abs_target, tok))
    return targets


def _check_worktree_removal(command, base_cwd=None, _depth=0):
    """Occupancy gate for worktree-removal commands (deny reason or None).

    Unlike add|move there is no strict-shape requirement — documented flows
    (plan-execution teardown) legitimately chain a removal with branch
    cleanup, so each statement between shell operators is scanned
    independently for `git [globals] worktree remove <target>` and for
    recursive `rm` touching .worktrees/. Every literal target is
    occupancy-checked; a statement prefixed with the exact escape token
    skips the check. Unextractable targets and shlex failures on
    removal-shaped commands DENY (fail closed) rather than fall open.
    Wrappers are unwrapped per statement head; a wrapper hidden mid-payload
    remains an accepted residual, consistent with add|move."""
    if _depth > _MAX_WRAPPER_DEPTH:
        return None

    repo_root = _repo_root()
    worktrees_root = (
        os.path.normpath(os.path.join(repo_root, _WORKTREE_ALLOWED_DIR))
        if repo_root
        else None
    )
    worktrees_real = (
        os.path.realpath(worktrees_root) if worktrees_root else None
    )
    base = base_cwd if base_cwd else (repo_root or os.getcwd())

    mentions_git_removal = bool(_GIT_WORKTREE_REMOVE_RE.search(command))
    rm_relevant = bool(re.search(r"\brm\b", command)) and (
        ".worktrees" in command
        or (
            worktrees_real is not None
            and _resolved_path_is_under(base, worktrees_real)
        )
    )
    if not mentions_git_removal and not rm_relevant:
        return None

    # No blanket subshell/backtick deny here (unlike add|move): doc/PR text
    # written through heredocs legitimately mentions `git worktree remove`
    # inside markdown backticks, and a blanket deny turns every such mention
    # into a false positive (found by dogfooding — the guard denied its own
    # PR-creation command). `$(...)` stays visible to the statement scan
    # below because _normalize_shell_operators splits parens, and a
    # substitution IN a removal target still denies via _UNSAFE_TARGET_RE.
    # A removal hidden entirely inside backticks is an accepted residual
    # under the non-adversarial threat model.
    normalized = _normalize_shell_operators(command)
    try:
        tokens = shlex.split(normalized)
    except ValueError:
        return _build_removal_unparseable_deny(command)

    removal_targets = []  # (abs_target, display_target, escaped)
    for statement in _iter_statements(tokens):
        escaped = _statement_has_escape(statement)
        head_index = 0
        while (
            head_index < len(statement)
            and "=" in statement[head_index]
            and not statement[head_index].startswith("=")
        ):
            head_index += 1
        if head_index >= len(statement):
            continue
        rest = statement[head_index:]

        nested = _extract_wrapped_command(rest)
        if nested is not None:
            nested_deny = _check_worktree_removal(
                nested, base_cwd, _depth + 1
            )
            if nested_deny is not None:
                return nested_deny
            continue

        rest = _strip_env_prefix(rest)
        if not rest:
            continue
        head = rest[0]

        if _is_git_token(head):
            abs_target, display, deny = _extract_git_removal_target(
                rest, base
            )
            if deny is not None:
                return deny
            if abs_target is not None:
                removal_targets.append((abs_target, display, escaped))
            continue

        if (
            os.path.basename(head) == "rm"
            and worktrees_root is not None
        ):
            for abs_target, display in _collect_rm_targets(
                rest, base, worktrees_root, worktrees_real
            ):
                removal_targets.append((abs_target, display, escaped))

    for abs_target, display, escaped in removal_targets:
        if escaped:
            continue
        try:
            occupants = _worktree_occupants(abs_target)
        except _OccupancyCheckError as error:
            return _build_unverifiable_deny(display, error)
        if occupants:
            return _build_occupied_deny(display, occupants)
    return None


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def _read_hook_payload():
    """Hook input: JSON on stdin (documented contract — the command nests at
    tool_input.command), falling back to the legacy flat CLAUDE_TOOL_INPUT
    env shape. Until 2026-07-07 this hook read ONLY the env var, which the
    harness never sets, so it had never actually fired. Returns
    (command, cwd)."""
    data = None
    if not sys.stdin.isatty():
        try:
            raw = sys.stdin.read()
        except OSError:
            raw = ""
        if raw.strip():
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = None
    if not isinstance(data, dict):
        try:
            data = json.loads(os.environ.get("CLAUDE_TOOL_INPUT", "{}"))
        except json.JSONDecodeError:
            data = {}
        if not isinstance(data, dict):
            data = {}
    tool_input = data.get("tool_input")
    if isinstance(tool_input, dict):
        command = tool_input.get("command", "")
    else:
        command = data.get("command", "")
    if not isinstance(command, str):
        command = ""
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = None
    return command, cwd


def _emit_decision(decision, reason):
    print(  # noqa: T201 — hook output to stdout is required
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": decision,
                    "permissionDecisionReason": reason,
                }
            }
        )
    )


def _run_hook_mode():
    command, payload_cwd = _read_hook_payload()
    if not command:
        return 0

    for pattern, reason in DENY_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            _emit_decision("deny", reason)
            return 0

    worktree_reason = _check_worktree_path(command, payload_cwd)
    if worktree_reason:
        _emit_decision("deny", worktree_reason)
        return 0

    removal_reason = _check_worktree_removal(command, payload_cwd)
    if removal_reason:
        _emit_decision("deny", removal_reason)
        return 0

    for entry in ASK_PATTERNS:
        pattern, reason = entry[0], entry[1]
        exclude = entry[_EXCLUDE_INDEX] if len(entry) > _EXCLUDE_INDEX else None
        if re.search(pattern, command, re.IGNORECASE):
            if exclude and re.search(exclude, command, re.IGNORECASE):
                continue
            _emit_decision("ask", reason)
            return 0
    return 0


def _run_occupancy_cli(argv):
    """`--occupancy <path> [--lsof-output-file <file>]`: occupant lines
    (pid<TAB>command<TAB>cwd) on stdout; empty output = unoccupied; exit 2 =
    could not verify (the caller decides fail-open vs fail-closed).
    worktree.sh shells out to this before harness-initiated removals."""
    target = None
    lsof_output_file = None
    i = 0
    while i < len(argv):
        if argv[i] == "--lsof-output-file" and i + 1 < len(argv):
            lsof_output_file = argv[i + 1]
            i += 2
            continue
        if target is None:
            target = argv[i]
            i += 1
            continue
        print(f"unexpected argument: {argv[i]}", file=sys.stderr)
        return 2
    if not target:
        print(
            "usage: command-guard.py --occupancy <path> "
            "[--lsof-output-file <file>]",
            file=sys.stderr,
        )
        return 2
    try:
        occupants = _worktree_occupants(target, lsof_output_file)
    except _OccupancyCheckError as error:
        print(f"occupancy check failed: {error}", file=sys.stderr)
        return 2
    for pid, command_name, cwd_path in occupants:
        print(f"{pid}\t{command_name}\t{cwd_path}")
    return 0


def main(argv):
    if argv and argv[0] == "--occupancy":
        return _run_occupancy_cli(argv[1:])
    return _run_hook_mode()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
