---
name: update-docs
description: Update repository documentation to match the current branch and current code. Use this skill when the user asks to refresh architecture docs, CLAUDE.md, ADRs, plans, templates, or related documentation after implementation changes.
---

Ensure all documentation reflects the current state of the code on this branch.

Read `docs/INDEX.md` for the trust hierarchy. Source code is the highest
authority. When code and docs disagree, the docs are wrong.

Use context from the current conversation when available. If you just
implemented the changes, you already know what changed and why — do not
ask the human to re-explain. Only ask about decisions or rationale you
genuinely do not have context for.

## 1. Understand the scope

Run `git diff main...HEAD --stat` and `git log main..HEAD --oneline`.
Read changed source files to understand what was modified at a behavioral
level. Categorize:

- **Structural** — new modules, moved files, changed boundaries
- **Behavioral** — new features, changed logic, new endpoints
- **Infrastructure** — new dependencies, changed tooling, configuration
- **Pattern** — new way of doing something that other code should follow

## 2. Update architecture docs

Read every doc in `docs/architecture/`. For each, check whether the
branch changes affect what it describes. Update any doc that no longer
matches the code. Do not ask — these are factual corrections.

| Doc | Covers |
|-----|--------|
| `system-overview.md` | Implemented slices, request flow, layer contracts |
| `bounded-areas-and-dependencies.md` | Module paths, dependency direction, import contracts |
| `data-topology-and-cdc.md` | Schemas, RLS model, CDC pipeline, projections |
| `runtime-composition.md` | Store lifecycle, middleware, adapters |
| `persistence-boundary.md` | Query module contracts, naming, import enforcement |

## 3. Update root files and templates

- `CLAUDE.md` — update if safety constraints, tech stack table,
  development commands, or pipeline descriptions are affected by the
  changes.
- `docs/templates/` — if implementation patterns changed, read relevant
  templates and update them to match actual code. Check
  `docs/templates/INDEX.md` for the catalog.

## 4. Complete plans

If the branch implements work described by an active plan in
`docs/plans/`, move that plan to `docs/archive/plans/` using `git mv`.
If the plan is only partially completed, update its status but leave it
in `docs/plans/`.

## 5. Architecture decisions

Check `docs/adrs/` for existing ADRs whose context changed (e.g., a
library or pattern they reference was replaced). Update changelog entries
in affected ADRs directly.

If the changes introduce a new technology, replace an existing component,
or make a design choice between meaningful alternatives:

- **High confidence on rationale** (from conversation context, commit
  messages, or the code itself) — draft the ADR using the template at
  `docs/adrs/000-adr-template.md` and present it for approval.
- **Rationale unclear** — ask why the decision was made before drafting.

## 6. Spec divergences

Scan `docs/specs/` for documents topically related to the changes. Only
read specs whose subject area overlaps with the changed code. Compare
the implementation against the spec's design intent.

Specs are frozen — never edit them. If the code deliberately diverges:

- **Single divergence** — draft an ADR that records the decision and
  references the spec it diverges from. Use the template at
  `docs/adrs/000-adr-template.md`. Present for approval if rationale
  is unclear; commit directly if you have high confidence from context.
- **Accumulated divergence** — if multiple ADRs already diverge from
  the same spec, or the changes fundamentally shift the original
  vision, recommend creating a new spec that supersedes the original.
  Always ask before creating a new spec.

## 7. Summary

After making changes, report:

- **Updated** — list every doc modified and what changed
- **ADR** — new or updated, with status (committed or pending approval)
- **Spec divergence** — any flagged, with recommendation
- **Plan completed** — any plans moved to archive
- **No action** — if docs were already current
