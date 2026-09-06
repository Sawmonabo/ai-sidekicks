// What makes the attention projection be read again.
//
// The finding this covers is a liveness one: the projection used to be read once per
// stable session-id set, so an item raised after the destination opened never
// reached the panel until it remounted. Every case here therefore asserts on TWO
// things — how many reads were performed, and what is on screen — because a re-read
// that renders nothing and a render that never re-read are the same bug from
// opposite sides.
//
// Time is frozen. The read is coalesced through the console's one refresh scheduler,
// so a case that did not advance a clock would be asserting about a read that has not
// happened yet rather than about one that never will.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
} from "../../bridge/index.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStoreRegistry } from "../../store/index.js";
import { NotificationCenter } from "./NotificationCenter.js";
import type {
  AttentionProjectionRead,
  AttentionProjectionReader,
} from "./attention-projection-read.js";
import { useAttentionProjection } from "./attention-read.js";
import { settle as settlePasses } from "../../core/settle.test-support.js";

const FIRST_SESSION_ID = "session-attention-one";
const SECOND_SESSION_ID = "session-attention-two";

function attentionItem(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: "attention-1",
    sessionId: FIRST_SESSION_ID,
    trigger: "pending_approval",
    severity: "actionable",
    summary: "A tool call is waiting on you.",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * A read that covered every session it asked about and carried these members.
 *
 * Written once because six cases below need it: the reader answers coverage beside
 * content, and a case spelling out an empty `refusedSessions` each time would be six
 * places to forget which half of the answer it was asserting about.
 */
function coveredRead(members: readonly unknown[]): AttentionProjectionRead {
  return { members, refusedSessions: [] };
}

/** A fixture bridge whose frozen clock the registry and the read both run on. */
function bridgeOnFrozenTime(): { bridge: ConsoleBridge; clock: ManualClock } {
  const bridge = createFixtureBridge({
    scenario: {
      id: "notifications-attention-read-test",
      label: "Nothing scripted",
      purpose: "Drives the attention read against a bridge that plays no beat.",
      sessionId: FIRST_SESSION_ID,
      participantIdsInJoinOrder: [],
      beats: [],
      replies: [],
      startedAtIso: "2026-01-01T10:05:00.000Z",
    },
  });
  const clock = bridge.scenarioEngine?.clock;
  expect(clock).toBeInstanceOf(ManualClock);
  return { bridge, clock: clock as ManualClock };
}

/**
 * A registry holding one open session, on the same frozen clock.
 *
 * The read is the growth port's own refusal, which is what a window whose bridge
 * cannot serve `sessionRead` is actually given — no store here ever initialises, and
 * none needs to: what this test drives is the CHANGE signal, not the projection.
 */
function registryHolding(clock: ManualClock): SessionStoreRegistry {
  const registry = new SessionStoreRegistry({ read: growthUnavailable("sessionRead"), clock });
  const store = registry.open(FIRST_SESSION_ID);
  // Given a base state the way a read would, so a later batch PROJECTS rather than
  // buffering behind a read this window cannot perform.
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return registry;
}

/** Settle one session event into the open session's projection. */
function settleSessionEvent(registry: SessionStoreRegistry, sequence: number): void {
  registry.enqueue(FIRST_SESSION_ID, [
    {
      id: `event-${String(sequence)}`,
      sessionId: FIRST_SESSION_ID,
      sequence,
      kind: "run.queued",
      occurredAt: "2026-01-01T10:06:00.000Z",
    },
  ]);
  registry.flush(FIRST_SESSION_ID);
}

function AttentionProbe(props: {
  readonly read: AttentionProjectionReader;
  readonly registry: SessionStoreRegistry;
}): React.JSX.Element {
  const { reading, retry } = useAttentionProjection(props.read, props.registry);
  return <NotificationCenter reading={reading} onReopen={retry} />;
}

/**
 * Mount the probe under the bridge provider, which is where a console surface runs.
 *
 * The read takes the window's clock from `useConsoleClock`, and that hook resolves
 * through the provider — so the provider is part of the shape under test rather than
 * harness decoration. Supplied with the same bridge the probe is handed, so a case
 * still drives exactly one transport.
 */
function renderProbe(
  read: AttentionProjectionReader,
  bridge: ConsoleBridge,
  registry: SessionStoreRegistry,
): ReturnType<typeof render> {
  return render(
    <SidekicksBridgeProvider bridge={bridge}>
      <AttentionProbe read={read} registry={registry} />
    </SidekicksBridgeProvider>,
  );
}

/** Let the read's promise settle after the frozen clock released it. */
async function settle(): Promise<void> {
  await settlePasses(3);
}

/** Move past the coalescing window and let whatever it released land. */
async function releaseCoalescedRead(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(REFRESH_DEBOUNCE_MS + 1);
  });
  await settle();
}

