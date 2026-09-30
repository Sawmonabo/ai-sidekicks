// One served payload reply read as the arm the pane draws, with no bridge and no reader.
//
// The decode itself is the contract's and is tested there. What is tested here is which
// arm a served answer lands on: a handle is not bytes, bytes that are not text are named
// rather than drawn, and text arrives whole however long it is.

import { describe, expect, it } from "vitest";

import type { ArtifactId, ArtifactReadResponse } from "@ai-sidekicks/contracts";
import { artifactPayloadReadingFrom } from "./artifact-payload.js";

describe("artifact payload reading — the served union has two arms and each splits", () => {
  const ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2201" as ArtifactId;
  const FACTS = {
    manifest: {
      id: ARTIFACT_ID,
      sessionId: "session-1",
      artifactType: "diff",
      digest: "sha256:2b4c",
      size: 22,
      annotations: {},
      state: "published",
      metadata: {},
      createdAt: "2026-09-02T07:00:00.000Z",
    },
    versionNumber: 1,
    versionCount: 1,
    versionWrittenAt: "2026-09-02T07:00:00.000Z",
  } as unknown as Pick<
    ArtifactReadResponse,
    "manifest" | "versionNumber" | "versionCount" | "versionWrittenAt"
  >;

  it("reads a handle-only reply as the deferred arm, carrying the handle", () => {
    expect(
      artifactPayloadReadingFrom(ARTIFACT_ID, { ...FACTS, payloadHandle: "sha256:2b4c" }),
    ).toStrictEqual({ status: "deferred", artifactId: ARTIFACT_ID, payloadHandle: "sha256:2b4c" });
  });

  it("reads base64 bytes as the whole text, however long, with the encoding beside it", () => {
    const long = "diff --git a/one b/one\n".repeat(2_000);
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      ...FACTS,
      payload: btoa(long),
      payloadEncoding: "base64",
    });
    expect(reading).toStrictEqual({
      status: "text",
      artifactId: ARTIFACT_ID,
      encoding: "base64",
      text: long,
    });
  });

  it("reports bytes that are not UTF-8 as opaque, with the reason, rather than as text", () => {
    const reading = artifactPayloadReadingFrom(ARTIFACT_ID, {
      ...FACTS,
      payload: "/w==",
      payloadEncoding: "base64",
    });
    expect(reading).toStrictEqual({
      status: "opaque",
      artifactId: ARTIFACT_ID,
      encoding: "base64",
      reason: "not-utf8",
    });
  });
});
