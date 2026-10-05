// A payload too large for one message is read window by window at one version, and the windows
// are joined as bytes, so a character split across two windows reads back whole.

import { describe, expect, it } from "vitest";

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts/artifacts/ingest";
import type {
  ArtifactReadRequest,
  ArtifactReadResponse,
} from "@ai-sidekicks/contracts/artifacts/operations";

import { SERVED_SUMMARY, SERVED_VERSION } from "#test/helpers/artifact-list-readers.js";
import type { DaemonReply } from "#renderer/services/daemon/daemon-reply.js";
import { readArtifactPayload } from "./artifact-payload-read.js";

const ARTIFACT_ID = SERVED_SUMMARY.id;

// A four-byte character starting two bytes before the first window ends, so each window holds
// half of it.
const SPLIT_TEXT = `${"a".repeat(ARTIFACT_CHUNK_MAX_BYTES - 2)}😀b`;

describe("reading an artifact's payload window by window", () => {
  it("joins the windows as bytes, at the version the first reply named", async () => {
    const requests: ArtifactReadRequest[] = [];
    const read = await readArtifactPayload(
      windowedRead(new TextEncoder().encode(SPLIT_TEXT), requests),
      ARTIFACT_ID,
    );

    expect(read.status === "served" ? read.value.content : read).toStrictEqual({
      status: "text",
      text: SPLIT_TEXT,
    });
    expect(requests.map((request) => request.range)).toStrictEqual([
      undefined,
      { offset: 0, length: ARTIFACT_CHUNK_MAX_BYTES },
      { offset: ARTIFACT_CHUNK_MAX_BYTES, length: 3 },
    ]);
    expect(requests.slice(1).map((request) => request.version)).toStrictEqual([3, 3]);
  });

  it("refuses a window that comes back short rather than reading zeros in its place", async () => {
    const bytes = new TextEncoder().encode(SPLIT_TEXT);
    const read = await readArtifactPayload(windowedRead(bytes, [], 1), ARTIFACT_ID);

    expect(read.status === "refused" ? read.refusal.code : read).toBe(
      "artifacts.payload_unreadable",
    );
  });
});

/**
 * An `artifact.read` over `bytes` at version 3: the first reply hands back a key, each ranged
 * read answers its window in base64, short by `shortBy` bytes. Every request lands in `requests`.
 */
function windowedRead(
  bytes: Uint8Array,
  requests: ArtifactReadRequest[],
  shortBy = 0,
): (request: ArtifactReadRequest) => Promise<DaemonReply<ArtifactReadResponse>> {
  const facts = {
    manifest: { ...SERVED_SUMMARY, size: bytes.length },
    ...SERVED_VERSION,
    versionNumber: 3,
    versionCount: 3,
  };
  return async (request) => {
    requests.push(request);
    if (request.range === undefined) {
      return { status: "served", value: { ...facts, payloadHandle: "sha256:2b4c" } };
    }
    const { offset, length } = request.range;
    const window = bytes.subarray(offset, offset + length - shortBy);
    return {
      status: "served",
      value: { ...facts, payload: base64Of(window), payloadEncoding: "base64" },
    };
  };
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
