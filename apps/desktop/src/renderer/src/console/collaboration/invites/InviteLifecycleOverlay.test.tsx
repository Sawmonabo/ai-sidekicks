// The window's invite lifecycle: what it opens, what it announces, and where it goes.
//
// THE PROPERTY WORTH THE MOST IS THAT NONE OF IT NEEDS A SESSION. A deep-link
// invitation is about a session this window is NOT in, and the recipient it reaches
// most often has opened none at all — so every case here drives the overlay with no
// session store anywhere in the tree. Mounted under the members section, as it once
// was, the two feeds opened only while a session view was on screen and none of this
// was reachable.
//
// The card's own readings are `InviteConfirmation.test.tsx`; the lifecycle's state
// machine is `pending-invite.test.ts`; the shell's `inert` guard over the same mount is
// `InviteLifecycleOverlay.modal-surface.test.tsx`, which is its own file because it
// asserts a fact nothing renders. What is asserted here is the HOSTING: which acts each
// entry point dispatches, and what the window does when a join lands.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createFixtureBridge,
  type GrowthOutcome,
  type GrowthPendingInviteState,
} from "../../bridge/index.js";
import { FixtureGrowthStream } from "../../bridge/fixture/fixture-growth-stream.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  closeThroughBackdrop,
  closeThroughEscape,
  mountOverlay,
  press,
} from "./invite-lifecycle-overlay.test-support.js";
import {
  FIRST_SESSION,
  PENDING_INVITE_ATTEMPT,
  readyPreview,
  refusedPreview,
  scenarioWithArrivals,
  unavailablePreview,
} from "./pending-invite.test-support.js";

/** What one mount over a hand-built pending feed hands back, plus what it retried. */
interface MountedArrivals {
  readonly body: HTMLElement;
  readonly retries: readonly unknown[];
}

/** How the scripted `invite.retryPending` answers the one press that reaches it. */
type RetryAnswer = (request: unknown) => Promise<GrowthOutcome<undefined>>;

/** The answer a retry gets unless a case wants the refused arm instead. */
const RETRY_SERVED: RetryAnswer = async () =>
  await Promise.resolve({ status: "served", value: undefined });

/**
 * Mount the overlay over a pending feed carrying exactly these arrivals, in order.
 *
 * The narrow exception `pending-invite.previews.test.ts` already takes, for the same
 * reason: the scenario table scripts INVITATIONS, so the two arms a preview reaches
 * when it produces none are the two states it cannot express. Everything else here —
 * the retry operation included — is the real fixture growth port.
 */
async function mountOverPendingFeed(
  arrivals: readonly GrowthPendingInviteState[],
  answerRetry: RetryAnswer = RETRY_SERVED,
): Promise<MountedArrivals> {
  const retries: unknown[] = [];
  const bridge = fixtureBridgeWithGrowth(scenarioWithArrivals(), {
    invitePendingSubscribe: async () => {
      const feed = new FixtureGrowthStream<GrowthPendingInviteState>();
      for (const arrival of arrivals) {
        feed.push(arrival);
      }
      return await Promise.resolve({ status: "served", value: feed });
    },
    inviteRetryPending: async (request) => {
      retries.push(request);
      return await answerRetry(request);
    },
  });
  const { body } = await mountOverlay(bridge);
  return { body, retries };
}

describe("the invite lifecycle — with no session open at all", () => {
  it("opens its feeds and announces the arrival", async () => {
    const { body } = await mountOverlay();
    expect(body.textContent ?? "").toContain("invitations waiting");
    expect(body.querySelector(".meridian-invite-notice")).not.toBeNull();
  });

  it("opens nothing by itself", async () => {
    // The arrival is on somebody else's schedule. A dialog that opened itself would
    // take the screen from whatever was being done.
    const { body } = await mountOverlay();
    expect(body.querySelector(".meridian-invite-confirmation")).toBeNull();
  });

  it("opens the confirmation on the press", async () => {
    const { body } = await mountOverlay();
    await press(body, "meridian-invite-notice__open");
    expect(body.querySelector(".meridian-invite-confirmation")).not.toBeNull();
    expect(body.textContent ?? "").toContain("Design review");
  });

  it("negative control: a scenario that scripts no arrival announces nothing", async () => {
    // Without this every case above would pass over an overlay that drew its notice
    // whether or not an invitation had come.
    const { body } = await mountOverlay(
      createFixtureBridge({ scenario: { ...scenarioWithArrivals(), pendingInvites: [] } }),
    );
    expect(body.querySelector(".meridian-invite-notice")).toBeNull();
  });
});

