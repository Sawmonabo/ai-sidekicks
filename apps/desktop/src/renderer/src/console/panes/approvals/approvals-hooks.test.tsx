// The approvals read: what it does after a reconnect, and whose session it answers
// for.
//
// One claim read twice. The reader is bound to the session it was opened for, so a
// reconnect re-reads THAT session and a rebind answers for the new one and never the
// old — a reader that outlived its binding would serve one session's approvals under
// another's name.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { REFRESH_MAX_WAIT_MS } from "../../core/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { type ApprovalsReader } from "./approvals-reader.js";
import {
  ReaderHarness,
  SECOND_SESSION_ID,
  SESSION_ID,
  initialisedStore,
  lifecycleEvent,
  mountReader,
  observableBridge,
  sessionIdsRead,
} from "./approvals-hooks.test-support.js";

describe("the read that follows a reconnect", () => {
  it("asks for one read when a degraded session store is repaired", async () => {
    const sessionStore = initialisedStore();
    const reader = await mountReader(sessionStore);
    // Spied after mount, so the `subscribe` read this surface already takes is not
    // in the count and the reason asserted below is the one this test caused.
    const requestRead = vi.spyOn(reader, "requestRead");

    act(() => {
      sessionStore.markDegraded("subscription-closed");
    });
    // Losing the stream is not the moment: the pane cannot read its way out of a
    // session that is still down, and a read fired here would be one the scheduler
    // performs against a wire that is not answering.
    expect(requestRead).not.toHaveBeenCalled();

    act(() => {
      sessionStore.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    expect(requestRead).toHaveBeenCalledTimes(1);
    expect(requestRead).toHaveBeenCalledWith("reconnect");
  });

  it("negative control: a store that never degraded asks for no reconnect read", async () => {
    // Without this the case above would pass over a hook that re-read on every
    // transition of the store, which is an interval in everything but name.
    const sessionStore = initialisedStore();
    const reader = await mountReader(sessionStore);
    const requestRead = vi.spyOn(reader, "requestRead");

    act(() => {
      sessionStore.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    expect(requestRead).not.toHaveBeenCalled();
  });

  it("asks again when the stream is lost and repaired a second time", async () => {
    const sessionStore = initialisedStore();
    const reader = await mountReader(sessionStore);
    const requestRead = vi.spyOn(reader, "requestRead");

    for (const cursor of [4, 8]) {
      act(() => {
        sessionStore.markDegraded("sequence-gap");
      });
      act(() => {
        sessionStore.initialise({ cursor, entities: [], participantJoinLog: [] });
      });
    }
    expect(requestRead).toHaveBeenCalledTimes(2);
  });
});

// A reader is bound to the session it reads. The pane is rebound — the deck keeps the
// mounted pane and hands it a different session — and every case below is one the
// `useState` initializer got wrong, because that initializer never runs a second time.

describe("the reader is bound to the session it reads", () => {
  /** Mount the harness, then rebind it to a second store. Returns both readers. */
  async function mountThenRebind(options: {
    readonly bridge: ConsoleBridge;
    readonly first: SessionStore;
    readonly second: SessionStore;
    readonly beforeRebind?: () => void;
  }): Promise<{ readonly first: ApprovalsReader; readonly second: ApprovalsReader }> {
    const seen: ApprovalsReader[] = [];
    const onReader = (reader: ApprovalsReader): void => {
      seen.push(reader);
    };
    let rerender: (element: React.JSX.Element) => void = () => undefined;
    await act(async () => {
      const result = render(
        <ReaderHarness bridge={options.bridge} sessionStore={options.first} onReader={onReader} />,
      );
      rerender = result.rerender;
    });
    options.beforeRebind?.();
    await act(async () => {
      rerender(
        <ReaderHarness bridge={options.bridge} sessionStore={options.second} onReader={onReader} />,
      );
    });
    const [first, second] = seen;
    if (first === undefined || second === undefined) {
      throw new Error("the hook did not hand back two readers");
    }
    return { first, second };
  }

  it("builds a second reader for the second session and reads THAT session", async () => {
    // The negative control is the old initializer itself: it handed back the same
    // reader object across the rebind, and every read it performed named the first
    // session — which is the whole finding.
    const { bridge, clock, calls } = observableBridge();
    const readers = await mountThenRebind({
      bridge,
      first: initialisedStore(),
      second: initialisedStore(SECOND_SESSION_ID),
    });
    expect(readers.second).not.toBe(readers.first);

    await act(async () => {
      clock.advance(REFRESH_MAX_WAIT_MS);
    });
    expect(sessionIdsRead(calls)).toContain(SECOND_SESSION_ID);
  });

  it("disposes the reader it replaced, and on unmount exactly the live one", async () => {
    const { bridge } = observableBridge();
    const first = initialisedStore();
    const second = initialisedStore(SECOND_SESSION_ID);
    const seen: ApprovalsReader[] = [];
    const onReader = (reader: ApprovalsReader): void => {
      seen.push(reader);
    };
    let rerender: (element: React.JSX.Element) => void = () => undefined;
    let unmount: () => void = () => undefined;
    await act(async () => {
      const result = render(
        <ReaderHarness bridge={bridge} sessionStore={first} onReader={onReader} />,
      );
      rerender = result.rerender;
      unmount = result.unmount;
    });
    const firstReader = seen[0];
    if (firstReader === undefined) {
      throw new Error("the hook handed back no reader");
    }
    const disposeFirst = vi.spyOn(firstReader, "dispose");

    await act(async () => {
      rerender(<ReaderHarness bridge={bridge} sessionStore={second} onReader={onReader} />);
    });
    const secondReader = seen.at(-1);
    if (secondReader === undefined || secondReader === firstReader) {
      throw new Error("the rebind did not build a second reader");
    }
    const disposeSecond = vi.spyOn(secondReader, "dispose");
    // The rebind disposes the reader it replaced and NOT the one it just built.
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(disposeSecond).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
    });
    expect(disposeSecond).toHaveBeenCalledTimes(1);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
  });

  it("does not carry the previous session's lifecycle high-water mark", async () => {
    // The retained cursor's mark sat at the first session's newest signal, so the
    // second session's own signal — at a lower local position, which is ordinary
    // for a fresh session — was read as already covered and never re-read.
    const { bridge } = observableBridge();
    const first = initialisedStore();
    first.apply(lifecycleEvent(SESSION_ID, 90));
    const second = initialisedStore(SECOND_SESSION_ID);
    const readers = await mountThenRebind({ bridge, first, second });
    const requestRead = vi.spyOn(readers.second, "requestRead");

    act(() => {
      second.apply(lifecycleEvent(SECOND_SESSION_ID, 3));
    });
    expect(requestRead).toHaveBeenCalledWith("terminal-event");
  });

  it("does not read a session left degraded as a repair of the next one", async () => {
    // The retained watcher remembered the first session's standing degraded flag, so
    // the second session's very first pass — which is not degraded — looked like the
    // repair transition and fired a reconnect read nothing had repaired.
    const { bridge } = observableBridge();
    const first = initialisedStore();
    const second = initialisedStore(SECOND_SESSION_ID);
    const readers = await mountThenRebind({
      bridge,
      first,
      second,
      beforeRebind: () => {
        act(() => {
          first.markDegraded("subscription-closed");
        });
      },
    });
    const requestRead = vi.spyOn(readers.second, "requestRead");

    act(() => {
      second.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    expect(requestRead).not.toHaveBeenCalledWith("reconnect");
  });
});

// The goal mutation's subject. `session.goalUpdate` names the session it mutates, so
// everything this hook holds — the in-flight latch and the two readings — belongs to
// the `(bridge, sessionId)` the call was issued under, and the component outlives a
// change of that pair.
