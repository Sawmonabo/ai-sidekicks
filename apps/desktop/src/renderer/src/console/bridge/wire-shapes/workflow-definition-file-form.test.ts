// The file form, checked on the five claims its module makes.
//
//   1. A file this console wrote is a file this console reads. One module owns both
//      sides precisely so the round trip holds, and a test that only parsed hand-typed
//      JSON would never notice the two drifting.
//   2. The marker is required and never compared. A file with none is refused; a file
//      whose marker is a string nobody registered is accepted, because no corpus
//      document registers one and enforcing a constant would reject the daemon's own
//      files the day it revised its.
//   3. The marker is not SENT. It is a property of the file, and the create request
//      carries no member for it.
//   4. Every closed member is checked against the tuple that declares it, so a phase
//      whose gate is a word nobody registered is refused rather than submitted.
//   5. The target is the caller's. A file names no scope, so the parse takes the one it
//      was handed and never one the bytes proposed — which is the decision the daemon's
//      operator-scope authorization is keyed on.

import { describe, expect, it } from "vitest";

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

/** One served body, with only what a case varies overridden. */
function versionBody(overrides: Partial<WorkflowVersionBody> = {}): WorkflowVersionBody {
  return {
    definitionId: "019b7a10-0280-7c11-8100-def111150001",
    versionNumber: 4,
    workflowVersionId: "019b7a10-0280-7d22-8100-be5100150004",
    contentHash: "b3:0f3c9a1d7e5b42c8a06d1f93be27540ac1d8e6b3927fa04c5de81b6203794acd",
    schemaVersion: "ai-sidekicks.workflow/v1",
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
function parseOrFail(text: string): ReturnType<typeof parseWorkflowDefinitionFile> {
  return parseWorkflowDefinitionFile(text, TARGET);
}

describe("the definition file form — what a serialized body reads back as", () => {
  it("round-trips the name, the entry and every phase", () => {
    const body = versionBody();
    const reading = parseOrFail(serializeWorkflowDefinitionFile(body));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(reading.body.name).toBe(body.name);
    expect(reading.body.entry).toStrictEqual(body.entry);
    expect(reading.body.phaseDefinitions).toStrictEqual(body.phaseDefinitions);
  });

  it("takes the scope from the caller and never from the file", () => {
    // The file the serializer wrote states no scope at all, and a parser that invented
    // one out of the provenance block would let bytes that travelled between machines
    // decide where they land — which is what the daemon's operator-scope authorization
    // is keyed on.
    const reading = parseOrFail(serializeWorkflowDefinitionFile(versionBody()));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(reading.body.scope).toBe(TARGET.scope);
    expect(reading.body.scopeRef).toBe(TARGET.scopeRef);
    expect(reading.body.sessionId).toBe(TARGET.sessionId);
  });

  it("sends no schema marker, because the create request carries no member for one", () => {
    const reading = parseOrFail(serializeWorkflowDefinitionFile(versionBody()));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(Object.keys(reading.body)).not.toContain("schemaVersion");
  });

  it("carries no content hash back, because a hash is the daemon's answer", () => {
    // The exported file records which version it came from, and none of that provenance
    // may ride the request: a caller claiming a content hash would be claiming an answer
    // only the daemon can compute.
    const reading = parseOrFail(serializeWorkflowDefinitionFile(versionBody()));

    expect(reading.status).toBe("parsed");
    if (reading.status !== "parsed") {
      return;
    }
    expect(Object.keys(reading.body)).not.toContain("contentHash");
    expect(Object.keys(reading.body)).not.toContain("workflowVersionId");
  });
});

describe("the definition file form — what it refuses, and what it deliberately does not", () => {
  it("refuses text that is not JSON at all, in its own words", () => {
    const reading = parseOrFail("not a file");

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("not JSON");
  });

  it("refuses a JSON object carrying no schema marker", () => {
    const reading = parseOrFail(JSON.stringify({ name: "Release checks", phaseDefinitions: [] }));

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("schemaVersion");
  });

  it("accepts a marker it has never seen, because no value is registered anywhere", () => {
    // The claim, stated positively: presence tells a definition file from the other
    // JSON a person might paste, and a parser comparing against a constant would reject
    // the daemon's own files the first time it revised the marker.
    const file = JSON.parse(serializeWorkflowDefinitionFile(versionBody())) as Record<
      string,
      unknown
    >;
    file["schemaVersion"] = "some.other.publisher/v9";

    expect(parseOrFail(JSON.stringify(file)).status).toBe("parsed");
  });

  it("refuses a phase whose gate is a word the vocabulary does not declare", () => {
    const file = JSON.parse(serializeWorkflowDefinitionFile(versionBody())) as Record<
      string,
      unknown
    >;
    file["phaseDefinitions"] = [
      {
        phaseId: "phase-draft",
        name: "Draft",
        type: "single-agent",
        gateType: "rubber-stamp",
        failureBehavior: "retry",
      },
    ];
    const reading = parseOrFail(JSON.stringify(file));

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("Phase 1");
  });

  it("refuses a file with no phases, which is a definition that runs nothing", () => {
    const file = JSON.parse(serializeWorkflowDefinitionFile(versionBody())) as Record<
      string,
      unknown
    >;
    file["phaseDefinitions"] = [];

    expect(parseOrFail(JSON.stringify(file)).status).toBe("invalid");
  });

  it("negative control: every perturbation above starts from a file that parses", () => {
    // Without this, each refusal case would hold over a parser that refused
    // everything — the right answer for all six, arrived at from a reader that never
    // accepts anything at all.
    expect(parseOrFail(serializeWorkflowDefinitionFile(versionBody())).status).toBe("parsed");
  });

  it("negative control: the phase reader is consulted, so two bad phases differ by index", () => {
    // Without this, the gate case would pass over a reader that returned one constant
    // sentence whatever it was handed.
    const file = JSON.parse(serializeWorkflowDefinitionFile(versionBody())) as Record<
      string,
      unknown
    >;
    file["phaseDefinitions"] = [
      {
        phaseId: "phase-draft",
        name: "Draft",
        type: "single-agent",
        gateType: "auto-continue",
        failureBehavior: "retry",
      },
      { phaseId: "phase-review", name: "Review", type: "human", gateType: "rubber-stamp" },
    ];
    const reading = parseOrFail(JSON.stringify(file));

    expect(reading.status).toBe("invalid");
    if (reading.status !== "invalid") {
      return;
    }
    expect(reading.reason).toContain("Phase 2");
  });
});
