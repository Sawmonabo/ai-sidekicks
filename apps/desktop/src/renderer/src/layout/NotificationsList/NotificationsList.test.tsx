// The notifications list draws the new answer once an open session's store moves.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
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

function item(): AttentionItem {
  return {
    id: "attention-1",
    momentId: "moment-1",
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    displayName: "Fix the login flow",
    stateWord: "Waiting on you",
    summary: "An approval is waiting.",
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
    return new SessionStoreRegistry({ read: () => Promise.resolve(undefined), clock });
  }

  /** Open one session whose store has a base state, so a settled event projects. */
  function openInitializedSession(registry: SessionStoreRegistry): string {
    registry.open("session-a").initialize({ cursor: 0, entities: [] });
    return "session-a";
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
      <NotificationsList
        reading={useAttentionProjection(props.read, props.registry, clock)}
        nowMilliseconds={clock.now()}
      />
    );
  }

  function mount(
    clock: ManualClock,
    read: AttentionProjectionReadCall,
    registry: SessionStoreRegistry,
  ): ReturnType<typeof render> {
    return render(
      <PlatformBridgeProvider bridge={bridgeOnClock("attention", clock).bridge} clock={clock}>
        <ReadThroughCenter read={read} registry={registry} />
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
        addressedSessionIds: ["session-a"],
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
});
