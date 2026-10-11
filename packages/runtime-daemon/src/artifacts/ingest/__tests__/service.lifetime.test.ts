// A completion answers its resend with the first result while the stream is held, running nothing
// again and pinning no slot; past the stream's lifetime the resend is refused and the same bytes
// sent again are stored once under a second manifest. A stream past its lifetime is ended at its
// next call however recently it was written, and the reaper ends one no call reaches, freeing its
// slot. The reaper deletes a spool no stream holds once unwritten past its time to live.

import { utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ABANDONED_SPOOL_TTL_MS, MAX_ACTIVE_INGEST_STREAMS } from "../limits.js";
import { openIngestHarness, type IngestHarness } from "./service.test-support.js";

const STREAM_INVALID = { code: "artifact.ingest_stream_invalid" };
const NOTES = new TextEncoder().encode("meeting notes");

let harness: IngestHarness;

afterEach(async () => {
  await harness.close();
});

describe("a resent completion", () => {
  it("answers the first result, running no pipeline and writing no second manifest", async () => {
    harness = await openIngestHarness();
    const { ingestId } = await harness.init(NOTES.length);
    await harness.chunk(ingestId, 0, NOTES);
    const first = await harness.complete(ingestId);

    await expect(harness.complete(ingestId)).resolves.toStrictEqual(first);

    expect(harness.pipelineRunCount()).toBe(1);
    expect(harness.manifestRows()).toHaveLength(1);
    expect(await harness.spooledBytes(ingestId)).toBeUndefined();
    await expect(harness.chunk(ingestId, 1, NOTES)).rejects.toMatchObject(STREAM_INVALID);
    // The completed stream holds no slot.
    for (let index = 0; index < MAX_ACTIVE_INGEST_STREAMS; index += 1) {
      await harness.init(NOTES.length);
    }
  });

  it("is refused past the lifetime, and the bytes sent again are stored once", async () => {
    harness = await openIngestHarness();
    const { ingestId } = await harness.init(NOTES.length);
    await harness.chunk(ingestId, 0, NOTES);
    const first = await harness.complete(ingestId);
    harness.passLifetime();

    await expect(harness.complete(ingestId)).rejects.toMatchObject(STREAM_INVALID);
    const second = await harness.ingest(NOTES);

    expect(second.contentHash).toBe(first.contentHash);
    expect(await harness.storedPayloads()).toHaveLength(1);
    expect(harness.manifestRows()).toHaveLength(2);
  });
});

describe("a stream past its lifetime", () => {
  it("is ended at its next call, however recently it was written", async () => {
    harness = await openIngestHarness();
    const { ingestId } = await harness.init(NOTES.length * 2);
    await harness.chunk(ingestId, 0, NOTES);
    harness.passLifetime();

    await expect(harness.chunk(ingestId, 1, NOTES)).rejects.toMatchObject({
      ...STREAM_INVALID,
      detail: { reason: "lifetime_expired" },
    });
    expect(await harness.spooledBytes(ingestId)).toBeUndefined();
  });

  it("is ended by the reaper when no call comes, freeing its slot", async () => {
    harness = await openIngestHarness();
    const open: string[] = [];
    for (let index = 0; index < MAX_ACTIVE_INGEST_STREAMS; index += 1) {
      open.push((await harness.init(NOTES.length)).ingestId);
    }
    await expect(harness.init(NOTES.length)).rejects.toMatchObject({
      code: "artifact.ingest_capacity_exhausted",
    });
    harness.passLifetime();

    await harness.service.reap();

    await expect(harness.init(NOTES.length)).resolves.toMatchObject({
      ingestId: expect.any(String),
    });
    for (const ingestId of open) {
      expect(await harness.spooledBytes(ingestId)).toBeUndefined();
    }
  });
});

describe("the reaper", () => {
  it("deletes a spool unwritten past its time to live and keeps a younger one", async () => {
    harness = await openIngestHarness();
    // Opening a stream creates the spool folder; the stream itself is not under test.
    await harness.init(NOTES.length);
    const abandoned = path.join(harness.spoolDirectory, "left-by-an-earlier-run");
    const younger = path.join(harness.spoolDirectory, "still-being-written");
    await writeFile(abandoned, NOTES);
    await writeFile(younger, NOTES);
    const now = Date.now();
    const minute = 60_000;
    await utimes(abandoned, new Date(now), new Date(now - ABANDONED_SPOOL_TTL_MS - minute));
    await utimes(younger, new Date(now), new Date(now - ABANDONED_SPOOL_TTL_MS + minute));

    await harness.service.reap();

    await expect(harness.spooledBytes("left-by-an-earlier-run")).resolves.toBeUndefined();
    await expect(harness.spooledBytes("still-being-written")).resolves.toStrictEqual(
      Buffer.from(NOTES),
    );
  });
});
