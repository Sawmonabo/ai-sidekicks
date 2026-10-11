// A publish decodes its payload before hashing, so identical bytes are stored once whichever way
// they came in, under a manifest each; a client's publish is attributed to its device and records
// the type read from the bytes, the daemon's own names no device; and a client's file, or a payload
// whose type cannot be read, is refused with nothing kept.

import { afterEach, describe, expect, it } from "vitest";

import {
  CALLING_DEVICE_ID,
  contentHashOf,
  openIngestHarness,
  PNG_SIGNATURE,
  type IngestHarness,
} from "../ingest/__tests__/service.test-support.js";

let harness: IngestHarness;

afterEach(async () => {
  await harness.close();
});

describe("a publish", () => {
  it("stores identical decoded bytes once, with a manifest and reference each", async () => {
    harness = await openIngestHarness();
    const text = "the run's summary";
    const bytes = new TextEncoder().encode(text);

    const asText = await harness.publish({
      artifactType: "summary",
      payload: text,
      mediaType: "text/markdown",
    });
    const asBase64 = await harness.publish({
      artifactType: "summary",
      payload: Buffer.from(bytes).toString("base64"),
      payloadEncoding: "base64",
      mediaType: "text/markdown",
    });
    const ingested = await harness.ingest(bytes);

    const contentHash = contentHashOf(bytes);
    expect(asText.manifest.digest).toBe(contentHash);
    expect(asBase64.manifest.digest).toBe(contentHash);
    expect(asBase64.manifest.size).toBe(bytes.length);
    expect(await harness.storedPayloads()).toHaveLength(1);
    const manifestIds = [asText.manifest.id, asBase64.manifest.id, ingested.artifactId];
    expect(new Set(manifestIds).size).toBe(3);
    expect(harness.payloadRefRows()).toStrictEqual(
      [...manifestIds]
        .sort()
        .map((manifestId) =>
          expect.objectContaining({ manifest_id: manifestId, storage_path: contentHash }),
        ),
    );
  });

  it("attributes a client's publish to its device, and the daemon's own to none", async () => {
    harness = await openIngestHarness();
    const payload = Buffer.from(PNG_SIGNATURE).toString("base64");

    const { manifest } = await harness.publish({
      artifactType: "design",
      payload,
      payloadEncoding: "base64",
      mediaType: "text/plain",
      metadata: { title: "Login screen", mediaType: "text/plain" },
    });
    const daemonPublish = await harness.publisher.publish(
      {
        sessionId: harness.sessionId,
        artifactType: "log",
        payload: "setup finished",
        mediaType: "text/x-log",
      },
      { kind: "daemon" },
    );

    // The reply is the manifest written: its id minted as version 7, its type read from the bytes.
    expect(manifest.id.charAt(14)).toBe("7");
    expect(manifest).toStrictEqual({
      id: manifest.id,
      sessionId: harness.sessionId,
      createdBy: CALLING_DEVICE_ID,
      artifactType: "design",
      digest: contentHashOf(PNG_SIGNATURE),
      size: PNG_SIGNATURE.length,
      state: "published",
      metadata: { title: "Login screen", mediaType: "image/png" },
      createdAt: manifest.createdAt,
    });
    expect(daemonPublish.manifest.createdBy).toBeUndefined();
    expect(harness.manifestRows()).toStrictEqual([
      expect.objectContaining({ id: manifest.id, created_by: CALLING_DEVICE_ID }),
      expect.objectContaining({
        id: daemonPublish.manifest.id,
        created_by: null,
        metadata: JSON.stringify({ mediaType: "text/x-log" }),
      }),
    ]);
  });
});

describe("a client's publish that is refused", () => {
  it("refuses a file, directing it to the ingest calls, and keeps nothing", async () => {
    harness = await openIngestHarness();

    await expect(
      harness.publish({
        artifactType: "file",
        payload: Buffer.from(PNG_SIGNATURE).toString("base64"),
        payloadEncoding: "base64",
        mediaType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "artifact.file_publish_refused" });

    expect(await harness.storedPayloads()).toStrictEqual([]);
    expect(await harness.spoolNames()).toStrictEqual([]);
    expect(harness.manifestRows()).toStrictEqual([]);
  });

  it("refuses for good a payload whose type cannot be read, deleting its spool", async () => {
    harness = await openIngestHarness({
      detectMediaType: () => Promise.reject(new Error("the parser ran past its bound")),
    });

    await expect(
      harness.publish({ artifactType: "summary", payload: "notes", mediaType: "text/plain" }),
    ).rejects.toMatchObject({ code: "artifact.type_unreadable" });

    expect(await harness.storedPayloads()).toStrictEqual([]);
    expect(await harness.spoolNames()).toStrictEqual([]);
    expect(harness.manifestRows()).toStrictEqual([]);
    expect(harness.payloadRefRows()).toStrictEqual([]);
  });
});
