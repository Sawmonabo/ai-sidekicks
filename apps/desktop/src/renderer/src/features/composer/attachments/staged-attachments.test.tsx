// The one wake-up a stalled upload gets, and the four things that take it away.
//
// The defect these cases hold is a circularity rather than an arithmetic slip: the
// staged list stamps its snapshot when the LEDGER publishes, and an upload that stalls is
// an upload that stops publishing — so the card holding the last stamp was held at the
// instant of the last progress, and `isIngestStalled` could never cross its threshold
// for precisely the stream that went quiet. Everything below drives the real staged list
// on the console's own frozen clock and renders the real card from the snapshot it
// publishes, which is the composition the composer's attachment strip makes.

import { ATTACHMENT_INGEST_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts";

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { INGEST_STALL_DISCLOSURE_MS } from "./attachment-caps.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { repeatedDisposalCount } from "@test/helpers/repeated-disposal.js";
import { resolveBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { AttachmentCard } from "./components/AttachmentCard.js";
import { StagedAttachments } from "./staged-attachments.js";
import {
  useStagedAttachments,
  type StagedAttachmentsBinding,
} from "./hooks/useStagedAttachments.js";
import type { AttachmentIngestPort } from "./services/attachment-ingest-answer.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import {
  INGEST_SESSION_ID,
  ScriptedIngestPort,
  patternedBytes,
} from "@test/helpers/scripted-ingest-port.js";

/** The instant every case starts at, so a stamp in an assertion is a real reading. */
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

/**
 * What the card says about the staged list's first entry, at the instant it published.
 *
 * The REAL card over the REAL snapshot, composed the way the composer's strip composes
 * them: the whole claim is that the instant a card is handed moves, so a case that
 * asserted on the snapshot alone would be checking the stamp and not the disclosure.
 */
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

    // The stream is open and its chunk is in flight: this is the last publication the
    // ledger will make, and the instant on it is the instant progress stopped.
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
    // One shot per deadline, and the deadline is behind us now — so the staged list holds
    // no timer at all and time moving again publishes nothing. A repeat here would be
    // the interval this file exists to not have.
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
    stagedAttachments.attachFiles([pickedFile(ATTACHMENT_INGEST_CHUNK_MAX_BYTES * 2)]);
    await crossMacrotaskBoundary();

    // Half a disclosure window in, the second chunk is gated before the first is let
    // through, so the stream is outstanding again the moment progress lands.
    clock.advance(INGEST_STALL_DISCLOSURE_MS / 2);
    port.holdChunks();
    firstChunkGate.open();
    await crossMacrotaskBoundary();
    const progressMilliseconds = START_MILLISECONDS + INGEST_STALL_DISCLOSURE_MS / 2;
    expect(stagedAttachments.snapshot.publishedAtMilliseconds).toBe(progressMilliseconds);

    // The deadline the first arming named passes with nothing to disclose: progress
    // moved it, and a wake-up that fired here would call a live upload stalled.
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

    // A completed upload cannot go quiet, so the last publication takes the wake-up
    // away rather than leaving one armed against an entry nothing will move again.
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

    // A timeout that outlived the surface would stamp a snapshot nobody reads and
    // hold a handle nobody can cancel.
    expect(clock.pendingCount).toBe(0);
    expect(publishCount).toBe(publishCountAtDisposal);
  });

  it("negative control: a staged list holding nothing arms no wake-up at all", async () => {
    // Without this, every case above would pass over a staged list that re-published on
    // any advance — which is the poll the no-interval rule forbids, wearing a
    // one-shot's clothes.
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
  it("publishes the instant `resolveBridgeClock` answers for the bridge it was handed", () => {
    // Under the fixture the entries are stamped from the window's own clock: a staged list
    // with a `RealClock` of its own would stamp `Date.now()`, two clocks inside one
    // window with the wall one always winning.
    const port = new ScriptedIngestPort();
    const clock = new ManualClock(START_MILLISECONDS);
    const bridge = bridgeOnClock("composer", clock);
    let binding: StagedAttachmentsBinding | undefined;
    render(
      <StagedAttachmentsProbe
        bridge={bridge}
        port={port.asPort()}
        onBinding={(taken) => {
          binding = taken;
        }}
      />,
    );

    expect(resolveBridgeClock(bridge).now()).toBe(START_MILLISECONDS);
    expect(binding?.snapshot.publishedAtMilliseconds).toBe(START_MILLISECONDS);
  });

  it("negative control: the stamp follows the clock it was given, not one fixed instant", () => {
    // Without this, a stamp hard-coded to the first case's start would pass it. Two
    // bridges on two clocks stamp two different instants.
    const laterStart = START_MILLISECONDS + INGEST_STALL_DISCLOSURE_MS;
    const port = new ScriptedIngestPort();
    let binding: StagedAttachmentsBinding | undefined;
    render(
      <StagedAttachmentsProbe
        bridge={bridgeOnClock("composer", new ManualClock(laterStart))}
        port={port.asPort()}
        onBinding={(taken) => {
          binding = taken;
        }}
      />,
    );

    expect(binding?.snapshot.publishedAtMilliseconds).toBe(laterStart);
    expect(binding?.snapshot.publishedAtMilliseconds).not.toBe(START_MILLISECONDS);
  });
});

