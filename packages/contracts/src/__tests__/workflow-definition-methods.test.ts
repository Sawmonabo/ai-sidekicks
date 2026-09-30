// The token's hash is all the daemon keeps, so a definition read reports a token's last use only
// beside the date the token was made; a last use with no token would describe one that is gone.
import { describe, expect, it } from "vitest";

import { WorkflowDefinitionReadResponseSchema } from "../workflow-definition-methods.js";

const NOW = "2026-09-29T08:00:00.000Z";

const DOCUMENT = {
  schemaVersion: "2",
  name: "Nightly suite",
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

describe("workflow.definitionRead", () => {
  it("reports a token's last use only beside its creation date", () => {
    const read = {
      id: "def-1",
      name: "Nightly suite",
      scope: "project",
      scopeRef: "/repo",
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
