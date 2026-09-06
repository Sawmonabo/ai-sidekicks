// The way out of a presence stream that refused to open, end to end.
//
// The unit case beside `Roster.tsx` proves the control calls what it is handed. This
// one proves what that call now does, through the whole path a person takes: the real
// section descriptor, the real models lease, the real push-driven read, and a bridge
// whose `daemon.subscribe` throws the way the shipped Tier-1 preload throws — which
// is the live path, not an unlucky one, because that build implements every daemon
// method by throwing.
//
// Under the shape this replaced the read marked itself started BEFORE the attempt, so
// the refusal was terminal for the life of the window: the control rendered, the click
// reached the model, and nothing subscribed. The assertion is therefore that the
// roster LOADS after the press, and not merely that a handler ran.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { withDaemonSubscribe } from "../../bridge/fixture-bridge.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../core/settle.test-support.js";
import { sidebarSectionRegistry, type SidebarSectionContext } from "../../seats/index.js";
import { SessionStore } from "../../store/index.js";
import { registerCollaborationSections } from "../sections.js";

/** Branded UUID, because the call door parses the request before it sends. */
const SESSION_ID = "019b7910-0006-7000-8000-000000000001";

/**
 * A real fixture bridge whose event subscription refuses until it is admitted.
 *
 * The one namespace override goes through the bridge family's own
 * `withDaemonSubscribe`, because the daemon namespace is that family's to reach —
 * `test/console/architecture/daemon-reply-chokepoint.test.ts` says so, and a suite
 * that spread it here would be a second door. Everything else is the shipped
 * fixture, so a pass here says the section reached a bridge rather than an object
 * shaped like one.
 */
function bridgeRefusingSubscribe(): {
  readonly bridge: ConsoleBridge;
  readonly admitSubscribe: () => void;
  readonly subscribeCallCount: () => number;
} {
  const base = createFixtureBridge({
    scenario: {
      id: "collaboration-members-reopen-test",
      label: "The members section over a subscription that refuses once",
      purpose: "Drives the roster's re-open control through the real read.",
      sessionId: SESSION_ID,
      participantIdsInJoinOrder: [],
      beats: [],
      replies: [
        { call: "presence.read", result: { participants: [] } },
        { call: "channel.list", result: { channels: [] } },
      ],
      startedAtIso: "2026-01-01T10:05:00.000Z",
    },
  });
  let admitted = false;
  let subscribeCallCount = 0;
  return {
    admitSubscribe: () => {
      admitted = true;
    },
    subscribeCallCount: () => subscribeCallCount,
    bridge: withDaemonSubscribe(base, (passThrough) => {
      subscribeCallCount += 1;
      if (!admitted) {
        throw new Error("daemon.subscribe is not available in this build");
      }
      return passThrough();
    }),
  };
}

function retryControl(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector(".meridian-roster .meridian-refusal__action button");
}

/** Let the section's own read arm and settle on the scenario's frozen clock. */
async function settleRead(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(PAST_REFRESH_DEBOUNCE_MS);
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  });
}

describe("the members section — a presence stream that refused to open", () => {
  it("re-opens on the press and loads the roster behind the new subscription", async () => {
    registerCollaborationSections();
    const seam = bridgeRefusingSubscribe();
    const context: SidebarSectionContext = {
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      bridge: seam.bridge,
      openPane: () => undefined,
      isOpen: true,
    };
    const renderSectionBody = sidebarSectionRegistry.descriptorFor("members")?.render;
    expect(renderSectionBody).toBeDefined();
    const { container } = render(<>{renderSectionBody?.(context)}</>);
    await settleRead(seam.bridge);

    expect(container.textContent ?? "").toContain("subscribe-failed");
    const retry = retryControl(container);
    expect(retry?.textContent).toBe("Try again");
    expect(seam.subscribeCallCount()).toBe(1);

    seam.admitSubscribe();
    await act(async () => {
      fireEvent.click(retry as HTMLButtonElement);
    });
    await settleRead(seam.bridge);

    // The subscription was taken again, the refusal is gone, and the served roster is
    // on screen — the three halves of "the surface came back".
    expect(seam.subscribeCallCount()).toBe(2);
    expect(retryControl(container)).toBeNull();
    expect(container.querySelector(".meridian-roster")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("subscribe-failed");
  });

  it("negative control: a subscription that opened offers no way back", async () => {
    // Without this the case above would pass over a section that rendered the control
    // on every arm, which reads as a refresh this surface does not have.
    registerCollaborationSections();
    const seam = bridgeRefusingSubscribe();
    seam.admitSubscribe();
    const context: SidebarSectionContext = {
      sessionStore: new SessionStore({ sessionId: SESSION_ID }),
      bridge: seam.bridge,
      openPane: () => undefined,
      isOpen: true,
    };
    const renderSectionBody = sidebarSectionRegistry.descriptorFor("members")?.render;
    const { container } = render(<>{renderSectionBody?.(context)}</>);
    await settleRead(seam.bridge);

    expect(retryControl(container)).toBeNull();
  });
});
