// The four ingest refusals this family answers for, and what each answer has to carry.
//
// Each case asserts the ONE fact the daemon's own sentence leaves out — the third
// enforcement point, the survivors, the quarantine, the content-versus-type verdict —
// because a table that merely had four entries would satisfy a length assertion while
// saying nothing a participant could act on.

import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_REFUSAL_COPY_CODES,
  TOO_LARGE_CODE,
  TOO_MANY_ATTACHMENTS_CODE,
  attachmentRefusalCopyFor,
} from "./attachment-refusal-copy.js";
import { INGEST_CAPACITY_EXHAUSTED_CODE, INGEST_STREAM_INVALID_CODE } from "./attachment-policy.js";

describe("attachment refusal copy — the codes answered", () => {
  it("answers for exactly the four whose meaning the code alone does not carry", () => {
    expect([...ATTACHMENT_REFUSAL_COPY_CODES].sort()).toStrictEqual([
      "artifact.scanner_rejected",
      "artifact.too_large",
      "artifact.too_many_attachments",
      "artifact.unsupported_media_type",
    ]);
  });

  it("leaves the two disposition-bearing codes to the policy module", () => {
    // Splitting these across two tables is how a code's classification and its
    // explanation come to disagree: `attachment-policy.ts` already answers both,
    // and for those two the meaning IS the disposition.
    expect(attachmentRefusalCopyFor(INGEST_STREAM_INVALID_CODE)).toBeUndefined();
    expect(attachmentRefusalCopyFor(INGEST_CAPACITY_EXHAUSTED_CODE)).toBeUndefined();
  });

  it("negative control: a code shaped like the others answers with nothing", () => {
    // Without this the lookup could return a default entry and every assertion below
    // would pass over copy that was never written.
    expect(attachmentRefusalCopyFor("artifact.invented_code")).toBeUndefined();
  });
});

describe("attachment refusal copy — what each entry has to say", () => {
  it("names the third enforcement point on the size refusal", () => {
    // The frame and the deployment bound are the two a participant expects. The
    // declaration-as-reservation is the one that refuses a chunk far below the cap,
    // and it is the whole reason this entry exists.
    const copy = attachmentRefusalCopyFor(TOO_LARGE_CODE);
    expect(copy?.meaning).toContain("transport frame");
    expect(copy?.meaning).toContain("declared");
    expect(copy?.meaning).toContain("reserved the spool");
  });

  it("names the survivors on the count refusal", () => {
    const copy = attachmentRefusalCopyFor(TOO_MANY_ATTACHMENTS_CODE);
    expect(copy?.meaning).toContain("whole carrier");
    expect(copy?.meaning).toContain("untouched");
    expect(copy?.nextMove).toContain("Nothing has to be uploaded a second time.");
  });

  it("names the quarantine and the re-typing that never happens", () => {
    const copy = attachmentRefusalCopyFor("artifact.unsupported_media_type");
    expect(copy?.meaning).toContain("quarantined");
    expect(copy?.meaning).toContain("never silently re-typed");
  });

  it("keeps the scanner's verdict distinct from a media-type problem", () => {
    const copy = attachmentRefusalCopyFor("artifact.scanner_rejected");
    expect(copy?.meaning).toContain("content verdict");
    expect(copy?.meaning).toContain("allow-listed");
    expect(copy?.meaning).toContain("runs no scanner");
  });
});
