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
- **An interface takes no `I` prefix:** `User`, never `IUser`. ESLint refuses it (`@typescript-eslint/naming-convention` in the root `eslint.config.mjs`).
- **Names read as proper English.** Things that act (functions, hooks, controls) start with the verb: `takeShell`, `useTakeShell`. Things that hold data (types, state, models) are noun phrases with the head noun last: `TakeShellAvailability`. Booleans read as questions: `isHeld`, `canTake`. An existing name is not renamed only to satisfy this.
- **File and folder names.** A name's case says what the file is responsible for; `.ts` or `.tsx` says only whether it contains JSX.
  - React component and page implementation files use a PascalCase basename: `.tsx` when the file contains JSX, `.ts` when it does not.
  - A reusable or exported component normally has its own clearly named component file. A tiny private helper component may stay with its sole owner when extracting it would create ceremony rather than a real reusable boundary.
  - Shared component and group owners use PascalCase folders. A folder may hold a small cohesive set of related components that share one semantic owner, styling, contracts or implementation infrastructure; it never becomes a generic component bucket.
  - React hooks use `useThing.ts`. A hook holds no presentation JSX; that presentation becomes a component when it has a real interface responsibility.
  - Other TypeScript and JavaScript modules use kebab-case file names. A non-component module that genuinely contains JSX may use `.tsx` and keeps its kebab-case basename.
  - Non-component folders use `kebab-case/`.
  - Tests keep the subject's file name stem and casing, and use `.test.ts` or `.test.tsx` according to whether the test itself contains JSX.
  - Subject-specific test support stays beside the subject as `*.test-support.ts(x)`; broader test helpers live under `tests/helpers/`.
  - JSX lives in `.tsx` files; a file with no JSX is `.ts`.
  - Tool- and framework-required file names, generated files and established configuration file names keep the spelling their owning tool requires.
  - Package-level `__tests__/` placement is the explicit package-test exception.
  - Rust follows Rust convention: `snake_case.rs`.
  - `index.ts` exists only for an intentional public API, uses named exports only, never `export *`, and never forms a barrel chain.
  - ESLint checks the shapes (`eslint-plugin-check-file` in the root `eslint.config.mjs`): kebab-case for every file and folder outside the desktop renderer, with `__tests__/` in the packages and the repository's tooling and `__fixtures__/` in the packages; in the renderer, PascalCase for a `.tsx` under `app/`, `components/`, `features/` or `layout/` that is not a test, test support or hook, and for a folder directly under `components/` or `layout/`, `useThing` for a file in a `hooks/` folder that is not test support, kebab-case, PascalCase or `useThing` for any other file, and kebab-case for any other folder; and no `.spec` file anywhere. ESLint also refuses a `.tsx` file with no JSX (a `no-restricted-syntax` selector that `requireJsxInTsx` in the root `eslint.config.mjs` adds for `.tsx` files). Whether a file is a component and what test support is named for are checked by reading.
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
