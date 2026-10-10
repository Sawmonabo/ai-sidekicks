// How the daemon builds each provider's live driver, one entry per provider. Only the daemon's
// startup imports this table: a descriptor stays data that imports no driver code, and no driver
// or shared module imports a factory, so the import graph has no cycle.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { createDriver as createClaudeDriver } from "./claude/index.js";
import { createDriver as createCodexDriver } from "./codex/index.js";
import type { ProviderDriver } from "./contract.js";

/** Each provider's driver factory, taking that provider's own dependencies. */
export const PROVIDER_DRIVER_FACTORIES: {
  readonly claude: typeof createClaudeDriver;
  readonly codex: typeof createCodexDriver;
} = {
  claude: createClaudeDriver,
  codex: createCodexDriver,
} satisfies {
  readonly [Provider in ProviderName]: (dependencies: never) => ProviderDriver;
};

/** What each provider's factory is built from, by provider. */
export type ProviderDriverDependencies = {
  readonly [Provider in ProviderName]: Parameters<(typeof PROVIDER_DRIVER_FACTORIES)[Provider]>[0];
};
