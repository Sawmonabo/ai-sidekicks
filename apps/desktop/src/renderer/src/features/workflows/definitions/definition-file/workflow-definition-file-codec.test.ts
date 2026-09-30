// The codec's one claim: its two calls fetch the form, then answer exactly what the form
// answers. Keeping the form off the initial graph cannot be asserted from inside the module
// graph (a transformed dynamic import resolves in the same tick); the `renderer-initial-bundle`
// budget bounds its size, not its membership. Refusals and the round trip are in the form's test.

import { describe, expect, it } from "vitest";

import {
  parseWorkflowDefinitionFile,
  serializeWorkflowDefinitionFile,
} from "./workflow-definition-file-codec.js";
import {
  parseDefinitionFile,
  serializeDefinitionFile,
  type WorkflowDefinitionImportTarget,
} from "./workflow-definition-file-form.js";
import type { WorkflowVersionBody } from "@renderer/services/wire-shapes/workflow-definition-body.js";

const TARGET: WorkflowDefinitionImportTarget = {
  sessionId: "019b7a12-0280-75e5-8510-ada11a5a3401",
  scope: "session",
  scopeRef: "019b7a12-0280-75e5-8510-ada11a5a3401",
};

/** One served body, at the smallest shape a file form is written from. */
function versionBody(): WorkflowVersionBody {
  return {
    definitionId: "019b7a10-0280-7c11-8100-def111150001",
    versionNumber: 4,
    workflowVersionId: "019b7a10-0280-7d22-8100-be5100150004",
    contentHash: "b3:0f3c9a1d7e5b42c8a06d1f93be27540ac1d8e6b3927fa04c5de81b6203794acd",
    schemaVersion: "1.0",
    name: "Release checks",
    entry: { startMode: "manual" },
    phaseDefinitions: [
      {
        phaseId: "phase-draft",
        name: "Draft",
        type: "single-agent",
        gateType: "auto-continue",
        failureBehavior: "retry",
      },
    ],
    createdAt: "2026-01-01T07:04:00.000Z",
  };
}

describe("the definition file codec — its two calls", () => {
  it("writes the bytes the form writes, once the form has arrived", async () => {
    const body = versionBody();

    await expect(serializeWorkflowDefinitionFile(body)).resolves.toBe(
      serializeDefinitionFile(body),
    );
  });

  it("reads back the body the form reads, target and all", async () => {
    const file = serializeDefinitionFile(versionBody());

    await expect(parseWorkflowDefinitionFile(file, TARGET)).resolves.toStrictEqual(
      parseDefinitionFile(file, TARGET),
    );
  });

  it("carries a refusal through rather than rejecting on it", async () => {
    const reading = await parseWorkflowDefinitionFile("name: [unterminated\n", TARGET);

    expect(reading.status).toBe("invalid");
  });
});
