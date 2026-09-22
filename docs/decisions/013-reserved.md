# ADR-013: Reserved Numbering Slot (Skipped, No Decision)

| Field         | Value                        |
| ------------- | ---------------------------- |
| **Status**    | `reserved-skipped`           |
| **Type**      | `N/A (no decision recorded)` |
| **Domain**    | `N/A`                        |
| **Date**      | `2026-04-15`                 |
| **Author(s)** | `Claude`                     |
| **Reviewers** | `Formalized 2026-04-19`      |

## Status Explanation

This ADR number is a formally-skipped slot. No decision is recorded at this position. The file exists to make the gap in ADR numbering explicit, so that a reader does not go looking for a missing document.

## Why The Slot Is Kept Rather Than Reclaimed

ADR-014 onward already exist and are cited by plans, specs, and other ADRs throughout the repository. Renumbering them to close the gap would mean rewriting every cross-reference for no decision-quality benefit, and a formally-skipped number is easier to reason about than a missing file. A new ADR takes the next free integer in the sequence; it never reclaims this number.

## Next Decision In Sequence

ADR numbering continues at [ADR-014: tRPC Control Plane API](./014-trpc-control-plane-api.md).
