# packages — rules

Binding for every change under `packages/`, on top of the [root `AGENTS.md`](../AGENTS.md), which this file never restates; how modules are grouped and named is in its [Folders by topic](../AGENTS.md#folders-by-topic).

## Dependencies between packages

- **The direction:** `contracts`, `crypto-paseto`, `search-index` and `search-ranking` depend on no other workspace package; `client-sdk` and `control-plane` depend on `contracts` alone, and `runtime-daemon` on `contracts`, `search-index`, whose index its session search reads, and `search-ranking`, whose scorer its file search ranks with; only `apps/` depend on `client-sdk`, and only `runtime-daemon` loads `search-index`. The client library and the daemon never import each other, so each changes without the other.
- **A package uses another only by listing it in its `package.json` and importing its exported entry points,** never a file across the boundary through `../`; a public module's import path follows its folder (`@ai-sidekicks/contracts/daemon/lifecycle`). pnpm makes an unlisted package unreachable, so a new workspace dependency is a line in the diff, and it follows the direction above.

## Contracts

- **A contract is a hand-written type plus its Zod schema annotated with it** (`export const SessionIdSchema: z.ZodType<SessionId, SessionId> = …`), because `isolatedDeclarations` refuses an exported schema whose type is inferred. The annotation only checks that the schema fits the type, never that the type is no wider, so the type must say exactly what the schema accepts and produces, never looser: a branded id where the schema brands, the exact literal where the schema pins one, `Record<string, never>` where the schema is a strict empty object.
