"""Token estimation and metrics calculation utilities."""

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import SkillMetrics


def estimate_tokens(text: str) -> int:
    """
    Estimate token count using chars/4 approximation.

    This is a rough estimate. Actual tokenization varies by model,
    but chars/4 is a reasonable approximation for English text.

    :param text: The text to estimate tokens for.
    :return: Estimated token count.
    """
    return len(text) // 4


def count_words(text: str) -> int:
    """
    Count words in text.

    :param text: The text to count words in.
    :return: Word count.
    """
    return len(text.split())


def count_lines(text: str) -> int:
    """
    Count lines in text.

    :param text: The text to count lines in.
    :return: Line count.
    """
    return len(text.split("\n"))


def calculate_skill_metrics(skill_path: Path, body_content: str) -> "SkillMetrics":
    """
    Calculate token, word, and line metrics for skill files.

    :param skill_path: Path to the skill directory.
    :param body_content: SKILL.md body content (without frontmatter).
    :return: SkillMetrics with all calculated values.
    """
    # Import here to avoid circular imports
    from .config import CONFIG
    from .models import FileMetrics, Metric, SkillMetrics, TokenMetric

    body_tokens = estimate_tokens(body_content)
    body_words = count_words(body_content)
    body_lines = count_lines(body_content)

    # SKILL.md metrics with status
    tokens_threshold = CONFIG.get_threshold(Metric.BODY_TOKENS)
    words_threshold = CONFIG.get_threshold(Metric.BODY_WORDS)
    lines_threshold = CONFIG.get_threshold(Metric.BODY_LINES)

    skill_md_tokens = TokenMetric(
        body_tokens,
        CONFIG.skill_md_tokens_error,
        tokens_threshold.evaluate(body_tokens),
    )
    skill_md_words = TokenMetric(
        body_words,
        CONFIG.skill_md_words_error,
        words_threshold.evaluate(body_words),
    )
    skill_md_lines = TokenMetric(
        body_lines,
        CONFIG.skill_md_lines_error,
        lines_threshold.evaluate(body_lines),
    )

    # Reference metrics
    references = []
    total_ref_tokens = 0
    refs_dir = skill_path / "references"

    if refs_dir.exists():
        ref_threshold = CONFIG.get_threshold(Metric.REFERENCE)
        for ref_file in sorted(refs_dir.glob("*.md")):
            ref_content = ref_file.read_text()
            ref_tokens = estimate_tokens(ref_content)
            ref_words = count_words(ref_content)
            ref_lines = count_lines(ref_content)
            total_ref_tokens += ref_tokens

            references.append(
                FileMetrics(
                    ref_file.name,
                    ref_tokens,
                    ref_words,
                    ref_lines,
                    ref_threshold.evaluate(ref_tokens),
                )
            )

    # Total metrics
    total_tokens_val = body_tokens + total_ref_tokens
    total_threshold = CONFIG.get_threshold(Metric.TOTAL)
    total_tokens = TokenMetric(
        total_tokens_val,
        CONFIG.total_budget,
        total_threshold.evaluate(total_tokens_val),
    )
    total_words = body_words + sum(r.words for r in references)
    total_lines = body_lines + sum(r.lines for r in references)

    return SkillMetrics(
        skill_md_tokens=skill_md_tokens,
        skill_md_words=skill_md_words,
        skill_md_lines=skill_md_lines,
        references=references,
        total_tokens=total_tokens,
        total_words=total_words,
        total_lines=total_lines,
    )
