// Where the emitter's audience actually comes from.
//
// `attention-notifier.test.ts` beside this drives the class over an audience each case
// composes by hand, which is the right shape for the history rules — the baseline, the
// dedup, the eviction — and says nothing about where a real window's audience comes
// from. That is where the defect was. The rule was correct as written: a focused window
// parked on a session already shows that session's attention, so a banner about it
// would interrupt somebody about the thing in front of them. What was wrong is what
// answered it. `FrameStore` opened `isWindowFocused: true` and moved that cell only on
// a transition, so a window that opened WITHOUT focus never received the `blur` that
// would have corrected it — and every new item of its active session was withheld from
// a person who was not looking at anything.
//
// SO THESE CASES MOUNT THE HOOK OVER A REAL STORE, built under a document that reports
// what a real window's document would. A case that composed the audience itself would
// pass against the defect and against the fix alike, because the value it asserts on is
// the value it wrote.
//
// THE FRAME OWNS THE LISTENER and this file does not reach for it: `frame/ConsoleRoot.
// test.tsx` drives the real focus and blur pair against the real registry. What is
// proved here is the other half — that the cell starts from the document, and that the
// emitter reads the cell rather than assuming it — with the last case joining the two,
// since the seed is a starting point and not a verdict.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AttentionItem, ConsoleBridge } from "../../bridge/index.js";
import {
  FOCUSED_DOCUMENT,
  UNFOCUSED_DOCUMENT,
  underDocumentFocus,
  type DocumentFocusReading,
} from "../../store/document-focus.test-support.js";
import { FrameStore } from "../../store/index.js";
import { AttentionPlane, type AttentionReading } from "./attention-plane.js";
import { useAttentionNotifications } from "./attention-notifier.js";
import type { OsNotificationDelivery } from "./os-notification-delivery.js";

/** The session the window is parked on — the one a focused window would suppress. */
const ACTIVE_SESSION_ID = "session-alpha";

/** This machine will show what it is handed, so nothing is withheld by the delivery. */
const PERMITTED_DELIVERY: OsNotificationDelivery = { status: "permitted" };

/** The first settled read, which raises nothing and is what every case starts from. */
const NO_ITEMS: readonly AttentionItem[] = [];

function itemFor(id: string): AttentionItem {
  return {
    id,
    sessionId: ACTIVE_SESSION_ID,
    trigger: "pending_approval",
    severity: "actionable",
    summary: "An approval is waiting.",
    sourceEventId: `event-for-${id}`,
    createdAt: "2026-01-01T10:00:00.000Z",
  };
}

/**
 * A settled read over the one session these cases name.
 *
 * The window is parked on that session throughout, so it is baselined by the first
 * settled read and every case's item is measured against it — which is what makes
 * these cases about the AUDIENCE rather than about the address set.
 */
function readingOf(items: readonly AttentionItem[]): AttentionReading {
  return {
    phase: "read",
    plane: new AttentionPlane(items),
    droppedCount: 0,
    refusedSessions: [],
    addressedSessionIds: [ACTIVE_SESSION_ID],
  };
}

interface MountedNotifier {
  /** The window's own store, so a case can read the seed and move it. */
  readonly frameStore: FrameStore;
  /** One entry per call that left this window. `showNotification` returns `void`. */
  readonly raisedNotifications: unknown[];
  /** Settle another read of the projection, which is how an item arrives. */
  readonly settleRead: (items: readonly AttentionItem[]) => void;
}

/**
 * Mount the emitter in a window whose document reports `documentFocus`.
 *
 * The store is built INSIDE the stub and the route is set after it, because the seed is
 * read in the constructor and nothing later re-reads the document — which is exactly
 * the property the first case is about.
 */
function mountNotifier(documentFocus: DocumentFocusReading): MountedNotifier {
  const frameStore = underDocumentFocus(documentFocus, () => new FrameStore());
  frameStore.navigate({ kind: "workspace", sessionId: ACTIVE_SESSION_ID });
  const raisedNotifications: unknown[] = [];
  const bridge = {
    sidekicks: {
      native: {
        showNotification: (notificationOptions: unknown) => {
          raisedNotifications.push(notificationOptions);
        },
      },
    },
  } as unknown as ConsoleBridge;
  const { rerender } = renderHook(
    (items: readonly AttentionItem[]) => {
      useAttentionNotifications({
        reading: readingOf(items),
        delivery: PERMITTED_DELIVERY,
        frameStore,
        bridge,
      });
    },
    { initialProps: NO_ITEMS },
  );
  return {
    frameStore,
    raisedNotifications,
    settleRead: (items) => {
      rerender(items);
    },
  };
}

describe("the attention emitter's audience — read from the window it is mounted in", () => {
  it("announces an item for the session a window that opened unfocused is parked on", () => {
    // The defect, end to end: this window claimed focus it never had, so the rule that
    // withholds a banner about what is already on screen withheld one about a screen
    // nobody was looking at.
    const mounted = mountNotifier(UNFOCUSED_DOCUMENT);
    expect(mounted.frameStore.getState().isWindowFocused).toBe(false);

    mounted.settleRead([itemFor("attention-1")]);

    expect(mounted.raisedNotifications).toHaveLength(1);
  });

  it("withholds the same item from a window that opened focused — the control", () => {
    // Without this the first case is satisfied by an emitter that announces everything,
    // which is the opposite defect and interrupts a person about what they are reading.
    const mounted = mountNotifier(FOCUSED_DOCUMENT);
    expect(mounted.frameStore.getState().isWindowFocused).toBe(true);

    mounted.settleRead([itemFor("attention-1")]);

    expect(mounted.raisedNotifications).toStrictEqual([]);
  });

  it("follows the cell when focus arrives after the window opened", () => {
    // The seed is where the answer starts and not what it is: the frame's own listener
    // writes this cell on every transition, and the emitter reads the cell at the
    // moment an item ARRIVES rather than holding whatever it was told at mount.
    const mounted = mountNotifier(UNFOCUSED_DOCUMENT);
    mounted.frameStore.setWindowFocused(true);

    mounted.settleRead([itemFor("attention-1")]);

    expect(mounted.raisedNotifications).toStrictEqual([]);
  });
});
