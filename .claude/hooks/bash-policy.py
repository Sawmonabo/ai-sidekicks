#!/usr/bin/env python3
"""Bash command policy for Claude Code: one script behind two hook events.

As a PreToolUse hook it refuses the banned shell forms before a command runs. As a
PermissionRequest hook it answers the removal prompt Claude Code still raises in bypass mode: a
command with no rm or rmdir runs, an rm or rmdir on spelled-out paths inside this checkout or
this user's Claude temp folder runs, and anything else prints nothing so the prompt reaches the
person. It reads rm and rmdir only, as that prompt does; a removal done any other way was never
asked about.
"""

import json
import os
import re
import subprocess
import sys
import time

# Each pattern is tried on the command as written and again with its quoted text emptied.
BANNED_FORMS = [
    (
        r"(^|[\s|;&(`])xargs\b",
        "xargs is banned: pass a list with `find ... -exec <program> {} +` or a "
        "`while IFS= read -r` loop",
    ),
    (
        r"(^|[\s|;&(`])(builtin\s+)?cd\s",
        "cd is banned: use git -C, --manifest-path, pnpm --dir and absolute paths",
    ),
    (
        r"(^|[\s|;&(`])pushd\s",
        "pushd is banned: use git -C, --manifest-path, pnpm --dir, env -C and absolute paths",
    ),
    (
        r"(^|[\s|;&(`])rg\b[^|;&\n]*\s(-[a-zA-Z]*r[a-zA-Z]*|--replace)(\s|=|$)",
        "rg -r/--replace is banned (it rewrites the output)",
    ),
    (r"\bgit\b[^|;&\n]*\bstash\b", "git stash is banned"),
    (r"--no-verify\b", "--no-verify is banned (the hook is the secret scan)"),
    (r"\bLEFTHOOK=0\b", "LEFTHOOK=0 is banned"),
    (r"\bgit\b[^|;&\n]*\bcommit-tree\b", "git commit-tree is banned"),
    (r"\bfilter-branch\b", "filter-branch is banned"),
    (
        r"\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*\s(--force|--force-with-lease|-f)(\s|=|$)",
        "a force push is banned (never rewrite pushed commits)",
    ),
    (
        r"\bgit\b[^|;&\n]*\bcommit\b[^|;&\n]*\s--amend\b",
        "commit --amend is banned (never rewrite pushed commits)",
    ),
]
HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

# The filesystem can ignore case, so RM runs rm.
REMOVAL_WORD = re.compile(r"(?<![\w.-])(?:rm|rmdir)(?![\w.-])", re.IGNORECASE)
DIRECTORY_CHANGE = re.compile(r"(?<![\w.-])(?:cd|pushd|popd|chdir)(?![\w.-])")
COMMAND_STARTS = ";&|\n({"
KEYWORD_BEFORE_COMMAND = re.compile(r"(?:^|[\s;&|(])(?:do|then|else)$")
BLANKS = re.compile(r"(?:[ \t]|\\\n)*")
ARGUMENTS_END = ";&|\n)"
DISCARDED_OUTPUT = re.compile(
    r"(?:[12]?>>?[ \t]*/dev/null|2>&1|&>>?[ \t]*/dev/null)(?=[\s;&|)]|$)"
)
PLAIN_TEXT = re.compile(r"[A-Za-z0-9_./@%+,:-]+")
SINGLE_QUOTED = re.compile(r"'([^']*)'")
DOUBLE_QUOTED = re.compile(r'"([^"$`\\!]*)"')
RM_FLAGS = re.compile(r"-[rRfv]+")
MAX_WALKED_ENTRIES = 20000
MAX_LOG_BYTES = 1_000_000


class Refused(Exception):
    """A reason a removal is not provably inside an allowed folder. It never quotes the command."""


def without_heredoc_bodies(command):
    """Drop heredoc bodies, which hold text such as a commit message."""
    kept = []
    lines = iter(command.split("\n"))
    for line in lines:
        kept.append(line)
        heredoc = HEREDOC_START.search(line)
        if heredoc:
            for body_line in lines:
                if body_line.strip() == heredoc.group(2):
                    break
    return "\n".join(kept)


