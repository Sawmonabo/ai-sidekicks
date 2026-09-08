// The definition file, checked on the claims its module makes about the DOCUMENT.
//
//   1. It is YAML, and one dialect of it. A file written as ordinary block mappings —
//      which is what the CLI and the SDK emit — reads here, and so does the JSON-shaped
//      spelling, because JSON is YAML. A reader that took only one of those closed the
//      round trip in one direction and broke it in the other.
//   2. A file this console wrote is a file this console reads, and the phases come back
//      whole. One module owns both sides precisely so that holds.
//   3. The marker is `ai-sidekicks-schema`, it is written quoted, it is read off the
//      node so an unquoted `1.0` still reads as `1.0`, and it is checked for the stored
//      shape and never against a constant.
//   4. The document has the marker and two parts and nothing else. An unknown top-level
//      key is a refusal by name, because that is what a conforming reader does with one.
//   5. The target is the caller's. A file names no scope, so the parse takes the one it
//      was handed and never one the bytes proposed — which is the decision the daemon's
//      operator-scope authorization is keyed on.

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import {
  parseWorkflowDefinitionFile,
  serializeWorkflowDefinitionFile,
  type WorkflowDefinitionImportTarget,
} from "./workflow-definition-file-form.js";
import type { WorkflowVersionBody } from "./workflow-definition-body.js";

const TARGET: WorkflowDefinitionImportTarget = {
  sessionId: "019b7a12-0280-75e5-8510-ada11a5a3401",
  scope: "session",
  scopeRef: "019b7a12-0280-75e5-8510-ada11a5a3401",
};

/**
 * One served body, with only what a case varies overridden.
 *
 * It carries a tool binding and a phase config on purpose: those two are the members an
 * earlier reader wrote and never read back, so a round trip over a body without them
 * would have passed while an import silently removed every tool call in the definition.
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
async function parseOrFail(
  text: string,
): Promise<Awaited<ReturnType<typeof parseWorkflowDefinitionFile>>> {
  return parseWorkflowDefinitionFile(text, TARGET);
}

/** The exported file's own top-level document, read by an independent reader. */
async function exportedDocument(
  body: WorkflowVersionBody = versionBody(),
): Promise<Record<string, unknown>> {
  const file = await serializeWorkflowDefinitionFile(body);
  return parse(file) as Record<string, unknown>;
}

/** The exported file with one top-level member added or replaced, re-serialized. */
async function exportedFileWith(members: Record<string, unknown>): Promise<string> {
  return stringify({ ...(await exportedDocument()), ...members });
}

