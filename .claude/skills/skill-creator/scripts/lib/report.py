"""Output formatters for skill reports."""

import json
import sys
import xml.etree.ElementTree as ET

from .config import CONFIG, HAS_YAML
from .models import SkillReport, TokenMetric, ValidationLevel

# YAML import for format_yaml (HAS_YAML comes from config)
if HAS_YAML:
    import yaml  # pyright: ignore[reportMissingModuleSource]

# Default table width for formatted output
DEFAULT_WIDTH = 80


def format_table(report: SkillReport, width: int = DEFAULT_WIDTH) -> str:
    """
    Generate detailed table output with thresholds.

    All content lines are padded to exactly width characters for consistent
    table borders. Column widths are calculated dynamically based on content.

    :param report: The SkillReport to format.
    :param width: Table width in characters (default: 80).
    :return: Formatted table string.
    """
    lines = []
    divider = "─" * width

    # Calculate dynamic column widths
    max_ref_name_len = 8  # Minimum width for "(none)"
    if report.references:
        max_ref_name_len = max(len(ref.name) for ref in report.references)

    # Helper to pad line to full width
    def pad(line: str) -> str:
        return line.ljust(width)

    # Header
    lines.append("=" * width)
    lines.append(pad(report.skill))
    lines.append("=" * width)
    lines.append("")

    # Result summary
    err_n = len(report.errors)
    warn_n = len(report.warnings)
    if report.status == ValidationLevel.PASS:
        if warn_n:
            s = "s" if warn_n != 1 else ""
            lines.append(pad(f"RESULT: PASS ({warn_n} warning{s})"))
        else:
            lines.append(pad("RESULT: PASS"))
    else:
        parts = []
        if err_n:
            s = "s" if err_n != 1 else ""
            parts.append(f"{err_n} error{s}")
        if warn_n:
            s = "s" if warn_n != 1 else ""
            parts.append(f"{warn_n} warning{s}")
        lines.append(pad(f"RESULT: FAIL ({', '.join(parts)})"))

    lines.append("")

    # Gates section
    lines.append(pad("VALIDATION GATES"))
    lines.append(divider)
    lines.append(_render_gates(report.gates, width))
    lines.append("")

    # Token analysis section
    lines.append(pad("TOKEN ANALYSIS"))
    lines.append(divider)

    # SKILL.md metrics
    lines.append(pad("  SKILL.md"))
    lines.append(_render_metric_line("Tokens", report.skill_md_tokens, width))
    lines.append(_render_metric_line("Words", report.skill_md_words, width))
    lines.append(_render_metric_line("Lines", report.skill_md_lines, width))
    lines.append("")

    # References
    enforcement = report.references_enforcement
    lines.append(pad(f"  References [{enforcement}]"))
    if report.references:
        for ref in report.references:
            lines.append(_render_reference_line(ref, max_ref_name_len, width))
        # Subtotal divider spans the numeric columns
        subtotal = sum(r.tokens for r in report.references)
        lines.append(_render_subtotal_line(subtotal, max_ref_name_len, width))
    else:
        lines.append(pad("    (none)"))
    lines.append("")

    # Total
    lines.append(pad("  Total"))
    lines.append(_render_total_line(report.total_tokens, width))
    lines.append("")

    # Issues section - use "ISSUES" for warnings-only, separate when errors exist
    if report.errors:
        lines.append(pad("ERRORS"))
        lines.append(divider)
        for err in report.errors:
            lines.append(
                pad(f"  ERROR: [{err.gate.capitalize()}] {err.message}")
            )
        lines.append("")

        if report.warnings:
            lines.append(pad("WARNINGS"))
            lines.append(divider)
            for warn in report.warnings:
                lines.append(
                    pad(f"  WARN: [{warn.gate.capitalize()}] {warn.message}")
                )
            lines.append("")
    elif report.warnings:
        lines.append(pad("ISSUES"))
        lines.append(divider)
        for warn in report.warnings:
            lines.append(
                pad(f"  WARN: [{warn.gate.capitalize()}] {warn.message}")
            )
        lines.append("")

    lines.append("=" * width)

    return "\n".join(lines)


