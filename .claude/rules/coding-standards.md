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
