#!/usr/bin/env python3
"""
Unified Skill Validator.

Combines 4-gate validation with token analysis into a single report.

Usage:
    validate_skill.py <skill-path>
    validate_skill.py <skill-path> --output=xml
    validate_skill.py <skill-path> --output=yaml
    validate_skill.py <skill-path> --output=json

Exit Codes:
    0   Validation passed
    1   Validation failed
"""

import sys
import re
import ast
import argparse
from pathlib import Path
from datetime import datetime

from lib import (
    CONFIG,
    HAS_YAML,
    Metric,
    ValidationLevel,
    SkillReport,
    TokenMetric,
    Issue,
    IssueType,
    calculate_skill_metrics,
    estimate_tokens,
    count_words,
    count_lines,
    format_table,
    format_xml,
    format_yaml,
    format_json,
)

# YAML import for gate_syntax (HAS_YAML comes from lib)
if HAS_YAML:
    import yaml  # pyright: ignore[reportMissingModuleSource]


# ===========================================================================
# Gate 1: Syntax Validation
# ===========================================================================


def gate_syntax(
    skill_md_content: str,
) -> tuple[list[str], list[str], dict | None]:
    """
    Validate YAML frontmatter and basic structure.

    :param skill_md_content: The full content of SKILL.md.
    :return: Tuple of (errors, warnings, frontmatter_dict or None).
    """
    errors = []
    warnings = []

    if not skill_md_content:
        errors.append("SKILL.md is empty or unreadable")
        return errors, warnings, None

    if not skill_md_content.startswith("---"):
        errors.append("Missing YAML frontmatter (must start with ---)")
        return errors, warnings, None

    match = re.match(r"^---\n(.*?)\n---", skill_md_content, re.DOTALL)
    if not match:
        errors.append("Invalid frontmatter format (missing closing ---)")
        return errors, warnings, None

    frontmatter_text = match.group(1)

    if HAS_YAML:
        try:
            frontmatter = yaml.safe_load(frontmatter_text)
            if not isinstance(frontmatter, dict):
                errors.append("Frontmatter must be a YAML dictionary")
                return errors, warnings, None
        except yaml.YAMLError as e:
            errors.append(f"Invalid YAML: {e}")
            return errors, warnings, None
    else:
        frontmatter = {}
        for line in frontmatter_text.split("\n"):
            if ":" in line:
                key, _, value = line.partition(":")
                frontmatter[key.strip()] = value.strip()

    allowed = {
        "name",
        "description",
        "license",
        "allowed-tools",
        "metadata",
        "version",
        "model",
        "disable-model-invocation",
        "user-invocable",
        "context",
        "agent",
        "argument-hint",
        "hooks",
        "compatibility",
    }
    unexpected = set(frontmatter.keys()) - allowed
    if unexpected:
        keys_str = ", ".join(sorted(unexpected))
        errors.append(f"Unexpected frontmatter keys: {keys_str}")

    if "name" not in frontmatter:
        errors.append("Missing required field: name")
    if "description" not in frontmatter:
        errors.append("Missing required field: description")

    name = frontmatter.get("name", "")
    if name:
        if not isinstance(name, str):
            errors.append(f"Name must be string, got {type(name).__name__}")
        elif not re.match(r"^[a-z0-9-]+$", name):
            errors.append(
                f"Name '{name}' must be hyphen-case "
                "(lowercase, digits, hyphens)"
            )
        elif name.startswith("-") or name.endswith("-") or "--" in name:
            errors.append(
                f"Name '{name}' cannot start/end with hyphen "
                "or have consecutive hyphens"
            )
        elif len(name) > 64:
            errors.append(f"Name too long ({len(name)} chars, max 64)")

    description = frontmatter.get("description", "")
    if description:
        if not isinstance(description, str):
            errors.append(
                f"Description must be string, got {type(description).__name__}"
            )
        elif "<" in description or ">" in description:
            errors.append("Description cannot contain angle brackets")
        elif len(description) > 1024:
            errors.append(
                f"Description too long ({len(description)} chars, max 1024)"
            )

    return errors, warnings, frontmatter


# ===========================================================================
# Gate 2: Semantic Validation
# ===========================================================================


