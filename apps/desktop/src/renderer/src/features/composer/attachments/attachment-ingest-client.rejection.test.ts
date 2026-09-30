// The two local faults the ingest client handles, and the port rejection it does not. A picker
// `Blob` moved or deleted mid-upload gives a rejecting read, so the entry is refused where a card
// can show it and offer the retry. A subscriber that throws during publish is reported on the
// diagnostic band because the write already landed. A rejected port call propagates unchanged.

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RealClock } from "@renderer/lib/clock.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { AttachmentSpoolReclaimer } from "./services/attachment-ingest-abort.js";
import type { AttachmentIngestPort } from "./services/attachment-ingest-answer.js";
import { PAYLOAD_READ_REFUSAL_CODE } from "./services/attachment-ingest-chunks.js";
import { AttachmentIngestEntries } from "./attachment-ingest-entries.js";
import {
  INGEST_SESSION_ID,
  SMALL_SOURCE,
  ScriptedIngestPort,
  clientOver,
  movableSourceOver,
  sourceOver,
} from "@test/helpers/scripted-ingest-port.js";
import {
  AttachmentIngestStreamDriver,
  INGEST_STREAM_SITE,
} from "./services/attachment-ingest-stream.js";

beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

afterEach(() => {
  windowTripwires.reset();
  windowTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — a file that stops being readable", () => {
  it("refuses the entry, sends nothing for the unreadable slice, and offers a retry", async () => {
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    const movable = movableSourceOver(
      "attachment-moved",
      "capture.bin",
      ARTIFACT_CHUNK_MAX_BYTES * 2,
    );
    movable.moveFile();
    client.attach(movable.source);
    await crossMacrotaskBoundary();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("refused");
    expect(entry?.refusal?.code).toBe(PAYLOAD_READ_REFUSAL_CODE);
    expect(entry?.disposition).toBe("retry-in-place");
    // The read failed before a request was composed, so nothing was sent.
    expect(port.chunkCalls).toStrictEqual([]);
  });

  it("negative control: a readable file completes and refuses nothing", async () => {
    // Without this the case above would pass over a client that refused whatever happened.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-two", "capture.bin", ARTIFACT_CHUNK_MAX_BYTES * 2));
    await crossMacrotaskBoundary();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("complete");
    expect(entry?.refusal).toBeUndefined();
  });
});

describe("ingest client — a subscriber that throws while the ledger publishes", () => {
  it("reports a publication that threw on the diagnostic band, not on the promise", async () => {
    // The write has landed by the time the emitter re-raises a throwing sink, so this is a
    // defect in the console and goes where defects go.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    let publishCount = 0;
    client.subscribe(() => {
      publishCount += 1;
      if (publishCount > 1) {
        throw new Error("a subscriber failed while receiving the staged list");
      }
    });
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    const [report] = windowTripwires.reports();
    expect(report?.site).toBe(INGEST_STREAM_SITE);
    expect(report?.detail).toContain("attachment-1");
    // The write landed before the fan-out failed, so this reports rather than writing again.
    expect(client.snapshot[0]?.state).toBe("ingesting");
  });

  it("negative control: a subscriber that does not throw records nothing", async () => {
    // Without this the case above would pass over a client firing on every healthy drive.
    const port = new ScriptedIngestPort();
    const client = clientOver(port);
    client.subscribe(() => undefined);
    client.attach(SMALL_SOURCE);
    await crossMacrotaskBoundary();

    expect(windowTripwires.totalFiringCount).toBe(0);
    expect(client.snapshot[0]?.state).toBe("complete");
  });
});

describe("ingest driver — a rejected port call reaches the caller", () => {
  it.each(["begin", "writeChunk", "complete"] as const)(
    "rejects with the %s call's own rejection and reports nothing",
    async (leg) => {
      const rejection = new Error(`the ${leg} call never reached a daemon`);
      const port: AttachmentIngestPort = {
        ...new ScriptedIngestPort().asPort(),
        [leg]: async () => {
          throw rejection;
        },
      };
      const ledger = new AttachmentIngestEntries();
      ledger.declare(SMALL_SOURCE);
      const driver = new AttachmentIngestStreamDriver({
        port,
        sessionId: INGEST_SESSION_ID,
        clock: new RealClock(),
        ledger,
        reclaimer: new AttachmentSpoolReclaimer(port),
      });

      await expect(driver.drive("attachment-1")).rejects.toBe(rejection);
      expect(windowTripwires.totalFiringCount).toBe(0);
      expect(driver.isRunning("attachment-1")).toBe(false);
    },
  );
});
