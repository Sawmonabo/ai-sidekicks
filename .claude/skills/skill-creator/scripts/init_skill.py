#!/usr/bin/env python3
"""
Skill Initializer - Creates a new skill from template

Usage:
    init_skill.py <skill-name> --path <path>

Examples:
    init_skill.py my-new-skill --path ~/.claude/skills
    init_skill.py pdf-editor --path ./skills
"""

import sys
from pathlib import Path


# Template loading from assets/
SCRIPT_DIR = Path(__file__).parent
ASSETS_DIR = SCRIPT_DIR.parent / "assets"


def load_template(template_name):
    """Load a template file from the assets directory."""
    template_path = ASSETS_DIR / template_name
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template_path}")
    return template_path.read_text(encoding="utf-8")


# Load templates from assets/
SKILL_TEMPLATE = load_template("skill-template.md")
EXAMPLE_SCRIPT = load_template("example-script.py")
EXAMPLE_REFERENCE = load_template("example-reference.md")
EXAMPLE_ASSET = load_template("example-asset.txt")


def title_case_skill_name(skill_name):
    """Convert hyphenated skill name to Title Case."""
    return " ".join(word.capitalize() for word in skill_name.split("-"))


def init_skill(skill_name, path):
    """Initialize a new skill directory with template."""
    skill_dir = Path(path).resolve() / skill_name

    if skill_dir.exists():
        print(f"Error: Directory already exists: {skill_dir}")
        return None

    try:
        skill_dir.mkdir(parents=True, exist_ok=False)
        print(f"Created: {skill_dir}")
    except Exception as e:
        print(f"Error creating directory: {e}")
        return None

    # Create SKILL.md
    skill_title = title_case_skill_name(skill_name)
    skill_content = SKILL_TEMPLATE.format(
        skill_name=skill_name, skill_title=skill_title
    )

    skill_md_path = skill_dir / "SKILL.md"
    try:
        skill_md_path.write_text(skill_content)
        print("Created: SKILL.md")
    except Exception as e:
        print(f"Error creating SKILL.md: {e}")
        return None

    # Create resource directories with examples
    try:
        # scripts/
        scripts_dir = skill_dir / "scripts"
        scripts_dir.mkdir(exist_ok=True)
        example_script = scripts_dir / "example.py"
        example_script.write_text(EXAMPLE_SCRIPT.format(skill_name=skill_name))
        example_script.chmod(0o755)
        print("Created: scripts/example.py")

        # references/
        references_dir = skill_dir / "references"
        references_dir.mkdir(exist_ok=True)
        example_ref = references_dir / "reference.md"
        example_ref.write_text(
            EXAMPLE_REFERENCE.format(skill_title=skill_title)
        )
        print("Created: references/reference.md")

        # assets/
        assets_dir = skill_dir / "assets"
        assets_dir.mkdir(exist_ok=True)
        example_asset = assets_dir / "example.txt"
        example_asset.write_text(EXAMPLE_ASSET)
        print("Created: assets/example.txt")

    except Exception as e:
        print(f"Error creating resources: {e}")
        return None

    print(f"\nSkill '{skill_name}' initialized at {skill_dir}")
    print("\nNext steps:")
    print("1. Edit SKILL.md - complete TODOs, write description")
    print("2. Add/remove resources in scripts/, references/, assets/")
    print("3. Run: scripts/validate_skill.py <path>")
    print("4. Run: scripts/package_skill.py <path>")

    return skill_dir


def main():
    if len(sys.argv) < 4 or sys.argv[2] != "--path":
        print("Usage: init_skill.py <skill-name> --path <path>")
        print("\nSkill name: hyphen-case, lowercase, max 64 chars")
        print("\nExamples:")
        print("  init_skill.py pdf-editor --path ~/.claude/skills")
        print("  init_skill.py data-analyzer --path ./skills")
        sys.exit(1)

    skill_name = sys.argv[1]
    path = sys.argv[3]

    print(f"Initializing skill: {skill_name}")
    print(f"Location: {path}\n")

    result = init_skill(skill_name, path)
    sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
