// A completed ingest writes the file's manifest and then its payload reference in one transaction,
// under a version 7 id, attributed to the calling device, recording the type read from the bytes;
// the caller's declared type is kept only for UTF-8 text whose bytes name no type, and bytes that
// are neither are an unknown binary. A payload the detector refused is refused for good and reaches
// neither the store nor the database; one whose type check could not run keeps its stream open,
// and the completion sent again stores it.

import { afterEach, describe, expect, it } from "vitest";

import { DetectorRejectedBytesError } from "../../detection/thread.js";

import {
  CALLING_DEVICE_ID,
  contentHashOf,
  openIngestHarness,
  PNG_SIGNATURE,
  type IngestHarness,
} from "../../__tests__/harness.test-support.js";

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

  it.each([
    {
      bytes: new TextEncoder().encode("# Release notes\n\nThe login works.\n"),
      declaredMediaType: "text/markdown; charset=utf-8",
      derivedMediaType: "text/markdown",
    },
    {
      bytes: new TextEncoder().encode("plain words"),
      declaredMediaType: "application/x-unknown",
      derivedMediaType: "text/plain",
    },
    {
      bytes: Uint8Array.of(0x00, 0xff, 0xfe, 0x80, 0x81),
      declaredMediaType: "text/plain",
      derivedMediaType: "application/octet-stream",
    },
  ])(
    "records $derivedMediaType for bytes naming no type, declared $declaredMediaType",
    async ({ bytes, declaredMediaType, derivedMediaType }) => {
      harness = await openIngestHarness();
      const { ingestId } = await harness.init(bytes.length, "notes", declaredMediaType);
      await harness.chunk(ingestId, 0, bytes);

      await expect(harness.complete(ingestId)).resolves.toMatchObject({ derivedMediaType });
      expect(harness.payloadRefRows()).toStrictEqual([
        expect.objectContaining({ media_type: derivedMediaType }),
      ]);
    },
  );
});

describe("a payload whose type cannot be read", () => {
  it("is refused for good when the detector refused it, and nothing of it is kept", async () => {
    harness = await openIngestHarness({
      detectMediaType: () => () =>
        Promise.reject(new DetectorRejectedBytesError("the parser refused the bytes")),
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

  it("keeps its stream open when the check could not run, and stores it sent again", async () => {
    let checkCount = 0;
    harness = await openIngestHarness({
      detectMediaType: () => () => {
        checkCount += 1;
        return checkCount === 1
          ? Promise.reject(new Error("the type check ran past its bound"))
          : Promise.resolve("image/png");
      },
    });
    const { ingestId } = await harness.init(PNG_SIGNATURE.length, "scan.png");
    await harness.chunk(ingestId, 0, PNG_SIGNATURE);

    await expect(harness.complete(ingestId)).rejects.toMatchObject({
      code: "artifact.type_check_unavailable",
      detail: { fileName: "scan.png" },
    });
    expect(await harness.spooledBytes(ingestId)).toStrictEqual(Buffer.from(PNG_SIGNATURE));

    const completed = await harness.complete(ingestId);
    expect(completed).toMatchObject({
      contentHash: contentHashOf(PNG_SIGNATURE),
      derivedMediaType: "image/png",
    });
    expect(harness.manifestRows()).toStrictEqual([
      expect.objectContaining({ id: completed.artifactId }),
    ]);
  });
});
