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

import { ConsoleRefusalError, refuse } from "../core/index.js";
import { PROVIDER_ACCOUNT_SUBSCRIBE_STREAM } from "./daemon-streams.js";
import {
  withRecordedStreamLifecycle,
  withStreamUnopenableAtFirst,
} from "./daemon-streams.test-support.js";
import {
  bridgeAnswering,
  createFixture,
  withDaemonCall,
  type BridgeUnderTest,
} from "./fixture/fixture-bridge.test-support.js";
import {
  AccountPlaneBridge,
  account,
  listReply,
  mountQuotas,
  usageWindow,
} from "./provider-quota-feed.test-support.js";
import { useProviderQuotas } from "./provider-quota-feed.js";
import { readRefusalOf } from "./reading-lifecycle.js";
import type { ProviderQuotaReadout } from "./provider-account-quota.js";
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

describe("a registry reading that healed says so", () => {
  it("clears the refusal the moment a later read serves", async () => {
    // THE DEFECT, and it was live. The served arm moved the phase and left
    // `readRefusal` standing, so a registry that refused once — one transient daemon
    // error — and then answered on the next window focus published populated
    // readings beside a refusal from a read two triggers ago. The composer's
    // accessory rail rendered that refusal beside healthy chips for the life of the
    // window, because it read the member without checking the phase.
    const plane = new AccountPlaneBridge(
      { accounts: "not a list" },
      {
        laterReply: listReply([account()], [usageWindow()]),
      },
    );
    const mounted = await mountQuotas(plane.bridge);
    expect(mounted.refusalCodeNow()).toBe("reply-unreadable");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(plane.bridge);

    expect(mounted.readingsNow()).toHaveLength(1);
    expect(mounted.refusalCodeNow()).toBeUndefined();
  });

  it("negative control: a read that refuses again keeps saying so", async () => {
    // Without this the case above would pass over a reading that dropped every
    // refusal it was ever handed, which renders a node nobody could read as a node
    // with nothing to report.
    const plane = new AccountPlaneBridge({ accounts: "not a list" });
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(plane.bridge);

    expect(mounted.refusalCodeNow()).toBe("reply-unreadable");
  });
});

describe("a registry reading whose open refused can be opened again", () => {
  it("re-opens on the window's own reason rather than reading behind a dead tail", async () => {
    // THE DEFECT, in the shape that is worse than the queue's. `#seedRead` guarded
    // only on the open flag, and the catch arm left that flag set — so a later read
    // COULD serve and published `phase: "read"` with populated readings and no live
    // tail behind them: a readout the rail renders as current that will never update
    // again. The reading now closes on that arm, so the trigger re-opens instead.
    const answered = withDaemonCall(createFixture().bridge, async ({ method }) =>
      method === "providerAccount.list"
        ? listReply([account()], [usageWindow()])
        : { accounts: [], usageWindows: [], readiness: [] },
    );
    const refusingFirst = withStreamUnopenableAtFirst(
      answered.bridge,
      PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
      new ConsoleRefusalError(
        refuse("console-daemon-stream", "stream-unavailable", "The daemon is a stub."),
      ),
    );
    const recorded = withRecordedStreamLifecycle(refusingFirst);

    let readout: ProviderQuotaReadout | undefined;
    function Probe(): null {
      readout = useProviderQuotas(recorded.bridge);
      return null;
    }
    await act(async () => {
      render(<Probe />);
    });
    expect(readout?.phase).toBe("refused");
    // No read was taken behind the refused open: the tail is what keeps the quotas
    // current, so a registry read without one stops being true as it lands.
    expect(answered.calls).toStrictEqual([]);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(recorded.bridge);

    expect(recorded.openCountFor(PROVIDER_ACCOUNT_SUBSCRIBE_STREAM)).toBe(2);
    expect(readout?.phase).toBe("read");
    expect(readout?.readings).toHaveLength(1);
    expect(readRefusalOf(readout ?? { phase: "reading", readRefusal: undefined })).toBeUndefined();
  });
});