def refuse_banned_forms(request):
    """Exit 2 with the reason when the command holds a banned form, which hands it to the agent."""
    raw = without_heredoc_bodies(request["tool_input"]["command"])
    # With quoted text emptied, a quoted separator cannot split a banned form in two. A
    # double-quoted string that holds a command substitution keeps its text, because that text runs.
    unquoted = re.sub(r"'[^']*'", "''", raw)
    unquoted = re.sub(
        r'"(?:\\.|[^"\\])*"',
        lambda quoted: quoted.group() if "$(" in quoted.group() else '""',
        unquoted,
    )
    for pattern, reason in BANNED_FORMS:
        if re.search(pattern, raw, re.M) or re.search(pattern, unquoted, re.M):
            print(f"bash-policy: refused, {reason}.", file=sys.stderr)
            sys.exit(2)


def read_literal_word(command, at):
    """Read one shell word the shell cannot change; return its text and where it ends."""
    parts = []
    while at < len(command) and command[at] not in " \t" + ARGUMENTS_END:
        plain = PLAIN_TEXT.match(command, at)
        quoted = SINGLE_QUOTED.match(command, at) or DOUBLE_QUOTED.match(command, at)
        if plain:
            parts.append(plain.group())
        elif quoted:
            parts.append(quoted.group(1))
        else:
            raise Refused("an rm argument is not a spelled-out path")
        at = (plain or quoted).end()
    return "".join(parts), at


def read_removal(command, at):
    """Read one rm or rmdir's words; return its targets and whether it removes folders whole."""
    words = []
    while True:
        blanks = BLANKS.match(command, at)
        at = blanks.end()
        if at == len(command) or command[at] in ARGUMENTS_END:
            break
        if not blanks.group():
            raise Refused("an rm word runs into other text")
        discarded = DISCARDED_OUTPUT.match(command, at)
        if discarded:
            at = discarded.end()
            continue
        word, at = read_literal_word(command, at)
        words.append(word)
    targets = []
    is_recursive = False
    options_ended = False
    for word in words:
        if options_ended or not word.startswith("-"):
            targets.append(word)
        elif targets:
            # BSD rm reads this as a file and GNU rm as an option, so neither reading is sure.
            raise Refused("an rm option follows a path")
        elif word == "--":
            options_ended = True
        elif not RM_FLAGS.fullmatch(word):
            raise Refused("an rm option outside -r, -f and -v")
        elif "r" in word.lower():
            is_recursive = True
    if not targets or "" in targets:
        raise Refused("an rm names no path")
    return targets, is_recursive


def git_output(cwd, *args):
    """Return a git answer about cwd, or nothing outside a repository."""
    result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=5)
    return result.stdout.strip() if result.returncode == 0 else ""


def usable_checkouts(candidates):
    """Keep the real checkouts; one holding the home folder never counts."""
    home = os.path.realpath(os.path.expanduser("~"))
    checkouts = []
    for candidate in candidates:
        real = os.path.realpath(candidate) if candidate else ""
        # A folder with no .git of its own came from core.worktree, not from a checkout.
        if not real or not os.path.lexists(os.path.join(real, ".git")):
            continue
        if real != "/" and not (home + "/").startswith(real + "/"):
            checkouts.append(real)
    return checkouts


