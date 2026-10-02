// The definition file document: it is YAML, a file this console wrote reads back whole with its
// `ai-sidekicks-schema` marker, an unknown top-level key is refused by name, and the target is the
// caller's and never the file's.

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

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

/**
 * One served body, with only what a case varies overridden. It carries a tool binding and a
 * phase config so a round trip proves both are written and read back; without them a round
 * trip would pass while an import removed every tool call.
 */
function versionBody(overrides: Partial<WorkflowVersionBody> = {}): WorkflowVersionBody {
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
        toolBindings: [
          {
            binding: {
              provider: "claude",
              scope: "project",
              scopeRef: "/Users/release/checks",
              serverName: "release-tools",
            },
            toolName: "cut_release_notes",
          },
        ],
        config: { instruction: "Draft the notes.\nList every merged change.\n", attempts: 2 },
      },
      {
        phaseId: "phase-review",
        name: "Review",
        type: "human",
        gateType: "human-approval",
        failureBehavior: "go-back-to",
        goBackTo: "phase-draft",
        dependsOn: ["phase-draft"],
      },
    ],
    createdAt: "2026-01-01T07:04:00.000Z",
    ...overrides,
  };
}

/** The parsed body, or a failure naming what the reading actually said. */
function parseOrFail(text: string): ReturnType<typeof parseDefinitionFile> {
  return parseDefinitionFile(text, TARGET);
}

/** The exported file's own top-level document, read by an independent reader. */
function exportedDocument(body: WorkflowVersionBody = versionBody()): Record<string, unknown> {
  return parse(serializeDefinitionFile(body)) as Record<string, unknown>;
}

/** The exported file with one top-level member added or replaced, re-serialized. */
function exportedFileWith(members: Record<string, unknown>): string {
  return stringify({ ...exportedDocument(), ...members });
}

describe("the definition file form — what a serialized body reads back as", () => {
  it("round-trips the name, the entry and every phase member", () => {
    // `toolBindings` and `config` must survive: dropping them would import different executable
    // bytes and a different content hash while reporting a successful round trip.
    const body = versionBody();
    const reading = parseOrFail(serializeDefinitionFile(body));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(reading.body.name).toBe(body.name);
    expect(reading.body.entry).toStrictEqual(body.entry);
    expect(reading.body.phaseDefinitions).toStrictEqual(body.phaseDefinitions);
  });

  it("takes the scope from the caller and never from the file", () => {
    const reading = parseOrFail(serializeDefinitionFile(versionBody()));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(reading.body.scope).toBe(TARGET.scope);
    expect(reading.body.scopeRef).toBe(TARGET.scopeRef);
    expect(reading.body.sessionId).toBe(TARGET.sessionId);
  });

  it("sends neither the marker nor any provenance, which the request has no member for", () => {
    const reading = parseOrFail(serializeDefinitionFile(versionBody()));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(Object.keys(reading.body)).not.toContain("schemaVersion");
    expect(Object.keys(reading.body)).not.toContain("ai-sidekicks-schema");
    expect(Object.keys(reading.body)).not.toContain("contentHash");
    expect(Object.keys(reading.body)).not.toContain("workflowVersionId");
  });
});

describe("the definition file form — the document an export writes", () => {
  it("writes the marker and the two parts, and nothing else at the top level", () => {
    // A `exportedFrom` block would make every exported file a refusal in a conforming CLI,
    // whose form is the hashed body plus an optional `layout`.
    expect(Object.keys(exportedDocument())).toStrictEqual([
      "ai-sidekicks-schema",
      "name",
      "entry",
      "phaseDefinitions",
    ]);
  });
});

describe("the definition file form — what it reads, and what it refuses", () => {
  it("reads a file written as ordinary block mappings, block scalars included", () => {
    // The primary producer: a CLI or SDK writes YAML, which `JSON.parse` would refuse.
    const reading = parseOrFail(
      [
        "ai-sidekicks-schema: 1.0",
        "name: Nightly checks",
        "entry:",
        "  startMode: manual",
        "phaseDefinitions:",
        "  - phaseId: phase-draft",
        "    name: Draft",
        "    type: single-agent",
        "    gateType: auto-continue",
        "    failureBehavior: retry",
        "    config:",
        "      instruction: |",
        "        Draft the notes.",
        "        List every merged change.",
        "",
      ].join("\n"),
    );

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(reading.body.name).toBe("Nightly checks");
    expect(reading.body.phaseDefinitions[0]?.config).toStrictEqual({
      instruction: "Draft the notes.\nList every merged change.\n",
    });
  });

  it("refuses an unknown top-level key by name", () => {
    const reading = parseOrFail(
      exportedFileWith({
        exportedFrom: { definitionId: "019b7a10-0280-7c11-8100-def111150001" },
      }),
    );

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("exportedFrom");
  });

  it("accepts the optional layout section and carries none of it into the request", () => {
    const reading = parseOrFail(exportedFileWith({ layout: { "phase-draft": { x: 40, y: 120 } } }));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(Object.keys(reading.body)).not.toContain("layout");
  });

  it("refuses a supplied start mode the engine cannot honor, rather than defaulting it", () => {
    // An unrecognized entry dropped by the reader becomes `manual` in the daemon, so a scheduled
    // definition would import as one that runs on a button press.
    const reading = parseOrFail(exportedFileWith({ entry: { startMode: "schedule" } }));

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("schedule");
  });

  it("refuses a stream of more than one document", () => {
    const reading = parseOrFail(`${serializeDefinitionFile(versionBody())}---\nname: second\n`);

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("more than one YAML document");
  });

  it("refuses a repeated key rather than taking the last one silently", () => {
    const reading = parseOrFail(`${serializeDefinitionFile(versionBody())}name: Something else\n`);

    expect(reading.status).toBe("invalid");
  });
});
