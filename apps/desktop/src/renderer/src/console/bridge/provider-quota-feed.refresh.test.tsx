// The provider-account registry is re-read when the window comes back.
//
// WHAT THIS IS ABOUT. `providerAccount.subscribe` keeps the accounts current while it
// is up, and `providerAccount.list` is what says what the registry IS. Before the
// console's re-read reasons were wired here that read happened once, inside the
// reading's own open, so a window left alone while a person authenticated an account
// in a terminal came back showing a registry that predated it.
//
// THE WINDOW HALF ONLY, and that is the claim. This reading is addressed at the NODE,
// so no one session's repair and no one session's timeline bear on it — tying a
// node-wide answer to whichever session happened to be open is what the split between
// the two trigger halves exists to refuse.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settleScheduledRead } from "./scheduled-read.test-support.js";

import { bridgeAnswering, type BridgeUnderTest } from "./fixture-bridge.test-support.js";
import { useProviderQuotas } from "./provider-quota-feed.js";
import type { ConsoleBridge } from "./console-bridge.js";

/** A bridge answering the registry read with an empty node. */
function answeringAccountList(): BridgeUnderTest {
  return bridgeAnswering(async (call, forward) => {
    if (call.method === "providerAccount.list") {
      return { accounts: [], usageWindows: [] };
    }
    return forward();
  });
}

function accountListCallCount(under: BridgeUnderTest): number {
  return under.calls.filter((call) => call.method === "providerAccount.list").length;
}

function QuotaProbe(props: { readonly bridge: ConsoleBridge }): null {
  useProviderQuotas(props.bridge);
  return null;
}

describe("the provider-account reading re-reads on the window's own reasons", () => {
  it("takes a fresh read when the window regains focus", async () => {
    const under = answeringAccountList();
    await act(async () => {
      render(<QuotaProbe bridge={under.bridge} />);
    });
    await settleScheduledRead(under.bridge);
    expect(accountListCallCount(under)).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(under.bridge);
    expect(accountListCallCount(under)).toBe(2);
  });

  it("negative control: nothing re-reads without a reason", async () => {
    const under = answeringAccountList();
    await act(async () => {
      render(<QuotaProbe bridge={under.bridge} />);
    });
    await settleScheduledRead(under.bridge);
    expect(accountListCallCount(under)).toBe(1);

    await settleScheduledRead(under.bridge);
    await settleScheduledRead(under.bridge);
    expect(accountListCallCount(under)).toBe(1);
  });
});