def format_xml(report: SkillReport) -> str:
    """
    Generate XML output for Claude/agents using stdlib ElementTree.

    :param report: The SkillReport to format.
    :return: Formatted XML string.
    """
    root = ET.Element("skill_report")

    # Metadata
    metadata = ET.SubElement(root, "metadata")
    ET.SubElement(metadata, "skill").text = report.skill
    ET.SubElement(metadata, "path").text = str(report.path)
    ET.SubElement(metadata, "timestamp").text = report.timestamp.isoformat()
    ET.SubElement(metadata, "status").text = report.status.value
    ET.SubElement(metadata, "warning_count").text = str(len(report.warnings))
    ET.SubElement(metadata, "error_count").text = str(len(report.errors))

    # Gates
    gates = ET.SubElement(root, "gates")
    for gate_name, gate_status in report.gates.items():
        gate = ET.SubElement(gates, "gate")
        gate.set("name", gate_name)
        gate.set("status", gate_status.value)

    # Token budget
    token_budget = ET.SubElement(root, "token_budget")

    # SKILL.md
    skill_md = ET.SubElement(token_budget, "skill_md")
    t = report.skill_md_tokens
    tokens_el = ET.SubElement(skill_md, "tokens")
    tokens_el.set("value", str(t.value))
    tokens_el.set("max", str(t.max))
    tokens_el.set("status", t.status.value)

    w = report.skill_md_words
    words_el = ET.SubElement(skill_md, "words")
    words_el.set("value", str(w.value))
    words_el.set("max", str(w.max))
    words_el.set("status", w.status.value)

    ln = report.skill_md_lines
    lines_el = ET.SubElement(skill_md, "lines")
    lines_el.set("value", str(ln.value))
    lines_el.set("max", str(ln.max))
    lines_el.set("status", ln.status.value)

    # References
    ref_count = len(report.references)
    enf = report.references_enforcement
    references = ET.SubElement(token_budget, "references")
    references.set("enforcement", enf)
    references.set("count", str(ref_count))

    for ref in report.references:
        file_el = ET.SubElement(references, "file")
        file_el.set("name", ref.name)
        ref_tokens = ET.SubElement(file_el, "tokens")
        ref_tokens.set("value", str(ref.tokens))
        ref_tokens.set("status", ref.status.value)
        ET.SubElement(file_el, "words").set("value", str(ref.words))
        ET.SubElement(file_el, "lines").set("value", str(ref.lines))

    subtotal = sum(r.tokens for r in report.references)
    subtotal_el = ET.SubElement(references, "subtotal")
    subtotal_el.set("tokens", str(subtotal))

    # Total
    total = ET.SubElement(token_budget, "total")
    tot = report.total_tokens
    total_tokens = ET.SubElement(total, "tokens")
    total_tokens.set("value", str(tot.value))
    if tot.max:
        total_tokens.set("max", str(tot.max))
        pct = int(tot.value / tot.max * 100)
        total_tokens.set("percent", str(pct))
    total_tokens.set("status", tot.status.value)
    ET.SubElement(total, "words").set("value", str(report.total_words))
    ET.SubElement(total, "lines").set("value", str(report.total_lines))

    # Issues
    issues = ET.SubElement(root, "issues")
    for err in report.errors:
        error_el = ET.SubElement(issues, "error")
        error_el.set("gate", err.gate)
        error_el.text = err.message
    for warn in report.warnings:
        warning_el = ET.SubElement(issues, "warning")
        warning_el.set("gate", warn.gate)
        warning_el.text = warn.message

    # Generate indented XML string
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="unicode")


def format_yaml(report: SkillReport) -> str:
    """
    Generate YAML output (token-efficient).

    :param report: The SkillReport to format.
    :return: Formatted YAML string.
    :raises SystemExit: If pyyaml is not installed.
    """
    if not HAS_YAML:
        msg = (
            "Error: YAML output requires pyyaml. "
            "Install with: pip install pyyaml"
        )
        print(msg, file=sys.stderr)
        sys.exit(1)

    data = _report_to_dict(report)
    return yaml.dump(
        {"skill_report": data},
        default_flow_style=False,
        sort_keys=False,
    )


