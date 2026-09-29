---
paths:
  - "packages/**"
  - "apps/**"
  - "tools/**"
  - ".claude/hooks/**"
---

# Coding Standards

Rules below apply to all code in this repo, in every language.

## Identifiers

Use the full, descriptive name for any identifier that names an entity or value: `browserWindow` not `win`, `config` not `cfg`, `request` not `req`. A well-named identifier documents _what_ a value is, so comments are free to explain _why_. Reserve single- or few-letter names for tight, idiomatic scopes only — `i`/`j` for loop indices, `e` for a `catch` binding, `x`/`y` for coordinates. Never abbreviate a domain entity to save keystrokes.

This governs identifiers you introduce. When editing code that already follows a consistent local convention (even an abbreviated one), match it unless you're explicitly asked to rename.

## Closed sets of values

Do not declare a TypeScript `enum` or `const enum` in application or domain code; ESLint refuses one (`ENUM_DECLARATION` in the root `eslint.config.mjs`). For a closed set:

- a string-literal union when only the type is needed: `type RunState = "queued" | "running" | "completed" | "failed";`
- an `as const` object with its derived union when the values are needed at runtime: `const RunState = { Queued: "queued", Running: "running" } as const;` and `type RunState = (typeof RunState)[keyof typeof RunState];`
- a discriminated union when each state carries its own data: `{ state: "running"; startedAt: string } | { state: "failed"; error: string }`.

An enum is allowed only where an external, generated or platform contract requires one. It stays at that boundary, behind a file-scoped lint exemption, and is translated there into one of the forms above.
