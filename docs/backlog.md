# Backlog

## Purpose

This file is the active development backlog for the product defined in [vision.md](./vision.md).

It should track real implementation work, follow-up product decisions, operational hardening, and targeted documentation updates that still affect delivery. It should not preserve completed readiness cleanup as backlog inventory.

## How To Use This Backlog

- Add items only when they represent real remaining work.
- Link every item to the governing spec, plan, ADR, or operations doc where possible.
- Keep items outcome-oriented. A backlog item should describe a deliverable, not a vague area of concern.
- Remove or rewrite stale items instead of letting the file become a historical log.
- When work is complete, update the canonical docs it depends on first, then remove the backlog item.

## Status Values

- `todo`
- `in_progress`
- `blocked`

## Priority Values

- `P0`
- `P1`
- `P2`

## In Progress

No active backlog items.

## Ready

No ready backlog items.

## Blocked

No blocked backlog items.

## Parking Lot

No parked backlog items.

## Item Template

Use this shape for new backlog items:

```md
### BL-00X: Short Title

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Relevant Spec](./specs/000-example.md), [Relevant Plan](./plans/000-example.md)
- Summary: One or two sentences describing the deliverable or change.
- Exit Criteria: Concrete condition that makes this item complete.
```

## Maintenance Rule

If information in a backlog item becomes durable product truth, move that information into the canonical docs and keep only the remaining work here.
