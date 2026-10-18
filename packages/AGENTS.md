# packages — rules

Binding for every change under `packages/`, on top of the [root `AGENTS.md`](../AGENTS.md), which this file never restates; how modules are grouped and named is in its [Folders by topic](../AGENTS.md#folders-by-topic).

## Dependencies between packages

- **The direction:** the TypeScript packages are each the TypeScript face of a crate, plus the markdown parser: `contracts` (generated from `sidekicks-contracts`), `client-sdk` (the Node-API package of `sidekicks-client-addon`, the addon over `sidekicks-client`), `compression` (the WebAssembly build of `sidekicks-compression`), `search-ranking` (the WebAssembly build of `sidekicks-search`'s matcher) and `markdown-parser`. `contracts`, `compression`, `search-ranking` and `markdown-parser` depend on no other workspace package, and `client-sdk` depends on `contracts` alone; outside `packages/`, only `apps/desktop` depends on them. The crates' graph is Cargo's, and its rules are in `crates/AGENTS.md`.
- **A package uses another only by listing it in its `package.json` and importing its exported entry points,** never a file across the boundary through `../`; a public module's import path follows its folder (`@ai-sidekicks/contracts/daemon/lifecycle`). pnpm makes an unlisted package unreachable, so a new workspace dependency is a line in the diff, and it follows the direction above.

## Contracts

- **The TypeScript under `packages/contracts/src/generated/` is generated from `crates/sidekicks-contracts` and never edited:** its types, constants and Ajv checks come from the Rust types, and a change to a contract is made in the crate and regenerated. Only the hand-written pieces `crates/AGENTS.md` lists sit outside that folder, in `packages/contracts/src`.
