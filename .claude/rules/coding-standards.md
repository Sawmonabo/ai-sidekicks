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

## Names

- **One canonical name per concept, within the layer where the concept lives.** A product or domain concept uses the design's word; an implementation concept keeps its conventional engineering name; a valid technical name is never renamed to match screen text. Inside one concept and one layer there are no synonyms. For example, the Settings › Runtime page is `runtime` in its folder, component, id, address and label; the process under it is the daemon (`packages/runtime-daemon/`, `callDaemon()`); and screen prose calls it the background service.
- **A product screen or page keeps one name end to end:** folder, component, route or destination id, address, navigation label and page heading.
- **A class, method, event or package name changes only when** the concept is obsolete, the name is inaccurate, or the design replaces the concept; never because a screen name changed. A rename updates producer, consumer, contract, tests and docs together. A word swap needs the same meaning on both sides.
- **Name a thing for what it is,** by its responsibility and owner; a generic word (`Surface`, `Feature`, `State`, `Act`) never stands in for that. No dumping-ground folders (`utils/`, `helpers/`, `common/`, `misc/`, `managers/`).
- **Names read as proper English.** Things that act (functions, hooks, controls) start with the verb: `takeShell`, `useTakeShell`. Things that hold data (types, state, models) are noun phrases with the head noun last: `TakeShellAvailability`. Booleans read as questions: `isHeld`, `canTake`. An existing name is not renamed only to satisfy this.
- **File names:** components and pages `PascalCase.tsx`, one component per file; hooks `useThing.ts`; other modules `kebab-case.ts`; folders `kebab-case/`; tests `Foo.test.tsx` and `foo.test.ts`. `.tsx` only when the file has JSX.
- **`shell` means a terminal or command shell.** Electron's main process is `main`; persistent interface chrome is `layout` or `AppShell`.
- Agent in code, sidekick on screen, as the root `AGENTS.md` states.

## Size, comments and docstrings

- **Size,** as the root `AGENTS.md` rule 6 sets it: a file stays under about 900 lines, and past that it splits at a real seam between two concepts. Data tables and test suites are not split for size.
- **Line length.** Prettier's 100-column width (`printWidth` in `prettier.config.js`) for code; comments wrap within the same width.
- **Comments are short.** One line where one line does, saying why, never restating the code. No task, plan, review or decision prose, no ids, no dates, no history.
- **Docstrings.** Every exported function, class, component, hook, type and constant carries a `/** … */` docstring of one or two sentences: what it is for, and any contract a caller must know (an error it throws, a unit, an invariant). No `@param` or `@returns` line that repeats the type, and no docstring on a private helper whose name says what it does.
- **No slop.** No dead code, unused export, placeholder branch, commented-out block, forwarding-only wrapper, or defensive check for a case that cannot happen.

## Closed sets of values

Do not declare a TypeScript `enum` or `const enum` in application or domain code; ESLint refuses one (`ENUM_DECLARATION` in the root `eslint.config.mjs`). For a closed set:

- a string-literal union when only the type is needed: `type RunState = "queued" | "running" | "completed" | "failed";`
- an `as const` object with its derived union when the values are needed at runtime: `const RunState = { Queued: "queued", Running: "running" } as const;` and `type RunState = (typeof RunState)[keyof typeof RunState];`
- a discriminated union when each state carries its own data: `{ state: "running"; startedAt: string } | { state: "failed"; error: string }`.

An enum is allowed only where an external, generated or platform contract requires one. It stays at that boundary, behind a file-scoped lint exemption, and is translated there into one of the forms above.
