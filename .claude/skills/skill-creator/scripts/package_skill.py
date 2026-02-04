#!/usr/bin/env python3
"""
Skill Packager - Creates a distributable .skill file.

Usage:
    package_skill.py <path/to/skill-folder> [output-directory] [--dry-run]

Options:
    --dry-run    Show what would be packaged without creating the file

Example:
    package_skill.py ~/.claude/skills/my-skill
    package_skill.py ./skills/pdf-editor ./dist
    package_skill.py ./skills/my-skill --dry-run
"""

import sys
import zipfile
from pathlib import Path

from lib import ValidationLevel
from validate_skill import validate_skill


def package_skill(skill_path, output_dir=None, dry_run=False):
    """
    Package a skill folder into a .skill file.

    :param skill_path: Path to the skill directory.
    :param output_dir: Optional output directory for the .skill file.
    :param dry_run: If True, show what would be packaged without creating.
    :return: Path to created .skill file, or None on failure.
    """
    skill_path = Path(skill_path).resolve()

    if not skill_path.exists():
        print(f"Error: Skill folder not found: {skill_path}")
        return None

    if not skill_path.is_dir():
        print(f"Error: Path is not a directory: {skill_path}")
        return None

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        print(f"Error: SKILL.md not found in {skill_path}")
        return None

    # Run validation
    print("Validating skill...")
    report = validate_skill(skill_path)

    if report.status == ValidationLevel.FAIL:
        error_count = len(report.errors)
        print(f"Validation failed: {error_count} error(s)")
        for err in report.errors:
            print(f"  [{err.gate.capitalize()}] {err.message}")
        print("\nFix errors before packaging.")
        return None

    # Build status message
    if report.warnings:
        warning_count = len(report.warnings)
        print(f"Skill valid with {warning_count} warning(s)\n")
    else:
        print("Skill is valid!\n")

    # Show warnings but continue
    if report.warnings:
        print(f"Warnings ({len(report.warnings)}):")
        for w in report.warnings:
            print(f"  [{w.gate.capitalize()}] {w.message}")
        print()

    # Determine output location
    skill_name = skill_path.name
    if output_dir:
        output_path = Path(output_dir).resolve()
        if not dry_run:
            output_path.mkdir(parents=True, exist_ok=True)
    else:
        output_path = Path.cwd()

    skill_filename = output_path / f"{skill_name}.skill"

    # Collect files to package
    files_to_package = []
    total_size = 0
    for file_path in skill_path.rglob("*"):
        if file_path.is_file():
            arcname = file_path.relative_to(skill_path.parent)
            file_size = file_path.stat().st_size
            files_to_package.append((file_path, arcname, file_size))
            total_size += file_size

    if dry_run:
        print("Dry run - would package the following files:\n")
        for _, arcname, file_size in files_to_package:
            print(f"  {arcname} ({file_size:,} bytes)")
        print(f"\nTotal: {len(files_to_package)} files, {total_size:,} bytes")
        print(f"Would create: {skill_filename}")
        return skill_filename

    # Create .skill file (zip format)
    try:
        with zipfile.ZipFile(
            skill_filename, "w", zipfile.ZIP_DEFLATED
        ) as zipf:
            for file_path, arcname, _ in files_to_package:
                zipf.write(file_path, arcname)
                print(f"  Added: {arcname}")

        print(f"\nPackaged: {skill_filename}")
        return skill_filename

    except Exception as e:
        print(f"Error creating .skill file: {e}")
        return None


def main():
    dry_run = "--dry-run" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]

    if len(args) < 1:
        print(
            "Usage: package_skill.py <path/to/skill-folder> "
            "[output-dir] [--dry-run]"
        )
        print("\nOptions:")
        print(
            "  --dry-run    Show what would be packaged "
            "without creating the file"
        )
        print("\nExample:")
        print("  package_skill.py ~/.claude/skills/my-skill")
        print("  package_skill.py ./skills/pdf-editor ./dist")
        print("  package_skill.py ./skills/my-skill --dry-run")
        sys.exit(1)

    skill_path = args[0]
    output_dir = args[1] if len(args) > 1 else None

    if dry_run:
        print(f"[DRY RUN] Packaging: {skill_path}")
    else:
        print(f"Packaging: {skill_path}")
    if output_dir:
        print(f"Output: {output_dir}")
    print()

    result = package_skill(skill_path, output_dir, dry_run)
    sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
