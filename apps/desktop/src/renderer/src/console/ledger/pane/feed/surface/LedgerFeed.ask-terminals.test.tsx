// Where a mounted ledger reads an ask's terminal from, and where it may not.
//
// A driver ask is opened by one row and settled by a later one, so whether a request
// still needs answering is a fact about the WINDOW. The window that answers it is the
// unfurled channel-scoped projection and never the model a narrowing left: a facet
// press that admits a request row while excluding the row that answered it must not be
// able to take the terminal with it, or the card offers answer controls for an ask the
// log has already settled and a participant answers it twice.
//
// Driven through the COMPOSED feed rather than through the fold, because the fold has
// been correct since it was written and what regressed — twice — is which window it is
// handed. The fold's own cases are `ledger/cards/bodies/input-ask.test.ts`'.
//
// THE ROW BODY IS A PROBE AND NOT A STAND-IN. The ask card belongs to the timeline
// subtree, so nothing
// ships in the seat yet; the probe below fills the seat and reads the REAL reader and
// the REAL hook, which is the pair under test. It renders the terminal's state where it
// found one so a case can tell "settled" from "still open" out of the DOM.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readDriverAsk, type DriverAskReading } from "../../../cards/bodies/input-ask.js";
import { useLedgerAskTerminal } from "../../../cards/bodies/AskTerminalProvider.js";
import { type TimelineRowSlotProps } from "../../../../seats/index.js";
import {
  facetChip,
  renderFeed,
  withLaidOutViewport,
  withdrawLedgerCommands,
} from "./LedgerFeedFixtures.test-support.js";
import {
  EARLY_JOINER,
  FIXTURE_ASK_ID,
  LATE_JOINER,
  openSessionStoreWithSplitActorAsk,
} from "../ledger-feed-logs.test-support.js";

afterEach(() => {
  withdrawLedgerCommands();
  vi.restoreAllMocks();
});

/**
 * The REQUEST row's probe.
 *
 * Keyed on the row's own state rather than on the ask id, because all four
 * `driver_ask.*` rows are ask rows and carry one id between them — a selector on the
 * id alone reads whichever of them the narrowing left, which is a different question
 * from the one every case here asks.
 */
const ASK_REQUEST_PROBE = '[data-ask-probe][data-ask-state="requested"]';

/** The TERMINAL row's probe — what a narrowing has to be able to take away. */
const ASK_TERMINAL_PROBE = '[data-ask-probe][data-ask-state="responded"]';

/** One ask row, reporting the terminal the mounted ledger published for it. */
function AskTerminalProbe(props: { readonly ask: DriverAskReading }): React.JSX.Element {
  const terminal = useLedgerAskTerminal(props.ask);
  return (
    <span
      data-ask-probe={props.ask.askId}
      data-ask-state={props.ask.state}
      data-ask-terminal={terminal?.state ?? "none"}
    >
      {props.ask.prompt ?? props.ask.askId}
    </span>
  );
}

/**
 * The seat filler: an ask row draws the probe, every other row draws its summary.
 *
 * The branch is in this plain function and the hook is inside the component, so no
 * hook is called conditionally — a probe that read the context itself would have to
 * be called for every row, ask or not.
 */
function renderAskProbeRow(mount: TimelineRowSlotProps): React.JSX.Element {
  const ask = readDriverAsk(mount.row);
  return ask === undefined ? <p>{mount.row.summary}</p> : <AskTerminalProbe ask={ask} />;
}

/** What the request row's probe says about its terminal, or `undefined`. */
function probedTerminal(feed: HTMLElement): string | undefined {
  return feed.querySelector<HTMLElement>(ASK_REQUEST_PROBE)?.dataset["askTerminal"];
}

describe("the mounted ledger's ask terminals — folded above every narrowing", () => {
  it("settles a request from a terminal the log holds", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithSplitActorAsk(true), undefined, renderAskProbeRow);

    expect(feed.querySelector(ASK_REQUEST_PROBE)?.getAttribute("data-ask-probe")).toBe(
      FIXTURE_ASK_ID,
    );
    expect(probedTerminal(feed)).toBe("responded");
  });

  it("keeps the request settled when the facet bar excludes the row that answered it", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithSplitActorAsk(true), undefined, renderAskProbeRow);

    // The requester's chip. It admits the request row and excludes the response row,
    // which a different participant authored.
    fireEvent.click(facetChip(feed, EARLY_JOINER));

    // The narrowing really took the terminal ROW out of the rendered window — without
    // this the case would pass over a filter that had admitted both and would say
    // nothing at all about which window the fold ran over.
    expect(feed.querySelector(ASK_TERMINAL_PROBE)).toBeNull();
    expect(feed.querySelector(ASK_REQUEST_PROBE)?.getAttribute("data-ask-probe")).toBe(
      FIXTURE_ASK_ID,
    );
    expect(probedTerminal(feed)).toBe("responded");
  });

  it("draws no request row at all under the answerer's own chip", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithSplitActorAsk(true), undefined, renderAskProbeRow);

    fireEvent.click(facetChip(feed, LATE_JOINER));

    // The narrowing is real: the request is gone, so the case above is a statement
    // about a terminal the window kept rather than about a filter that did nothing.
    expect(feed.querySelector(ASK_REQUEST_PROBE)).toBeNull();
  });

  // Without this every assertion above would pass over a probe that reported
  // "responded" for anything, and over a fold that invented a terminal.
  it("negative control: an unsettled request reports no terminal", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithSplitActorAsk(false), undefined, renderAskProbeRow);

    expect(feed.querySelector(ASK_REQUEST_PROBE)?.getAttribute("data-ask-probe")).toBe(
      FIXTURE_ASK_ID,
    );
    expect(probedTerminal(feed)).toBe("none");
  });
});
