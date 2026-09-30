// The definition file document: it is YAML (block mappings and the JSON spelling both read), a
// file this console wrote reads back whole, the marker is `ai-sidekicks-schema` (written quoted,
// read off the node, checked for shape and never against a constant), an unknown top-level key
// is refused by name, and the target is the caller's and never the file's.

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
 * phase config because a reader once wrote those and never read them back, so a round trip
 * without them would pass while an import removed every tool call.
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
  it("writes the marker quoted, so it reads back as a string and not as a number", () => {
    const file = serializeDefinitionFile(versionBody());

    expect(file).toContain('ai-sidekicks-schema: "1.0"');
    expect(exportedDocument()["ai-sidekicks-schema"]).toBe("1.0");
  });

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

  it("writes block YAML rather than JSON, at two-space indentation", () => {
    const file = serializeDefinitionFile(versionBody());

    expect(file).toContain("\nname: Release checks\n");
    expect(file).toContain("\nentry:\n  startMode: manual\n");
    expect(file).toContain("\n  - phaseId: phase-draft\n");
    expect(file.endsWith("\n")).toBe(true);
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

  it("reads the JSON spelling too, because JSON is YAML", () => {
    const document = exportedDocument();

    expect(parseOrFail(JSON.stringify(document, undefined, 2)).status).toBe("parsed");
  });

  it("reads an unquoted marker off the node, so `1.0` does not collapse to `1`", () => {
    const reading = parseOrFail(
      ["ai-sidekicks-schema: 1.0", ...blockPhaseLines("Nightly checks")].join("\n"),
    );

    expect(reading.status).toBe("parsed");
  });

  it("refuses a marker whose shape no store could have held", () => {
    const reading = parseOrFail(
      serializeDefinitionFile(versionBody({ schemaVersion: "ai-sidekicks.workflow/v1" })),
    );

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("ai-sidekicks.workflow/v1");
  });

  it("accepts a marker value it has never seen, because no value is registered", () => {
    // The shape is what a store can hold; a constant would reject the daemon's own files.
    expect(parseOrFail(serializeDefinitionFile(versionBody({ schemaVersion: "2.7" }))).status).toBe(
      "parsed",
    );
  });

  it("refuses a document carrying the response field's name instead of the marker", () => {
    const { "ai-sidekicks-schema": marker, ...withoutMarker } = exportedDocument();
    const reading = parseOrFail(stringify({ schemaVersion: marker, ...withoutMarker }));

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("ai-sidekicks-schema");
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
    // End to end: an unrecognized entry dropped by the reader became `manual` in the daemon,
    // so a scheduled definition imported as one that runs on a button press.
    const reading = parseOrFail(exportedFileWith({ entry: { startMode: "schedule" } }));

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("schedule");
  });

  it("carries no entry where the file states none, which is the daemon's to materialize", () => {
    const { entry, ...withoutEntry } = exportedDocument();
    const reading = parseOrFail(stringify(withoutEntry));

    expect(entry).toStrictEqual({ startMode: "manual" });
    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(Object.keys(reading.body)).not.toContain("entry");
  });

  it("refuses text that is not a YAML document at all, in its own words", () => {
    const reading = parseOrFail("name: [unterminated\n");

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("not YAML that can be read");
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

  it("refuses a document that is not a map of named sections", () => {
    expect(parseOrFail("- one\n- two\n").status).toBe("invalid");
    expect(parseOrFail("").status).toBe("invalid");
  });

  it("negative control: every perturbation above starts from a file that parses", () => {
    // Guards against a parser that refuses everything.
    expect(parseOrFail(serializeDefinitionFile(versionBody())).status).toBe("parsed");
  });
});

/** The smallest readable definition body, as block YAML lines under a marker. */
function blockPhaseLines(name: string): readonly string[] {
  return [
    `name: ${name}`,
    "phaseDefinitions:",
    "  - phaseId: phase-draft",
    "    name: Draft",
    "    type: single-agent",
    "    gateType: auto-continue",
    "    failureBehavior: retry",
    "",
  ];
}
