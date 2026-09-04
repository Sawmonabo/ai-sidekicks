// The one wake-up a stalled upload gets, and the four things that take it away.
//
// The defect these cases hold is a circularity rather than an arithmetic slip: the
// carrier stamps its snapshot when the LEDGER publishes, and an upload that stalls is
// an upload that stops publishing — so the card holding the last stamp was held at the
// instant of the last progress, and `isIngestStalled` could never cross its threshold
// for precisely the stream that went quiet. Everything below drives the real carrier
// on the console's own frozen clock and renders the real card from the snapshot it
// publishes, which is the exact composition `AttachmentCarrierSection` makes.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_CHUNK_BYTE_CAP,
  INGEST_STALL_DISCLOSURE_MS,
  ManualClock,
} from "../core/index.js";
import { AttachmentCard } from "./AttachmentCard.js";
import { AttachmentCarrier } from "./attachment-carrier.js";
import { ScriptedGrowthPort, patternedBytes } from "./attachment-ingest-scripted-port.js";

/** The instant every case starts at, so a stamp in an assertion is a real reading. */
const START_MILLISECONDS = 1_000;

/** The sentence the card puts on an upload that has gone quiet. */
const STALL_DISCLOSURE = "This upload has gone quiet";

/** Long enough for every continuation a case starts to come back. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One file, exactly as a picker hands it over. */
function pickedFile(byteLength: number): File {
  return new File([patternedBytes(byteLength)], "notes.md", { type: "text/markdown" });
}

/** One started carrier over one scripted port, on a clock the case advances by hand. */
function carrierOver(port: ScriptedGrowthPort, clock: ManualClock): AttachmentCarrier {
  const carrier = new AttachmentCarrier({
    bridge: port.asBridge(),
    sessionId: "session-1",
    clock,
  });
  carrier.start();
  return carrier;
}

/**
 * What the card says about the carrier's first entry, at the instant it published.
 *
 * The REAL card over the REAL snapshot, composed the way the sidebar section composes
 * them: the whole claim is that the instant a card is handed moves, so a case that
 * asserted on the snapshot alone would be checking the stamp and not the disclosure.
 */
function cardTextFor(carrier: AttachmentCarrier): string {
  const [entry] = carrier.snapshot.entries;
  expect(entry).toBeDefined();
  if (entry === undefined) {
    return "";
  }
  const { container } = render(
    <AttachmentCard
      reading={{ kind: "ingesting", entry }}
      nowMilliseconds={carrier.snapshot.publishedAtMilliseconds}
    />,
  );
  return container.textContent ?? "";
}

