// The codec, checked on the one claim it makes that its form module does not: the door's
// two entries fetch the form and then answer exactly what the form answers.
//
// WHAT IS NOT CHECKED HERE, AND WHERE IT IS. That the form stays off the initial import
// graph is a fact about the emitted bundle, and asserting it from inside the module
// graph is not possible — a transformed dynamic import resolves in the same tick. The
// guard for it is the initial-graph census in the bundle tier, which pins this family's
// owner row: a static import of the form from the door puts those bytes back on the
// graph and turns that pin red, naming the module.
//
// AND THE READING ITSELF IS NOT RE-CHECKED. Every refusal, every marker rule and the
// round trip belong to `workflow-definition-file-form.test.ts`, which reads them off the
// module that performs them. Restating one here would be a second copy of an assertion
// that moves when the form moves.

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
import type { WorkflowVersionBody } from "./workflow-definition-body.js";

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

describe("the definition file codec — the door's two entries", () => {
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
