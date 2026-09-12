// The hook that holds one window's offer binding, and the three properties only a
// React tree can settle.
//
// SPLIT FROM `ledger-row-offers-binding.test.ts` on the same seam the module itself
// is split on: that file drives the BEHAVIOUR with no render at all, and this drives
// the WIRING — where the bridge comes from, when the surface is read, and whether the
// binding's identity holds. One file carrying both went past this package's size rule.
//
// THE IDENTITY CASE IS THE LOAD-BEARING ONE. `LedgerFeedRow` is a memo boundary and
// this binding is one of its props, so a binding rebuilt when the window moved would
// move on every admitted event and re-render every mounted row's card with it.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../../bridge/index.js";
import { FIRST_RUN_SCENARIO } from "../../../../bridge/scenario/first-run.js";
import { sampleGeneralRow } from "../../../cards/row-samples.test-support.js";
import {
  useLedgerRowOffers,
  type LedgerRowOfferRequest,
  type LedgerRowOffersBinding,
} from "./ledger-row-offers-binding.js";

const SAMPLE_ROW_ID = "event-02";

/** One row's request, with nothing optional. */
function offerRequest(): LedgerRowOfferRequest {
  return {
    row: sampleGeneralRow(),
    density: "collapsed",
    chapterRunId: undefined,
    bodyText: undefined,
    pathReference: undefined,
  };
}

/** Press the one offer of a kind on a binding, or fail loudly. */
function press(
  binding: LedgerRowOffersBinding | undefined,
  kind: "open-row" | "copy-row-id",
): void {
  const offer = binding?.offersFor(offerRequest()).find((candidate) => candidate.kind === kind);
  if (offer === undefined) {
    throw new Error(`no offer of kind ${kind} was built`);
  }
  offer.perform();
}

describe("the hook that holds a window's row offers", () => {
  it("keeps ONE binding identity across renders whose surfaces moved", () => {
    const bindings: LedgerRowOffersBinding[] = [];

    function BindingIdentityProbe(props: { readonly generation: number }): React.JSX.Element {
      // A fresh surface object per render, which is what a live feed hands it.
      bindings.push(
        useLedgerRowOffers({
          rowLease: () => undefined,
          setRowLease: () => undefined,
          jumpToRow: () => undefined,
        }),
      );
      return <output>{String(props.generation)}</output>;
    }

    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const { rerender } = render(
      <SidekicksBridgeProvider bridge={bridge}>
        <BindingIdentityProbe generation={1} />
      </SidekicksBridgeProvider>,
    );
    rerender(
      <SidekicksBridgeProvider bridge={bridge}>
        <BindingIdentityProbe generation={2} />
      </SidekicksBridgeProvider>,
    );

    expect(bindings.length).toBeGreaterThan(1);
    expect(new Set(bindings).size).toBe(1);
  });

  it("presses against the COMMITTED window, never the one a discarded render built", () => {
    // The ref is written from the layout phase rather than the render body: a render
    // React discards still runs the body, and a press against a window that never
    // reached the screen would scroll to a row nobody can see.
    const reached: string[] = [];
    let binding: LedgerRowOffersBinding | undefined;

    function CommittedSurfacesProbe(props: { readonly generation: number }): React.JSX.Element {
      binding = useLedgerRowOffers({
        rowLease: () => undefined,
        setRowLease: (rowKey, lease) => {
          reached.push(`gen${props.generation}:setRowLease:${rowKey}:${lease.density}`);
        },
        jumpToRow: () => undefined,
      });
      return <output>{String(props.generation)}</output>;
    }

    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const { rerender } = render(
      <SidekicksBridgeProvider bridge={bridge}>
        <CommittedSurfacesProbe generation={1} />
      </SidekicksBridgeProvider>,
    );
    act(() => {
      rerender(
        <SidekicksBridgeProvider bridge={bridge}>
          <CommittedSurfacesProbe generation={2} />
        </SidekicksBridgeProvider>,
      );
    });

    press(binding, "open-row");
    expect(reached).toStrictEqual([`gen2:setRowLease:${SAMPLE_ROW_ID}:expanded`]);
  });

  it("reads the bridge off the provider rather than taking one as an argument", () => {
    const copied: string[] = [];
    let binding: LedgerRowOffersBinding | undefined;
    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const instrumented = {
      ...bridge,
      sidekicks: {
        ...bridge.sidekicks,
        native: {
          ...bridge.sidekicks.native,
          copyToClipboard: async (text: string) => {
            copied.push(text);
          },
        },
      },
    };

    function ProviderBridgeProbe(): React.JSX.Element {
      binding = useLedgerRowOffers({
        rowLease: () => undefined,
        setRowLease: () => undefined,
        jumpToRow: () => undefined,
      });
      return <output />;
    }

    render(
      <SidekicksBridgeProvider bridge={instrumented}>
        <ProviderBridgeProbe />
      </SidekicksBridgeProvider>,
    );

    press(binding, "copy-row-id");
    expect(copied).toStrictEqual([SAMPLE_ROW_ID]);
  });
});
