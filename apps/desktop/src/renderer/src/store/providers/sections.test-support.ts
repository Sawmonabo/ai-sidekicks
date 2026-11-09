// The two providers' sections as `provider.list` sends them, for suites that need the provider
// list: the store's own and any view that names a provider.

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

/** One provider's section with nothing read or declared yet: its id and its name. */
export function providerSection(provider: string, name: string): ProviderSection {
  return {
    provider: provider as ProviderId,
    name,
    planWords: [],
    builtInTools: [],
    appSetEnvironmentNames: [],
    mcp: { transports: ["stdio"], configMembers: [] },
    skillNameMaxLength: null,
    voiceKinds: [],
    places: [{ installation: null, commandPath: null, checkedAt: null }],
    availableForNewSessions: true,
    helpersAtOnce: null,
    autoCompactPercent: null,
    rows: [],
    sessionOptions: [],
  };
}

/** The sections of the two providers the app drives today, in the service's order. */
export function providerSectionsFixture(): readonly ProviderSection[] {
  return [providerSection("claude", "Claude Code"), providerSection("codex", "Codex")];
}
