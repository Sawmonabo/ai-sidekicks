#!/usr/bin/env python3
"""Worktree-occupancy check used by worktree.sh before a removal.

`--occupancy <path>` lists live processes whose cwd sits at or inside
<path>, one `pid<TAB>command<TAB>cwd` line each, and exits 0; empty output
means the path is free. Exit 2 means the probe itself could not run, so the
caller decides fail-open vs fail-closed (see _run_occupancy_cli).
"""

import os
import subprocess
import sys

_LSOF_BIN = "/usr/sbin/lsof"
_OCCUPANCY_TIMEOUT_SECONDS = 10


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
    # A typo'd or already-removed path has no occupants, which would read as
    # "verified free" — the one answer this probe must never invent.
    if not os.path.isdir(target):
        print(f"not a directory: {target}", file=sys.stderr)
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
    sys.stderr.write("usage: command-guard.py --occupancy <path>\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
