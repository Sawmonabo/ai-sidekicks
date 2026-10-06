# packages — structure rules

Binding for every change under `packages/`, on top of the [root `AGENTS.md`](../AGENTS.md), which this file never restates; how modules are grouped and named is in its [Folders by topic](../AGENTS.md#folders-by-topic).

## Dependencies between packages

- **The direction:** `contracts`, `crypto-paseto` and `search-ranking` depend on no other workspace package; `client-sdk`, `runtime-daemon` and `control-plane` depend on `contracts` alone; only `apps/` depend on `client-sdk`. The client library and the daemon never import each other, so each changes without the other.
- **A package uses another only by listing it in its `package.json` and importing its exported entry points,** never a file across the boundary through `../`; a public module's import path follows its folder (`@ai-sidekicks/contracts/daemon/lifecycle`). pnpm makes an unlisted package unreachable, so a new workspace dependency is a line in the diff, and it follows the direction above.
