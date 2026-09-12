// The durable authority a started session is stamped with, across a visit elsewhere.
//
// THE DEFECT, WHICH NOTHING ON SCREEN SHOWS. A person starts a session, is carried
// into it, comes back to the list, turns the auto-pin switch off or rearranges the
// tiers by hand, and then sends their first message into the draft. Every mount of
// this destination used to build its own durable holder, so the second visit minted a
// second preference store and a second pin store over the ONE database this window
// has — and the authority stamped by the first visit went on resolving through the
// first pair. The send then read a switch nobody was changing any more, and wrote a
// pin map from before the person rearranged it over the one they had just arranged.
//
// DRIVEN THROUGH THE WHOLE DESTINATION, TWICE, on `session-start.test.tsx`' reasoning
// one file over: the defect is a LIFETIME, and a case that called the authority's
// verbs directly would prove their arithmetic while mounting nothing that could have
// the defect. The unmount between the two renders is the navigation — `cleanup` is
// how a case leaves a destination — and both renders are handed the SAME context, so
// the `UiStateStore` identity holds across them exactly as this window's does.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contextWith } from "../session-surface.context.test-support.js";
import { renderSurface, settle } from "../session-surface.test-support.js";
import {
  CREATED_SESSION_ID,
  installProbeBridge,
  pressStart,
  uninstallProbeBridge,
} from "./probe-bridge.test-support.js";
import { settleFirstSendAutoPin } from "../../seats/index.js";
import { SESSION_PIN_TIERS_KEY } from "../rows/session-pins.js";
import type { ConsoleSurfaceContext } from "../../seats/index.js";

/** A session the node's directory answers for, so the list draws a row with a menu. */
const LISTED_SESSION_ID = "019b78c9-0a80-7b31-9c40-4f0a0b6d1234";

/** A create that settles with a session, on `session-start.test.tsx`' own shape. */
function creatingBridge(): void {
  installProbeBridge(
    vi.fn().mockResolvedValue({
      sessionId: CREATED_SESSION_ID,
      state: "active",
      channels: [],
    }),
  );
}

/** Mount the destination, press Start, let the create settle, and then leave. */
async function startASessionAndLeave(context: ConsoleSurfaceContext): Promise<void> {
  const { container } = renderSurface(context);
  await settle();
  pressStart(container);
  await settle();
  // The navigation the act performs, as a test can perform it: the destination that
  // stamped the authority is gone, and what comes back is a fresh mount of it.
  cleanup();
}

/** Come back to the list, the way the rail does. */
async function returnToTheList(context: ConsoleSurfaceContext): Promise<HTMLElement> {
  const { container } = renderSurface(context);
  await settle();
  return container;
}

/** Turn the auto-pin switch off, the way a person does. */
function turnAutoPinOff(container: HTMLElement): void {
  const control = container.querySelector<HTMLInputElement>(".meridian-auto-pin__switch input");
  if (control === null) {
    throw new Error("the destination rendered no auto-pin switch");
  }
  act(() => {
    control.click();
  });
}

/** Pin one listed row to the front tier through its own context menu. */
function pinFromRowMenu(container: HTMLElement, sessionId: string): void {
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Where ${sessionId} sits in the list"]`,
  );
  if (trigger === null) {
    throw new Error(`the list drew no place menu for ${sessionId}`);
  }
  act(() => {
    trigger.click();
  });
  // The popup is PORTALLED, so its items are in the document rather than under the
  // surface root this harness answers with.
  const move = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (item) => item.textContent === "Pin to the front tier",
  );
  if (move === undefined) {
    throw new Error("the place menu offered no move to the front tier");
  }
  act(() => {
    move.click();
  });
}

describe("the auto-pin authority a settled start stamps", () => {
  afterEach(() => {
    uninstallProbeBridge();
    vi.clearAllMocks();
  });

  it("reads the switch as the destination's newest mount left it", async () => {
    creatingBridge();
    const context = contextWith({ bridgeSource: "live" });
    await startASessionAndLeave(context);

    const container = await returnToTheList(context);
    turnAutoPinOff(container);
    await settle();

    // The rule's own reason and not this port's: the switch is off, so nothing is
    // pinned automatically — which is what the person just asked for.
    expect(settleFirstSendAutoPin(context.bridge, CREATED_SESSION_ID)).toStrictEqual({
      pinned: false,
      because: "setting-off",
    });
  });

  it("negative control: a return that changes nothing still pins", async () => {
    // Without this, the case above would pass over an authority the unmount simply
    // broke — an answer of "not pinned" for every session started before a
    // navigation, which is the same surface wrong in the other direction.
    creatingBridge();
    const context = contextWith({ bridgeSource: "live" });
    await startASessionAndLeave(context);

    await returnToTheList(context);

    expect(settleFirstSendAutoPin(context.bridge, CREATED_SESSION_ID)).toStrictEqual({
      pinned: true,
    });
  });

  it("leaves a pin the newest mount made standing rather than writing over it", async () => {
    creatingBridge();
    const context = contextWith({
      bridgeSource: "live",
      directorySessionIds: [LISTED_SESSION_ID],
    });
    await startASessionAndLeave(context);

    const container = await returnToTheList(context);
    pinFromRowMenu(container, LISTED_SESSION_ID);
    await settle();

    expect(settleFirstSendAutoPin(context.bridge, CREATED_SESSION_ID)).toStrictEqual({
      pinned: true,
    });
    await settle();

    // Read back off the store itself rather than off the screen: what the defect
    // destroyed was the durable record, and a stale writer spreading its own copy of
    // the map leaves the person's manual pin nowhere at all.
    const record = await context.uiStateStore.readGlobal(SESSION_PIN_TIERS_KEY);
    expect(record?.value).toStrictEqual({
      [LISTED_SESSION_ID]: "front",
      [CREATED_SESSION_ID]: "front",
    });
  });
});