def format_json(report: SkillReport) -> str:
    """
    Generate JSON output for programmatic use.

    :param report: The SkillReport to format.
    :return: Formatted JSON string.
    """
    return json.dumps(_report_to_dict(report), indent=2)


def _report_to_dict(report: SkillReport) -> dict:
    """
    Convert SkillReport to JSON-serializable dict.

    :param report: The SkillReport to convert.
    :return: Dictionary representation of the report.
    """
    # Build token metrics for skill_md
    skill_md_tokens = {
        "value": report.skill_md_tokens.value,
        "max": report.skill_md_tokens.max,
        "status": report.skill_md_tokens.status.value,
    }
    skill_md_words = {
        "value": report.skill_md_words.value,
        "max": report.skill_md_words.max,
        "status": report.skill_md_words.status.value,
    }
    skill_md_lines = {
        "value": report.skill_md_lines.value,
        "max": report.skill_md_lines.max,
        "status": report.skill_md_lines.status.value,
    }

    # Build reference file list
    ref_files = [
        {
            "name": f.name,
            "tokens": f.tokens,
            "words": f.words,
            "lines": f.lines,
            "status": f.status.value,
        }
        for f in report.references
    ]

    # Calculate total percentage
    total_max = report.total_tokens.max
    if total_max:
        total_pct = int(report.total_tokens.value / total_max * 100)
    else:
        total_pct = 0

    # Build total tokens dict
    total_tokens = {
        "value": report.total_tokens.value,
        "max": report.total_tokens.max,
        "percent": total_pct,
        "status": report.total_tokens.status.value,
    }

    # Build issues list
    issues = [
        {"type": i.type.value, "gate": i.gate, "message": i.message}
        for i in report.errors + report.warnings
    ]

    # Convert gates dict to use string values
    gates_dict = {k: v.value for k, v in report.gates.items()}

    return {
        "skill": report.skill,
        "path": str(report.path),
        "timestamp": report.timestamp.isoformat(),
        "status": report.status.value,
        "warnings": len(report.warnings),
        "errors": len(report.errors),
        "gates": gates_dict,
        "token_budget": {
            "skill_md": {
                "tokens": skill_md_tokens,
                "words": skill_md_words,
                "lines": skill_md_lines,
            },
            "references": {
                "enforcement": report.references_enforcement,
                "files": ref_files,
                "subtotal": sum(f.tokens for f in report.references),
            },
            "total": {
                "tokens": total_tokens,
                "words": report.total_words,
                "lines": report.total_lines,
            },
        },
        "issues": issues,
    }


# === Rendering Helpers ===


def _render_gates(gates: dict[str, ValidationLevel], width: int) -> str:
    """
    Render gate status in two-column format with dot leaders.

    Each row is padded to the full width. Gates are displayed in pairs
    with consistent column alignment.

    :param gates: Dictionary mapping gate names to ValidationLevel.
    :param width: Total line width for padding.
    :return: Formatted gate status string.
    """
    items = list(gates.items())
    lines = []

    # Calculate column widths for consistent alignment
    # Format: "  Name .......... STATUS    Name .......... STATUS"
    max_name_len = max(len(name) for name, _ in items)
    col_width = (
        max_name_len + 1 + 10 + 1 + 4
    )  # name + space + dots + space + PASS

    for i in range(0, len(items), 2):
        # Left column
        name_left = items[i][0].capitalize()
        status_left = items[i][1].value
        dots_left = "." * (col_width - len(name_left) - 1 - len(status_left))
        left = f"{name_left} {dots_left} {status_left}"

        if i + 1 < len(items):
            # Right column
            name_right = items[i + 1][0].capitalize()
            status_right = items[i + 1][1].value
            dots_right = "." * (
                col_width - len(name_right) - 1 - len(status_right)
            )
            right = f"{name_right} {dots_right} {status_right}"
            line = f"  {left}    {right}"
        else:
            line = f"  {left}"

        lines.append(line.ljust(width))

    return "\n".join(lines)


