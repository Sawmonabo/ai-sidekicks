// A session this window never opened is still a session this read answers for.
//
// The other two spec files beside this one drive the read over the sessions this
// window HOLDS — a store that moved, a session that opened, a transport that was
// swapped. This one drives the half that has no store at all: the read is fanned out
// over every session the window can NAME, and the node's directory is most of that
// set on any machine a person actually uses.
//
// The harness is `attention-read.test-support.tsx`, and the scenario beat it carries
// is the fixture's stand-in for the daemon saying attention moved: the fixture
// derives its projection from delivered beats, so a beat reaches every session the
// bridge can name rather than only the ones with stores in this window.

import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { subscribeToOpenSessions } from "../../store/index.js";
import type { AttentionProjectionReader } from "./attention-projection-read.js";
import {
  ATTENTION_PLANE_BEAT,
  BEAT_DUE_MS,
  SECOND_SESSION_ID,
  attentionItem,
  bridgeOnFrozenTime,
  coveredRead,
  registryHolding,
  releaseCoalescedRead,
  renderProbe,
} from "./attention-read.test-support.js";

describe("the attention read — a session this window never opened still moves", () => {
  it("renders an item for a directory session that has no store in this window", async () => {
    // The defect, stated as a case. The read is fanned out over every session this
    // window can NAME — the node's directory merged with its open set — and a session
    // nobody here ever opened has no store to move. Watching the stores alone, this
    // window read that session's projection once, at mount, and nothing in it could
    // ever say the approval had arrived: the badge, the centre, and the OS banner all
    // stayed on their baseline for as long as the window stayed open.
    const { bridge, clock } = bridgeOnFrozenTime([ATTENTION_PLANE_BEAT]);
    const registry = registryHolding(clock);
    let servedItems: readonly unknown[] = [];
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead(servedItems)));

    const { container } = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);
    expect(read).toHaveBeenCalledTimes(1);

    // The session gaining the approval is emphatically NOT the one this registry
    // holds a store for.
    servedItems = [
      attentionItem({
        sessionId: SECOND_SESSION_ID,
        summary: "An approval is waiting in a session you never opened.",
      }),
    ];
    act(() => {
      bridge.scenarioEngine?.advance(BEAT_DUE_MS);
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent ?? "").toContain(
      "An approval is waiting in a session you never opened.",
    );
  });

  it("planted control: the store signal alone cannot see that beat at all", async () => {
    // The old shape, planted beside the new one on the same delivery. Without it the
    // case above would pass over an instrument that could not tell the two signals
    // apart — a beat that happened to move an open session's store would satisfy it
    // for a reason that has nothing to do with the unopened session.
    const { bridge, clock } = bridgeOnFrozenTime([ATTENTION_PLANE_BEAT]);
    const registry = registryHolding(clock);
    const openSessionSignals = vi.fn();
    const attentionPlaneSignals = vi.fn();
    const releaseStores = subscribeToOpenSessions(registry, openSessionSignals);
    const releasePlane = bridge.attentionSubscribe(attentionPlaneSignals);

    act(() => {
      bridge.scenarioEngine?.advance(BEAT_DUE_MS);
    });
    releaseStores();
    releasePlane();

    expect(openSessionSignals).toHaveBeenCalledTimes(0);
    expect(attentionPlaneSignals).toHaveBeenCalledTimes(1);
  });

  it("reads nothing more once the surface has gone, on either signal", async () => {
    // Both halves are released together or neither is: a teardown that dropped one
    // would leave the survivor waking a read that has been disposed.
    const { bridge, clock } = bridgeOnFrozenTime([ATTENTION_PLANE_BEAT]);
    const registry = registryHolding(clock);
    const read = vi.fn<AttentionProjectionReader>(() => Promise.resolve(coveredRead([])));

    const view = renderProbe(read, bridge, registry);
    await releaseCoalescedRead(clock);
    view.unmount();

    act(() => {
      bridge.scenarioEngine?.advance(BEAT_DUE_MS);
    });
    await releaseCoalescedRead(clock);

    expect(read).toHaveBeenCalledTimes(1);
    expect(registry.listenerCount).toBe(0);
    expect(bridge.scenarioEngine?.sinkCount).toBe(0);
  });
});
