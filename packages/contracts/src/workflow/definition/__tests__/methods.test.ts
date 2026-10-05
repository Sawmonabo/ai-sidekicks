// The definition methods are called by the builder, the catalog, an agent's tools and the
// Versions panel. These cases hold what those callers rely on: a create names the workflow once,
// in its document; a read reports a token's last use only beside the date the token was made,
// since the daemon keeps only the token's hash; and each version names who saved it.
import { describe, expect, it } from "vitest";

import {
  WorkflowDefinitionCreateRequestSchema,
  WorkflowDefinitionReadResponseSchema,
  WorkflowVersionChainReadResponseSchema,
} from "../methods.js";

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";
const NOW = "2026-09-29T08:00:00.000Z";

const DOCUMENT = {
  schemaVersion: "2",
  name: "Test workflow",
  trigger: {
    id: "manual",
    kind: "trigger.manual",
    kindVersion: 1,
    name: "Start",
    order: 0,
    params: {},
  },
  nodes: [],
  edges: [],
};

describe("workflow.definitionCreate", () => {
  it("creates from the document, whose name is the one name", () => {
    const create = {
      scope: "project",
      scopeRef: PROJECT_ID,
      document: DOCUMENT,
    };
    expect(WorkflowDefinitionCreateRequestSchema.safeParse(create).success).toBe(true);
    expect(
      WorkflowDefinitionCreateRequestSchema.safeParse({ ...create, name: "Test workflow" }).success,
    ).toBe(false);
  });
});

describe("workflow.definitionRead", () => {
  it("reports a token's last use only beside its creation date", () => {
    const read = {
      id: "def-1",
      name: "Test workflow",
      scope: "project",
      scopeRef: PROJECT_ID,
      versionNumber: 3,
      workflowVersionId: "ver-3",
      contentHash: "b3:0123abcd",
      document: DOCUMENT,
      createdAt: NOW,
      webhookTokenCreatedAt: NOW,
      webhookTokenLastUsedAt: NOW,
      webhookLastFire: { at: NOW, outcome: "token_mismatch" },
    };
    expect(WorkflowDefinitionReadResponseSchema.safeParse(read).success).toBe(true);
    const { webhookTokenCreatedAt: _created, ...usedWithoutToken } = read;
    expect(WorkflowDefinitionReadResponseSchema.safeParse(usedWithoutToken).success).toBe(false);
  });
});

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
