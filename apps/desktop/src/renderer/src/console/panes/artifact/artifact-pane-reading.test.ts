// The reductions one reading makes on the next, driven with no bridge and no clock.
//
// Each case is about a claim the pane would otherwise make falsely: that a read
// answered for a row it did not name, that a row the list never carried belongs to the
// session, or that a refusal still stands after the act it refused was answered.

import { describe, expect, it } from "vitest";

import type { GrowthArtifactRead } from "../../bridge/index.js";
import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP, refuse } from "../../core/index.js";
import type { ArtifactManifestRow, ArtifactsPanelState } from "../../repos/artifact-model.js";
import {
  NOTHING_READ_YET,
  artifactPayloadReadingFrom,
  readFailureRefusal,
  withReplacedRow,
  withRowRefusal,
  withoutRow,
  withoutRowRefusal,
} from "./artifact-pane-reading.js";

function row(id: string, state: ArtifactManifestRow["state"]): ArtifactManifestRow {
  return {
    id,
    sessionId: "session-1",
    artifactType: "diff",
    digest: "sha256:2b4c",
    size: 4096,
    annotations: {},
    visibility: "shared",
    state,
    metadata: {},
    createdAt: "2026-09-02T07:00:00.000Z",
  };
}

const REFUSAL = refuse("growth-port", "wire-unregistered", "Not checked.");

describe("artifact pane reading — replacing a row from its own read", () => {
  it("replaces the row the read named and leaves its neighbours alone", () => {
    const listed: ArtifactsPanelState = {
      kind: "listed",
      rows: [row("first", "published"), row("second", "published")],
    };
    const next = withReplacedRow(listed, row("second", "superseded"));
    expect(next.kind === "listed" ? next.rows.map((each) => each.state) : []).toStrictEqual([
      "published",
      "superseded",
    ]);
  });

  it("negative control: a row the list does not carry is not added to it", () => {
    // Without this, a single-artifact read would be able to claim a session
    // membership that no list read established.
    const listed: ArtifactsPanelState = { kind: "listed", rows: [row("first", "published")] };
    const next = withReplacedRow(listed, row("elsewhere", "published"));
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual(["first"]);
  });

  it("leaves an arm that holds no rows exactly as it found it", () => {
    expect(withReplacedRow({ kind: "not-checked" }, row("first", "published"))).toStrictEqual({
      kind: "not-checked",
    });
  });
});

describe("artifact pane reading — what a row's last act answered", () => {
  it("records a refusal against the row it was about", () => {
    const recorded = withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL);
    expect(recorded.get("first")).toStrictEqual(REFUSAL);
    expect(NOTHING_READ_YET.refusalByArtifactId.size).toBe(0);
  });

  it("clears the refusal once an act answered for that row", () => {
    const recorded = withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL);
    expect(withoutRowRefusal(recorded, "first").has("first")).toBe(false);
  });

  it("negative control: clearing one row's refusal leaves another's standing", () => {
    const both = withRowRefusal(
      withRowRefusal(NOTHING_READ_YET.refusalByArtifactId, "first", REFUSAL),
      "second",
      REFUSAL,
    );
    const remaining = withoutRowRefusal(both, "first");
    expect(remaining.has("first")).toBe(false);
    expect(remaining.has("second")).toBe(true);
  });
});

describe("artifact pane reading — a read that threw", () => {
  it("carries the failure's own sentence and names this reader as its origin", () => {
    const refusal = readFailureRefusal(new Error("the socket closed"));
    expect(refusal.code).toBe("read-threw");
    expect(refusal.origin).toBe("artifact-pane-reader");
    expect(refusal.detail).toContain("the socket closed");
  });

  it("negative control: a thrown non-error is not rendered as its own text", () => {
    // A thrown value can be anything, including participant content. The sentence
    // says a value was thrown; it never puts the value on screen.
    const refusal = readFailureRefusal({ secret: "do not render me" });
    expect(refusal.detail).not.toContain("do not render me");
    expect(refusal.detail).toContain("not an error");
  });
});

