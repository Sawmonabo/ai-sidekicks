// What a row offers, and what each absent offer is absent BECAUSE of.
//
// The builder is pure over a value bag, so every case here drives it with four
// lambdas and no render at all. Two properties are being checked and they are not
// the same: WHICH offers a row carries under a given set of facts, and what each
// offer reaches when it is pressed. A suite that only counted the offers would pass
// over a menu whose every item ran the wrong callback.
//
// EVERY CONDITIONAL OFFER IS CHECKED ON BOTH ARMS, which is the negative control the
// package standard asks for: an offer built unconditionally would satisfy a suite
// that only ever supplied the fact it needs.

import { describe, expect, it } from "vitest";

import type { FilePathRef } from "@ai-sidekicks/contracts";

// Deeply, and only here: the row samples are the cards' own fixtures and no door
// publishes them, so this reaches the module that declares them.
import { sampleGeneralRow } from "../../../cards/row-samples.test-support.js";
import {
  LEDGER_ROW_OFFER_KINDS,
  buildLedgerRowOffers,
  type LedgerRowOfferInputs,
  type LedgerRowOfferKind,
} from "./ledger-row-offers.js";

/** What one case watched happen, in the order it happened. */
type OfferTrace = string[];

/**
 * A path token, minted the one way a test can.
 *
 * The brand exists so that no PRODUCTION value is one — the main process mints the
 * token and dereferences it. A fixture standing in for what main would send is the
 * one place the assertion has to be written by hand, and it is written once.
 */
const FIXTURE_PATH_REFERENCE = "path-ref-01" as FilePathRef;

const SAMPLE_ROW_ID = "event-02";
const SAMPLE_RUN_ID = "run-with-a-chapter";
const SAMPLE_BODY = "The tool wrote four lines and this is all of them.";

/** The inputs a row carries when it has nothing optional. */
function offerInputs(
  trace: OfferTrace,
  overrides: Partial<LedgerRowOfferInputs> = {},
): LedgerRowOfferInputs {
  return {
    row: sampleGeneralRow(),
    density: "collapsed",
    setDensity: (rowId, density) => {
      trace.push(`setDensity:${rowId}:${density}`);
    },
    copyRowId: (rowId) => {
      trace.push(`copyRowId:${rowId}`);
    },
    bodyText: undefined,
    copyBody: (bodyText) => {
      trace.push(`copyBody:${bodyText}`);
    },
    replayFromRow: (rowId) => {
      trace.push(`replayFromRow:${rowId}`);
    },
    chapterRunId: undefined,
    jumpToChapter: (runId) => {
      trace.push(`jumpToChapter:${runId}`);
    },
    pathReference: undefined,
    revealFileAtPath: (pathReference) => {
      trace.push(`revealFileAtPath:${pathReference}`);
    },
    ...overrides,
  };
}

/** The kinds a set of inputs produces, in order. */
function offerKinds(inputs: LedgerRowOfferInputs): LedgerRowOfferKind[] {
  return buildLedgerRowOffers(inputs).map((offer) => offer.kind);
}

/** Press the one offer of a kind, or fail loudly rather than silently doing nothing. */
function press(inputs: LedgerRowOfferInputs, kind: LedgerRowOfferKind): void {
  const offer = buildLedgerRowOffers(inputs).find((candidate) => candidate.kind === kind);
  if (offer === undefined) {
    throw new Error(`no offer of kind ${kind} was built`);
  }
  offer.perform();
}

