// The Versions panel and a run's header read a definition's version chain; each version names who
// saved it, an agent by its id.
import { describe, expect, it } from "vitest";

import { WorkflowVersionChainReadResponseSchema } from "../versions.js";

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-29T08:00:00.000Z";

describe("workflow.versionChainRead", () => {
  it("names who saved each version, an agent by its id", () => {
    const chain = {
      definitionId: "def-1",
      versions: [
        {
          workflowVersionId: "ver-1",
          versionNumber: 1,
          contentHash: "b3:01",
          createdAt: NOW,
          savedBy: { kind: "user" },
        },
        {
          workflowVersionId: "ver-2",
          versionNumber: 2,
          contentHash: "b3:02",
          createdAt: NOW,
          savedBy: { kind: "agent", agentId: AGENT_ID },
          changesFromPrevious: {
            nodesAdded: 0,
            nodesRemoved: 0,
            nodesChanged: 2,
            edgesAdded: 1,
            edgesRemoved: 0,
          },
        },
      ],
    };
    expect(WorkflowVersionChainReadResponseSchema.safeParse(chain).success).toBe(true);
    const anonymousAgent = {
      ...chain,
      versions: [{ ...chain.versions[0], savedBy: { kind: "agent" } }],
    };
    expect(WorkflowVersionChainReadResponseSchema.safeParse(anonymousAgent).success).toBe(false);
  });
});