def gate_semantic(
    skill_md_content: str,
    frontmatter: dict | None,
) -> tuple[list[str], list[str]]:
    """
    Validate description quality and content semantics.

    :param skill_md_content: The full content of SKILL.md.
    :param frontmatter: Parsed frontmatter dict, or None if parsing failed.
    :return: Tuple of (errors, warnings).
    """
    errors = []
    warnings = []

    description = frontmatter.get("description", "") if frontmatter else ""

    trigger_patterns = [
        r"\buse when\b",
        r"\btrigger",
        r"\bwhen .*(want|need|ask)",
        r"\bfor (creating|editing|working|handling)",
    ]
    has_trigger = any(
        re.search(p, description, re.IGNORECASE) for p in trigger_patterns
    )
    if not has_trigger and description:
        warnings.append(
            "Description should include trigger context (e.g., 'Use when...')"
        )

    if description and len(description) < 50:
        warnings.append(
            f"Description seems short ({len(description)} chars). "
            "Include what it does AND when to use it."
        )

    if "[TODO" in skill_md_content or "[TODO:" in skill_md_content:
        errors.append("SKILL.md contains unresolved [TODO] placeholders")

    # Second-person patterns that suggest action (prefer imperative)
    # Note: "this will" removed - legitimate for describing behavior
    # Note: "you can" removed - acceptable for optional features
    imperative_patterns = [
        (r"\byou should\b", "you should"),
        (r"\byou need to\b", "you need to"),
        (r"\byou must\b", "you must"),
    ]
    body_start = skill_md_content.find("---", 3)
    if body_start > 0:
        body = skill_md_content[body_start + 3 :]
        for pattern, display in imperative_patterns:
            if re.search(pattern, body, re.IGNORECASE):
                warnings.append(
                    f"Consider imperative voice: found '{display}' "
                    "(use 'Run...' not 'You should run...')"
                )
                break

    return errors, warnings


# ===========================================================================
# Gate 3: Budget Validation
# ===========================================================================


def gate_budget(
    skill_path: Path,
    skill_md_content: str,
) -> tuple[list[str], list[str]]:
    """
    Validate token budgets using dynamic allocation.

    Enforcement Model:
        - SKILL.md body: ENFORCED (can produce errors)
        - Single reference: ADVISORY (warnings only, never blocks)
        - Total skill: ENFORCED (can produce errors)

    Per-file limits are advisory to allow flexibility in skill architecture.
    Only the total skill budget is enforced as a hard limit.

    :param skill_path: Path to the skill directory.
    :param skill_md_content: The full content of SKILL.md.
    :return: Tuple of (errors, warnings).
    """
    errors = []
    warnings = []

    body_match = re.match(
        r"^---\n.*?\n---\n?(.*)", skill_md_content, re.DOTALL
    )
    body = body_match.group(1) if body_match else skill_md_content

    body_tokens = estimate_tokens(body)
    body_words = count_words(body)
    body_lines = count_lines(body)

    # SKILL.md body tokens (ENFORCED)
    tokens_threshold = CONFIG.get_threshold(Metric.BODY_TOKENS)
    result = tokens_threshold.evaluate(body_tokens)
    if result == ValidationLevel.FAIL:
        errors.append(
            f"SKILL.md body too large: ~{body_tokens} tokens "
            f"(max {CONFIG.skill_md_tokens_error:,})"
        )
    elif result == ValidationLevel.WARN:
        warnings.append(
            f"SKILL.md body approaching limit: ~{body_tokens} tokens "
            f"(target <{CONFIG.skill_md_tokens_warning:,})"
        )

    # SKILL.md body words (ENFORCED)
    words_threshold = CONFIG.get_threshold(Metric.BODY_WORDS)
    result = words_threshold.evaluate(body_words)
    if result == ValidationLevel.FAIL:
        errors.append(
            f"SKILL.md body too long: {body_words} words "
            f"(max {CONFIG.skill_md_words_error:,})"
        )
    elif result == ValidationLevel.WARN:
        warnings.append(
            f"SKILL.md body lengthy: {body_words} words "
            f"(target <{CONFIG.skill_md_words_warning:,})"
        )

    # SKILL.md body lines (ENFORCED)
    lines_threshold = CONFIG.get_threshold(Metric.BODY_LINES)
    result = lines_threshold.evaluate(body_lines)
    if result == ValidationLevel.FAIL:
        errors.append(
            f"SKILL.md too many lines: {body_lines} "
            f"(max {CONFIG.skill_md_lines_error})"
        )
    elif result == ValidationLevel.WARN:
        warnings.append(
            f"SKILL.md many lines: {body_lines} "
            f"(target <{CONFIG.skill_md_lines_warning})"
        )

    # Reference files (ADVISORY - warnings only, never errors)
    refs_dir = skill_path / "references"
    total_ref_tokens = 0

    if refs_dir.exists():
        ref_threshold = CONFIG.get_threshold(Metric.REFERENCE)
        for ref_file in refs_dir.glob("*.md"):
            ref_content = ref_file.read_text()
            ref_tokens = estimate_tokens(ref_content)
            total_ref_tokens += ref_tokens

            # Advisory warnings based on severity
            result = ref_threshold.evaluate(ref_tokens)
            if result == ValidationLevel.WARN:
                if ref_tokens > CONFIG.reference_strong_warning:
                    warnings.append(
                        f"Reference {ref_file.name}: ~{ref_tokens} tokens "
                        "(advisory, consider splitting)"
                    )
                else:
                    warnings.append(
                        f"Reference {ref_file.name}: ~{ref_tokens} tokens "
                        "(advisory)"
                    )

        # Total references (ADVISORY)
        refs_total_threshold = CONFIG.get_threshold(Metric.REFERENCES_TOTAL)
        result = refs_total_threshold.evaluate(total_ref_tokens)
        if result == ValidationLevel.WARN:
            warnings.append(
                f"Total references: ~{total_ref_tokens} tokens "
                "(consider if all are needed simultaneously)"
            )

    # Total skill (ENFORCED)
    total_tokens = body_tokens + total_ref_tokens
    total_threshold = CONFIG.get_threshold(Metric.TOTAL)
    result = total_threshold.evaluate(total_tokens)

    if result == ValidationLevel.FAIL:
        errors.append(
            f"Total skill exceeds budget: ~{total_tokens} tokens "
            f"(max {CONFIG.total_budget:,}). "
            f"Reduce SKILL.md ({body_tokens}) "
            f"or references ({total_ref_tokens})."
        )
    elif result == ValidationLevel.WARN:
        pct = int(total_tokens / CONFIG.total_budget * 100)
        warnings.append(
            f"Total skill approaching limit: ~{total_tokens} tokens "
            f"({pct}% of {CONFIG.total_budget:,})"
        )

    return errors, warnings


