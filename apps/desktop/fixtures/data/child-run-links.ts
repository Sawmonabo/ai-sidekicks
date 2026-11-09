// The `agent.childRunLink.list` reply of a session that has dispatched nothing: no child, no
// refused create, and the badge's counts at zero, so the Agents pane draws its empty line.

import type { AgentChildRunLinkListResponse } from "@ai-sidekicks/contracts/orchestration";

import type { ScenarioReply } from "#renderer/services/daemon/scenario/reply.fixture.js";

/** The child-run tree of a session nothing was dispatched from. */
export const NO_CHILD_RUN_LINKS_REPLY: ScenarioReply = {
  call: "agent.childRunLink.list",
  result: {
    children: [],
    counts: { live: 0, total: 0, waiting: 0 },
    rejectedCreates: [],
  } satisfies AgentChildRunLinkListResponse,
};
