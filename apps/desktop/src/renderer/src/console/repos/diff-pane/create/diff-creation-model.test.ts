// What holds the create control, in the order the reading is asked about it.
//
// THE ORDER IS THE CLAIM. A create already in flight is reported ahead of an unresolved
// attribution, because a person who has just pressed is asking about the press; and the
// attribution is reported ahead of the empty fields, because naming two refs would not
// make an unattributable subject sendable. Each case below fixes one of those steps by
// holding a LATER one wrong at the same time.

import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import {
  DIFF_CREATE_REFUSAL_CODES,
  DIFF_CREATE_REFUSAL_ORIGIN,
  diffCreateStanding,
  patchUnparsableDetail,
  payloadNotAPatchDetail,
  type DiffCreationReading,
} from "./diff-creation-model.js";

const NAMED = { baseRef: "origin/develop", headRef: "feat/thing" };
const UNNAMED = { baseRef: "", headRef: "" };
const RESOLVED = { attributionMode: "workspace_fallback", workspaceId: "w-1" } as const;
const REFUSAL = refuse(DIFF_CREATE_REFUSAL_ORIGIN, "subject-unresolved", "nothing to attribute to");

function reading(
  prerequisite: DiffCreationReading["prerequisite"],
  act: DiffCreationReading["act"] = { status: "idle" },
): DiffCreationReading {
  return { prerequisite, act };
}

describe("diffCreateStanding — what holds the control, and in which order", () => {
  it("is sendable once the attribution is read and both states are named", () => {
    expect(diffCreateStanding(reading({ status: "read", value: RESOLVED }), NAMED)).toStrictEqual({
      status: "sendable",
    });
  });

  it("reports the create in flight ahead of everything else", () => {
    // The fields are empty too, and the press is still what the person is asking about.
    const standing = diffCreateStanding(
      reading({ status: "read", value: RESOLVED }, { status: "sending" }),
      UNNAMED,
    );
    expect(standing.status === "held" && standing.because).toBe("A diff is being minted.");
  });

  it("reports the attribution ahead of the empty fields", () => {
    // Naming two refs would not make an unattributable subject sendable.
    const unresolved = diffCreateStanding(reading({ status: "refused", refusal: REFUSAL }), NAMED);
    expect(unresolved.status).toBe("held");
    const reading_ = diffCreateStanding(reading({ status: "reading" }), UNNAMED);
    expect(reading_.status === "held" && reading_.because).toBe(
      "Resolving what this diff would be attributed to.",
    );
  });

  it("negative control: a resolved subject with nothing typed is still held", () => {
    const standing = diffCreateStanding(reading({ status: "read", value: RESOLVED }), UNNAMED);
    expect(standing.status === "held" && standing.because).toBe(
      "Name both compared states — a diff is taken between two of them.",
    );
  });

  it("holds an unasked question, so the control is never live before the read", () => {
    expect(diffCreateStanding(reading({ status: "not-read" }), NAMED).status).toBe("held");
  });
});

describe("the sentences a served-but-unusable payload renders as", () => {
  it("names the handle case without calling it a failure", () => {
    const detail = payloadNotAPatchDetail({ status: "deferred", payloadHandle: "sha256:abc" });
    expect(detail).toContain("fetch handle");
    expect(detail).not.toContain("failed");
  });

  it("tells the two opaque reasons apart in the words a person reads", () => {
    const notText = payloadNotAPatchDetail({
      status: "opaque",
      encoding: "base64",
      reason: "not-utf8",
    });
    const undecodable = payloadNotAPatchDetail({
      status: "opaque",
      encoding: "base64",
      reason: "undecodable",
    });
    expect(notText).not.toBe(undecodable);
    expect(undecodable).toContain("would not decode");
  });

  it("names the figure and the bound on the over-cap arm", () => {
    const detail = payloadNotAPatchDetail({ status: "over-cap", characterCount: 9_000_000 });
    expect(detail).toContain("9000000");
  });
});

describe("the unparsable-patch sentence", () => {
  it("negative control: it carries the artifact id and never the parser's own message", () => {
    // A rejection off a parse can carry the patch text that caused it, which is
    // repository content, so the handle is what a person takes to the diagnostic band.
    const detail = patchUnparsableDetail("artifact-77");
    expect(detail).toContain("artifact-77");
    expect(detail.toLowerCase()).not.toContain("hunk");
  });
});

describe("the vocabulary this surface mints", () => {
  it("declares its codes exactly once, with no count written in prose", () => {
    expect(new Set(DIFF_CREATE_REFUSAL_CODES).size).toBe(DIFF_CREATE_REFUSAL_CODES.length);
    expect(DIFF_CREATE_REFUSAL_CODES).toContain("patch-unparsable");
  });
});
