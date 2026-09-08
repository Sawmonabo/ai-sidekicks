// What the attachment carrier is composed from: the artifact members a phase's schema
// declares, read out of the answer somebody composed.
//
// Every case drives a real schema through the real walk, because the claim under test is
// about what the SCHEMA declares and in what order — a plan or a path list written by
// hand here would assert this walk against an order this test chose. Two of the cases
// carry a schema the mapper cannot draw at all, which is where the plan-shaped reading
// this replaced went silent.

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

  it("carries an artifact answered as JSON beside a member the mapper could not draw", () => {
    // The whole-plan raw fallback: one member sends the WHOLE form to the editor — here
    // an object nested two levels deep — and the artifact member beside it is still
    // declared, still answerable, and still an attachment. A walk over the drawn plan
    // sees no entries at all for this schema and hands back an empty carrier, so the id
    // travels as an ordinary string in `fields` and the daemon never resolves it.
    const ids = attachmentArtifactIdsIn(
      objectSchema({
        design: ARTIFACT_MEMBER,
        release: {
          type: "object",
          properties: { window: { type: "object", properties: { opensAt: { type: "string" } } } },
        },
      }),
      { design: "artifact-typed-into-json", release: { window: { opensAt: "2026-01-01" } } },
    );

    expect(ids).toEqual(["artifact-typed-into-json"]);
  });

  it("reads an artifact declared under a repeated object, entry by entry", () => {
    // The shape a path-shaped discovery cannot address: the position an artifact answer
    // sits at exists only in the answer, so the declaration and the value are read
    // together. Nothing the mapper draws reaches here either — an array of objects is
    // outside the render set — which is why this case exists at all.
    const ids = attachmentArtifactIdsIn(
      objectSchema({
        exhibits: {
          type: "array",
          items: {
            type: "object",
            properties: { caption: { type: "string" }, file: ARTIFACT_MEMBER },
          },
        },
      }),
      {
        exhibits: [
          { caption: "before", file: "artifact-before" },
          { caption: "after", file: "artifact-after" },
        ],
      },
    );

    expect(ids).toEqual(["artifact-before", "artifact-after"]);
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
