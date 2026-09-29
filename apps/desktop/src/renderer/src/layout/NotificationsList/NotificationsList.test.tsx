// What the notification center puts on screen, and the two controls it must not.
//
// The hardest properties here are absences: there is no dismiss anywhere in the
// contract, and per-session mute is deferred while the console design allows it — so
// the center must offer neither, and "must not render a control" is exactly the claim a
// type cannot make.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { type AttentionItem } from "@ai-sidekicks/contracts";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { refuse } from "@renderer/lib/refusal.js";
import { settle } from "@test/helpers/settle.js";
import { formatClockTime, formatDateTime } from "@renderer/console/primitives/index.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { NotificationsList } from "./NotificationsList.js";
import {
  AttentionSummary,
  type AttentionReading,
  type RefusedAttentionSession,
} from "@renderer/store/attention/attention-summary.js";
import {
  useAttentionProjection,
  type AttentionProjectionReadCall,
} from "@renderer/store/attention/hooks/useAttentionProjection.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attention-1",
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    summary: "An approval is waiting.",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function readingOf(
  items: readonly AttentionItem[],
  refusedSessions: readonly RefusedAttentionSession[] = [],
): AttentionReading {
  return {
    phase: "read",
    summary: new AttentionSummary(items),
    droppedCount: 0,
    refusedSessions,
    addressedSessionIds: ADDRESSED_SESSION_IDS,
  };
}

/** The sessions this panel's fan-out asked about. The panel renders none of them. */
const ADDRESSED_SESSION_IDS: readonly string[] = ["session-a", "session-b"];

/** One session the fan-out never got an answer for, refused with a session refusal. */
function refusedSession(sessionId: string): RefusedAttentionSession {
  return {
    sessionId,
    refusal: refuse(
      "attention-projection",
      "session.not_found",
      "That session is not known to the daemon.",
    ),
  };
}

describe("a projection read in flight", () => {
  it("renders as a read in flight", () => {
    const { container } = render(<NotificationsList reading={{ phase: "reading" }} />);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
  });
});

