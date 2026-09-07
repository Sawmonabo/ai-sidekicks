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

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidekicksBridgeProvider } from "../../bridge/index.js";
import type { AttentionProjectionReader } from "./attention-projection-read.js";
import {
  AttentionProbe,
  SECOND_SESSION_ID,
  attentionItem,
  bridgeOnFrozenTime,
  coveredRead,
  registryHolding,
  releaseCoalescedRead,
  renderProbe,
  settleSessionEvent,
} from "./attention-read.test-support.js";

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
      await crossMacrotaskBoundary();
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
      await crossMacrotaskBoundary();
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
