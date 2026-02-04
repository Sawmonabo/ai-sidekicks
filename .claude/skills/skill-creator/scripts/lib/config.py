"""
Skill Budget Configuration - Single Source of Truth

This module defines all token budget thresholds for skill validation.
Documentation and validation scripts reference this module - never
hardcode threshold values elsewhere.

Environment Variable Overrides:
    SKILL_TOTAL_BUDGET: Total token budget (default: 8000)
    SKILL_WARNING_RATIO: Warning threshold as decimal (default: 0.75)
"""

import os
from dataclasses import dataclass, field
from typing import Optional, TypeVar

from .models import EnforcementMode, Metric, ValidationLevel

try:
    import yaml  # noqa: F401 # pyright: ignore[reportMissingModuleSource]

    HAS_YAML = True
except ImportError:
    HAS_YAML = False


T = TypeVar("T", int, float)


def _env_value(name: str, default: T, convert: type[T]) -> T:
    """
    Get environment variable with type conversion.

    :param name: Environment variable name.
    :param default: Default value if not set or conversion fails.
    :param convert: Type to convert to (int or float).
    :return: Converted value or default.
    """
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return convert(value)
    except ValueError:
        return default


@dataclass(frozen=True)
class ThresholdConfig:
    """Configuration for a single threshold."""

    warning: int
    error: Optional[int]  # None = advisory (no error possible)
    mode: EnforcementMode

    def evaluate(self, value: int) -> ValidationLevel:
        """Evaluate a value against this threshold."""
        if self.error is not None and value > self.error:
            return ValidationLevel.FAIL
        if value > self.warning:
            return ValidationLevel.WARN
        return ValidationLevel.PASS


@dataclass
class BudgetConfig:
    """
    Token budget configuration for skill validation.

    All thresholds are defined here. Documentation and validation
    scripts reference this module - never hardcode values elsewhere.

    Enforcement Model:
        - SKILL.md body: ENFORCED (can error)
        - Single reference: ADVISORY (warnings only)
        - Total skill: ENFORCED (can error)
    """

    # Total skill budget (ENFORCED)
    total_budget: int = field(
        default_factory=lambda: _env_value("SKILL_TOTAL_BUDGET", 8000, int)
    )
    warning_ratio: float = field(
        default_factory=lambda: _env_value("SKILL_WARNING_RATIO", 0.75, float)
    )

    # SKILL.md body thresholds (ENFORCED)
    skill_md_tokens_warning: int = 3000
    skill_md_tokens_error: int = 4600
    skill_md_words_warning: int = 3500
    skill_md_words_error: int = 5000
    skill_md_lines_warning: int = 500
    skill_md_lines_error: int = 600

    # Per-file reference thresholds (ADVISORY - warnings only)
    reference_warning: int = 800  # Gentle nudge
    reference_strong_warning: int = 1500  # Stronger nudge

    # Combined references threshold (ADVISORY)
    total_references_warning: int = 3000

    @property
    def total_warning(self) -> int:
        """Warning threshold based on total budget and ratio."""
        return int(self.total_budget * self.warning_ratio)

    def get_threshold(self, metric: Metric) -> ThresholdConfig:
        """
        Get threshold configuration for a metric.

        :param metric: The Metric enum value to get threshold for.
        :return: ThresholdConfig for the specified metric.
        :raises ValueError: If metric is not recognized.
        """
        thresholds = {
            Metric.BODY_TOKENS: ThresholdConfig(
                warning=self.skill_md_tokens_warning,
                error=self.skill_md_tokens_error,
                mode=EnforcementMode.ENFORCED,
            ),
            Metric.BODY_WORDS: ThresholdConfig(
                warning=self.skill_md_words_warning,
                error=self.skill_md_words_error,
                mode=EnforcementMode.ENFORCED,
            ),
            Metric.BODY_LINES: ThresholdConfig(
                warning=self.skill_md_lines_warning,
                error=self.skill_md_lines_error,
                mode=EnforcementMode.ENFORCED,
            ),
            Metric.REFERENCE: ThresholdConfig(
                warning=self.reference_warning,
                error=None,
                mode=EnforcementMode.ADVISORY,
            ),
            Metric.REFERENCES_TOTAL: ThresholdConfig(
                warning=self.total_references_warning,
                error=None,
                mode=EnforcementMode.ADVISORY,
            ),
            Metric.TOTAL: ThresholdConfig(
                warning=self.total_warning,
                error=self.total_budget,
                mode=EnforcementMode.ENFORCED,
            ),
        }
        if metric not in thresholds:
            raise ValueError(f"Unknown metric: {metric}")
        return thresholds[metric]


# Global instance - the single source of truth
CONFIG = BudgetConfig()


if __name__ == "__main__":
    # Display current configuration when run directly
    print("Skill Budget Configuration")
    print("=" * 40)
    print(f"Total budget:        {CONFIG.total_budget}")
    print(f"Warning ratio:       {CONFIG.warning_ratio}")
    print(f"Warning threshold:   {CONFIG.total_warning}")
    print()
    print("SKILL.md body (ENFORCED):")
    print(
        f"  Tokens:  warn={CONFIG.skill_md_tokens_warning}, "
        f"error={CONFIG.skill_md_tokens_error}"
    )
    print(
        f"  Words:   warn={CONFIG.skill_md_words_warning}, "
        f"error={CONFIG.skill_md_words_error}"
    )
    print(
        f"  Lines:   warn={CONFIG.skill_md_lines_warning}, "
        f"error={CONFIG.skill_md_lines_error}"
    )
    print()
    print("Reference files (ADVISORY):")
    print(
        f"  Single:  warn={CONFIG.reference_warning}, "
        f"strong={CONFIG.reference_strong_warning}"
    )
    print(f"  Total:   warn={CONFIG.total_references_warning}")
    print()
    print("Environment overrides:")
    print("  SKILL_TOTAL_BUDGET=<int>")
    print("  SKILL_WARNING_RATIO=<float>")
