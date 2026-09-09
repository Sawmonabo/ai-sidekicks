// Putting away an acceptance that never reached the control plane.
//
// ITS OWN FILE BESIDE `InviteLifecycleOverlay.test.tsx`, which asserts what each entry
// point dispatches over a head nobody has answered yet. What is here is the other
// half: which act each of those same three entry points reaches once an ANSWER has
// arrived, and that is decided by what main is still holding rather than by whether an
// answer exists.
//
// THE DEFECT THIS FILE EXISTS FOR. `unavailable` was classified with the five terminal
// arms, so **Done**, Escape and the backdrop alike put the card away and released
// nothing — while the wire's own `retryable` says the acceptance was never sent and
// main is still holding the reference. Two consequences, neither visible on screen:
// the handle stayed allocated until its TTL, and reopening or replaying the pending
// feed surfaced the same invitation again after the person had put it away.
//
// WHAT IS ASSERTED IS THE DISPATCH AND NOT THE FIXTURE'S BOOKKEEPING. The port is
// recorded rather than replaced wholesale, so each case reads the request the console
// actually put on the wire — a claim about what this window asked main to do, which is
// the whole of what the defect got wrong.

import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { ConsoleScenario } from "../../bridge/scenario/runtime/vocabulary.js";
import {
  closeThroughBackdrop,
  closeThroughEscape,
  mountOverlay,
  press,
} from "./invite-lifecycle-overlay.test-support.js";
import {
  FIRST_REFERENCE,
  scenarioWithArrivals,
  scenarioWithUnsentAcceptance,
} from "./pending-invite.test-support.js";

/** One mount over a scripted answer, and every dismissal the console dispatched. */
interface MountedAnswer {
  readonly body: HTMLElement;
  readonly dismissals: readonly unknown[];
}

/** How the recorded `invite.dismissPending` answers, where a case wants to decide it. */
type DismissAnswer = ConsoleBridge["growth"]["inviteDismissPending"];

/**
 * Mount over a scenario, confirm its first invitation, and hold what that answered.
 *
 * The confirmation is dispatched HERE rather than per case because it is the setup
 * every case shares — the answer is what each of them is about, and a case composing
 * its own would be four spellings of one arrival.
 */
async function answeredCard(
  scenario: ConsoleScenario,
  answerDismissal?: DismissAnswer,
): Promise<MountedAnswer> {
  const dismissals: unknown[] = [];
  const bridge = fixtureBridgeWithGrowth(scenario, {
    inviteDismissPending: async (request) => {
      dismissals.push(request);
      return await (answerDismissal ?? served)(request);
    },
  });
  const { body } = await mountOverlay(bridge);
  await press(body, "meridian-invite-notice__open");
  await press(body, "meridian-invite-confirmation__confirm");
  return { body, dismissals };
}

/** What a dismissal gets unless a case wants the refused arm instead. */
const served: DismissAnswer = async () =>
  await Promise.resolve({ status: "served", value: undefined });

/** The one request a released reference produces, asserted whole. */
const RELEASED_FIRST_REFERENCE: readonly unknown[] = [{ reference: FIRST_REFERENCE }];

describe("the invite lifecycle — closing an acceptance that was never sent", () => {
  it("reports it as unsent before anything is closed", async () => {
    // The premise every case below rests on: the card is showing the `unavailable`
    // answer, which is what makes closing it a release rather than a tidy-up.
    const { body, dismissals } = await answeredCard(scenarioWithUnsentAcceptance());
    expect(body.textContent ?? "").toContain("This acceptance could not be sent.");
    expect(dismissals).toStrictEqual([]);
  });

  it("releases the reference from the control on the answer", async () => {
    const { body, dismissals } = await answeredCard(scenarioWithUnsentAcceptance());
    await press(body, "meridian-invite-outcome__acknowledge");
    expect(dismissals).toStrictEqual(RELEASED_FIRST_REFERENCE);
  });

  it("releases it on Escape", async () => {
    const { body, dismissals } = await answeredCard(scenarioWithUnsentAcceptance());
    await closeThroughEscape(body);
    expect(dismissals).toStrictEqual(RELEASED_FIRST_REFERENCE);
  });

  it("releases it on a press outside it", async () => {
    const { body, dismissals } = await answeredCard(scenarioWithUnsentAcceptance());
    await closeThroughBackdrop(body);
    expect(dismissals).toStrictEqual(RELEASED_FIRST_REFERENCE);
  });

  it("dispatches exactly one, however the card then goes away", async () => {
    // The latch's own claim, read at the seam that matters: the head is released on
    // the dismissal's settlement, so a second close gesture against the same answer
    // has nothing left to address and puts no second act on the wire.
    const { body, dismissals } = await answeredCard(scenarioWithUnsentAcceptance());
    await press(body, "meridian-invite-outcome__acknowledge");
    await press(body, "meridian-invite-notice__open");
    expect(dismissals).toStrictEqual(RELEASED_FIRST_REFERENCE);
  });

  it("negative control: an answer that DID spend its reference releases nothing", async () => {
    // Without this every case above would pass over a card that dismissed on every
    // close — which would send `invite.dismissPending` against a handle main let go
    // when the acceptance landed. The scripted first arrival joins, so its reference
    // is consumed and closing is local by construction.
    const { body, dismissals } = await answeredCard(scenarioWithArrivals());
    await press(body, "meridian-invite-outcome__acknowledge");
    expect(dismissals).toStrictEqual([]);
    expect(body.querySelector(".meridian-invite-confirmation")).toBeNull();
  });

  it("keeps the card, the answer and the reference when the dismissal is refused", async () => {
    // The other half of routing the close through main: the release is now something
    // that can FAIL, so the card has to survive one that did. A handler that cleared
    // the prompt on the way out would take the refusal off screen with it and leave
    // the person looking at a notice with no account of why the invitation came back.
    const { body, dismissals } = await answeredCard(
      scenarioWithUnsentAcceptance(),
      growthRefusing("inviteDismissPending"),
    );
    await press(body, "meridian-invite-outcome__acknowledge");

    expect(dismissals).toStrictEqual(RELEASED_FIRST_REFERENCE);
    expect(body.querySelector(".meridian-invite-confirmation")).not.toBeNull();
    expect(body.textContent ?? "").toContain("wire-unregistered");
    expect(body.textContent ?? "").toContain("This acceptance could not be sent.");
  });
});
