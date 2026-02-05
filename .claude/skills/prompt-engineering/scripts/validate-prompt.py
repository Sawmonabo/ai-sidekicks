#!/usr/bin/env python3
"""
Prompt Validation Script v4.0

Validates Claude prompts for best practices, optimized for Claude.

Usage:
    python validate-prompt.py <prompt_file>
    python validate-prompt.py --stdin
    python validate-prompt.py <prompt_file> --json

Exit codes:
    0 - All checks passed
    1 - Warnings found
    2 - Errors found
"""

import argparse
import re
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import ClassVar


class Severity(Enum):
    ERROR = "ERROR"
    WARNING = "WARNING"
    INFO = "INFO"


@dataclass
class Issue:
    severity: Severity
    message: str
    line: int | None = None
    suggestion: str | None = None


MIN_EXAMPLE_COUNT = 2
MAX_PROMPT_WORDS = 2000
MIN_PROMPT_WORDS = 50


class PromptValidator:
    """Validates prompts against Claude best practices."""

    STRUCTURAL_TAGS: ClassVar[set[str]] = {
        "role",
        "instructions",
        "context",
        "input",
        "output",
        "examples",
        "constraints",
        "task",
        "format",
        "output_format",
    }

    PRINCIPAL_STRONG: ClassVar[list[str]] = [
        r"\bprincipal\b",
        r"\bstaff\b",
        r"\bdistinguished\b",
        r"\bchief\b",
    ]

    PRINCIPAL_ACCEPTABLE: ClassVar[list[str]] = [
        r"\bsenior\b",
        r"\blead\b",
        r"\bexpert\b",
        r"\bauthority\b",
        r"\bspecialist\b",
        r"\bwith\s+(?:\d+\+?\s+)?years?\b",
        r"\b(?:deep|extensive)\s+expertise\b",
        r"\brecognized\s+(?:expert|authority)\b",
    ]

    VAGUE_PATTERNS: ClassVar[list[tuple[str, str]]] = [
        (r"\bbe\s+(?:good|better|nice|helpful)\b", "Too vague"),
        (r"\bdo\s+(?:your|the)\s+best\b", "Define success criteria"),
        (r"\bas\s+needed\b", "Specify when/how"),
        (r"\bif\s+appropriate\b", "Define what's appropriate"),
        (r"\btry to\b", "'try to' is vague - be direct"),
        (r"\bmaybe\b", "'maybe' creates ambiguity"),
    ]

    NEGATIVE_PATTERNS: ClassVar[list[tuple[str, str]]] = [
        (r"don't\s+(?:be|use|do|include)", "Use positive framing"),
        (r"never\s+(?:use|do|include|be)", "Use positive framing"),
        (r"avoid\s+(?:using|being|doing)", "Specify what TO do"),
    ]

    THINKING_PATTERNS: ClassVar[list[tuple[str, str]]] = [
        (r"\bthink\s+(?:through|about|step)", "Use 'consider' instead"),
        (r"\bthink\s+carefully\b", "Use 'consider carefully'"),
        (r"\bthinking\s+process\b", "Use 'reasoning process'"),
    ]

    ACTION_VERBS: ClassVar[set[str]] = {
        "analyze",
        "create",
        "review",
        "implement",
        "identify",
        "compare",
        "evaluate",
        "design",
        "build",
        "write",
        "check",
        "verify",
        "validate",
        "audit",
        "assess",
        "generate",
        "produce",
        "develop",
        "explain",
        "describe",
        "list",
        "summarize",
        "extract",
        "categorize",
        "classify",
    }

    def __init__(self, content: str):
        self.content = content
        self.lines = content.split("\n")
        self.issues: list[Issue] = []
        self.content_no_codeblocks = self._remove_code_blocks(content)

    def _remove_code_blocks(self, content: str) -> str:
        """Remove markdown code blocks to avoid false positives."""
        content = re.sub(r"```[\s\S]*?```", "", content)
        return re.sub(r"`[^`]+`", "", content)

    def validate(self) -> list[Issue]:
        """Run all validation checks."""
        self.check_xml_closure()
        self.check_structural_elements()
        self.check_principal_level()
        self.check_vague_instructions()
        self.check_negative_phrasing()
        self.check_thinking_sensitivity()
        self.check_action_verbs()
        self.check_examples()
        self.check_output_format()
        self.check_placeholders()
        self.check_length()
        return self.issues

    def check_xml_closure(self):
        """Check XML tags are properly closed."""
        lines_outside = self._get_lines_outside_codeblocks()
        tag_stack: list[tuple[str, int]] = []
        tag_pattern = re.compile(r"<(/?)(\w+)(?:\s[^>]*)?>")

        for line_num, line in lines_outside:
            for match in tag_pattern.finditer(line):
                is_closing = match.group(1) == "/"
                tag_name = match.group(2).lower()

                if is_closing:
                    if not tag_stack:
                        self.issues.append(
                            Issue(
                                Severity.ERROR,
                                f"Closing </{tag_name}> without opening",
                                line=line_num,
                            )
                        )
                    elif tag_stack[-1][0] != tag_name:
                        expected = tag_stack[-1][0]
                        self.issues.append(
                            Issue(
                                Severity.ERROR,
                                f"Mismatched: expected </{expected}>",
                                line=line_num,
                            )
                        )
                        tag_stack.pop()
                    else:
                        tag_stack.pop()
                elif not match.group(0).endswith("/>"):
                    tag_stack.append((tag_name, line_num))

        for tag_name, line_num in tag_stack:
            self.issues.append(
                Issue(
                    Severity.ERROR,
                    f"Unclosed tag <{tag_name}>",
                    line=line_num,
                    suggestion=f"Add </{tag_name}> to close",
                )
            )

    def _get_lines_outside_codeblocks(self) -> list[tuple[int, str]]:
        """Get lines with numbers, excluding code blocks."""
        result: list[tuple[int, str]] = []
        in_codeblock = False
        for i, line in enumerate(self.lines, 1):
            if line.strip().startswith("```"):
                in_codeblock = not in_codeblock
                continue
            if not in_codeblock:
                clean = re.sub(r"`[^`]+`", "", line)
                result.append((i, clean))
        return result

    def check_structural_elements(self):
        """Check for recommended structural elements."""
        content_lower = self.content.lower()

        has_role = bool(
            re.search(r"<role>|you\s+are\s+a[n]?\s+\w+", content_lower)
        )
        if not has_role:
            self.issues.append(
                Issue(
                    Severity.INFO,
                    "No role/persona definition found",
                    suggestion="Add <role>You are a...</role>",
                )
            )

        pattern = r"##?\s*(?:instructions|task|your task)"
        has_instructions = "<instructions>" in content_lower or bool(
            re.search(pattern, content_lower)
        )
        if not has_instructions:
            self.issues.append(
                Issue(
                    Severity.WARNING,
                    "No clear instructions section found",
                    suggestion="Add <instructions> or ## Instructions",
                )
            )

    def check_principal_level(self):
        """Check for principal-level persona."""
        has_strong = any(
            re.search(p, self.content, re.IGNORECASE)
            for p in self.PRINCIPAL_STRONG
        )
        has_acceptable = any(
            re.search(p, self.content, re.IGNORECASE)
            for p in self.PRINCIPAL_ACCEPTABLE
        )

        if has_strong:
            return

        if has_acceptable:
            self.issues.append(
                Issue(
                    Severity.INFO,
                    "Acceptable expertise but not principal-level",
                    suggestion="Consider: 'principal', 'staff', 'distinguished'",
                )
            )
        else:
            self.issues.append(
                Issue(
                    Severity.WARNING,
                    "No principal-level persona established",
                    suggestion="Add: 'principal [role] with deep expertise'",
                )
            )

    def check_vague_instructions(self):
        """Flag vague or ambiguous instructions."""
        for pattern, message in self.VAGUE_PATTERNS:
            for i, line in enumerate(self.lines, 1):
                if re.search(pattern, line, re.IGNORECASE):
                    self.issues.append(
                        Issue(
                            Severity.WARNING,
                            f"Vague: {message}",
                            line=i,
                        )
                    )

    def check_negative_phrasing(self):
        """Flag negative phrasing that could be positive."""
        for pattern, message in self.NEGATIVE_PATTERNS:
            for i, line in enumerate(self.lines, 1):
                if re.search(pattern, line, re.IGNORECASE):
                    self.issues.append(
                        Issue(
                            Severity.INFO,
                            f"Negative phrasing: {message}",
                            line=i,
                            suggestion="Rephrase as what TO do",
                        )
                    )

    def check_thinking_sensitivity(self):
        """Check for 'think' usage (Claude sensitivity)."""
        skip_keywords = ["extended_thinking", "thinking_budget"]
        if any(kw in self.content.lower() for kw in skip_keywords):
            return

        for pattern, message in self.THINKING_PATTERNS:
            for i, line in enumerate(self.lines, 1):
                line_lower = line.lower()
                if "instead of" in line_lower or "avoid" in line_lower:
                    continue
                if re.search(pattern, line, re.IGNORECASE):
                    self.issues.append(
                        Issue(
                            Severity.WARNING,
                            f"Thinking sensitivity: {message}",
                            line=i,
                            suggestion="Replace 'think' with 'consider'",
                        )
                    )

    def check_action_verbs(self):
        """Check that instructions contain explicit action verbs."""
        instructions_match = re.search(
            r"<instructions>([\s\S]*?)</instructions>",
            self.content,
            re.IGNORECASE,
        )

        if not instructions_match:
            pattern = r"##?\s*(?:instructions|your task)\s*([\s\S]*?)(?=##|\Z)"
            instructions_match = re.search(
                pattern, self.content, re.IGNORECASE
            )

        if not instructions_match:
            return

        instructions_text = instructions_match.group(1).lower()
        found_verbs = set()

        for verb in self.ACTION_VERBS:
            if re.search(rf"\b{verb}\b", instructions_text):
                found_verbs.add(verb)

        if len(found_verbs) == 0:
            self.issues.append(
                Issue(
                    Severity.INFO,
                    "No explicit action verbs found in instructions",
                    suggestion="Add verbs: analyze, create, review, implement",
                )
            )

    def check_examples(self):
        """Check for examples."""
        pattern = r"<examples?>|##?\s*examples?|for\s+example"
        has_examples = bool(re.search(pattern, self.content, re.IGNORECASE))

        if not has_examples:
            self.issues.append(
                Issue(
                    Severity.INFO,
                    "No examples found",
                    suggestion="Add <examples> with input/output pairs",
                )
            )
        else:
            count = len(
                re.findall(r"<example\s*(?:id=)?", self.content, re.IGNORECASE)
            )
            if 0 < count < MIN_EXAMPLE_COUNT:
                self.issues.append(
                    Issue(
                        Severity.INFO,
                        f"Only {count} example found",
                        suggestion="Consider 2-3 diverse examples",
                    )
                )

    def check_output_format(self):
        """Check for output format specification."""
        pattern = (
            r"<output_format>|<format>|##?\s*(?:output|response)\s*format"
        )
        has_format = bool(re.search(pattern, self.content, re.IGNORECASE))

        if not has_format:
            self.issues.append(
                Issue(
                    Severity.INFO,
                    "No output format specified",
                    suggestion="Add <output_format> for structure",
                )
            )

    def check_placeholders(self):
        """Check placeholder format consistency."""
        content = self.content_no_codeblocks
        double = len(re.findall(r"\{\{[^}]+\}\}", content))
        single = len(re.findall(r"(?<!\{)\{[^{}]+\}(?!\})", content))
        angle = len(re.findall(r"<<[^>]+>>", content))

        formats_used = sum(1 for x in [double, single, angle] if x > 0)
        if formats_used > 1:
            self.issues.append(
                Issue(
                    Severity.WARNING,
                    "Inconsistent placeholder formats",
                    suggestion="Use {{PLACEHOLDER}} consistently",
                )
            )

    def check_length(self):
        """Check prompt length."""
        words = len(self.content.split())

        if words > MAX_PROMPT_WORDS:
            self.issues.append(
                Issue(
                    Severity.WARNING,
                    f"Prompt is long ({words} words)",
                    suggestion="Use progressive disclosure",
                )
            )
        elif words < MIN_PROMPT_WORDS:
            self.issues.append(
                Issue(
                    Severity.INFO,
                    f"Prompt is short ({words} words)",
                    suggestion="Ensure sufficient context",
                )
            )


