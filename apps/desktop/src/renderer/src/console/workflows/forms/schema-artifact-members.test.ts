// What the attachment carrier is composed from: the artifact members a phase's schema
// declares, read out of the answer somebody composed.
//
// Every case goes through the real mapper rather than a hand-built plan, because the
// claim under test is about the SCHEMA's declared order — a plan written by hand here
// would assert this walk against an order this test chose.

import { describe, expect, it } from "vitest";

import { attachmentArtifactIdsIn } from "./schema-artifact-members.js";

/** One object schema over the given members, in the order they are written. */
function objectSchema(
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { type: "object", properties };
}

/** An artifact-reference member, which is a string carrying the corpus's own format. */
const ARTIFACT_MEMBER = { type: "string", format: "artifact" } as const;

describe("the attachment carrier's artifact members", () => {
  it("yields answered artifact members in the order the schema declares them", () => {
    const ids = attachmentArtifactIdsIn(
      objectSchema({
        design: ARTIFACT_MEMBER,
        summary: { type: "string" },
        evidence: ARTIFACT_MEMBER,
      }),
      // Written in the opposite order to the schema, so a walk over the ANSWER's keys
      // would come back reversed and this case would fail.
      { evidence: "artifact-evidence", summary: "looks fine", design: "artifact-design" },
    );

    expect(ids).toEqual(["artifact-design", "artifact-evidence"]);
  });

  it("contributes nothing for an artifact member nobody answered", () => {
    const ids = attachmentArtifactIdsIn(
      objectSchema({ design: ARTIFACT_MEMBER, evidence: ARTIFACT_MEMBER }),
      // Cleared and never touched: the text controls write the empty string for the
      // first, and the second is simply absent.
      { design: "" },
    );

    expect(ids).toEqual([]);
  });

  it("reads a group's artifact members at their own paths, after the members above them", () => {
    const ids = attachmentArtifactIdsIn(
      objectSchema({
        cover: ARTIFACT_MEMBER,
        release: {
          type: "object",
          properties: { notes: { type: "string" }, signoff: ARTIFACT_MEMBER },
        },
      }),
      { cover: "artifact-cover", release: { notes: "shipped", signoff: "artifact-signoff" } },
    );

    expect(ids).toEqual(["artifact-cover", "artifact-signoff"]);
  });

  it("yields every entry of a repeated artifact control, in the order the list holds them", () => {
    const ids = attachmentArtifactIdsIn(
      objectSchema({ attachments: { type: "array", items: ARTIFACT_MEMBER } }),
      { attachments: ["artifact-one", "", "artifact-two"] },
    );

    expect(ids).toEqual(["artifact-one", "artifact-two"]);
  });

  it("reads a raw document at the artifact members' own paths", () => {
    // The arm on screen is the form's; the artifact members are the schema's. A schema
    // whose members are all drawable but which nothing could compile is answered in the
    // raw editor, and its attachments still have to reach the carrier.
    const ids = attachmentArtifactIdsIn(objectSchema({ design: ARTIFACT_MEMBER }), {
      design: "artifact-typed-by-hand",
    });

    expect(ids).toEqual(["artifact-typed-by-hand"]);
  });

  it("names no artifact member for a schema the mapper could not map at all", () => {
    expect(attachmentArtifactIdsIn({ type: "string" }, { anything: "artifact-9" })).toEqual([]);
    expect(attachmentArtifactIdsIn(undefined, { design: "artifact-9" })).toEqual([]);
  });

  it("carries a member twice where two questions named one artifact", () => {
    const ids = attachmentArtifactIdsIn(
      objectSchema({ before: ARTIFACT_MEMBER, after: ARTIFACT_MEMBER }),
      { before: "artifact-same", after: "artifact-same" },
    );

    expect(ids).toEqual(["artifact-same", "artifact-same"]);
  });
});