/** A surface that holds the binding and hands its one control back to the case. */
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
    // The bug, exercised: StrictMode runs the cleanup and then the setup again on the
    // same component instance, and a memoised staged list survives that. The cleanup
    // terminally disposed the ingest client, so every file chosen afterwards reached a
    // client whose `attach` returns at once — the surface inert, and silently.
    const port = new ScriptedIngestPort();
    let binding: StagedAttachmentsBinding | undefined;
    render(
      <StrictMode>
        <StagedAttachmentsProbe
          bridge={bridgeOnClock("composer")}
          port={port.asPort()}
          onBinding={(taken) => {
            binding = taken;
          }}
        />
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
    // The same cleanup runs when the bridge or the session moves, so this drives the
    // re-mint through the other door — and asserts that exactly ONE stream opens. A
    // hook that minted a staged list on every render would satisfy the case above while
    // opening a stream per pass, which is the leak the memo existed to prevent dressed
    // as a fix for the one it caused.
    const port = new ScriptedIngestPort();
    let binding: StagedAttachmentsBinding | undefined;
    const { rerender } = render(
      <StagedAttachmentsProbe
        bridge={bridgeOnClock("composer")}
        port={port.asPort()}
        onBinding={(taken) => {
          binding = taken;
        }}
      />,
    );
    const bridge = bridgeOnClock("composer");
    rerender(
      <StagedAttachmentsProbe
        bridge={bridge}
        port={port.asPort()}
        onBinding={(taken) => {
          binding = taken;
        }}
      />,
    );

    await act(async () => {
      binding?.attachFiles([pickedFile(300)]);
      await crossMacrotaskBoundary();
    });

    expect(port.initCalls).toHaveLength(1);
    expect(binding?.snapshot.entries).toHaveLength(1);
  });

  it("disposes every staged list it opened exactly once", async () => {
    // The seam is told the disposal is TERMINAL, through `isClosed`, and the re-mint
    // is the seam's. Re-derived in the hook's own effect instead, the corpse
    // StrictMode's replay produced was recorded as committed, the hook published a
    // replacement, and the value-change cleanup disposed the corpse a second time.
    // `AttachmentIngestClient.dispose` guards on its own flag, so nothing broke and
    // nothing could fail — which is why the CALL is counted and not its effect.
    const disposals = vi.spyOn(StagedAttachments.prototype, "dispose");
    try {
      const port = new ScriptedIngestPort();
      const { unmount } = render(
        <StrictMode>
          <StagedAttachmentsProbe
            bridge={bridgeOnClock("composer")}
            port={port.asPort()}
            onBinding={() => {}}
          />
        </StrictMode>,
      );
      await act(async () => {
        await crossMacrotaskBoundary();
      });
      unmount();

      expect(repeatedDisposalCount(disposals)).toBe(0);
      // Negative control on the count: a spy that saw nothing reports zero repeats.
      expect(disposals.mock.contexts.length).toBeGreaterThan(0);
    } finally {
      disposals.mockRestore();
    }
  });
});