describe("the invite lifecycle — every dismissal releases the reference", () => {
  /** Open the card, then close it the named way, and report what the notice says after. */
  async function dismissThrough(close: (body: HTMLElement) => Promise<void>): Promise<HTMLElement> {
    const { body } = await mountOverlay();
    await press(body, "meridian-invite-notice__open");
    await close(body);
    return body;
  }

  /**
   * The head has moved on exactly when the card no longer names the first arrival.
   *
   * Read off the notice rather than off a spy on the port: what the fixture's
   * `inviteDismissPending` did is the lifecycle's own claim, already covered next
   * door, and this file is about which entry points reach it. The second invitation
   * carries no session name, so the queue having advanced is visible on screen.
   */
  function stillNamesTheFirstArrival(body: HTMLElement): boolean {
    return (body.textContent ?? "").includes("Design review");
  }

  it("releases it from the control", async () => {
    const body = await dismissThrough(async (root) => {
      await press(root, "meridian-invite-confirmation__dismiss");
    });
    expect(stillNamesTheFirstArrival(body)).toBe(false);
  });

  it("releases it on Escape", async () => {
    const body = await dismissThrough(closeThroughEscape);
    expect(stillNamesTheFirstArrival(body)).toBe(false);
  });

  it("releases it on a press outside it", async () => {
    const body = await dismissThrough(closeThroughBackdrop);
    expect(stillNamesTheFirstArrival(body)).toBe(false);
  });

  it("negative control: opening and reading it releases nothing", async () => {
    // Without this the three cases above would pass over a lifecycle that dropped the
    // head on any interaction at all, including the press that only opened the card.
    const { body } = await mountOverlay();
    await press(body, "meridian-invite-notice__open");
    expect(stillNamesTheFirstArrival(body)).toBe(true);
  });
});

