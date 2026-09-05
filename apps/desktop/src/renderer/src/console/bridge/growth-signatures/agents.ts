// The agent plane: what a session's roster read takes and gives back.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section and row comments below are the single table's own, kept with the row they
// explain.
//
// The value type is imported from the module that DECLARES it rather than through the
// `growth-values/` door every other plane uses: that door publishes the pre-split
// surface and is held to it by a pinned census, and the agent values landed after the
// split. `bridge/index.ts` re-exports them from the declaring module for the same
// reason.

import type { GrowthAgentSummary } from "../growth-values/agents.js";

export interface AgentGrowthSignatures {
  // The agent roster. Registered in `api-payload-contracts.md` §`agent.attach /
  // agent.detach / agent.configUpdate / agent.list` and in no code package, so it is
  // the port's rather than `callDaemon`'s. The value is this family's NARROWING of
  // the registered reply rather than the reply itself: the composer reads two facts
  // off a row — the effective paying account and the pending switch — and a surface
  // handed the whole row would be reading members nothing here renders.
  agentList: {
    request: { readonly sessionId: string };
    value: readonly GrowthAgentSummary[];
  };
}
