// The one wake-up a stalled upload gets, and what takes it away. The defect held here is a
// circularity: the snapshot is stamped when the ledger publishes and a stalled upload stops
// publishing, so `isIngestStalled` could never cross its threshold for the stream that went
// quiet. Cases drive the real staged list on a frozen clock and render the real card from it.

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts";

import { act, render } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { INGEST_STALL_DISCLOSURE_MS } from "./attachment-caps.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { repeatedDisposalCount } from "@test/helpers/repeated-disposal.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { AttachmentCard } from "./components/AttachmentCard.js";
import { StagedAttachments } from "./staged-attachments.js";
import {
  useStagedAttachments,
  type StagedAttachmentsBinding,
} from "./hooks/useStagedAttachments.js";
import type { AttachmentIngestPort } from "./services/attachment-ingest-answer.js";
import { bridgeOnClock, type BridgeOnClock } from "@test/helpers/fixture-bridge.js";
import {
  INGEST_SESSION_ID,
  ScriptedIngestPort,
  patternedBytes,
} from "@test/helpers/scripted-ingest-port.js";

/** The instant every case starts at. */
const START_MILLISECONDS = 1_000;

/** The sentence the card puts on an upload that has gone quiet. */
const STALL_DISCLOSURE = "This upload has gone quiet";

/** One file, exactly as a picker hands it over. */
function pickedFile(byteLength: number): File {
  return new File([patternedBytes(byteLength)], "notes.md", { type: "text/markdown" });
}

/** One started staged list over one scripted port, on a clock the case advances by hand. */
function stagedAttachmentsOver(port: ScriptedIngestPort, clock: ManualClock): StagedAttachments {
  const stagedAttachments = new StagedAttachments({
    port: port.asPort(),
    sessionId: INGEST_SESSION_ID,
    clock,
  });
  stagedAttachments.start();
  return stagedAttachments;
}

/** What the real card says about the first entry, rendered from the real snapshot. */
function cardTextFor(stagedAttachments: StagedAttachments): string {
  const [entry] = stagedAttachments.snapshot.entries;
  expect(entry).toBeDefined();
  if (entry === undefined) {
    return "";
  }
  const { container } = render(
    <AttachmentCard
      reading={{ kind: "ingesting", entry }}
      nowMilliseconds={stagedAttachments.snapshot.publishedAtMilliseconds}
    />,
  );
  return container.textContent ?? "";
}