describe("a row's offers — which ones it carries", () => {
  it("offers the disclosure, the id, and the replay to a row with nothing optional", () => {
    expect(offerKinds(offerInputs([]))).toStrictEqual([
      "open-row",
      "copy-row-id",
      "replay-from-here",
    ]);
  });

  it("names the disclosure for the state a press would move the row TO", () => {
    expect(offerKinds(offerInputs([], { density: "collapsed" }))[0]).toBe("open-row");
    expect(offerKinds(offerInputs([], { density: "expanded" }))[0]).toBe("close-row");
  });

  it("offers the body copy only once a body has been read", () => {
    expect(offerKinds(offerInputs([]))).not.toContain("copy-body");
    expect(offerKinds(offerInputs([], { bodyText: SAMPLE_BODY }))).toContain("copy-body");
  });

  it("offers the body copy for a body that was read and says nothing", () => {
    // The distinction the input's own doc draws: `undefined` is "not read" and the
    // empty string is a body that IS read and is empty. A guard written as a
    // truthiness test would drop this case and look correct.
    expect(offerKinds(offerInputs([], { bodyText: "" }))).toContain("copy-body");
  });

  it("keeps the two copies together, ahead of everything that navigates", () => {
    expect(
      offerKinds(
        offerInputs([], {
          bodyText: SAMPLE_BODY,
          chapterRunId: SAMPLE_RUN_ID,
          pathReference: FIXTURE_PATH_REFERENCE,
        }),
      ),
    ).toStrictEqual([
      "open-row",
      "copy-row-id",
      "copy-body",
      "replay-from-here",
      "jump-to-chapter",
      "reveal-file-at-path",
    ]);
  });

  it("offers the chapter jump only when THIS window holds the run's chapter", () => {
    expect(offerKinds(offerInputs([]))).not.toContain("jump-to-chapter");
    expect(offerKinds(offerInputs([], { chapterRunId: SAMPLE_RUN_ID }))).toContain(
      "jump-to-chapter",
    );
  });

  it("offers the file reveal only when the row carries a path token", () => {
    expect(offerKinds(offerInputs([]))).not.toContain("reveal-file-at-path");
    expect(offerKinds(offerInputs([], { pathReference: FIXTURE_PATH_REFERENCE }))).toContain(
      "reveal-file-at-path",
    );
  });

  it("can produce every kind the enumeration declares", () => {
    // The totality check the enumeration's own comment asks for: a kind added to the
    // tuple that no input can produce is a member nothing would report.
    const producible = new Set<LedgerRowOfferKind>([
      ...offerKinds(offerInputs([], { density: "expanded" })),
      ...offerKinds(
        offerInputs([], {
          density: "collapsed",
          bodyText: SAMPLE_BODY,
          chapterRunId: SAMPLE_RUN_ID,
          pathReference: FIXTURE_PATH_REFERENCE,
        }),
      ),
    ]);
    expect([...producible].sort()).toStrictEqual([...LEDGER_ROW_OFFER_KINDS].sort());
  });

  it("labels every offer as a verb with no trailing punctuation", () => {
    for (const offer of buildLedgerRowOffers(
      offerInputs([], {
        bodyText: SAMPLE_BODY,
        chapterRunId: SAMPLE_RUN_ID,
        pathReference: FIXTURE_PATH_REFERENCE,
      }),
    )) {
      expect(offer.label).not.toMatch(/[.:…]$/);
      expect(offer.label.trim()).toBe(offer.label);
    }
  });
});

describe("a row's offers — what pressing one reaches", () => {
  it("writes the opposite density to the LIST, keyed by this row", () => {
    const trace: OfferTrace = [];
    press(offerInputs(trace, { density: "collapsed" }), "open-row");
    press(offerInputs(trace, { density: "expanded" }), "close-row");
    expect(trace).toStrictEqual([
      `setDensity:${SAMPLE_ROW_ID}:expanded`,
      `setDensity:${SAMPLE_ROW_ID}:collapsed`,
    ]);
  });

  it("copies this row's own id and this row's own body", () => {
    const trace: OfferTrace = [];
    const inputs = offerInputs(trace, { bodyText: SAMPLE_BODY });
    press(inputs, "copy-row-id");
    press(inputs, "copy-body");
    expect(trace).toStrictEqual([`copyRowId:${SAMPLE_ROW_ID}`, `copyBody:${SAMPLE_BODY}`]);
  });

  it("scrubs the replay engine to this row", () => {
    const trace: OfferTrace = [];
    press(offerInputs(trace), "replay-from-here");
    expect(trace).toStrictEqual([`replayFromRow:${SAMPLE_ROW_ID}`]);
  });

  it("jumps by the RUN the chapter is keyed by, never by the row's own id", () => {
    const trace: OfferTrace = [];
    press(offerInputs(trace, { chapterRunId: SAMPLE_RUN_ID }), "jump-to-chapter");
    expect(trace).toStrictEqual([`jumpToChapter:${SAMPLE_RUN_ID}`]);
  });

  it("hands the reveal the token it was given, untouched", () => {
    const trace: OfferTrace = [];
    press(offerInputs(trace, { pathReference: FIXTURE_PATH_REFERENCE }), "reveal-file-at-path");
    expect(trace).toStrictEqual([`revealFileAtPath:${FIXTURE_PATH_REFERENCE}`]);
  });
});
