// The notifications list draws the new answer once an open session's store moves, says a failed
// read failed until `Try again` reads again, and draws a provider's new build under `Earlier`,
// uncounted, landing on that provider's settings section.

import { act, fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "#renderer/lib/reads/refresh/caps.js";
import { settle } from "#test/helpers/settle.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { NotificationsList } from "./NotificationsList.js";
import {
  useAttentionProjection,
  type AttentionProjectionReadCall,
} from "#renderer/store/attention/hooks/useAttentionProjection.js";
import { openingPageLimit, offScreenRowLimit } from "#test/helpers/session/store/fixtures.js";
import { AttentionSummary } from "#renderer/store/attention/summary.js";
import {
  providerBuildItem,
  RELEASE_NOTES_ADDRESS,
  UPDATED_PROVIDER_ID,
} from "#renderer/store/attention/provider-build.test-support.js";

/** The session the items here belong to. */
const SESSION_A = "019b7892-1a00-7c31-8110-cca0117a0a01" as SessionId;

function item(): AttentionItem {
  return {
    id: "attention-1",
    momentId: "moment-1",
    sessionId: SESSION_A,
    trigger: "pendingApproval",
    severity: "actionable",
    displayName: "Fix the login flow",
    stateWord: "Waiting on you",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    bannerState: "pending",
    seen: false,
  };
}

describe("what makes the attention read run again", () => {
  // The read goes through the one refresh scheduler, so time is frozen and a case releases a
  // coalesced read by moving the clock past its window.

  function registryOn(clock: ManualClock): SessionStoreRegistry {
    return new SessionStoreRegistry({
      openingPageLimit,
      offScreenRowLimit,
      read: () => Promise.resolve(undefined),
      clock,
    });
  }

  /** Open one session whose store has a base state, so a settled event projects. */
  function openInitializedSession(registry: SessionStoreRegistry): string {
    registry.open(SESSION_A).initialize({ shape: "project", cursor: 0, entities: [] });
    return SESSION_A;
  }

  /** Settle one event into an open session's store, which is what moves its projection. */
  function settleEvent(registry: SessionStoreRegistry, sessionId: string): void {
    registry.enqueue(sessionId, [
      {
        id: "event-1",
        sessionId,
        sequence: 1,
        cursor: "cursor-at-1",
        kind: "run.queued",
        occurredAt: "2026-01-01T10:06:00.000Z",
      },
    ]);
    registry.flush(sessionId);
  }

  function ReadThroughCenter(props: {
    readonly read: AttentionProjectionReadCall;
    readonly registry: SessionStoreRegistry;
  }): React.JSX.Element {
    const clock = useClock();
    return (
      <NotificationsList reading={useAttentionProjection(props.read, props.registry, clock)} />
    );
  }

  function mount(
    clock: ManualClock,
    read: AttentionProjectionReadCall,
    registry: SessionStoreRegistry,
  ): ReturnType<typeof render> {
    return render(
      <PlatformBridgeProvider bridge={bridgeOnClock("attention", clock).bridge} clock={clock}>
        {/* A failed read's line speaks through the window's announcer. */}
        <LiveAnnouncerProvider clock={clock}>
          <ReadThroughCenter read={read} registry={registry} />
        </LiveAnnouncerProvider>
      </PlatformBridgeProvider>,
    );
  }

  /** A call serving whatever `served.items` holds when it runs. */
  function callServing(served: { items: readonly AttentionItem[] }): AttentionProjectionReadCall {
    return vi.fn(() =>
      Promise.resolve({
        items: served.items,
        droppedCount: 0,
        refusedSessions: [],
        addressedSessionIds: [SESSION_A],
      }),
    );
  }

  async function releaseCoalescedRead(clock: ManualClock): Promise<void> {
    await act(async () => {
      clock.advance(REFRESH_DEBOUNCE_MS + 1);
    });
    await settle();
  }

  it("re-reads and renders the new answer when an open session's store moves", async () => {
    const clock = new ManualClock(0);
    const registry = registryOn(clock);
    const sessionId = openInitializedSession(registry);
    const served = { items: [] as readonly AttentionItem[] };
    const read = callServing(served);
    const { container } = mount(clock, read, registry);
    await releaseCoalescedRead(clock);
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.textContent ?? "").not.toContain("Fix the login flow");

    served.items = [item()];
    act(() => {
      settleEvent(registry, sessionId);
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent ?? "").toContain("Fix the login flow");
  });

  it("says a failed read failed and reads again on Try again", async () => {
    const clock = new ManualClock(0);
    const registry = registryOn(clock);
    const served = callServing({ items: [item()] });
    const read = vi
      .fn<AttentionProjectionReadCall>()
      .mockRejectedValueOnce(new Error("the projection read failed"))
      .mockImplementation(served);
    const view = mount(clock, read, registry);
    // The list alone: the announcer's own region keeps the last sentence it said.
    const list = (): string =>
      view.getByRole("region", { name: "Notifications" }).textContent ?? "";
    await releaseCoalescedRead(clock);
    expect(list()).toContain("Couldn't load notifications");

    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(2);
    expect(list()).not.toContain("Couldn't load notifications");
    expect(list()).toContain("Fix the login flow");
  });
});

describe("a provider's new build in the list", () => {
  it("draws under Earlier, uncounted, and lands on its provider's section", async () => {
    const clock = new ManualClock(0);
    const { bridge } = bridgeOnClock("attention", clock);
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    const onOpen = vi.fn();
    const bridgeOpeningLinks = { ...bridge, native: { ...bridge.native, openExternal } };
    const view = render(
      <PlatformBridgeProvider bridge={bridgeOpeningLinks} clock={clock}>
        <NotificationsList
          reading={{
            phase: "read",
            summary: new AttentionSummary([item(), providerBuildItem()]),
            droppedCount: 0,
            refusedSessions: [],
            addressedSessionIds: [SESSION_A],
          }}
          onOpen={onOpen}
        />
      </PlatformBridgeProvider>,
    );

    // The waiting group counts the approval alone; the build sits under Earlier.
    const waiting = view.getByRole("region", { name: "Waiting on you" });
    expect(waiting.textContent).toContain("Waiting on you 1");
    expect(within(waiting).queryByText("Claude Code")).toBeNull();
    const earlier = view.getByRole("region", { name: "Earlier" });
    expect(within(earlier).getByText("Claude Code")).toBeTruthy();
    expect(within(earlier).getByText("updated · 2.1.293 → 2.1.294")).toBeTruthy();

    fireEvent.click(within(earlier).getByRole("button", { name: /Claude Code/u }));
    expect(onOpen).toHaveBeenCalledWith({
      kind: "settings",
      page: "providers",
      selection: UPDATED_PROVIDER_ID,
    });

    fireEvent.click(within(earlier).getByRole("button", { name: "What's new" }));
    await settle();
    expect(openExternal).toHaveBeenCalledWith(RELEASE_NOTES_ADDRESS);
  });
});
