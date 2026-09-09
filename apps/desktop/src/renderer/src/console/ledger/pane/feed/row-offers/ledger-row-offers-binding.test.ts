// Where a row's offers meet the surfaces that carry them out.
//
// The builder next door decides WHICH offers a row has; this decides what each one
// reaches, so every case below presses an offer and reads what moved — a lease, the
// scroll writer, the replay engine, or the host's clipboard.
//
// THE HOOK IS NOT HERE. `ledger-row-offers-binding.hook.test.tsx` drives it, because
// the wiring needs a React tree and the behaviour does not — and because one file
// carrying both subjects went past this package's own size rule.
//
// THE TWO REFUSING ACTS ARE DRIVEN ON BOTH FAILURE ARMS, which is the whole reason
// the module wraps the call rather than the promise: the shipped bridge throws
// synchronously and the fixture rejects, and a boundary attached to the promise
// alone passes a suite that only ever drives the fixture. Both arms are here, and
// the refusal is read off the frame's own act channel — a press that quietly did
// nothing fails rather than looking identical to one that refused.

import { afterEach, describe, expect, it } from "vitest";

import type { FilePathRef } from "@ai-sidekicks/contracts";

import { createFixtureBridge, type ConsoleBridge } from "../../../../bridge/index.js";
import { FIRST_RUN_SCENARIO } from "../../../../bridge/scenario/first-run.js";
import { type ConsoleRefusal } from "../../../../core/index.js";
import { publishConsoleActRefusalSink } from "../../../../palette/index.js";
import { type LedgerRowLease } from "../../../frame/index.js";
import { sampleGeneralRow } from "../../../cards/row-samples.test-support.js";
import {
  LEDGER_BODY_NOT_COPIED_REFUSAL,
  LEDGER_FILE_NOT_REVEALED_REFUSAL,
  LEDGER_ROW_ID_NOT_COPIED_REFUSAL,
  buildLedgerRowOffersBinding,
  type LedgerRowOfferRequest,
  type LedgerRowOfferSurface,
} from "./ledger-row-offers-binding.js";
import { type LedgerRowOfferKind } from "./ledger-row-offers.js";

/** What one case watched happen, in the order it happened. */
type SurfaceTrace = string[];

const SAMPLE_ROW_ID = "event-02";
const SAMPLE_RUN_ID = "run-with-a-chapter";
const SAMPLE_BODY = "The tool wrote four lines and this is all of them.";
/** See the builder suite: the brand exists so that no production value is one. */
const FIXTURE_PATH_REFERENCE = "path-ref-01" as FilePathRef;

/** How a host call failed, when a case wants it to. */
type HostFailure = "throws" | "rejects" | "none";

/** A bridge whose two native calls record, or fail in the named way. */
function instrumentedBridge(trace: SurfaceTrace, failure: HostFailure): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
  const fail = (call: string): Promise<void> => {
    if (failure === "throws") {
      throw new Error(`${call} threw`);
    }
    if (failure === "rejects") {
      return Promise.reject(new Error(`${call} rejected`));
    }
    return Promise.resolve();
  };
  return {
    ...bridge,
    sidekicks: {
      ...bridge.sidekicks,
      native: {
        ...bridge.sidekicks.native,
        copyToClipboard: (text: string) => {
          trace.push(`copyToClipboard:${text}`);
          return fail("copyToClipboard");
        },
        revealInFileExplorer: (path: FilePathRef) => {
          trace.push(`revealInFileExplorer:${path}`);
          return fail("revealInFileExplorer");
        },
      },
    },
  };
}

/** The window's live surfaces, recording what an offer reached. */
function offerSurface(
  trace: SurfaceTrace,
  bridge: ConsoleBridge,
  leases: Map<string, LedgerRowLease> = new Map(),
): LedgerRowOfferSurface {
  return {
    rowLease: (rowKey) => leases.get(rowKey),
    setRowLease: (rowKey, lease) => {
      leases.set(rowKey, lease);
      trace.push(`setRowLease:${rowKey}:${lease.density}:${lease.innerScrollTopPx}`);
    },
    jumpToRow: (rowKey) => {
      trace.push(`jumpToRow:${rowKey}`);
    },
    replayFromRow: (rowId) => {
      trace.push(`replayFromRow:${rowId}`);
    },
    bridge,
  };
}

