# Domain Doc Minimum Requirements

## Purpose

This file defines the minimum structure and writing rules for canonical docs in `domain/`.

## Required Sections

Every domain doc must include:

1. `Purpose`
2. `Scope`
3. `Definitions`
4. `What This Is`
5. `What This Is Not`
6. `Invariants`
7. `Relationships To Adjacent Concepts`
8. `State Model` or `Lifecycle` when applicable
9. `Example Flows`
10. `Edge Cases`
11. `Related Specs`
12. `Related ADRs`

## Writing Rules

- Define terms precisely and consistently.
- Avoid implementation-level detail unless it clarifies semantics.
- Make boundaries between related domain concepts explicit.
- If a term can be confused with another term, say so directly.

## Quality Bar

A domain doc is not complete unless:

- another agent can use it to interpret specs consistently
- the concept is distinguished from neighboring concepts
- its invariants are explicit
