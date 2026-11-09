// The machine's `provider.list` reply, which every scenario answers: the two providers' sections,
// so each screen that reads a provider's name finds it. The sections hold the names, the plan
// word the scripted Codex account's plan reads as, and the least else the contract asks; no place
// has been checked yet and no driver row is declared.

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type {
  ProviderListResponse,
  ProviderPlanWord,
  ProviderSection,
} from "@ai-sidekicks/contracts/provider/settings";

import type { ScenarioReply } from "#renderer/services/daemon/scenario/reply.fixture.js";

/** The `provider.list` reply every scenario answers with, Claude Code first, then Codex. */
export const PROVIDER_LIST_REPLY: ScenarioReply = {
  call: "provider.list",
  result: {
    providers: [
      providerSection("claude" as ProviderId, "Claude Code", []),
      providerSection("codex" as ProviderId, "Codex", [{ plan: "team", word: "Business" }]),
    ],
  } satisfies ProviderListResponse,
};

/** One provider's section, named, with its plan words and otherwise empty. */
function providerSection(
  provider: ProviderId,
  name: string,
  planWords: readonly ProviderPlanWord[],
): ProviderSection {
  return {
    provider,
    name,
    planWords: [...planWords],
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
