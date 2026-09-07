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
// machine is `pending-invite.test.ts`. What is asserted here is the HOSTING: which
// acts each entry point dispatches, and what the window does when a join lands.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { InviteLifecycleOverlay } from "./InviteLifecycleOverlay.js";
import { FIRST_SESSION, scenarioWithArrivals } from "./pending-invite.test-support.js";

/** What one mount of the overlay hands back to a case. */
interface MountedOverlay {
  readonly body: HTMLElement;
  readonly openSession: ReturnType<typeof vi.fn>;
}

/**
 * Mount the overlay over a scripted arrival, with no session anywhere in the tree.
 *
 * The bridge is the only thing it is given, which is the claim: this lifecycle is
 * bridge-scoped, so a window that has opened nothing still receives what arrives.
 */
async function mountOverlay(bridge?: ConsoleBridge): Promise<MountedOverlay> {
  const openSession = vi.fn();
  const resolved = bridge ?? createFixtureBridge({ scenario: scenarioWithArrivals() });
  const { container } = render(
    <InviteLifecycleOverlay bridge={resolved} openSession={openSession} />,
  );
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  return { body: container.ownerDocument.body, openSession };
}

/** Press one control by the class it carries, letting whatever it dispatched settle. */
async function press(root: HTMLElement, className: string): Promise<void> {
  const found = root.querySelector<HTMLButtonElement>(`.${className}`);
  if (found === null) {
    throw new Error(`no ${className}`);
  }
  await act(async () => {
    found.click();
    await crossMacrotaskBoundary();
  });
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
    const body = await dismissThrough(async (root) => {
      const popup = root.querySelector(".meridian-invite-confirmation");
      if (popup === null) {
        throw new Error("no popup");
      }
      await act(async () => {
        popup.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await crossMacrotaskBoundary();
      });
    });
    expect(stillNamesTheFirstArrival(body)).toBe(false);
  });

  it("releases it on a press outside it", async () => {
    const body = await dismissThrough(async (root) => {
      const backdrop = root.querySelector(".meridian-invite-confirmation__backdrop");
      if (backdrop === null) {
        throw new Error("no backdrop");
      }
      await act(async () => {
        backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        backdrop.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await crossMacrotaskBoundary();
      });
    });
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
