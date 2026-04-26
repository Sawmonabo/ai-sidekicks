# ADR-013: Reserved Numbering Slot (Skipped, No Decision)

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `reserved-skipped` |
| **Type** | `N/A (no decision recorded)` |
| **Domain** | `N/A` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |
| **Reviewers** | `Formalized 2026-04-19` |

## Status Explanation

This ADR number is a formally-skipped slot. No decision was ever drafted, proposed, or accepted at this position. The file exists to make the gap in ADR numbering explicit so that future readers (human or AI agent) do not search for a missing document.

## Why This Slot Was Left Empty

ADR-013 was created as a placeholder during the adversarial-review cleanup pass on 2026-04-15 (commit `d186470`; git-authored by `Sawmon`, co-authored by `Claude Opus 4.6`). Git history for this file shows a single creation commit; there was no prior draft, no deleted decision, and no referenced topic that was meant to land here.

## Why The Slot Is Kept Rather Than Reclaimed

ADRs 014 through 021 already exist and are cited by plans, specs, and other ADRs throughout the repository. Renumbering downstream ADRs to close the gap would require rewriting every cross-reference (search `ADR-014` through `ADR-021` repo-wide) for zero decision-quality benefit. The numbering gap is cheaper than the renumbering churn, and a formally-skipped ADR is easier for an AI agent to reason about than a missing file.

## Canonical Resolution Of BL-074

[BL-074](../archive/backlog-archive.md) asked whether to fill or remove this stub. The resolution is **neither**: the number is retained as a formally-skipped slot. This document is the explicit record of that decision. A future ADR must choose the next free integer in the sequence (see ADR registry in `docs/decisions/`) — it must not attempt to reclaim this number.

## Next Decision In Sequence

ADR numbering continues at [ADR-014: tRPC Control Plane API](./014-trpc-control-plane-api.md).

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-15 | Created | Placeholder file added in adversarial-review cleanup commit `d186470` (co-authored by Claude Opus 4.6). |
| 2026-04-19 | Formalized | BL-074 resolution: slot kept as formally-skipped, not filled and not removed. Renumbering downstream ADRs rejected as cost-ineffective churn. |