def _render_metric_line(label: str, metric: TokenMetric, width: int) -> str:
    """
    Render a metric line with right-aligned value and dot leaders to status.

    Format: "    Label:     value / max ............................... STATUS"

    :param label: The metric label (Tokens, Words, Lines).
    :param metric: The TokenMetric object.
    :param width: Total line width for padding.
    :return: Formatted metric line.
    """
    indent = "    "
    status_str = metric.status.value

    if metric.max:
        val_str = f"{metric.value:,} / {metric.max:,}"
    else:
        val_str = f"{metric.value:,}"

    # Fixed column widths for alignment
    label_col = 8  # "Tokens:" width
    value_col = 18  # Right-aligned value column

    # Build prefix with label
    prefix = f"{indent}{label}:"

    # Calculate dots: width - indent - label_col - value_col - status - spaces
    content_start = len(indent) + label_col + value_col
    dots_count = width - content_start - len(status_str) - 2  # 2 for spaces
    dots = "." * max(dots_count, 3)

    return f"{prefix:<{len(indent) + label_col}}{val_str:>{value_col}} {dots} {status_str}"


def _render_reference_line(ref, max_name_len: int, width: int) -> str:
    """
    Render a reference file line with threshold info and dot leaders.

    Format: "    filename:         tokens (threshold: X, strong: Y) .. STATUS"

    :param ref: FileMetrics object for the reference file.
    :param max_name_len: Maximum filename length for column alignment.
    :param width: Total line width for padding.
    :return: Formatted reference line.
    """
    indent = "    "
    threshold = CONFIG.reference_warning
    strong = CONFIG.reference_strong_warning
    threshold_info = f"(threshold: {threshold:,}, strong: {strong:,})"
    status_str = ref.status.value

    # Build name:tokens with aligned columns
    name_col = max_name_len + 1  # +1 for colon
    token_col = 10  # Right-aligned token count

    name_part = f"{ref.name}:"
    token_part = f"{ref.tokens:>,}"

    # Calculate dots to fill to width
    fixed_part = f"{indent}{name_part:<{name_col}}{token_part:>{token_col}} {threshold_info}"
    dots_count = width - len(fixed_part) - len(status_str) - 2
    dots = "." * max(dots_count, 3)

    return f"{fixed_part} {dots} {status_str}"


def _render_subtotal_line(subtotal: int, max_name_len: int, width: int) -> str:
    """
    Render the subtotal line with divider and aligned value.

    The divider spans from indent across the name:token columns.
    The subtotal value aligns with the token values in reference lines.

    :param subtotal: Total tokens from all references.
    :param max_name_len: Maximum filename length for column alignment.
    :param width: Total line width for padding.
    :return: Formatted subtotal line with divider above.
    """
    indent = "    "
    name_col = max_name_len + 1  # +1 for colon (matches reference line)
    token_col = 10  # Matches reference line token column

    # Divider spans name + token columns
    divider_len = name_col + token_col
    divider_line = f"{indent}{'─' * divider_len}"

    # Subtotal: label left-aligned in name_col, value right-aligned in token_col
    subtotal_line = (
        f"{indent}{'Subtotal:':<{name_col}}{subtotal:>{token_col},}"
    )

    return f"{divider_line.ljust(width)}\n{subtotal_line.ljust(width)}"


def _render_total_line(metric: TokenMetric, width: int) -> str:
    """
    Render the total tokens line with percentage and dot leaders.

    Format: "    Tokens: value / max (pct%) ........................... STATUS"

    :param metric: TokenMetric for total tokens.
    :param width: Total line width for padding.
    :return: Formatted total line.
    """
    indent = "    "
    status_str = metric.status.value

    if metric.max:
        pct = int(metric.value / metric.max * 100)
        val_str = f"{metric.value:,} / {metric.max:,} ({pct}%)"
    else:
        val_str = f"{metric.value:,}"

    prefix = f"{indent}Tokens: {val_str}"

    # Calculate dots to fill to width
    dots_count = width - len(prefix) - len(status_str) - 2
    dots = "." * max(dots_count, 3)

    return f"{prefix} {dots} {status_str}"


