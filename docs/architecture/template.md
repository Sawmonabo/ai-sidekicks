# Architecture Doc Minimum Requirements

## Purpose

This file defines the minimum structure and writing rules for canonical docs in `architecture/`.

## Required Sections

Every architecture doc must include:

1. `Purpose`
2. `Scope`
3. `Context`
4. `Responsibilities`
5. `Component Boundaries`
6. `Data Flow`
7. `Trust Boundaries` when applicable
8. `Failure Modes`
9. `Related Domain Docs`
10. `Related Specs`
11. `Related ADRs`

## Writing Rules

- Architecture docs must map back to domain concepts rather than inventing their own vocabulary.
- Keep responsibilities explicit.
- If a boundary is important, name both sides of the boundary and what crosses it.
- If a choice is costly to reverse, mark it as an ADR candidate.

## Quality Bar

An architecture doc is not complete unless:

- ownership is unambiguous
- boundary crossings are described
- the document can explain why the component exists in domain terms
