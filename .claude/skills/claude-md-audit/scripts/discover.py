#!/usr/bin/env python3
"""Discover all instruction files and determine loading order.

Finds CLAUDE.md, .claude/rules/*.md, and @-included files (e.g., AGENTS.md).
Outputs a JSON manifest grouped by loading phase, suitable for consumption
by the claude-md-audit skill. Uses only Python stdlib — no dependencies.

Usage:
    python .claude/skills/claude-md-audit/scripts/discover.py [--root DIR]
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Final, Literal, TypedDict

# ── Constants ────────────────────────────────────────────────

type PhaseKey = Literal[
    "phase_1_always_root",
    "phase_2_always_rules",
    "phase_3_path_scoped_rules",
    "phase_4_subdirectory",
]
type FileLoading = Literal["always", "path-scoped", "on-demand"]


class UnresolvedReference(TypedDict):
    file: str
    line: int
    reference: str
    issue: str


class CircularReference(TypedDict):
    file: str
    reason: str


class IncludeEntry(TypedDict):
    path: str
    lines: int
    reference: str
    reference_line: int
    resolved: bool
    loading: Literal["included"]
    included_by: str
    includes: list[IncludeEntry]


class FileEntry(TypedDict, total=False):
    path: str
    lines: int
    phase: int
    loading: FileLoading
    includes: list[IncludeEntry]
    triggers_on: list[str]
    depth: int
    parent_dir: str


class PhaseSummary(TypedDict):
    description: str
    files: list[FileEntry]
    total_lines: int
    total_lines_with_includes: int


class Manifest(TypedDict):
    root: str
    total_files: int
    total_files_with_includes: int
    total_lines: int
    total_lines_with_includes: int
    phases: dict[PhaseKey, PhaseSummary]
    loading_order: list[str]
    include_graph: dict[str, list[str]]
    unresolved_references: list[UnresolvedReference]
    circular_references: list[CircularReference]


MAX_INCLUDE_DEPTH: Final[int] = 5
INCLUDE_RE: Final[re.Pattern[str]] = re.compile(r"^@(\S+\.md)\s*$")
ROOT_MARKDOWN_FILES: Final[tuple[str, str]] = ("CLAUDE.md", ".claude.md")
PHASE_DESCRIPTIONS: Final[dict[PhaseKey, str]] = {
    "phase_1_always_root": (
        "Root CLAUDE.md \u2014 always loaded, every conversation"
    ),
    "phase_2_always_rules": (
        "Rules without path scoping \u2014 always loaded, every conversation"
    ),
    "phase_3_path_scoped_rules": (
        "Rules with path scoping"
        " \u2014 loaded when agent works in matching paths"
    ),
    "phase_4_subdirectory": (
        "Subdirectory CLAUDE.md \u2014 loaded when agent enters that directory"
    ),
}

# ── Public API ───────────────────────────────────────────────


def discover(root: Path) -> Manifest:
    """Discover and classify all instruction files.

    :param root: Repository root directory.
    :return: Manifest dict with phases, loading order,
        include graph, and diagnostics.
    """
    root = root.resolve()

    phase1, unresolved_1, circular_1 = _discover_root_file(root)
    phase2, phase3 = _discover_rules(root)
    phase4, unresolved_4, circular_4 = _discover_subdirectory_files(root)

    all_unresolved = unresolved_1 + unresolved_4
    all_circular = circular_1 + circular_4
    all_files = phase1 + phase2 + phase3 + phase4

    total_lines = sum(f["lines"] for f in all_files)
    include_lines = sum(
        _sum_include_lines(f.get("includes", [])) for f in all_files
    )
    include_file_count = sum(
        _count_include_files(f.get("includes", [])) for f in all_files
    )

    phases: dict[PhaseKey, PhaseSummary] = {
        "phase_1_always_root": _make_phase_dict(
            PHASE_DESCRIPTIONS["phase_1_always_root"],
            phase1,
        ),
        "phase_2_always_rules": _make_phase_dict(
            PHASE_DESCRIPTIONS["phase_2_always_rules"],
            phase2,
        ),
        "phase_3_path_scoped_rules": _make_phase_dict(
            PHASE_DESCRIPTIONS["phase_3_path_scoped_rules"],
            phase3,
        ),
        "phase_4_subdirectory": _make_phase_dict(
            PHASE_DESCRIPTIONS["phase_4_subdirectory"],
            phase4,
        ),
    }

    return {
        "root": str(root),
        "total_files": len(all_files),
        "total_files_with_includes": (len(all_files) + include_file_count),
        "total_lines": total_lines,
        "total_lines_with_includes": (total_lines + include_lines),
        "phases": phases,
        "loading_order": _build_loading_order(all_files),
        "include_graph": _build_include_graph(all_files),
        "unresolved_references": all_unresolved,
        "circular_references": all_circular,
    }


def scan_includes(
    filepath: Path,
    root: Path,
    visited: set[Path] | None = None,
    depth: int = 0,
) -> tuple[
    list[IncludeEntry],
    list[UnresolvedReference],
    list[CircularReference],
]:
    """Scan a markdown file for @include references.

    Detects lines matching ``^@<path>.md$`` outside fenced
    code blocks. Resolves paths relative to the referencing
    file's directory. Recurses into included files with cycle
    and depth protection.

    :param filepath: The file to scan for @references.
    :param root: Repository root for path validation.
    :param visited: Already-visited paths (cycle detection).
    :param depth: Current recursion depth.
    :return: Tuple of (resolved_includes,
        unresolved_references, circular_references).
    """
    if visited is None:
        visited = set()

    resolved_self = filepath.resolve()
    all_unresolved: list[UnresolvedReference] = []
    all_circular: list[CircularReference] = []
    root_resolved = root.resolve()
    rel_file = str(filepath.relative_to(root_resolved))

    # Cycle detection
    if resolved_self in visited:
        all_circular.append(
            {
                "file": rel_file,
                "reason": "circular reference",
            }
        )
        return [], all_unresolved, all_circular
    visited.add(resolved_self)

    # Depth limit
    if depth > MAX_INCLUDE_DEPTH:
        all_unresolved.append(
            {
                "file": rel_file,
                "line": 0,
                "reference": "(recursive)",
                "issue": (f"max include depth ({MAX_INCLUDE_DEPTH}) exceeded"),
            }
        )
        return [], all_unresolved, all_circular

    try:
        text = filepath.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        all_unresolved.append(
            {
                "file": rel_file,
                "line": 0,
                "reference": "(self)",
                "issue": f"cannot read file: {exc}",
            }
        )
        return [], all_unresolved, all_circular

    includes: list[IncludeEntry] = []
    seen_resolved: set[Path] = set()

    for line_num, ref_path_str in _extract_include_refs(text):
        ref_resolved = (filepath.parent / ref_path_str).resolve()

        if not _is_within_root(ref_resolved, root_resolved):
            all_unresolved.append(
                {
                    "file": rel_file,
                    "line": line_num,
                    "reference": f"@{ref_path_str}",
                    "issue": ("resolves outside repository root"),
                }
            )
            continue

        if ref_resolved in seen_resolved:
            continue
        seen_resolved.add(ref_resolved)

        rel_path = str(ref_resolved.relative_to(root_resolved))

        if not ref_resolved.is_file():
            all_unresolved.append(
                {
                    "file": rel_file,
                    "line": line_num,
                    "reference": f"@{ref_path_str}",
                    "issue": "file not found",
                }
            )
            continue

        sub_includes, sub_unresolved, sub_circular = scan_includes(
            ref_resolved, root, visited, depth + 1
        )
        all_unresolved.extend(sub_unresolved)
        all_circular.extend(sub_circular)

        include_entry: IncludeEntry = {
            "path": rel_path,
            "lines": count_lines(ref_resolved),
            "reference": f"@{ref_path_str}",
            "reference_line": line_num,
            "resolved": True,
            "loading": "included",
            "included_by": rel_file,
            "includes": sub_includes,
        }
        includes.append(include_entry)

    return includes, all_unresolved, all_circular


def _find_git_binary() -> str | None:
    """Return the absolute path to the git executable, if available."""
    return shutil.which("git")


def find_git_root(start: Path) -> Path:
    """Find the git repository root, or fall back to *start*."""
    git_binary = _find_git_binary()
    if git_binary is None:
        return start

    try:
        result = subprocess.run(
            [git_binary, "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
            cwd=start,
        )
        if result.returncode == 0:
            return Path(result.stdout.strip())
    except FileNotFoundError:
        pass
    return start


def has_paths_frontmatter(
    filepath: Path,
) -> list[str] | None:
    """Check if a markdown file has YAML frontmatter with
    a ``paths:`` field.

    :param filepath: Path to the markdown file.
    :return: List of path patterns if found, None otherwise.
    """
    try:
        text = filepath.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    if not text.startswith("---"):
        return None

    end = text.find("---", 3)
    if end == -1:
        return None

    frontmatter = text[3:end]
    paths: list[str] = []
    in_paths = False
    for line in frontmatter.splitlines():
        stripped = line.strip()
        if stripped.startswith("paths:"):
            in_paths = True
            # Check for inline list: paths: [a, b]
            inline = stripped[6:].strip()
            if inline.startswith("["):
                items = inline.strip("[]").split(",")
                paths.extend(
                    item.strip().strip("\"'") for item in items if item.strip()
                )
                return paths if paths else None
            continue
        if in_paths:
            if stripped.startswith("- "):
                paths.append(stripped[2:].strip().strip("\"'"))
            elif stripped and not stripped.startswith("#"):
                break  # New YAML key

    return paths if paths else None


def count_lines(filepath: Path) -> int:
    """Count lines in a file."""
    try:
        return sum(
            1 for line in filepath.read_text(encoding="utf-8").splitlines()
        )
    except (OSError, UnicodeDecodeError):
        return 0


# ── Private: discovery phase helpers ─────────────────────────


def _discover_root_file(
    root: Path,
) -> tuple[
    list[FileEntry],
    list[UnresolvedReference],
    list[CircularReference],
]:
    """Phase 1: find the root CLAUDE.md or .claude.md.

    :param root: Resolved repository root.
    :return: (files, unresolved, circular).
    """
    for name in ROOT_MARKDOWN_FILES:
        candidate = root / name
        if candidate.is_file():
            includes, unresolved, circular = scan_includes(candidate, root)
            entry: FileEntry = {
                "path": str(candidate.relative_to(root)),
                "lines": count_lines(candidate),
                "phase": 1,
                "loading": "always",
                "includes": includes,
            }
            return [entry], unresolved, circular
    return [], [], []


def _discover_rules(
    root: Path,
) -> tuple[list[FileEntry], list[FileEntry]]:
    """Phases 2-3: find always-loaded and path-scoped rules.

    :param root: Resolved repository root.
    :return: (always_loaded_rules, path_scoped_rules).
    """
    always_rules: list[FileEntry] = []
    scoped_rules: list[FileEntry] = []
    rules_dir = root / ".claude" / "rules"
    if not rules_dir.is_dir():
        return always_rules, scoped_rules

    for md_file in sorted(rules_dir.glob("*.md")):
        paths = has_paths_frontmatter(md_file)
        rel_path = str(md_file.relative_to(root))
        line_count = count_lines(md_file)

        if paths:
            scoped_rules.append(
                {
                    "path": rel_path,
                    "lines": line_count,
                    "phase": 3,
                    "loading": "path-scoped",
                    "triggers_on": paths,
                    "includes": [],
                }
            )
        else:
            always_rules.append(
                {
                    "path": rel_path,
                    "lines": line_count,
                    "phase": 2,
                    "loading": "always",
                    "includes": [],
                }
            )
    return always_rules, scoped_rules


def _discover_subdirectory_files(
    root: Path,
) -> tuple[
    list[FileEntry],
    list[UnresolvedReference],
    list[CircularReference],
]:
    """Phase 4: find subdirectory CLAUDE.md files.

    :param root: Resolved repository root.
    :return: (files, unresolved, circular) sorted by
        depth then path.
    """
    files: list[FileEntry] = []
    all_unresolved: list[UnresolvedReference] = []
    all_circular: list[CircularReference] = []
    gitignored = _get_gitignored_dirs(root)

    for dirpath, dirnames, _filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root)
        dirnames[:] = [
            d
            for d in dirnames
            if d != ".git" and str(rel_dir / d) not in gitignored
        ]

        for name in ROOT_MARKDOWN_FILES:
            candidate = Path(dirpath) / name
            is_root = candidate.resolve() == (root / name).resolve()
            if not candidate.is_file() or is_root:
                continue

            rel = str(candidate.relative_to(root))
            includes, unresolved, circular = scan_includes(candidate, root)
            all_unresolved.extend(unresolved)
            all_circular.extend(circular)
            files.append(
                {
                    "path": rel,
                    "lines": count_lines(candidate),
                    "phase": 4,
                    "loading": "on-demand",
                    "depth": rel.count(os.sep),
                    "parent_dir": str(Path(rel).parent),
                    "includes": includes,
                }
            )

    files.sort(
        key=lambda entry: (
            entry["depth"],
            entry["path"],
        )
    )
    return files, all_unresolved, all_circular


def _get_gitignored_dirs(root: Path) -> set[str]:
    """Get gitignored directory paths relative to root.

    Uses ``git ls-files`` to discover directories that
    ``.gitignore`` patterns would exclude, so the directory
    walker can prune them.

    :param root: Repository root.
    :return: Set of relative directory paths
        (without trailing slashes).
    """
    git_binary = _find_git_binary()
    if git_binary is None:
        return set()

    try:
        result = subprocess.run(
            [
                git_binary,
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
            ],
            capture_output=True,
            text=True,
            check=False,
            cwd=root,
        )
        if result.returncode == 0:
            return {
                line.rstrip("/") for line in result.stdout.splitlines() if line
            }
    except FileNotFoundError:
        pass
    return set()


# ── Private: manifest building helpers ───────────────────────


def _build_loading_order(
    all_files: list[FileEntry],
) -> list[str]:
    """Build ordered list of file paths with includes.

    :param all_files: All discovered file entries.
    :return: Paths in loading order.
    """
    order: list[str] = []
    for file_entry in all_files:
        order.append(file_entry["path"])
        order.extend(_flatten_includes(file_entry.get("includes", [])))
    return order


def _flatten_includes(
    includes: list[IncludeEntry],
) -> list[str]:
    """Flatten an include tree into an ordered path list."""
    paths: list[str] = []
    for inc in includes:
        if inc.get("resolved", False):
            paths.append(inc["path"])
            paths.extend(_flatten_includes(inc.get("includes", [])))
    return paths


def _build_include_graph(
    all_files: list[FileEntry],
) -> dict[str, list[str]]:
    """Build a flat mapping of parent path to child paths.

    :param all_files: File dicts with nested include trees.
    :return: Flat graph of include relationships.
    """
    graph: dict[str, list[str]] = {}
    for file_entry in all_files:
        _append_include_graph(
            graph,
            file_entry["path"],
            file_entry.get("includes", []),
        )
    return graph


def _append_include_graph(
    graph: dict[str, list[str]],
    parent_path: str,
    includes: list[IncludeEntry],
) -> None:
    """Append include relationships into the flattened graph."""
    resolved = [inc["path"] for inc in includes if inc.get("resolved")]
    if resolved:
        graph[parent_path] = resolved

    for include in includes:
        nested_includes = include.get("includes", [])
        if include.get("resolved") and nested_includes:
            _append_include_graph(graph, include["path"], nested_includes)


def _make_phase_dict(
    description: str,
    files: list[FileEntry],
) -> PhaseSummary:
    """Build a phase summary dict for the manifest.

    :param description: Human-readable phase description.
    :param files: File entries belonging to this phase.
    :return: Phase summary with line counts.
    """
    return {
        "description": description,
        "files": files,
        "total_lines": sum(f["lines"] for f in files),
        "total_lines_with_includes": (_phase_lines_with_includes(files)),
    }


def _phase_lines_with_includes(
    files: list[FileEntry],
) -> int:
    """Sum direct lines plus included lines for a phase.

    :param files: Phase file entries with include trees.
    :return: Combined line count.
    """
    direct = sum(f["lines"] for f in files)
    included = sum(_sum_include_lines(f.get("includes", [])) for f in files)
    return direct + included


def _sum_include_lines(includes: list[IncludeEntry]) -> int:
    """Sum total lines from a resolved include tree."""
    total = 0
    for inc in includes:
        if inc.get("resolved", False):
            total += inc.get("lines", 0)
            total += _sum_include_lines(inc.get("includes", []))
    return total


def _count_include_files(includes: list[IncludeEntry]) -> int:
    """Count resolved included files recursively."""
    count = 0
    for inc in includes:
        if inc.get("resolved", False):
            count += 1
            count += _count_include_files(inc.get("includes", []))
    return count


# ── Private: scan_includes helpers ───────────────────────────


def _extract_include_refs(
    text: str,
) -> list[tuple[int, str]]:
    """Extract @include references from markdown text.

    Skips references inside fenced code blocks.

    :param text: The markdown file content.
    :return: List of (line_number, reference_path) tuples.
    """
    refs: list[tuple[int, str]] = []
    in_code_block = False
    for line_num, raw_line in enumerate(text.splitlines(), 1):
        stripped = raw_line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        match = INCLUDE_RE.match(stripped)
        if match:
            refs.append((line_num, match.group(1)))
    return refs


def _is_within_root(path: Path, root: Path) -> bool:
    """Check whether *path* is inside *root*."""
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


# ── Private: output helpers ──────────────────────────────────


def _write_summary(manifest: Manifest) -> None:
    """Write a human-readable summary to stderr."""
    total_files = manifest["total_files"]
    total_with_includes = manifest["total_files_with_includes"]
    direct_lines = manifest["total_lines"]
    lines_with_includes = manifest["total_lines_with_includes"]

    if total_files == total_with_includes:
        file_str = f"{total_files} files"
    else:
        included = total_with_includes - total_files
        file_str = f"{total_files} files + {included} included"

    if direct_lines == lines_with_includes:
        line_str = f"{direct_lines} total lines"
    else:
        included = lines_with_includes - direct_lines
        line_str = (
            f"{direct_lines} direct + {included}"
            f" included = {lines_with_includes}"
            " total lines"
        )
    sys.stderr.write(f"\nFound {file_str}, {line_str}\n")

    for phase_data in manifest["phases"].values():
        _write_phase_summary(phase_data)

    unresolved = manifest["unresolved_references"]
    if unresolved:
        sys.stderr.write(
            f"\n  WARNING: {len(unresolved)}"
            " unresolved @include reference(s)\n"
        )
    circular = manifest["circular_references"]
    if circular:
        sys.stderr.write(
            f"  WARNING: {len(circular)} circular @include reference(s)\n"
        )


def _write_phase_summary(phase_data: PhaseSummary) -> None:
    """Write a single phase's summary line to stderr."""
    if not phase_data["files"]:
        return
    desc = phase_data["description"]
    file_count = len(phase_data["files"])
    direct_lines = phase_data["total_lines"]
    lines_with_includes = phase_data["total_lines_with_includes"]
    if direct_lines == lines_with_includes:
        suffix = ""
    else:
        included = lines_with_includes - direct_lines
        suffix = f" ({direct_lines} direct + {included} included)"
    sys.stderr.write(
        f"  {desc}: {file_count} files, {lines_with_includes} lines{suffix}\n"
    )


# ── Entry point ──────────────────────────────────────────────


def _parse_root_arg(argv: list[str]) -> Path | None:
    """Parse an optional ``--root`` argument from argv."""
    if "--root" not in argv:
        return None

    root_index = argv.index("--root") + 1
    if root_index >= len(argv):
        raise SystemExit("Error: --root requires a directory path.")
    return Path(argv[root_index]).resolve()


def main() -> None:
    root = _parse_root_arg(sys.argv)
    if root is None:
        root = find_git_root(Path(".").resolve())
    manifest = discover(root)

    sys.stdout.write(json.dumps(manifest, indent=2) + "\n")

    _write_summary(manifest)


if __name__ == "__main__":
    main()