describe("the definition file form — what a serialized body reads back as", () => {
  it("round-trips the name, the entry and every phase member", async () => {
    // THE PIN FOR THE MEMBERS THAT USED TO VANISH. `toolBindings` and `config` were
    // written by the exporter and dropped by the reader, so an imported definition
    // reached the daemon with different executable bytes and a different content hash
    // while reporting a successful round trip.
    const body = versionBody();
    const reading = await parseOrFail(await serializeWorkflowDefinitionFile(body));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(reading.body.name).toBe(body.name);
    expect(reading.body.entry).toStrictEqual(body.entry);
    expect(reading.body.phaseDefinitions).toStrictEqual(body.phaseDefinitions);
  });

  it("takes the scope from the caller and never from the file", async () => {
    const reading = await parseOrFail(await serializeWorkflowDefinitionFile(versionBody()));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(reading.body.scope).toBe(TARGET.scope);
    expect(reading.body.scopeRef).toBe(TARGET.scopeRef);
    expect(reading.body.sessionId).toBe(TARGET.sessionId);
  });

  it("sends neither the marker nor any provenance, which the request has no member for", async () => {
    const reading = await parseOrFail(await serializeWorkflowDefinitionFile(versionBody()));

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
  it("writes the marker quoted, so it reads back as a string and not as a number", async () => {
    const file = await serializeWorkflowDefinitionFile(versionBody());

    expect(file).toContain('ai-sidekicks-schema: "1.0"');
    expect((await exportedDocument())["ai-sidekicks-schema"]).toBe("1.0");
  });

  it("writes the marker and the two parts, and nothing else at the top level", async () => {
    // The pin for the section that used to be there. A `exportedFrom` block made every
    // file this console wrote a refusal in a conforming CLI, because the registered form
    // has exactly the hashed body plus an optional `layout`.
    expect(Object.keys(await exportedDocument())).toStrictEqual([
      "ai-sidekicks-schema",
      "name",
      "entry",
      "phaseDefinitions",
    ]);
  });

  it("writes block YAML rather than JSON, at two-space indentation", async () => {
    const file = await serializeWorkflowDefinitionFile(versionBody());

    expect(file).toContain("\nname: Release checks\n");
    expect(file).toContain("\nentry:\n  startMode: manual\n");
    expect(file).toContain("\n  - phaseId: phase-draft\n");
    expect(file.endsWith("\n")).toBe(true);
  });
});

describe("the definition file form — what it reads, and what it refuses", () => {
  it("reads a file written as ordinary block mappings, block scalars included", async () => {
    // The pin for the primary producer. A CLI or SDK writes YAML, and the reader that
    // called `JSON.parse` refused every such file before it validated anything.
    const reading = await parseOrFail(
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

  it("reads the JSON spelling too, because JSON is YAML", async () => {
    const document = await exportedDocument();

    expect((await parseOrFail(JSON.stringify(document, undefined, 2))).status).toBe("parsed");
  });

  it("reads an unquoted marker off the node, so `1.0` does not collapse to `1`", async () => {
    const reading = await parseOrFail(
      ["ai-sidekicks-schema: 1.0", ...blockPhaseLines("Nightly checks")].join("\n"),
    );

    expect(reading.status).toBe("parsed");
  });

  it("refuses a marker whose shape no store could have held", async () => {
    const reading = await parseOrFail(
      await serializeWorkflowDefinitionFile(
        versionBody({ schemaVersion: "ai-sidekicks.workflow/v1" }),
      ),
    );

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("ai-sidekicks.workflow/v1");
  });

  it("accepts a marker value it has never seen, because no value is registered", async () => {
    // The claim, stated positively: the SHAPE is what a store can hold, and comparing
    // against a constant would reject the daemon's own files the day it revised one.
    expect(
      (
        await parseOrFail(
          await serializeWorkflowDefinitionFile(versionBody({ schemaVersion: "2.7" })),
        )
      ).status,
    ).toBe("parsed");
  });

  it("refuses a document carrying the response field's name instead of the marker", async () => {
    const { "ai-sidekicks-schema": marker, ...withoutMarker } = await exportedDocument();
    const reading = await parseOrFail(stringify({ schemaVersion: marker, ...withoutMarker }));

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("ai-sidekicks-schema");
  });

  it("refuses an unknown top-level key by name", async () => {
    const reading = await parseOrFail(
      await exportedFileWith({
        exportedFrom: { definitionId: "019b7a10-0280-7c11-8100-def111150001" },
      }),
    );

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("exportedFrom");
  });

  it("accepts the optional layout section and carries none of it into the request", async () => {
    const reading = await parseOrFail(
      await exportedFileWith({ layout: { "phase-draft": { x: 40, y: 120 } } }),
    );

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(Object.keys(reading.body)).not.toContain("layout");
  });

  it("refuses a supplied start mode the engine cannot honour, rather than defaulting it", async () => {
    // End to end, because the defect was end to end: the reader dropped an entry it did
    // not recognise, the create request then carried none, and the daemon materialized
    // `manual` — so a definition meant to fire on a schedule imported as one that runs
    // when somebody presses a button, and every layer reported success.
    const reading = await parseOrFail(await exportedFileWith({ entry: { startMode: "schedule" } }));

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("schedule");
  });

  it("carries no entry where the file states none, which is the daemon's to materialize", async () => {
    const { entry, ...withoutEntry } = await exportedDocument();
    const reading = await parseOrFail(stringify(withoutEntry));

    expect(entry).toStrictEqual({ startMode: "manual" });
    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(Object.keys(reading.body)).not.toContain("entry");
  });

  it("refuses text that is not a YAML document at all, in its own words", async () => {
    const reading = await parseOrFail("name: [unterminated\n");

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("not YAML that can be read");
  });

  it("refuses a stream of more than one document", async () => {
    const reading = await parseOrFail(
      `${await serializeWorkflowDefinitionFile(versionBody())}---\nname: second\n`,
    );

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("more than one YAML document");
  });

  it("refuses a repeated key rather than taking the last one silently", async () => {
    const reading = await parseOrFail(
      `${await serializeWorkflowDefinitionFile(versionBody())}name: Something else\n`,
    );

    expect(reading.status).toBe("invalid");
  });

  it("refuses a document that is not a map of named sections", async () => {
    expect((await parseOrFail("- one\n- two\n")).status).toBe("invalid");
    expect((await parseOrFail("")).status).toBe("invalid");
  });

  it("negative control: every perturbation above starts from a file that parses", async () => {
    // Without this, each refusal case would hold over a parser that refused
    // everything — the right answer for all of them, arrived at from a reader that
    // never accepts anything at all.
    expect((await parseOrFail(await serializeWorkflowDefinitionFile(versionBody()))).status).toBe(
      "parsed",
    );
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