describe("the invite lifecycle — where a join takes the window", () => {
  it("opens the session the joined outcome names", async () => {
    const { body, openSession } = await mountOverlay();
    await press(body, "meridian-invite-notice__open");
    expect(openSession).not.toHaveBeenCalled();
    await press(body, "meridian-invite-confirmation__confirm");
    expect(openSession.mock.calls).toStrictEqual([[FIRST_SESSION]]);
  });

  it("navigates once, however many times the settled card re-renders", async () => {
    // The outcome stays on the reading until it is acknowledged, so every later pass
    // sees the same `joined` frame; a guard that was a boolean rather than the
    // attempt's own reference would either navigate twice or swallow the next join.
    const { body, openSession } = await mountOverlay();
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-confirmation__confirm");
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("negative control: an outcome that is not a join navigates nowhere", async () => {
    // The second arrival settles `authentication-required`, which is a step the
    // person completes rather than a membership — navigating there would open a
    // session nobody is a member of yet.
    const { body, openSession } = await mountOverlay();
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-confirmation__dismiss");
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-confirmation__confirm");
    expect(body.textContent ?? "").toContain("Sign in to finish joining.");
    expect(openSession).not.toHaveBeenCalled();
  });
});

describe("the invite lifecycle — a deep link that produced no invitation", () => {
  // The defect this block exists for: the notice drew for the ready arm alone, so a
  // refused preview and one that could not be put at all arrived, were held by the
  // lifecycle, and reached no screen — and the retry the `unavailable` arm carries the
  // handle for was reachable from no control anywhere in the console.

  it("announces a link that did not open, rather than an invitation that is waiting", async () => {
    const { body } = await mountOverPendingFeed([refusedPreview()]);
    const text = body.textContent ?? "";
    expect(text).toContain("An invitation link did not open.");
    expect(text).not.toContain("invitation waiting");
  });

  it("negative control: an invitation that DID open is still announced as one", async () => {
    // Without this the case above would pass over a notice that had stopped
    // distinguishing the two readings and reported every arrival as a failure.
    const { body } = await mountOverlay();
    expect(body.textContent ?? "").toContain("invitations waiting");
  });

  it("opens the same card on the same press, and names the refusal in it", async () => {
    const { body } = await mountOverPendingFeed([refusedPreview()]);
    expect(body.querySelector(".meridian-invite-confirmation")).toBeNull();
    await press(body, "meridian-invite-notice__open");
    const text = body.textContent ?? "";
    expect(text).toContain("invite.expired");
    expect(text).toContain("Ask whoever sent it for a fresh link");
  });

  it("puts the preview again through the lifecycle's own retry, on the attempt handle", async () => {
    // The whole point of the arm: the control reaches `invite.retryPending` carrying the
    // handle that names which outstanding deep link this is, and never a reference.
    const { body, retries } = await mountOverPendingFeed([unavailablePreview()]);
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-outcome__retry");
    expect(retries).toEqual([{ attempt: PENDING_INVITE_ATTEMPT }]);
  });

  it("closes the card once the retried head is released, without a second press", async () => {
    // A served retry releases the head, because its answer arrives as a fresh pending
    // state rather than in this card. Nothing is left to look at, so nothing is shown.
    const { body } = await mountOverPendingFeed([unavailablePreview()]);
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-outcome__retry");
    expect(body.querySelector(".meridian-invite-confirmation")).toBeNull();
    expect(body.querySelector(".meridian-invite-notice")).toBeNull();
  });

  it("puts a refused preview away on its own control, and it stays away", async () => {
    const { body } = await mountOverPendingFeed([refusedPreview()]);
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-outcome__acknowledge");
    expect(body.querySelector(".meridian-invite-notice")).toBeNull();
  });
});

describe("the invite lifecycle — one gesture opens one prompt", () => {
  // The defect this block exists for: the card's open state was a bare flag, so it
  // survived the prompt it had been opened for. A served retry releases its head, and
  // with anything queued behind it the dialog swapped straight to the next prompt —
  // an invitation nobody had pressed **Look at it** for, on screen without the gesture
  // every arrival is supposed to need.

  it("closes when a served retry releases the head a second prompt is queued behind", async () => {
    const { body } = await mountOverPendingFeed([unavailablePreview(), readyPreview()]);
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-outcome__retry");

    // The queue moved on rather than emptying, so there IS something to look at — and
    // the card is closed over it, because it is not what the gesture was made for.
    expect(body.querySelector(".meridian-invite-confirmation")).toBeNull();
    expect(body.textContent ?? "").toContain("You have an invitation waiting.");
  });

  it("opens the prompt that moved up on its own press, and only then", async () => {
    // The other half: the gesture is REQUIRED rather than the arrival being hidden, so
    // the same press that opened the first prompt opens the one behind it.
    const { body } = await mountOverPendingFeed([unavailablePreview(), readyPreview()]);
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-outcome__retry");
    await press(body, "meridian-invite-notice__open");

    expect(body.querySelector(".meridian-invite-confirmation")).not.toBeNull();
    expect(body.querySelector(".meridian-invite-confirmation__confirm")).not.toBeNull();
  });

  it("negative control: a REFUSED retry keeps the card open, with the refusal in it", async () => {
    // Without this the two cases above would pass over a card that closed on every
    // retry press — which would take a refused retry off the screen along with the
    // words explaining why it refused, on the one arm where the head has not moved.
    const { body } = await mountOverPendingFeed(
      [unavailablePreview(), readyPreview()],
      growthRefusing("inviteRetryPending"),
    );
    await press(body, "meridian-invite-notice__open");
    await press(body, "meridian-invite-outcome__retry");

    expect(body.querySelector(".meridian-invite-confirmation")).not.toBeNull();
    expect(body.textContent ?? "").toContain("wire-unregistered");
  });
});
