# Coding Standards

Rules below apply to all code you write, in every language and project. Keep this file to genuinely universal standards — anything language-, paradigm-, or repo-specific belongs in that project's instructions, not here.

## Identifiers

Use the full, descriptive name for any identifier that names an entity or value: `browserWindow` not `win`, `config` not `cfg`, `request` not `req`. A well-named identifier documents _what_ a value is, so comments are free to explain _why_. Reserve single- or few-letter names for tight, idiomatic scopes only — `i`/`j` for loop indices, `e` for a `catch` binding, `x`/`y` for coordinates. Never abbreviate a domain entity to save keystrokes.

This governs identifiers you introduce. When editing code that already follows a consistent local convention (even an abbreviated one), match it unless you're explicitly asked to rename.
