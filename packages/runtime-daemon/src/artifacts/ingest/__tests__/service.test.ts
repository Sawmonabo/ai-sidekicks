// A completed ingest writes the file's manifest and then its payload reference in one transaction,
// under a version 7 id, attributed to the calling device, recording the type read from the bytes
// and never the caller's declaration; the same bytes twice are stored once under two manifests;
// and a payload whose type cannot be read is refused for good and reaches neither the store nor
// the database.

import { afterEach, describe, expect, it } from "vitest";

import {
  CALLING_DEVICE_ID,
  contentHashOf,
  openIngestHarness,
  PNG_SIGNATURE,
  type IngestHarness,
} from "./service.test-support.js";

let harness: IngestHarness;

afterEach(async () => {
  await harness.close();
});

describe("a completed ingest", () => {
  it("writes the manifest and its payload reference, stamped with the calling device", async () => {
    harness = await openIngestHarness();
    const { ingestId } = await harness.init(
      PNG_SIGNATURE.length,
      "../../screens/shot\0.png.exe",
      "text/plain",
    );
    await harness.chunk(ingestId, 0, PNG_SIGNATURE);

    const response = await harness.complete(ingestId);

    const contentHash = contentHashOf(PNG_SIGNATURE);
    expect(response.artifactId.charAt(14)).toBe("7");
    expect(response).toStrictEqual({
      artifactId: response.artifactId,
      contentHash,
      normalizedName: "shot.png.exe",
      derivedMediaType: "image/png",
      derivedSizeBytes: PNG_SIGNATURE.length,
    });
    expect(harness.manifestRows()).toStrictEqual([
      {
        id: response.artifactId,
        session_id: harness.sessionId,
        created_by: CALLING_DEVICE_ID,
        artifact_type: "file",
        state: "published",
        content_hash: contentHash,
        size_bytes: PNG_SIGNATURE.length,
        metadata: JSON.stringify({ fileName: "shot.png.exe", mediaType: "image/png" }),
      },
    ]);
    expect(harness.payloadRefRows()).toStrictEqual([
      {
        manifest_id: response.artifactId,
        storage_path: contentHash,
        media_type: "image/png",
        size_bytes: PNG_SIGNATURE.length,
      },
    ]);
    // The stored path is the digest's, never the caller's name.
    const storedPayloads = await harness.storedPayloads();
    expect(storedPayloads).toHaveLength(1);
    expect(storedPayloads[0]).toMatch(/^sha256[/\\][0-9a-f]{2}[/\\][0-9a-f]{64}$/u);
  });

  it("stores the same bytes once, under two manifests each with its own reference", async () => {
    harness = await openIngestHarness();
    const bytes = new TextEncoder().encode("the same notes, twice");

    const first = await harness.ingest(bytes);
    const second = await harness.ingest(bytes);

    expect(second.artifactId).not.toBe(first.artifactId);
    expect(await harness.storedPayloads()).toHaveLength(1);
    expect(harness.manifestRows().map((row) => row.id)).toStrictEqual([
      first.artifactId,
      second.artifactId,
    ]);
    expect(harness.payloadRefRows()).toStrictEqual([
      expect.objectContaining({ manifest_id: first.artifactId, storage_path: first.contentHash }),
      expect.objectContaining({ manifest_id: second.artifactId, storage_path: first.contentHash }),
    ]);
  });
});

describe("a payload whose type cannot be read", () => {
  it("is refused for good, naming the file, and nothing of it is kept", async () => {
    harness = await openIngestHarness({
      detectMediaType: () => Promise.reject(new Error("the parser ran past its bound")),
    });
    const { ingestId } = await harness.init(PNG_SIGNATURE.length, "scan.pdf");
    await harness.chunk(ingestId, 0, PNG_SIGNATURE);

    // Never the restart code, which would send the same bytes into the same failure again.
    await expect(harness.complete(ingestId)).rejects.toMatchObject({
      code: "artifact.type_unreadable",
      detail: { fileName: "scan.pdf" },
    });

    expect(await harness.storedPayloads()).toStrictEqual([]);
    expect(harness.manifestRows()).toStrictEqual([]);
    expect(harness.payloadRefRows()).toStrictEqual([]);
    expect(await harness.spooledBytes(ingestId)).toBeUndefined();
  });
});
