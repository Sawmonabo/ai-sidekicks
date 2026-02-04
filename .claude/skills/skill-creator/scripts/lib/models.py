"""Data models for skill validation reports."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path


class ValidationLevel(Enum):
    """Validation outcome levels."""

    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"
    SKIP = "SKIP"  # Gate skipped due to prerequisite failure


class EnforcementMode(Enum):
    """How limits are enforced."""

    ADVISORY = "advisory"  # Warnings only, never blocks
    ENFORCED = "enforced"  # Can produce errors that block


class IssueType(Enum):
    """Issue severity types."""

    ERROR = "error"
    WARNING = "warning"


class Metric(Enum):
    """Metric types for threshold lookups."""

    BODY_TOKENS = "body_tokens"
    BODY_WORDS = "body_words"
    BODY_LINES = "body_lines"
    REFERENCE = "reference"
    REFERENCES_TOTAL = "references_total"
    TOTAL = "total"


@dataclass
class TokenMetric:
    """
    Token/word/line count with threshold status.

    :param value: The measured value.
    :param max: The maximum/threshold value, or None if no limit.
    :param status: Status from threshold evaluation.
    """

    value: int
    max: int | None = None
    status: ValidationLevel = ValidationLevel.PASS


@dataclass
class FileMetrics:
    """
    Metrics for a single file.

    :param name: The filename.
    :param tokens: Estimated token count.
    :param words: Word count.
    :param lines: Line count.
    :param status: Status from threshold evaluation.
    """

    name: str
    tokens: int
    words: int
    lines: int
    status: ValidationLevel = ValidationLevel.PASS


@dataclass
class Issue:
    """
    Validation error or warning.

    :param type: Issue type (error or warning).
    :param gate: Gate that produced this issue
                 ("syntax", "semantic", "budget", "integrity").
    :param message: Human-readable issue description.
    """

    type: IssueType
    gate: str
    message: str


@dataclass
class SkillMetrics:
    """Calculated metrics for a skill."""

    skill_md_tokens: "TokenMetric"
    skill_md_words: "TokenMetric"
    skill_md_lines: "TokenMetric"
    references: list["FileMetrics"]
    total_tokens: "TokenMetric"
    total_words: int
    total_lines: int


@dataclass
class SkillReport:
    """
    Complete skill validation report.

    :param skill: The skill name (directory name).
    :param path: Full path to the skill directory.
    :param timestamp: When the validation was run.
    :param status: Overall status (PASS or FAIL).
    :param gates: Dict mapping gate names to validation levels.
    :param skill_md_tokens: Token metrics for SKILL.md body.
    :param skill_md_words: Word metrics for SKILL.md body.
    :param skill_md_lines: Line metrics for SKILL.md body.
    :param references: List of metrics for reference files.
    :param references_enforcement: Enforcement mode ("advisory").
    :param total_tokens: Combined token metrics.
    :param total_words: Combined word count.
    :param total_lines: Combined line count.
    :param errors: List of error issues.
    :param warnings: List of warning issues.
    """

    skill: str
    path: Path
    timestamp: datetime
    status: ValidationLevel

    gates: dict[str, ValidationLevel]

    skill_md_tokens: TokenMetric
    skill_md_words: TokenMetric
    skill_md_lines: TokenMetric

    references: list[FileMetrics] = field(default_factory=list)
    references_enforcement: str = "advisory"

    total_tokens: TokenMetric = field(default_factory=lambda: TokenMetric(0))
    total_words: int = 0
    total_lines: int = 0

    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