describe("attachment carrier — the stall disclosure wakes once at its threshold", () => {
  it("re-stamps the snapshot at the deadline so the stalled arm renders", async () => {
    const port = new ScriptedGrowthPort();
    const clock = new ManualClock(START_MILLISECONDS);
    port.holdChunks();
    const carrier = carrierOver(port, clock);
    carrier.attachFiles([pickedFile(300)]);
    await settle();

    // The stream is open and its chunk is in flight: this is the last publication the
    // ledger will make, and the instant on it is the instant progress stopped.
    expect(carrier.snapshot.entries[0]?.state).toBe("ingesting");
    expect(carrier.snapshot.publishedAtMilliseconds).toBe(START_MILLISECONDS);
    expect(cardTextFor(carrier)).not.toContain(STALL_DISCLOSURE);

    clock.advance(INGEST_STALL_DISCLOSURE_MS);

    expect(carrier.snapshot.publishedAtMilliseconds).toBe(
      START_MILLISECONDS + INGEST_STALL_DISCLOSURE_MS,
    );
    expect(cardTextFor(carrier)).toContain(STALL_DISCLOSURE);
  });

  it("wakes once and not on a cadence", async () => {
    // One shot per deadline, and the deadline is behind us now — so the carrier holds
    // no timer at all and time moving again publishes nothing. A repeat here would be
    // the interval this file exists to not have.
    const port = new ScriptedGrowthPort();
    const clock = new ManualClock(START_MILLISECONDS);
    port.holdChunks();
    const carrier = carrierOver(port, clock);
    carrier.attachFiles([pickedFile(300)]);
    await settle();
    clock.advance(INGEST_STALL_DISCLOSURE_MS);
    const stampAtDisclosure = carrier.snapshot.publishedAtMilliseconds;

    expect(clock.pendingCount).toBe(0);
    clock.advance(INGEST_STALL_DISCLOSURE_MS * 3);
    expect(carrier.snapshot.publishedAtMilliseconds).toBe(stampAtDisclosure);
  });

  it("re-arms to the new deadline when a chunk lands before the old one", async () => {
    const port = new ScriptedGrowthPort();
    const clock = new ManualClock(START_MILLISECONDS);
    const firstChunkGate = port.holdChunks();
    const carrier = carrierOver(port, clock);
    carrier.attachFiles([pickedFile(ATTACHMENT_CHUNK_BYTE_CAP * 2)]);
    await settle();

    // Half a disclosure window in, the second chunk is gated before the first is let
    // through, so the stream is outstanding again the moment progress lands.
    clock.advance(INGEST_STALL_DISCLOSURE_MS / 2);
    port.holdChunks();
    firstChunkGate.open();
    await settle();
    const progressMilliseconds = START_MILLISECONDS + INGEST_STALL_DISCLOSURE_MS / 2;
    expect(carrier.snapshot.publishedAtMilliseconds).toBe(progressMilliseconds);

    // The deadline the first arming named passes with nothing to disclose: progress
    // moved it, and a wake-up that fired here would call a live upload stalled.
    clock.advance(INGEST_STALL_DISCLOSURE_MS / 2);
    expect(carrier.snapshot.publishedAtMilliseconds).toBe(progressMilliseconds);
    expect(cardTextFor(carrier)).not.toContain(STALL_DISCLOSURE);

    clock.advance(INGEST_STALL_DISCLOSURE_MS / 2);
    expect(carrier.snapshot.publishedAtMilliseconds).toBe(
      progressMilliseconds + INGEST_STALL_DISCLOSURE_MS,
    );
    expect(cardTextFor(carrier)).toContain(STALL_DISCLOSURE);
  });

  it("holds no timer once the stream has settled", async () => {
    const port = new ScriptedGrowthPort();
    const clock = new ManualClock(START_MILLISECONDS);
    const carrier = carrierOver(port, clock);
    carrier.attachFiles([pickedFile(300)]);
    await settle();

    // A completed upload cannot go quiet, so the last publication takes the wake-up
    // away rather than leaving one armed against an entry nothing will move again.
    expect(carrier.snapshot.entries[0]?.state).toBe("complete");
    expect(clock.pendingCount).toBe(0);
  });

  it("publishes nothing after disposal", async () => {
    const port = new ScriptedGrowthPort();
    const clock = new ManualClock(START_MILLISECONDS);
    port.holdChunks();
    const carrier = carrierOver(port, clock);
    let publishCount = 0;
    carrier.subscribe(() => {
      publishCount += 1;
    });
    carrier.attachFiles([pickedFile(300)]);
    await settle();
    const publishCountAtDisposal = publishCount;

    carrier.dispose();
    clock.advance(INGEST_STALL_DISCLOSURE_MS * 3);

    // A timeout that outlived the surface would stamp a snapshot nobody reads and
    // hold a handle nobody can cancel.
    expect(clock.pendingCount).toBe(0);
    expect(publishCount).toBe(publishCountAtDisposal);
  });

  it("negative control: a carrier holding nothing arms no wake-up at all", async () => {
    // Without this, every case above would pass over a carrier that re-published on
    // any advance — which is the poll the no-interval rule forbids, wearing a
    // one-shot's clothes.
    const port = new ScriptedGrowthPort();
    const clock = new ManualClock(START_MILLISECONDS);
    const carrier = carrierOver(port, clock);
    let publishCount = 0;
    carrier.subscribe(() => {
      publishCount += 1;
    });
    await settle();

    expect(clock.pendingCount).toBe(0);
    clock.advance(INGEST_STALL_DISCLOSURE_MS * 3);
    expect(publishCount).toBe(0);
    expect(carrier.snapshot.publishedAtMilliseconds).toBe(START_MILLISECONDS);
  });
});