# ===========================================================================
# Gate 4: Integrity Validation
# ===========================================================================


def gate_integrity(
    skill_path: Path,
    skill_md_content: str,
) -> tuple[list[str], list[str]]:
    """
    Validate references exist and no recursion patterns.

    :param skill_path: Path to the skill directory.
    :param skill_md_content: The full content of SKILL.md.
    :return: Tuple of (errors, warnings).
    """
    errors = []
    warnings = []

    # Extract body only (skip frontmatter) for recursion check
    # Frontmatter may legitimately contain skill name in description triggers
    body_start = skill_md_content.find("---", 3)
    body_for_recursion = (
        skill_md_content[body_start + 3 :]
        if body_start > 0
        else skill_md_content
    )

    recursion_patterns = [
        r"Skill.*skill-creator",
        r"invoke.*skill-creator",
        r"/skill-creator\b",
    ]
    for pattern in recursion_patterns:
        if re.search(pattern, body_for_recursion, re.IGNORECASE):
            errors.append(
                f"Potential recursion: skill references itself ({pattern})"
            )

    # Remove code blocks to avoid false positives
    content_no_code = re.sub(
        r"```.*?```", "", skill_md_content, flags=re.DOTALL
    )
    content_no_code = re.sub(r"`[^`]+`", "", content_no_code)

    ref_patterns = [
        ("references", r"references/([^\s\)\*`]+\.md)"),
        ("scripts", r"scripts/([^\s\)\*`]+\.py)"),
        ("scripts", r"scripts/([^\s\)\*`]+\.sh)"),
        ("assets", r"assets/([^\s\)\*`]+\.[a-z]+)"),
    ]

    for folder, pattern in ref_patterns:
        matches = re.findall(pattern, content_no_code)
        for match in matches:
            # Skip markdown bold syntax and placeholders
            if match.startswith("*") or "<" in match or "{" in match:
                continue
            check_path = skill_path / folder / match
            if not check_path.exists():
                rel_path = f"{folder}/{match}"
                errors.append(f"Referenced file not found: {rel_path}")

    scripts_dir = skill_path / "scripts"
    if scripts_dir.exists():
        for script in scripts_dir.glob("*.py"):
            try:
                ast.parse(script.read_text())
            except SyntaxError as e:
                errors.append(
                    f"Python syntax error in {script.name}: "
                    f"{e.msg} (line {e.lineno})"
                )

    if "NEVER" in skill_md_content and "ALWAYS" in skill_md_content:
        warnings.append(
            "Mixed NEVER/ALWAYS directives - ensure they don't conflict"
        )

    return errors, warnings


# ===========================================================================
# Main Validator
# ===========================================================================