describe("staged attachments — the stall disclosure wakes once at its threshold", () => {
  it("re-stamps the snapshot at the deadline so the stalled arm renders", async () => {
    const port = new ScriptedIngestPort();
    const clock = new ManualClock(START_MILLISECONDS);
    port.holdChunks();
    const stagedAttachments = stagedAttachmentsOver(port, clock);
    stagedAttachments.attachFiles([pickedFile(300)]);
    await crossMacrotaskBoundary();

    // The stream is open and its chunk is in flight: the ledger's last publication, stamped at
    // the instant progress stopped.
    expect(stagedAttachments.snapshot.entries[0]?.state).toBe("ingesting");
    expect(stagedAttachments.snapshot.publishedAtMilliseconds).toBe(START_MILLISECONDS);
    expect(cardTextFor(stagedAttachments)).not.toContain(STALL_DISCLOSURE);

    clock.advance(INGEST_STALL_DISCLOSURE_MS);

    expect(stagedAttachments.snapshot.publishedAtMilliseconds).toBe(
      START_MILLISECONDS + INGEST_STALL_DISCLOSURE_MS,
    );
    expect(cardTextFor(stagedAttachments)).toContain(STALL_DISCLOSURE);
  });

  it("wakes once and not on a cadence", async () => {
    // One shot per deadline, and the deadline is behind us now, so the list holds no timer and
    // time moving again publishes nothing.
    const port = new ScriptedIngestPort();
    const clock = new ManualClock(START_MILLISECONDS);
    port.holdChunks();
    const stagedAttachments = stagedAttachmentsOver(port, clock);
    stagedAttachments.attachFiles([pickedFile(300)]);
    await crossMacrotaskBoundary();
    clock.advance(INGEST_STALL_DISCLOSURE_MS);
    const stampAtDisclosure = stagedAttachments.snapshot.publishedAtMilliseconds;

    expect(clock.pendingCount).toBe(0);
    clock.advance(INGEST_STALL_DISCLOSURE_MS * 3);
    expect(stagedAttachments.snapshot.publishedAtMilliseconds).toBe(stampAtDisclosure);
  });

  it("re-arms to the new deadline when a chunk lands before the old one", async () => {
    const port = new ScriptedIngestPort();
    const clock = new ManualClock(START_MILLISECONDS);
    const firstChunkGate = port.holdChunks();
    const stagedAttachments = stagedAttachmentsOver(port, clock);
    stagedAttachments.attachFiles([pickedFile(ARTIFACT_CHUNK_MAX_BYTES * 2)]);
    await crossMacrotaskBoundary();

    // The second chunk is gated before the first is let through, so the stream is outstanding
    // again the moment progress lands.
    clock.advance(INGEST_STALL_DISCLOSURE_MS / 2);
    port.holdChunks();
    firstChunkGate.open();
    await crossMacrotaskBoundary();
    const progressMilliseconds = START_MILLISECONDS + INGEST_STALL_DISCLOSURE_MS / 2;
    expect(stagedAttachments.snapshot.publishedAtMilliseconds).toBe(progressMilliseconds);

    // The first arming's deadline passes with nothing to disclose: progress moved it.
    clock.advance(INGEST_STALL_DISCLOSURE_MS / 2);
    expect(stagedAttachments.snapshot.publishedAtMilliseconds).toBe(progressMilliseconds);
    expect(cardTextFor(stagedAttachments)).not.toContain(STALL_DISCLOSURE);

    clock.advance(INGEST_STALL_DISCLOSURE_MS / 2);
    expect(stagedAttachments.snapshot.publishedAtMilliseconds).toBe(
      progressMilliseconds + INGEST_STALL_DISCLOSURE_MS,
    );
    expect(cardTextFor(stagedAttachments)).toContain(STALL_DISCLOSURE);
  });

  it("holds no timer once the stream has settled", async () => {
    const port = new ScriptedIngestPort();
    const clock = new ManualClock(START_MILLISECONDS);
    const stagedAttachments = stagedAttachmentsOver(port, clock);
    stagedAttachments.attachFiles([pickedFile(300)]);
    await crossMacrotaskBoundary();

    // A completed upload cannot go quiet, so the last publication takes the wake-up away.
    expect(stagedAttachments.snapshot.entries[0]?.state).toBe("complete");
    expect(clock.pendingCount).toBe(0);
  });

  it("publishes nothing after disposal", async () => {
    const port = new ScriptedIngestPort();
    const clock = new ManualClock(START_MILLISECONDS);
    port.holdChunks();
    const stagedAttachments = stagedAttachmentsOver(port, clock);
    let publishCount = 0;
    stagedAttachments.subscribe(() => {
      publishCount += 1;
    });
    stagedAttachments.attachFiles([pickedFile(300)]);
    await crossMacrotaskBoundary();
    const publishCountAtDisposal = publishCount;

    stagedAttachments.dispose();
    clock.advance(INGEST_STALL_DISCLOSURE_MS * 3);

    // A timeout that outlived the staged list would stamp a snapshot nobody reads.
    expect(clock.pendingCount).toBe(0);
    expect(publishCount).toBe(publishCountAtDisposal);
  });

  it("negative control: a staged list holding nothing arms no wake-up at all", async () => {
    // Without this, a list that re-published on any advance, a poll dressed as a one-shot,
    // would pass the cases above.
    const port = new ScriptedIngestPort();
    const clock = new ManualClock(START_MILLISECONDS);
    const stagedAttachments = stagedAttachmentsOver(port, clock);
    let publishCount = 0;
    stagedAttachments.subscribe(() => {
      publishCount += 1;
    });
    await crossMacrotaskBoundary();

    expect(clock.pendingCount).toBe(0);
    clock.advance(INGEST_STALL_DISCLOSURE_MS * 3);
    expect(publishCount).toBe(0);
    expect(stagedAttachments.snapshot.publishedAtMilliseconds).toBe(START_MILLISECONDS);
  });
});

describe("useStagedAttachments — the stamp is the window's clock, never the host's", () => {
  it("publishes the instant the window's clock answers", () => {
    // Entries are stamped from the window's own clock; a `RealClock` of the list's own would
    // stamp `Date.now()` and win over the fixture's.
    const port = new ScriptedIngestPort();
    const clock = new ManualClock(START_MILLISECONDS);
    const fixture = bridgeOnClock("composer", clock);
    let binding: StagedAttachmentsBinding | undefined;
    render(
      underWindow(
        fixture,
        <StagedAttachmentsProbe
          bridge={fixture.bridge}
          port={port.asPort()}
          onBinding={(taken) => {
            binding = taken;
          }}
        />,
      ),
    );

    expect(clock.now()).toBe(START_MILLISECONDS);
    expect(binding?.snapshot.publishedAtMilliseconds).toBe(START_MILLISECONDS);
  });

  it("negative control: the stamp follows the clock it was given, not one fixed instant", () => {
    // Without this, a stamp hard-coded to the first case's start would pass it.
    const laterStart = START_MILLISECONDS + INGEST_STALL_DISCLOSURE_MS;
    const port = new ScriptedIngestPort();
    const fixture = bridgeOnClock("composer", new ManualClock(laterStart));
    let binding: StagedAttachmentsBinding | undefined;
    render(
      underWindow(
        fixture,
        <StagedAttachmentsProbe
          bridge={fixture.bridge}
          port={port.asPort()}
          onBinding={(taken) => {
            binding = taken;
          }}
        />,
      ),
    );

    expect(binding?.snapshot.publishedAtMilliseconds).toBe(laterStart);
    expect(binding?.snapshot.publishedAtMilliseconds).not.toBe(START_MILLISECONDS);
  });
});