def _format_section(issues: list[Issue], heading: str) -> list[str]:
    if not issues:
        return []

    lines = [f"\n{heading} ({len(issues)}):\n"]
    for issue in issues:
        loc = f" (line {issue.line})" if issue.line else ""
        lines.append(f"  - {issue.message}{loc}")
        if issue.suggestion:
            lines.append(f"    -> {issue.suggestion}")
    return lines


def format_report(issues: list[Issue], filename: str) -> str:
    """Format validation results."""
    if not issues:
        return f"[PASS] {filename}: All checks passed!\n"

    errors = [i for i in issues if i.severity == Severity.ERROR]
    warnings = [i for i in issues if i.severity == Severity.WARNING]
    infos = [i for i in issues if i.severity == Severity.INFO]

    lines = [f"\n=== Validation Report: {filename} ===\n"]

    lines.extend(_format_section(errors, "[ERROR]"))
    lines.extend(_format_section(warnings, "[WARNING]"))
    lines.extend(_format_section(infos, "[INFO]"))

    lines.append(f"\n{'=' * 45}")
    lines.append(
        f"Summary: {len(errors)} errors, "
        f"{len(warnings)} warnings, {len(infos)} suggestions\n"
    )

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Validate Claude prompts (v4.0)"
    )
    parser.add_argument("file", nargs="?", help="Prompt file to validate")
    parser.add_argument("--stdin", action="store_true", help="Read from stdin")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.stdin:
        content = sys.stdin.read()
        filename = "<stdin>"
    elif args.file:
        path = Path(args.file)
        if not path.exists():
            sys.stderr.write(f"Error: File not found: {args.file}\n")
            sys.exit(2)
        content = path.read_text()
        filename = path.name
    else:
        parser.print_help()
        sys.exit(1)

    validator = PromptValidator(content)
    issues = validator.validate()

    if args.json:
        import json

        output = {
            "file": filename,
            "version": "4.0",
            "issues": [
                {
                    "severity": i.severity.value,
                    "message": i.message,
                    "line": i.line,
                    "suggestion": i.suggestion,
                }
                for i in issues
            ],
            "summary": {
                "errors": len(
                    [i for i in issues if i.severity == Severity.ERROR]
                ),
                "warnings": len(
                    [i for i in issues if i.severity == Severity.WARNING]
                ),
                "info": len(
                    [i for i in issues if i.severity == Severity.INFO]
                ),
            },
        }
        sys.stdout.write(f"{json.dumps(output, indent=2)}\n")
    else:
        sys.stdout.write(f"{format_report(issues, filename)}\n")

    if any(i.severity == Severity.ERROR for i in issues):
        sys.exit(2)
    elif any(i.severity == Severity.WARNING for i in issues):
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