def validate_skill(skill_path: Path) -> SkillReport:
    """
    Run 4-gate validation on a skill.

    BREAKING CHANGE: Previously returned tuple[bool, str, dict].
    Now returns SkillReport. Update callers:
    - Use report.status == ValidationLevel.PASS instead of valid bool
    - Use report.errors instead of details["errors"]
    - Use report.warnings instead of details["warnings"]

    :param skill_path: Path to the skill directory.
    :return: Complete validation report with gates, metrics, and issues.
    """
    skill_path = Path(skill_path).resolve()
    timestamp = datetime.now()

    # Handle path errors
    if not skill_path.exists():
        msg = f"Skill directory not found: {skill_path}"
        return _error_report(skill_path, timestamp, msg)

    if not skill_path.is_dir():
        msg = f"Path is not a directory: {skill_path}"
        return _error_report(skill_path, timestamp, msg)

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return _error_report(skill_path, timestamp, "SKILL.md not found")

    skill_md_content = skill_md.read_text()

    # Run gates and collect results
    all_errors = []
    all_warnings = []
    gates = {}

    # Gate 1: Syntax
    errors, warnings, frontmatter = gate_syntax(skill_md_content)
    gates["syntax"] = ValidationLevel.PASS if not errors else ValidationLevel.FAIL
    all_errors.extend([
        Issue(IssueType.ERROR, "syntax", e) for e in errors
    ])
    all_warnings.extend([
        Issue(IssueType.WARNING, "syntax", w) for w in warnings
    ])

    # Gate 2: Semantic (only if syntax passed)
    if frontmatter is not None:
        errors, warnings = gate_semantic(skill_md_content, frontmatter)
        gates["semantic"] = (
            ValidationLevel.PASS if not errors else ValidationLevel.FAIL
        )
        all_errors.extend([
            Issue(IssueType.ERROR, "semantic", e) for e in errors
        ])
        all_warnings.extend([
            Issue(IssueType.WARNING, "semantic", w) for w in warnings
        ])
    else:
        gates["semantic"] = ValidationLevel.SKIP

    # Gate 3: Budget
    errors, warnings = gate_budget(skill_path, skill_md_content)
    gates["budget"] = ValidationLevel.PASS if not errors else ValidationLevel.FAIL
    all_errors.extend([
        Issue(IssueType.ERROR, "budget", e) for e in errors
    ])
    all_warnings.extend([
        Issue(IssueType.WARNING, "budget", w) for w in warnings
    ])

    # Gate 4: Integrity
    errors, warnings = gate_integrity(skill_path, skill_md_content)
    gates["integrity"] = (
        ValidationLevel.PASS if not errors else ValidationLevel.FAIL
    )
    all_errors.extend([
        Issue(IssueType.ERROR, "integrity", e) for e in errors
    ])
    all_warnings.extend([
        Issue(IssueType.WARNING, "integrity", w) for w in warnings
    ])

    # Calculate metrics
    body_match = re.match(
        r"^---\n.*?\n---\n?(.*)",
        skill_md_content,
        re.DOTALL,
    )
    body = body_match.group(1) if body_match else skill_md_content
    metrics = calculate_skill_metrics(skill_path, body)

    # Determine overall status
    status = ValidationLevel.PASS if not all_errors else ValidationLevel.FAIL

    return SkillReport(
        skill=skill_path.name,
        path=skill_path,
        timestamp=timestamp,
        status=status,
        gates=gates,
        skill_md_tokens=metrics.skill_md_tokens,
        skill_md_words=metrics.skill_md_words,
        skill_md_lines=metrics.skill_md_lines,
        references=metrics.references,
        references_enforcement="advisory",
        total_tokens=metrics.total_tokens,
        total_words=metrics.total_words,
        total_lines=metrics.total_lines,
        errors=all_errors,
        warnings=all_warnings,
    )


def _error_report(
    skill_path: Path,
    timestamp: datetime,
    message: str,
) -> SkillReport:
    """
    Create a SkillReport for early-exit errors.

    :param skill_path: Path to the skill directory.
    :param timestamp: Timestamp for the report.
    :param message: Error message to include.
    :return: SkillReport with FAIL status and the error.
    """
    return SkillReport(
        skill=skill_path.name,
        path=skill_path,
        timestamp=timestamp,
        status=ValidationLevel.FAIL,
        gates={},
        skill_md_tokens=TokenMetric(0),
        skill_md_words=TokenMetric(0),
        skill_md_lines=TokenMetric(0),
        errors=[Issue(IssueType.ERROR, "syntax", message)],
    )


# ===========================================================================
# CLI
# ===========================================================================

FORMATTERS = {
    "table": format_table,
    "xml": format_xml,
    "yaml": format_yaml,
    "json": format_json,
}


def main():
    """CLI entry point for skill validation."""
    parser = argparse.ArgumentParser(
        description="Validate skill and generate unified report"
    )
    parser.add_argument("skill_path", help="Path to skill directory")
    parser.add_argument(
        "--output",
        choices=FORMATTERS.keys(),
        default="table",
        help="Output format (default: table)",
    )

    args = parser.parse_args()

    report = validate_skill(Path(args.skill_path))
    formatter = FORMATTERS[args.output]
    print(formatter(report))

    sys.exit(0 if report.status == ValidationLevel.PASS else 1)


if __name__ == "__main__":
    main()