describe("artifact pane reading — removing a row a delete answered for", () => {
  it("drops the row the delete named and keeps the rest", () => {
    const listed: ArtifactsPanelState = {
      kind: "listed",
      rows: [row("first", "published"), row("second", "published")],
    };
    const next = withoutRow(listed, "first");
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual([
      "second",
    ]);
  });

  it("negative control: a delete for a row not on the list removes nothing", () => {
    const listed: ArtifactsPanelState = { kind: "listed", rows: [row("first", "published")] };
    const next = withoutRow(listed, "elsewhere");
    expect(next.kind === "listed" ? next.rows.map((each) => each.id) : []).toStrictEqual(["first"]);
  });

  it("leaves an arm that holds no rows exactly as it found it", () => {
    expect(withoutRow({ kind: "loading" }, "first")).toStrictEqual({ kind: "loading" });
  });
});

describe("artifact payload reading — the served union has two arms and each splits", () => {
  const ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2201";
  const MANIFEST = {
    artifactId: ARTIFACT_ID,
    sessionId: "session-1",
    artifactType: "diff",
    digest: "sha256:2b4c",
    size: 22,
    annotations: {},
    visibility: "shared",
    state: "published",
    metadata: {},
    createdAt: "2026-09-02T07:00:00.000Z",
  } as unknown as GrowthArtifactRead["manifest"];

  it("reads a handle-only reply as the deferred arm, carrying the handle", () => {
    expect(
      artifactPayloadReadingFrom(ARTIFACT_ID, {
        manifest: MANIFEST,
        payloadHandle: "sha256:2b4c",
      }),
    ).toStrictEqual({ status: "deferred", artifactId: ARTIFACT_ID, payloadHandle: "sha256:2b4c" });
  });

  it("decodes base64 bytes by the encoding the reply declared, never by sniffing", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==",
      payloadEncoding: "base64",
    });
    expect(reading).toStrictEqual({
      status: "text",
      artifactId: ARTIFACT_ID,
      encoding: "base64",
      text: "diff --git a/one b/one",
      truncated: false,
    });
  });

  it("takes a utf8 payload as it stands", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "already text",
      payloadEncoding: "utf8",
    });
    expect(reading.status === "text" ? reading.text : "").toBe("already text");
  });

  it("bounds the preview and says it did", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "x".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP + 1),
      payloadEncoding: "utf8",
    });
    expect(reading.status === "text" ? reading.text.length : 0).toBe(
      ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
    );
    expect(reading.status === "text" ? reading.truncated : false).toBe(true);
  });

  it("names bytes that are not text rather than decoding them into question marks", () => {
    // `0xFF 0xFF` is not valid UTF-8. A lenient decoder answers with replacement
    // characters, which a preview would draw as though they were the payload.
    expect(
      artifactPayloadReadingFrom(ARTIFACT_ID, {
        manifest: MANIFEST,
        payload: "//8=",
        payloadEncoding: "base64",
      }),
    ).toStrictEqual({
      status: "opaque",
      artifactId: ARTIFACT_ID,
      encoding: "base64",
      reason: "not-utf8",
    });
  });

  it("names an undecodable base64 payload as its own reason", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "not base64 at all!!",
      payloadEncoding: "base64",
    });
    expect(reading.status === "opaque" ? reading.reason : "").toBe("undecodable");
  });

  it("negative control: nothing about the arm is inferred from the bytes", () => {
    // The same bytes on the two encodings are two different readings, which is what
    // makes `payloadEncoding` load-bearing rather than a hint.
    const asBase64 = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "ZGlmZg==",
      payloadEncoding: "base64",
    });
    const asUtf8 = artifactPayloadReadingFrom(ARTIFACT_ID, {
      manifest: MANIFEST,
      payload: "ZGlmZg==",
      payloadEncoding: "utf8",
    });
    expect(asBase64.status === "text" ? asBase64.text : "").toBe("diff");
    expect(asUtf8.status === "text" ? asUtf8.text : "").toBe("ZGlmZg==");
  });
});