def allowed_roots(cwd):
    """List the folders removals may touch: the temp folder, this checkout and its main checkout."""
    candidates = [git_output(cwd, "rev-parse", "--show-toplevel")]
    common = git_output(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if os.path.basename(common.rstrip("/")) == ".git":
        candidates.append(os.path.dirname(common.rstrip("/")))
    # The folder's own name stays unresolved, because a link there could lead to the home folder.
    temp = os.path.join(os.path.realpath("/tmp"), f"claude-{os.getuid()}")
    return [temp, *usable_checkouts(candidates)]


def is_protected_name(name):
    folded = name.casefold()
    return folded in (".git", "head") or folded.startswith(".env")


def sits_in_another_repository(path, root):
    """Say whether a folder between root and path is a repository of its own."""
    folder = root
    for part in path[len(root) + 1 :].split("/")[:-1]:
        folder = os.path.join(folder, part)
        # A checkout holds .git and a bare git folder holds HEAD.
        if any(os.path.lexists(os.path.join(folder, name)) for name in (".git", "HEAD")):
            return True
    return False


def inside_a_root(path, roots):
    """Say whether path sits strictly inside a root, in no other repository or worktree."""
    return any(
        path.startswith(root + "/") and not sits_in_another_repository(path, root)
        for root in roots
    )


def holds_protected_entry(folder):
    """Say whether removing folder whole reaches a repository or a secret file."""
    walked = 0
    for _, directories, files in os.walk(folder):
        names = directories + files
        walked += len(names)
        if walked > MAX_WALKED_ENTRIES or any(is_protected_name(name) for name in names):
            return True
    return False


def check_target(target, cwd, roots, is_recursive, changes_directory):
    """Raise Refused unless target sits strictly inside an allowed root."""
    if not target.startswith("/"):
        if changes_directory:
            raise Refused("a relative path follows a directory change")
        target = os.path.join(cwd, target)
    trimmed = target.rstrip("/") or "/"
    # rm removes a link itself, so its own folder counts; a trailing slash follows it instead.
    linked = os.path.join(os.path.realpath(os.path.dirname(trimmed)), os.path.basename(trimmed))
    real = os.path.realpath(target)
    if any(is_protected_name(part) for part in (linked + "/" + real).split("/")):
        raise Refused("a path is protected")
    if not inside_a_root(linked, roots) or not inside_a_root(real, roots):
        raise Refused("a path is outside this checkout and the temp folder")
    if is_recursive and holds_protected_entry(real):
        raise Refused("a folder holds a repository or a secret file")


def check_removals(command, cwd):
    """Raise Refused unless every rm and rmdir removes spelled-out paths in an allowed folder."""
    removals = list(REMOVAL_WORD.finditer(command))
    if not removals:
        return "no rm or rmdir"
    changes_directory = bool(DIRECTORY_CHANGE.search(command))
    roots = allowed_roots(cwd)
    for removal in removals:
        before = command[: removal.start()].rstrip(" \t")
        starts_a_command = (
            not before or before[-1] in COMMAND_STARTS or KEYWORD_BEFORE_COMMAND.search(before)
        )
        if not starts_a_command:
            raise Refused("an rm word is not a command of its own")
        targets, is_recursive = read_removal(command, removal.end())
        for target in targets:
            check_target(target, cwd, roots, is_recursive, changes_directory)
    return "rm on spelled-out paths in an allowed folder"


def record(request, decision, reason):
    """Log a decision without the command, which can carry a secret."""
    folder = os.path.join(os.environ["CLAUDE_PROJECT_DIR"], ".claude", "tmp")
    path = os.path.join(folder, "bash-policy.log")
    os.makedirs(folder, exist_ok=True)
    if os.path.exists(path) and os.path.getsize(path) > MAX_LOG_BYTES:
        os.replace(path, path + ".1")
    entry = {
        "at": time.strftime("%Y-%m-%d %I:%M:%S %p"),
        "decision": decision,
        "reason": reason,
        "description": request["tool_input"].get("description", ""),
    }
    with open(path, "a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")


def answer_removal_prompt(request):
    """Approve the bypass-mode removal prompt, or print nothing so it reaches the person."""
    # The removal prompt arrives with an empty list; an ask rule's prompt arrives without one.
    if (
        request["permission_mode"] != "bypassPermissions"
        or request.get("permission_suggestions") != []
    ):
        return
    try:
        reason = check_removals(request["tool_input"]["command"], request["cwd"])
    except Refused as refusal:
        record(request, "ask", str(refusal))
        return
    record(request, "allow", reason)
    output = {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}
    print(json.dumps({"hookSpecificOutput": output}))


POLICIES = {"PreToolUse": refuse_banned_forms, "PermissionRequest": answer_removal_prompt}

if __name__ == "__main__":
    hook_request = json.load(sys.stdin)
    POLICIES[hook_request["hook_event_name"]](hook_request)