describe("the attention read — a session change is what re-reads it", () => {
  it("renders an item that only appeared after the first read had settled", async () => {
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    let servedItems: readonly unknown[] = [];
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead(servedItems)));

    const { container } = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.textContent ?? "").toContain("Nothing needs you.");

    servedItems = [attentionItem()];
    act(() => {
      registry.open(SECOND_SESSION_ID);
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent ?? "").toContain("A tool call is waiting on you.");
  });

  it("re-reads when the transport is swapped and the reader itself did not move", async () => {
    // The hook took a bridge it named nowhere in its body, so the read it held
    // outlived the transport it was made through. It was right only because the one
    // caller derives its reader from `bridge.growth` — correctness resting on a memo
    // in a file this module does not own. Here the reader identity is deliberately
    // STABLE across the swap, which is the shape that exposes it.
    const first = bridgeOnFrozenTime();
    const registry = registryHolding(first.clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead([])));

    const view = renderProbe(read, first.bridge, registry);
    await releaseCoalescedRead(first.clock);
    expect(read).toHaveBeenCalledTimes(1);

    const second = bridgeOnFrozenTime();
    await act(async () => {
      view.rerender(
        <SidekicksBridgeProvider bridge={second.bridge}>
          <AttentionProbe read={read} registry={registry} />
        </SidekicksBridgeProvider>,
      );
      await Promise.resolve();
    });
    await releaseCoalescedRead(second.clock);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("negative control: a re-render carrying the same bridge re-reads nothing", async () => {
    // Without this, a hook that rebuilt the read on every pass would satisfy the case
    // above while putting a read on the wire for every render the surface performs.
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead([])));

    const view = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <SidekicksBridgeProvider bridge={bridge}>
          <AttentionProbe read={read} registry={registry} />
        </SidekicksBridgeProvider>,
      );
      await Promise.resolve();
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("costs one read when two changes land inside one window", async () => {
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead([])));

    renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);
    expect(read).toHaveBeenCalledTimes(1);

    act(() => {
      registry.open(SECOND_SESSION_ID);
      registry.open("session-attention-three");
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("negative control: changes spaced past the window each get their own read", async () => {
    // Without this, the coalescing case would pass over a read that had stopped
    // answering the signal altogether.
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead([])));

    renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);

    act(() => {
      registry.open(SECOND_SESSION_ID);
    });
    await releaseCoalescedRead(clock);
    act(() => {
      registry.open("session-attention-three");
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(3);
  });

  it("reads nothing more once the surface has gone", async () => {
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead([])));

    const view = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);
    view.unmount();

    act(() => {
      registry.open(SECOND_SESSION_ID);
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(1);
    // And nothing is left listening for the next one, either.
    expect(registry.listenerCount).toBe(0);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("the attention read — a reader that fails is not a reader nobody asked", () => {
  it("renders the failure's own code rather than the not-checked line", async () => {
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() =>
      Promise.reject(new Error("the projection reader gave out")),
    );

    const { container } = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);

    const text = container.textContent ?? "";
    expect(text).toContain("read-failed");
    expect(text).toContain("the projection reader gave out");
    expect(text).not.toContain("has not been read");
    expect(text).not.toContain("Nothing needs you.");
  });

  it("offers a way back, and taking it puts the read again", async () => {
    // A refused projection read is otherwise terminal for the destination: the effect
    // that opened it runs once per read, and a person who landed on the panel while a
    // cap was tripped had one line of error text and nothing to press.
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    let refusalsLeft = 1;
    const read = vi.fn<AttentionProjectionReader>(() => {
      if (refusalsLeft > 0) {
        refusalsLeft -= 1;
        return Promise.reject(new Error("the projection reader gave out"));
      }
      return Promise.resolve(undefined);
    });

    const { container } = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);
    const retry = container.querySelector(".meridian-refusal__action button");
    expect(retry?.textContent).toBe("Try again");

    await act(async () => {
      fireEvent.click(retry as HTMLButtonElement);
    });
    await releaseCoalescedRead(clock);

    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(container.textContent ?? "").toContain("has not been read");
  });

  it("negative control: a served read offers no way back", async () => {
    // Without this, the case above would pass over a panel that carried the control on
    // every phase — a retry beside an answer, which reads as a refresh this surface
    // does not have.
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(undefined));

    const { container } = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);

    expect(container.querySelector(".meridian-refusal__action")).toBeNull();
  });

  it("negative control: a reader answering 'nothing was read' still says exactly that", async () => {
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(undefined));

    const { container } = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);

    expect(container.textContent ?? "").toContain("has not been read");
  });
});

describe("the attention read — an event settling is a session change", () => {
  it("re-reads when the session projection moves, not only when a session opens", async () => {
    // The claim the finding rests on: attention changes as session events settle,
    // and the surface holds no other signal that one did.
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    let servedItems: readonly unknown[] = [];
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead(servedItems)));

    const { container } = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);
    expect(read).toHaveBeenCalledTimes(1);

    servedItems = [attentionItem({ summary: "A run finished while you were reading." })];
    act(() => {
      settleSessionEvent(registry, 1);
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent ?? "").toContain("A run finished while you were reading.");
  });

  it("costs one read for a burst of events in one window", async () => {
    const { bridge, clock } = bridgeOnFrozenTime();
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead([])));

    renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);

    act(() => {
      settleSessionEvent(registry, 1);
      settleSessionEvent(registry, 2);
      settleSessionEvent(registry, 3);
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(2);
  });
});
