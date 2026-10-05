// What each provider is called on screen. The wire's provider name never reaches the screen.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

/** The on-screen name of each provider, total over the contract's provider set. */
export const PROVIDER_LABELS: Readonly<Record<ProviderName, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};
