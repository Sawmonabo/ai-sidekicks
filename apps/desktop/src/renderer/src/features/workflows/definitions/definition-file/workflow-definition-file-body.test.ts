// The hashed body of a definition file: every registered member survives a round trip and
// nothing else gets in. The reader is driven directly so a case varying one phase member does
// not also test the marker.

import { describe, expect, it } from "vitest";

import {
  definitionBodyFileRecord,
  readDefinitionBody,
  type WorkflowDefinitionFileBody,
} from "./workflow-definition-file-body.js";
import type {
  WorkflowPhaseDefinition,
  WorkflowVersionBody,
} from "@renderer/services/wire-shapes/workflow-definition-body.js";

/**
 * One phase carrying every member the registered shape declares, so a member the writer or
 * reader forgets fails the round trip.
 */
const COMPLETE_PHASE: WorkflowPhaseDefinition = {
  phaseId: "phase-verify",
  name: "Verify",
  type: "multi-agent",
  gateType: "quality-checks",
  failureBehavior: "go-back-to",
  toolBindings: [
    { binding: { provider: "codex", scope: "user", serverName: "checks" }, toolName: "run_suite" },
  ],
  goBackTo: "phase-draft",
  dependsOn: ["phase-draft", "phase-plan"],
  parallelJoinPolicy: "all-settled",
  config: { instruction: "Run every suite.", retries: 3, blocking: true },
};

/** The served body the record writer is handed. */
function versionBody(phase: WorkflowPhaseDefinition = COMPLETE_PHASE): WorkflowVersionBody {
  return {
    definitionId: "019b7a10-0280-7c11-8100-def111150001",
    versionNumber: 9,
    workflowVersionId: "019b7a10-0280-7d22-8100-be5100150009",
    contentHash: "b3:4b1d0f6c9e2a7854cb30d1972fe6845ac0d1e83b9f27a504cde18b6320973adc",
    schemaVersion: "1.0",
    name: "Release checks",
    entry: { startMode: "manual" },
    phaseDefinitions: [phase],
    createdAt: "2026-01-01T07:04:00.000Z",
  };
}

/** The body as a document states it, starting from what the writer produced. */
function documentWith(members: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...definitionBodyFileRecord(versionBody()), ...members };
}

/** One phase document, starting from the complete phase the writer produced. */
function phaseDocumentWith(members: Record<string, unknown>): Record<string, unknown> {
  const written = definitionBodyFileRecord(versionBody())["phaseDefinitions"];
  const [phase] = written as readonly Record<string, unknown>[];
  return { ...phase, ...members };
}

/** The read body, or a failure naming the sentence the reader actually answered with. */
function readOrFail(document: Record<string, unknown>): WorkflowDefinitionFileBody | string {
  return readDefinitionBody(document);
}

describe("the hashed body — what the writer writes and the reader reads back", () => {
  it("carries every member the phase shape declares, through both sides", () => {
    const reading = readOrFail(documentWith());

    expect(typeof reading).not.toBe("string");
    if (typeof reading === "string") {
      return;
    }
    expect(reading.phaseDefinitions).toStrictEqual([COMPLETE_PHASE]);
  });

  it("carries an empty predecessor list, which is not the same fact as no list", () => {
    const reading = readOrFail(
      documentWith({ phaseDefinitions: [phaseDocumentWith({ dependsOn: [] })] }),
    );

    expect(typeof reading).not.toBe("string");
    if (typeof reading === "string") {
      return;
    }
    expect(reading.phaseDefinitions[0]?.dependsOn).toStrictEqual([]);
  });
});

describe("the hashed body — the entry record", () => {
  it("refuses an entry record carrying a member an entry does not have", () => {
    expect(
      readOrFail(documentWith({ entry: { startMode: "manual", cron: "0 3 * * *" } })),
    ).toContain("cron");
  });
});

describe("the hashed body — what a phase may not carry", () => {
  it("refuses a member no phase declares, by name", () => {
    // Carrying it would widen a registered request shape; dropping it is a silent edit.
    expect(
      readOrFail(documentWith({ phaseDefinitions: [phaseDocumentWith({ timeoutMs: 30000 })] })),
    ).toContain("timeoutMs");
  });

  it("refuses a present member whose value is wrong, rather than dropping it", () => {
    const wrongValues: readonly Record<string, unknown>[] = [
      { goBackTo: 4 },
      { dependsOn: "phase-draft" },
      { dependsOn: ["phase-draft", 7] },
      { parallelJoinPolicy: "first-past-the-post" },
      { config: "instruction" },
      { toolBindings: "run_suite" },
    ];

    for (const members of wrongValues) {
      const reading = readOrFail(documentWith({ phaseDefinitions: [phaseDocumentWith(members)] }));
      expect(typeof reading, `${Object.keys(members)[0] ?? ""} was not refused`).toBe("string");
    }
  });
});
