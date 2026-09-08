// The hashed body of a definition file, checked on the two claims that decide whether a
// round trip is real: every registered member survives it, and nothing else gets in.
//
// The reader is driven directly rather than through the document above it, because what
// is under test here is the record shapes: the document's own suite pins the file, and a
// case that had to compose a whole file to vary one phase member would be testing the
// marker every time it meant to test `dependsOn`.

import { describe, expect, it } from "vitest";

import {
  definitionBodyFileRecord,
  readDefinitionBody,
  type WorkflowDefinitionFileBody,
} from "./workflow-definition-file-body.js";
import type { WorkflowPhaseDefinition, WorkflowVersionBody } from "./workflow-definition-body.js";

/**
 * One phase carrying EVERY member the registered shape declares.
 *
 * Every member on one record is the point: the round-trip case below is what pins the
 * writer and the reader to the same set, so a member either of them forgets is a
 * failure here rather than a definition that imports as something else.
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
  it("carries no entry where the file states none, so the daemon materializes it", () => {
    const { entry, ...withoutEntry } = documentWith();
    const reading = readOrFail(withoutEntry);

    expect(typeof reading).not.toBe("string");
    if (typeof reading === "string") {
      return;
    }
    expect(entry).toBeDefined();
    expect(Object.keys(reading)).not.toContain("entry");
  });

  it("refuses an unsupported start mode by name rather than defaulting it", () => {
    // The pin. A reader that dropped an unrecognised entry left the daemon to
    // materialize `manual`, so a definition its author expects to run on a schedule
    // imported as one that runs when somebody presses a button — a change of WHEN the
    // workflow runs, reported as a success.
    const reading = readOrFail(documentWith({ entry: { startMode: "schedule" } }));

    expect(reading).toContain("schedule");
  });

  it("refuses an entry record carrying a member an entry does not have", () => {
    expect(
      readOrFail(documentWith({ entry: { startMode: "manual", cron: "0 3 * * *" } })),
    ).toContain("cron");
  });

  it("refuses an entry that is not a record at all", () => {
    expect(typeof readOrFail(documentWith({ entry: "manual" }))).toBe("string");
  });
});

describe("the hashed body — what a phase may not carry", () => {
  it("refuses a member no phase declares, by name", () => {
    // Carrying it would widen a registered request shape and dropping it would be the
    // same silent edit one member along, so the reader refuses and says which.
    expect(
      readOrFail(documentWith({ phaseDefinitions: [phaseDocumentWith({ timeoutMs: 30000 })] })),
    ).toContain("timeoutMs");
  });

  it("refuses a gate, type or failure behavior the vocabulary does not declare", () => {
    expect(
      readOrFail(
        documentWith({ phaseDefinitions: [phaseDocumentWith({ gateType: "rubber-stamp" })] }),
      ),
    ).toContain("Phase 1");
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

  it("refuses a phase sequence that is empty or is not a sequence", () => {
    expect(typeof readOrFail(documentWith({ phaseDefinitions: [] }))).toBe("string");
    expect(typeof readOrFail(documentWith({ phaseDefinitions: {} }))).toBe("string");
  });

  it("refuses a body carrying no name", () => {
    expect(typeof readOrFail(documentWith({ name: "" }))).toBe("string");
  });

  it("names the phase it refused, so two bad phases differ by index", () => {
    const reading = readOrFail(
      documentWith({
        phaseDefinitions: [phaseDocumentWith({}), phaseDocumentWith({ gateType: "rubber-stamp" })],
      }),
    );

    expect(reading).toContain("Phase 2");
  });

  it("negative control: every perturbation above starts from a body that reads", () => {
    expect(typeof readOrFail(documentWith())).not.toBe("string");
  });
});
