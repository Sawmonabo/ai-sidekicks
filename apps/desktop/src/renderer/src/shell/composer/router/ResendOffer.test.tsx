// The resend offer, and the target it belongs to.
//
// Split along the seam the component was. An offer is about one undelivered body at
// one address; carrying it across an address change would offer to send a person's
// words to a run they did not write them for.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FIRST_AGENT_ID,
  FIRST_RUN_ID,
  SECOND_AGENT_ID,
  answerSteer,
  mountAddressable,
  stubBridge,
} from "./composer-send-bar.test-support.js";

describe("ComposerSendBar — a resend offer belongs to the target it was written for", () => {
  it("withholds the offer under a target the body was not written for", async () => {
    // The defect: the last sent body outlived the address it was sent under, so the
    // second agent's tripwire card offered the first agent's words — and pressing
    // "Send again" sent them there. The card itself still renders; only the offer is
    // gone, which is what `ResendOffer` already does with no body.
    const calls: string[] = [];
    const bar = mountAddressable(
      stubBridge(async (method, params) => {
        calls.push(JSON.stringify(params));
        return await answerSteer(method);
      }),
    );

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });
    expect(bar.resend()).not.toBeNull();

    bar.address(SECOND_AGENT_ID);
    expect(bar.result.container.textContent).toContain("driver.text_neutralization_failed");
    expect(bar.resend()).toBeNull();
  });

  it("does not restore the offer on returning to the address it was written at", async () => {
    // The contract this surface states — "`undefined` once the composer is
    // re-addressed" — and the half a read-time comparison could not keep. Held in a
    // hook-wide `useState` and merely HIDDEN by an address guard, the body was still
    // there and the return trip offered it again: a resend card standing minutes
    // later, attached to nothing the person just did, next to a run whose state has
    // moved on. The offer is now held under `(bridge, draftKey)`, which re-seeds on
    // the render that first sees a subject — so leaving drops it rather than hiding
    // it, and the whole record goes with a bridge replacement too.
    const bar = mountAddressable(stubBridge(answerSteer));

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });
    expect(bar.resend()).not.toBeNull();

    bar.address(SECOND_AGENT_ID);
    expect(bar.resend()).toBeNull();

    bar.address(FIRST_AGENT_ID);
    expect(bar.resend()).toBeNull();
  });

  it("resends that body to its own target, once", async () => {
    const sent: unknown[] = [];
    const bar = mountAddressable(
      stubBridge(async (method, params) => {
        sent.push(params);
        return await answerSteer(method);
      }),
    );

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });
    await act(async () => {
      bar.resend()?.click();
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      targetRunId: FIRST_RUN_ID,
      content: "keep going on the parser",
    });
  });
});