/** An element under a provider carrying this window's bridge and clock. */
function underWindow(fixture: BridgeOnClock, element: ReactElement): React.JSX.Element {
  return (
    <PlatformBridgeProvider bridge={fixture.bridge} clock={fixture.clock}>
      {element}
    </PlatformBridgeProvider>
  );
}

/** A component that holds the binding and hands its one control back to the case. */
function StagedAttachmentsProbe(props: {
  readonly bridge: PlatformBridge;
  readonly port: AttachmentIngestPort;
  readonly onBinding: (binding: StagedAttachmentsBinding) => void;
}): React.JSX.Element {
  const binding = useStagedAttachments(props.bridge, INGEST_SESSION_ID, props.port);
  props.onBinding(binding);
  return <span>{String(binding.snapshot.entries.length)}</span>;
}

describe("useStagedAttachments — a disposed staged list is re-minted on the replayed setup", () => {
  it("reaches a live client after StrictMode has torn one down and mounted again", async () => {
    // StrictMode runs the cleanup and then the setup again on the same instance. The cleanup
    // terminally disposed the ingest client, so files chosen afterwards would reach a client
    // whose `attach` returns at once, silently.
    const port = new ScriptedIngestPort();
    const fixture = bridgeOnClock("composer");
    let binding: StagedAttachmentsBinding | undefined;
    render(
      <StrictMode>
        {underWindow(
          fixture,
          <StagedAttachmentsProbe
            bridge={fixture.bridge}
            port={port.asPort()}
            onBinding={(taken) => {
              binding = taken;
            }}
          />,
        )}
      </StrictMode>,
    );

    await act(async () => {
      binding?.attachFiles([pickedFile(300)]);
      await crossMacrotaskBoundary();
    });

    expect(port.initCalls).toHaveLength(1);
    expect(port.chunkCalls).toHaveLength(1);
    expect(binding?.snapshot.entries[0]?.state).toBe("complete");
  });

  it("negative control: a changed collaborator re-mints once, not once per render", async () => {
    // The same cleanup runs when the bridge or the session moves. Exactly one stream must
    // open; a hook minting a list on every render would pass the case above but open one per pass.
    const port = new ScriptedIngestPort();
    const first = bridgeOnClock("composer");
    let binding: StagedAttachmentsBinding | undefined;
    const { rerender } = render(
      underWindow(
        first,
        <StagedAttachmentsProbe
          bridge={first.bridge}
          port={port.asPort()}
          onBinding={(taken) => {
            binding = taken;
          }}
        />,
      ),
    );
    const second = bridgeOnClock("composer");
    rerender(
      underWindow(
        second,
        <StagedAttachmentsProbe
          bridge={second.bridge}
          port={port.asPort()}
          onBinding={(taken) => {
            binding = taken;
          }}
        />,
      ),
    );

    await act(async () => {
      binding?.attachFiles([pickedFile(300)]);
      await crossMacrotaskBoundary();
    });

    expect(port.initCalls).toHaveLength(1);
    expect(binding?.snapshot.entries).toHaveLength(1);
  });

  it("disposes every staged list it opened exactly once", async () => {
    // The seam is told the disposal is terminal, through `isClosed`, and the re-mint is the
    // seam's. `AttachmentIngestClient.dispose` guards on its own flag, so a second disposal
    // breaks nothing visible; that is why the call is counted and not its effect.
    const disposals = vi.spyOn(StagedAttachments.prototype, "dispose");
    try {
      const port = new ScriptedIngestPort();
      const fixture = bridgeOnClock("composer");
      const { unmount } = render(
        <StrictMode>
          {underWindow(
            fixture,
            <StagedAttachmentsProbe
              bridge={fixture.bridge}
              port={port.asPort()}
              onBinding={() => {}}
            />,
          )}
        </StrictMode>,
      );
      await act(async () => {
        await crossMacrotaskBoundary();
      });
      unmount();

      expect(repeatedDisposalCount(disposals)).toBe(0);
      // A spy that saw nothing would report zero repeats.
      expect(disposals.mock.contexts.length).toBeGreaterThan(0);
    } finally {
      disposals.mockRestore();
    }
  });
});