/** One row's request, with nothing optional unless a case supplies it. */
function offerRequest(overrides: Partial<LedgerRowOfferRequest> = {}): LedgerRowOfferRequest {
  return {
    row: sampleGeneralRow(),
    density: "collapsed",
    chapterRunId: undefined,
    bodyText: undefined,
    pathReference: undefined,
    ...overrides,
  };
}

/** Press the one offer of a kind, or fail loudly rather than silently doing nothing. */
function press(
  surface: LedgerRowOfferSurface,
  request: LedgerRowOfferRequest,
  kind: LedgerRowOfferKind,
): void {
  const offer = buildLedgerRowOffersBinding(() => surface)
    .offersFor(request)
    .find((candidate) => candidate.kind === kind);
  if (offer === undefined) {
    throw new Error(`no offer of kind ${kind} was built`);
  }
  offer.perform();
}

/** Every refusal raised on the frame's channel for the length of one case. */
function collectRaisedRefusals(): {
  readonly raised: ConsoleRefusal[];
  readonly withdraw: () => void;
} {
  const raised: ConsoleRefusal[] = [];
  const withdraw = publishConsoleActRefusalSink((refusal) => {
    raised.push(refusal);
  });
  return { raised, withdraw };
}

describe("a row's offer binding — the surfaces it writes to", () => {
  it("writes the disclosure to the list's lease table", () => {
    const trace: SurfaceTrace = [];
    press(offerSurface(trace, instrumentedBridge(trace, "none")), offerRequest(), "open-row");
    expect(trace).toStrictEqual([`setRowLease:${SAMPLE_ROW_ID}:expanded:0`]);
  });

  it("carries a parked inner offset through a disclosure rather than resetting it", () => {
    // A body a reader scrolled inside and then collapsed comes back where they left
    // it. Zeroing here would be the row deciding that closing a body also rewinds it.
    const trace: SurfaceTrace = [];
    const leases = new Map<string, LedgerRowLease>([
      [SAMPLE_ROW_ID, { density: "expanded", innerScrollTopPx: 240 }],
    ]);
    const surface = offerSurface(trace, instrumentedBridge(trace, "none"), leases);
    press(surface, offerRequest({ density: "expanded" }), "close-row");
    expect(trace).toStrictEqual([`setRowLease:${SAMPLE_ROW_ID}:collapsed:240`]);
  });

  it("parks a row that has no lease yet at the top of its own body", () => {
    const trace: SurfaceTrace = [];
    press(offerSurface(trace, instrumentedBridge(trace, "none")), offerRequest(), "open-row");
    expect(trace).toStrictEqual([`setRowLease:${SAMPLE_ROW_ID}:expanded:0`]);
  });

  it("jumps by the run the chapter header is keyed by", () => {
    const trace: SurfaceTrace = [];
    press(
      offerSurface(trace, instrumentedBridge(trace, "none")),
      offerRequest({ chapterRunId: SAMPLE_RUN_ID }),
      "jump-to-chapter",
    );
    expect(trace).toStrictEqual([`jumpToRow:${SAMPLE_RUN_ID}`]);
  });

  it("hands the replay scrub to the surface that owns its own refusal", () => {
    const trace: SurfaceTrace = [];
    press(
      offerSurface(trace, instrumentedBridge(trace, "none")),
      offerRequest(),
      "replay-from-here",
    );
    expect(trace).toStrictEqual([`replayFromRow:${SAMPLE_ROW_ID}`]);
  });

  it("reads the surface at PRESS time, never at build time", () => {
    // The binding's identity is minted once and the window moves under it. A
    // closure over the surface would keep writing to the window that has gone.
    const firstTrace: SurfaceTrace = [];
    const secondTrace: SurfaceTrace = [];
    const bridge = instrumentedBridge(firstTrace, "none");
    let live = offerSurface(firstTrace, bridge);
    const binding = buildLedgerRowOffersBinding(() => live);
    const offers = binding.offersFor(offerRequest());
    live = offerSurface(secondTrace, bridge);
    offers.find((offer) => offer.kind === "open-row")?.perform();
    expect(firstTrace).toStrictEqual([]);
    expect(secondTrace).toStrictEqual([`setRowLease:${SAMPLE_ROW_ID}:expanded:0`]);
  });
});