describe("what the center never offers", () => {
  it("draws no dismiss control beside an item", () => {
    const { container } = render(<NotificationsList reading={readingOf([item()])} />);
    const labels = [...container.querySelectorAll("button")].map(
      (button) => `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`,
    );
    expect(labels.some((label) => /dismiss|clear|mark read/iu.test(label))).toBe(false);
  });

  it("says mute is global and draws no per-session switch", () => {
    const { container } = render(<NotificationsList reading={readingOf([item()])} />);
    expect(container.textContent ?? "").toContain("Muting is a single global setting");
    expect(container.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
  });
});

describe("the density fold", () => {
  const withBoth = [
    item({ id: "blocking" }),
    item({ id: "chatter", severity: "informational", trigger: "run_completed" }),
  ];

  it("folds the informational half under a count while anything is actionable", () => {
    const { container } = render(<NotificationsList reading={readingOf(withBoth)} />);
    const fold = container.querySelector(".meridian-attention__fold-summary");
    expect(fold?.textContent).toBe("1 informational");
  });

  it("negative control: with nothing actionable the informational items are not folded", () => {
    const { container } = render(
      <NotificationsList
        reading={readingOf([item({ severity: "informational", trigger: "mention" })])}
      />,
    );
    expect(container.querySelector(".meridian-attention__fold")).toBeNull();
    expect(container.querySelectorAll(".meridian-attention__items")).toHaveLength(1);
  });
});

describe("an item's own render", () => {
  it("shows the projection's summary verbatim beside the console's reading of the trigger", () => {
    const { container } = render(<NotificationsList reading={readingOf([item()])} />);
    const text = container.textContent ?? "";
    expect(text).toContain("An approval is waiting.");
    expect(text).toContain("Waiting on an approval");
  });

  it("names the scope off `runId` rather than recomputing it", () => {
    const { container } = render(
      <NotificationsList reading={readingOf([item({ id: "aggregate" })])} />,
    );
    expect(container.textContent ?? "").toContain("Everything unresolved in this session");
  });

  it("negative control: a run-scoped item names its run instead", () => {
    const { container } = render(
      <NotificationsList reading={readingOf([item({ runId: "run-7" })])} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("run-7");
    expect(text).not.toContain("Everything unresolved in this session");
  });

  it("is a press only when the caller supplied somewhere to go", () => {
    const withoutOpen = render(<NotificationsList reading={readingOf([item()])} />);
    expect(withoutOpen.container.querySelectorAll(".meridian-attention__row--open")).toHaveLength(
      0,
    );
    const withOpen = render(
      <NotificationsList reading={readingOf([item()])} onOpen={() => undefined} />,
    );
    expect(withOpen.container.querySelectorAll(".meridian-attention__row--open")).toHaveLength(1);
  });
});

describe("members the boundary refused", () => {
  it("says how many were dropped rather than shrinking the list silently", () => {
    const { container } = render(
      <NotificationsList
        reading={{
          phase: "read",
          summary: new AttentionSummary([item()]),
          droppedCount: 2,
          refusedSessions: [],
          addressedSessionIds: ADDRESSED_SESSION_IDS,
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("2 deliveries could not be read");
    // Groups above and the dropped line below: a partial read shows both halves.
    expect(container.querySelectorAll(".meridian-attention__group")).toHaveLength(1);
  });

  it("negative control: a clean read says nothing about dropped members", () => {
    const { container } = render(<NotificationsList reading={readingOf([item()])} />);
    expect(container.textContent ?? "").not.toContain("could not be read");
  });

  it("never reports an all-clear for a read it could recognize none of", () => {
    // The failure this catches is the worst one this list has: a person is told
    // nothing needs them on the strength of a read whose every member was refused.
    const { container } = render(
      <NotificationsList
        reading={{
          phase: "read",
          summary: new AttentionSummary([]),
          droppedCount: 2,
          refusedSessions: [],
          addressedSessionIds: ADDRESSED_SESSION_IDS,
        }}
      />,
    );
    expect(container.textContent ?? "").toContain("2 deliveries could not be read");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });
});

describe("a read that did not cover every session", () => {
  // The worst sentence this list has is the all-clear, and without this arm it would
  // be reachable on a read one session never answered: a fan-out that dropped the
  // refusals would read an empty projection from the sessions that did answer as
  // "nothing", and tell a person they were free on a question half the console never
  // got back.

  it("never says a person is free while a session went unchecked", () => {
    const { container } = render(
      <NotificationsList reading={readingOf([], [refusedSession("session-b")])} />,
    );
    expect(container.textContent ?? "").toContain("One session could not be checked.");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: the same empty read with every session answered draws only the heading", () => {
    // Nothing waiting is shown by absence, so the list keeps its heading and draws
    // nothing under it. Without this, the not-checked cases here would pass over a
    // center that drew its warning for every empty read.
    const { container } = render(<NotificationsList reading={readingOf([])} />);
    expect(container.querySelector(".meridian-attention__title")?.textContent).toBe("Needs you");
    expect(container.querySelector(".meridian-nothing")).toBeNull();
    expect(container.querySelector(".meridian-attention__groups")).toBeNull();
  });

  it("keeps the dropped-member line beside the coverage warning", () => {
    // Two different facts about one read — members this console could not recognize,
    // and sessions that never answered — and neither may stand in for the other.
    const { container } = render(
      <NotificationsList
        reading={{
          phase: "read",
          summary: new AttentionSummary([]),
          droppedCount: 1,
          refusedSessions: [refusedSession("session-b")],
          addressedSessionIds: ADDRESSED_SESSION_IDS,
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("One session could not be checked.");
    expect(text).toContain("1 delivery could not be read");
  });
});

describe("when an attention item was raised", () => {
  // The two instants are one calendar day apart at the same wall-clock minute, which
  // is the collision the reading has to survive: rows are grouped by session and by
  // nothing else, so nothing else in this list says which day an item belongs to.
  const RAISED_TODAY = "2026-01-01T10:00:00.000Z";
  const RAISED_NEXT_DAY = "2026-01-02T10:00:00.000Z";

  function attentionReadings(container: HTMLElement): readonly string[] {
    return [...container.querySelectorAll(".meridian-attention__row .meridian-figure--wire")]
      .map((figure) => figure.textContent ?? "")
      .filter((text) => text !== "");
  }

  it("renders two items a day apart as two different readings", () => {
    const { container } = render(
      <NotificationsList
        reading={readingOf([
          item({ id: "attention-today", createdAt: RAISED_TODAY }),
          item({ id: "attention-next-day", createdAt: RAISED_NEXT_DAY }),
        ])}
      />,
    );
    const [today, nextDay] = attentionReadings(container);
    expect(today).toBe(formatDateTime(RAISED_TODAY));
    expect(nextDay).toBe(formatDateTime(RAISED_NEXT_DAY));
    expect(nextDay).not.toBe(today);
  });

  it("negative control: the clock-only reading of those two instants is one string", () => {
    // Without this the case above would pass over two instants that were never a
    // collision, and would prove nothing about which formatter the row reaches for.
    expect(formatClockTime(RAISED_NEXT_DAY)).toBe(formatClockTime(RAISED_TODAY));
  });

  it("keeps the exact instant on the row's own title, unformatted", () => {
    const { container } = render(
      <NotificationsList reading={readingOf([item({ createdAt: RAISED_TODAY })])} />,
    );
    const titles = [...container.querySelectorAll(".meridian-attention__row [title]")].map(
      (element) => element.getAttribute("title"),
    );
    expect(titles).toContain(RAISED_TODAY);
  });
});

describe("what makes the attention read run again", () => {
  // The read goes through the console's one refresh scheduler, so time is frozen and a
  // case releases a coalesced read by moving the clock past its window.

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
    expect(container.textContent ?? "").not.toContain("An approval is waiting.");

    served.items = [item()];
    act(() => {
      settleEvent(registry, sessionId);
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent ?? "").toContain("An approval is waiting.");
  });

  it("releases its subscription and reads no more once the list has gone", async () => {
    const clock = new ManualClock(0);
    const registry = registryOn(clock);
    const read = callServing({ items: [] });
    const view = mount(clock, read, registry);
    await releaseCoalescedRead(clock);
    expect(registry.listenerCount).toBe(1);
    view.unmount();

    act(() => {
      registry.open("session-b");
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(1);
    expect(registry.listenerCount).toBe(0);
    expect(clock.pendingCount).toBe(0);
  });
});
