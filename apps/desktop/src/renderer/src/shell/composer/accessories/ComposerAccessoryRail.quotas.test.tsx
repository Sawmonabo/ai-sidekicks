// The quota chips on the rail, and the notice beside them.
//
// Two subjects that are one seam: where a chip's numbers come from — the node's
// account plane, never the session timeline — and what the rail says when the tail
// carrying the next reading delivers something this build cannot decode. Both are
// about a reading's PROVENANCE, which is invisible on a chip.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  withCapturedStream,
  type StreamUnderTest,
} from "../../../console/bridge/fixture-bridge.test-support.js";
import {
  PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
import {
  EMPTY_REGISTRY,
  ONE_URGENT_QUOTA,
  mountRailSettled,
  railScenarioAnsweringRegistry,
} from "./rail.test-support.js";

describe("ComposerAccessoryRail — the quota chips come off the account plane", () => {
  /** A fixture bridge answering the node-scoped registry read with `reply`. */
  function bridgeAnswering(reply: unknown): ConsoleBridge {
    return createFixtureBridge({ scenario: railScenarioAnsweringRegistry(reply) });
  }

  it("renders a chip from the registry read with an EMPTY session timeline", async () => {
    // The whole finding, as one case. The session store is given nothing, so a chip
    // on screen can only have come from the account plane — which is where the
    // registered wire puts this data, and where the session timeline never could.
    const container = await mountRailSettled([], { bridge: bridgeAnswering(ONE_URGENT_QUOTA) });

    const chip = container.querySelector(".meridian-rate-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Rail team");
    expect(chip?.textContent).toContain("Weekly, all models");
  });

  it("negative control: no chip appears when the registry answers with no account", async () => {
    // Without this the case above would hold over a rail that rendered a chip from
    // anything at all, including the fixture's own defaults.
    const container = await mountRailSettled([], { bridge: bridgeAnswering(EMPTY_REGISTRY) });

    expect(container.querySelector(".meridian-rate-chip")).toBeNull();
    // Scoped to the meters: the rail renders the queue read's own refusal too, and
    // a document-wide query here would be answered by whichever read failed.
    expect(container.querySelector(".meridian-composer__meters .meridian-refusal")).toBeNull();
  });

  it("says the registry could not be read rather than looking like a healthy node", async () => {
    // A chip's absence is not a health reading. A read that failed and a node whose
    // quotas are all fine render identically unless the refusal is on screen.
    //
    // THE CODE IS THE FIXTURE'S AND NO LONGER THE SURFACE'S. A scenario cannot hand a
    // surface a reply the corpus does not register for that method any more: the
    // fixture refuses the SCRIPT with `reply-off-contract` before the rail sees it, so
    // what this asserts is that a refusal reaches the meters carrying the code it was
    // given — which is the property the case is about — rather than which of the two
    // refusals upstream produced it.
    const container = await mountRailSettled([], {
      bridge: bridgeAnswering({ accounts: "not a list" }),
    });

    const refusal = container.querySelector(".meridian-composer__meters .meridian-refusal");
    expect(refusal).not.toBeNull();
    expect(refusal?.textContent).toContain("reply-off-contract");
  });
});

describe("ComposerAccessoryRail — an unreadable delivery is said beside the chips", () => {
  /**
   * The fixture bridge with the account-plane tail's own handler captured.
   *
   * Captured rather than scripted because what is being claimed is what happens AFTER
   * the read has settled, and a scenario beat would put that moment on the fixture's
   * clock instead of on the case's — the same reason the reading's own test captures
   * its tail. Through the bridge family's own helper, so every other stream the rail
   * opens is still the fixture's.
   */
  function bridgeWithCapturedAccountTail(reply: unknown): StreamUnderTest {
    return withCapturedStream(
      createFixtureBridge({ scenario: railScenarioAnsweringRegistry(reply) }),
      PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
    );
  }

  it("keeps the chip and says the tail is incomplete", async () => {
    // Beside the chip and never instead of it: the reading on screen is the best the
    // console has, and what the notice adds is that the tail carrying the next one is
    // incomplete — which an unreadable `account_removed` or `usage_window_updated`
    // used to hide entirely.
    const plane = bridgeWithCapturedAccountTail(ONE_URGENT_QUOTA);
    const container = await mountRailSettled([], { bridge: plane.bridge });
    await act(async () => {
      plane.deliver({ kind: "account_removed" });
    });

    const partial = container.querySelector(".meridian-quota-partial");
    expect(partial).not.toBeNull();
    expect(partial?.textContent).toContain("could not be read");
    expect(partial?.querySelector(".meridian-refusal")?.textContent).toContain(
      "delivery-unreadable",
    );
    expect(container.querySelector(".meridian-rate-chip")).not.toBeNull();
  });

  it("negative control: a readable delivery leaves no notice at all", async () => {
    // Without this the case above would hold over a rail that rendered the notice
    // whenever the tail delivered anything.
    const plane = bridgeWithCapturedAccountTail(ONE_URGENT_QUOTA);
    const container = await mountRailSettled([], { bridge: plane.bridge });
    await act(async () => {
      plane.deliver({ kind: "account_removed", accountId: "acct-elsewhere" });
    });

    expect(container.querySelector(".meridian-quota-partial")).toBeNull();
    expect(container.querySelector(".meridian-rate-chip")).not.toBeNull();
  });
});
