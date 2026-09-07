// One window's standing offer: what replaces it, what spends it, and what does not.
//
// THE PROPERTIES WORTH A FILE ARE THE TWO THAT ARE INVISIBLE WHEN THEY BREAK. An
// offer that is not spent by its claim attaches the same definition again the next
// time a form opens, which reads as the console deciding to attach something nobody
// asked for a second time. And an offer honoured by a form scoped to a DIFFERENT
// session puts an agent in a session that was never named — a wrong act rather than a
// missing one, and the kind a screenshot cannot show.

import { describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { AttachHandoff, attachHandoffFor } from "./attach-handoff.js";

const SESSION_ID = "session-9";
const OTHER_SESSION_ID = "session-10";

/** One offer, in the shape the offering surface makes one. */
function offerOf(definitionId: string, sessionId: string = SESSION_ID) {
  return { sessionId, definitionId, definitionName: "Reviewer" };
}

describe("the attach handoff — what one window is holding", () => {
  it("holds the offer it was given", () => {
    const handoff = new AttachHandoff();

    handoff.offer(offerOf("definition-1"));

    expect(handoff.standingOffer).toEqual(offerOf("definition-1"));
  });

  it("holds ONE offer, so a second press replaces the first", () => {
    // A queue would attach the definition somebody abandoned before the one they
    // meant, and nothing on this surface says which of two offers is current.
    const handoff = new AttachHandoff();

    handoff.offer(offerOf("definition-1"));
    handoff.offer(offerOf("definition-2"));

    expect(handoff.standingOffer?.definitionId).toBe("definition-2");
  });

  it("takes the offer back when it is withdrawn", () => {
    const handoff = new AttachHandoff();
    handoff.offer(offerOf("definition-1"));

    handoff.withdraw();

    expect(handoff.standingOffer).toBeUndefined();
  });

  it("starts holding nothing, which is not the same as holding an empty offer", () => {
    expect(new AttachHandoff().standingOffer).toBeUndefined();
  });
});

describe("the attach handoff — claiming", () => {
  it("hands the offer to the session it was made for", () => {
    const handoff = new AttachHandoff();
    handoff.offer(offerOf("definition-1"));

    expect(handoff.claim(SESSION_ID)).toEqual(offerOf("definition-1"));
  });

  it("spends the offer, so a second claim gets nothing", () => {
    // The defect this exists for: an offer that survived its claim would re-open the
    // form on the same definition every time the definition read moved.
    const handoff = new AttachHandoff();
    handoff.offer(offerOf("definition-1"));

    handoff.claim(SESSION_ID);

    expect(handoff.claim(SESSION_ID)).toBeUndefined();
    expect(handoff.standingOffer).toBeUndefined();
  });

  it("negative control: another session neither takes the offer nor spends it", () => {
    // An agent joins a session. Honouring an offer in a session nobody named would be
    // the console choosing where the agent lands.
    const handoff = new AttachHandoff();
    handoff.offer(offerOf("definition-1"));

    expect(handoff.claim(OTHER_SESSION_ID)).toBeUndefined();
    expect(handoff.standingOffer).toEqual(offerOf("definition-1"));
  });

  it("claims nothing where nothing was offered", () => {
    expect(new AttachHandoff().claim(SESSION_ID)).toBeUndefined();
  });
});

describe("the attach handoff — who is told", () => {
  it("tells a watcher on every act that moves the offer", () => {
    const handoff = new AttachHandoff();
    const watcher = vi.fn();
    handoff.watch(watcher);

    handoff.offer(offerOf("definition-1"));
    handoff.claim(SESSION_ID);
    handoff.offer(offerOf("definition-2"));
    handoff.withdraw();

    expect(watcher).toHaveBeenCalledTimes(4);
  });

  it("says nothing on a withdrawal that withdrew nothing", () => {
    // A notification for an act that changed no state is a render for nothing, which
    // is what the console's own budget rules are about.
    const handoff = new AttachHandoff();
    const watcher = vi.fn();
    handoff.watch(watcher);

    handoff.withdraw();

    expect(watcher).not.toHaveBeenCalled();
  });

  it("says nothing on a claim another session did not take", () => {
    const handoff = new AttachHandoff();
    handoff.offer(offerOf("definition-1"));
    const watcher = vi.fn();
    handoff.watch(watcher);

    handoff.claim(OTHER_SESSION_ID);

    expect(watcher).not.toHaveBeenCalled();
  });

  it("stops telling a watcher that stopped watching", () => {
    const handoff = new AttachHandoff();
    const watcher = vi.fn();
    const stop = handoff.watch(watcher);

    stop();
    handoff.offer(offerOf("definition-1"));

    expect(watcher).not.toHaveBeenCalled();
  });
});

describe("the attach handoff — one per window", () => {
  /** A bridge-shaped key. The handoff keys on identity and reads no member of it. */
  function bridgeKey(): ConsoleBridge {
    return {} as ConsoleBridge;
  }

  it("answers one handoff for one bridge, however often it is asked", () => {
    const bridge = bridgeKey();

    expect(attachHandoffFor(bridge)).toBe(attachHandoffFor(bridge));
  });

  it("negative control: a second window holds a handoff of its own", () => {
    // Keyed on the bridge because the offer is a fact about ONE window's intent. A
    // process-wide handoff would hand an auxiliary window an offer made in the main
    // one, and take it away from the surface that was waiting for it.
    const first = attachHandoffFor(bridgeKey());
    const second = attachHandoffFor(bridgeKey());

    first.offer(offerOf("definition-1"));

    expect(second.standingOffer).toBeUndefined();
  });
});