describe("a row's offer binding — the host calls and how they fail", () => {
  let withdrawSink: (() => void) | undefined;

  afterEach(() => {
    withdrawSink?.();
    withdrawSink = undefined;
  });

  it("puts the row's own id on the host clipboard", () => {
    const trace: SurfaceTrace = [];
    press(offerSurface(trace, instrumentedBridge(trace, "none")), offerRequest(), "copy-row-id");
    expect(trace).toStrictEqual([`copyToClipboard:${SAMPLE_ROW_ID}`]);
  });

  it("puts the row's body on the host clipboard, verbatim", () => {
    const trace: SurfaceTrace = [];
    press(
      offerSurface(trace, instrumentedBridge(trace, "none")),
      offerRequest({ bodyText: SAMPLE_BODY }),
      "copy-body",
    );
    expect(trace).toStrictEqual([`copyToClipboard:${SAMPLE_BODY}`]);
  });

  it("hands the reveal the token untouched", () => {
    const trace: SurfaceTrace = [];
    press(
      offerSurface(trace, instrumentedBridge(trace, "none")),
      offerRequest({ pathReference: FIXTURE_PATH_REFERENCE }),
      "reveal-file-at-path",
    );
    expect(trace).toStrictEqual([`revealInFileExplorer:${FIXTURE_PATH_REFERENCE}`]);
  });

  it("says the id was not copied when the host THROWS", async () => {
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    const trace: SurfaceTrace = [];
    press(offerSurface(trace, instrumentedBridge(trace, "throws")), offerRequest(), "copy-row-id");
    await Promise.resolve();
    expect(raised).toStrictEqual([LEDGER_ROW_ID_NOT_COPIED_REFUSAL]);
    expect(raised[0]?.code).toBe("ledger.row_id_not_copied");
  });

  it("says the id was not copied when the host REJECTS", async () => {
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    const trace: SurfaceTrace = [];
    press(offerSurface(trace, instrumentedBridge(trace, "rejects")), offerRequest(), "copy-row-id");
    await Promise.resolve();
    expect(raised).toStrictEqual([LEDGER_ROW_ID_NOT_COPIED_REFUSAL]);
  });

  it("says the BODY was not copied, in its own words, on either failure", async () => {
    for (const failure of ["throws", "rejects"] as const) {
      const { raised, withdraw } = collectRaisedRefusals();
      const trace: SurfaceTrace = [];
      press(
        offerSurface(trace, instrumentedBridge(trace, failure)),
        offerRequest({ bodyText: SAMPLE_BODY }),
        "copy-body",
      );
      await Promise.resolve();
      expect(raised).toStrictEqual([LEDGER_BODY_NOT_COPIED_REFUSAL]);
      expect(raised[0]?.code).toBe("ledger.body_not_copied");
      withdraw();
    }
  });

  it("says the file was not revealed on either failure", async () => {
    for (const failure of ["throws", "rejects"] as const) {
      const { raised, withdraw } = collectRaisedRefusals();
      const trace: SurfaceTrace = [];
      press(
        offerSurface(trace, instrumentedBridge(trace, failure)),
        offerRequest({ pathReference: FIXTURE_PATH_REFERENCE }),
        "reveal-file-at-path",
      );
      await Promise.resolve();
      expect(raised).toStrictEqual([LEDGER_FILE_NOT_REVEALED_REFUSAL]);
      expect(raised[0]?.code).toBe("ledger.file_not_revealed");
      withdraw();
    }
  });

  it("raises nothing at all when the host takes the copy", async () => {
    // The negative control for every case above: a binding that refused
    // unconditionally would pass all of them.
    const { raised, withdraw } = collectRaisedRefusals();
    withdrawSink = withdraw;
    const trace: SurfaceTrace = [];
    press(offerSurface(trace, instrumentedBridge(trace, "none")), offerRequest(), "copy-row-id");
    await Promise.resolve();
    expect(raised).toStrictEqual([]);
  });
});
