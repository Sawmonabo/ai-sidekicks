# packages — rules

Applies to every change under `packages/`, on top of the [root `AGENTS.md`](../AGENTS.md), which this file never restates; how modules are grouped and named is in its [Folders by topic](../AGENTS.md#folders-by-topic).

## Dependencies between packages

- **The direction:** the TypeScript packages are each the TypeScript face of a crate, plus the markdown parser: `contracts` (the TypeScript types, constants and Ajv checks generated from `sidekicks-contracts`, plus the hand-written pieces a schema cannot carry), `client-sdk` (the Node-API package of `sidekicks-client-addon`, the addon over `sidekicks-client`, which the desktop loads in a `utilityProcess`), `compression` (loads `sidekicks-compression`'s WebAssembly build for the page), `search-ranking` (loads the WebAssembly build of `sidekicks-search`'s matcher for the renderer) and `markdown-parser` (Sätteri's markdown parser as WebAssembly, built from its released source with our fix, which the desktop's markdown worker compiles and the page runs). `contracts`, `compression`, `search-ranking` and `markdown-parser` depend on no other workspace package, and `client-sdk` depends on `contracts` alone; outside `packages/`, only `apps/desktop` depends on them. The crates' graph is Cargo's, and its rules are in `crates/AGENTS.md`.
- **A package uses another only by listing it in its `package.json` and importing its exported entry points,** never a file across the boundary through `../`; a public module's import path follows its folder (`@ai-sidekicks/contracts/daemon/lifecycle`). pnpm makes an unlisted package unreachable, so a new workspace dependency is a line in the diff, and it follows the direction above.

## Contracts

- **The TypeScript under `packages/contracts/src/generated/` is generated from `crates/sidekicks-contracts` and never edited:** its types, constants and Ajv checks come from the Rust types, and a change to a contract is made in the crate and regenerated. Only the hand-written pieces [`crates/sidekicks-contracts/AGENTS.md`](../crates/sidekicks-contracts/AGENTS.md#wire-contracts-sidekicks-contracts) lists sit outside that folder, in `packages/contracts/src`.
