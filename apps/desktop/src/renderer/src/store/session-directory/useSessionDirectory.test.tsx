// The directory read holds one answer, and asks again when the node's list moves.
//
// The call that lists the sessions is a plain function the test hands the hook, so
// what is measured is the hook's own logic: it starts as a read in flight, reads once
// per mount, and reads again on a window focus or a settled act, keeping the answer
// already on screen while it does. Which frames a call swap paints is a claim about
// frames rather than states, so `session-directory.frames.test.tsx` measures it.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle as settleReactWork } from "@test/helpers/settle.js";
import { NO_TRANSPORT_RECONNECT } from "@renderer/lib/transport-reconnect.js";
import {
  offeredSessionIds,
  requestSessionDirectoryRead,
  useSessionDirectory,
  type SessionDirectoryReadCall,
  type SessionDirectoryState,
} from "./session-directory.js";

/** A call that counts its reads and answers the one row that names its read. */
interface CountedDirectoryCall {
  readonly read: SessionDirectoryReadCall;
  /** Reads asked for so far. Read after a settle, never during one. */
  readCount(): number;
}

/**
 * The row is the claim: a second read that returned the first read's row could not
 * tell a re-read apart from a cached answer, and what the frame-lifetime binding lost
 * was precisely the ability to see a session the node gained after the window opened.
 */
function countedDirectoryCall(): CountedDirectoryCall {
  let readCount = 0;
  return {
    readCount: () => readCount,
    read: () => {
      readCount += 1;
      return Promise.resolve([{ sessionId: `session-read-${String(readCount)}`, state: "active" }]);
    },
  };
}

/** The session ids a settled directory carries, or `undefined` while it is reading. */
function servedSessionIds(state: SessionDirectoryState): readonly string[] | undefined {
  return state.status === "served" ? state.sessions.map((session) => session.sessionId) : undefined;
}

/** Regain the window's focus, the way a person switching back to it does. */
async function regainWindowFocus(): Promise<void> {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await settleReactWork();
}

function DirectoryProbe(props: {
  readonly read: SessionDirectoryReadCall;
  readonly onObserve: (state: SessionDirectoryState) => void;
}): React.JSX.Element {
  props.onObserve(useSessionDirectory(props.read, NO_TRANSPORT_RECONNECT));
  return <></>;
}

function observeDirectory(read: SessionDirectoryReadCall): SessionDirectoryState[] {
  const observed: SessionDirectoryState[] = [];
  render(
    <DirectoryProbe
      read={read}
      onObserve={(state) => {
        observed.push(state);
      }}
    />,
  );
  return observed;
}

function lastState(observed: readonly SessionDirectoryState[]): SessionDirectoryState {
  const state = observed.at(-1);
  if (state === undefined) {
    throw new Error("the probe never rendered, so there is no state to read");
  }
  return state;
}

describe("useSessionDirectory — one read", () => {
  afterEach(() => {
    cleanup();
  });

  it("starts as a read in flight and settles on the node's sessions", async () => {
    const observed = observeDirectory(countedDirectoryCall().read);

    // The first state is load-bearing: a hook that started at `served` with no rows
    // would report an empty node for a read that had not happened.
    expect(observed[0]?.status).toBe("reading");

    await settleReactWork();
    expect(servedSessionIds(lastState(observed))).toStrictEqual(["session-read-1"]);
  });

  it("reads once per mount, and not again on a re-render", async () => {
    // A directory that re-read itself on every render would be a poll wearing a
    // hook's name, and the endurance tier's churn would drive one read per cycle.
    const counted = countedDirectoryCall();
    const observed: SessionDirectoryState[] = [];
    const probe = (
      <DirectoryProbe
        read={counted.read}
        onObserve={(state) => {
          observed.push(state);
        }}
      />
    );
    const view = render(probe);
    await settleReactWork();
    view.rerender(probe);
    await settleReactWork();

    expect(counted.readCount()).toBe(1);
    expect(lastState(observed).status).toBe("served");
  });
});

describe("useSessionDirectory — the node's list moves, and so does the read", () => {
  afterEach(() => {
    cleanup();
  });

  it("re-reads when the window regains focus, and renders what the node answers now", async () => {
    // The frame-lifetime case, stated as a person meets it: a session created on this
    // node by another window after this one mounted. Nothing in this window's own
    // stream says so, and the window coming back to the front is the moment
    // `store/read/read-triggers.ts` names for a node-scoped reading.
    const counted = countedDirectoryCall();
    const observed = observeDirectory(counted.read);
    await settleReactWork();
    expect(counted.readCount()).toBe(1);
    expect(servedSessionIds(lastState(observed))).toContain("session-read-1");

    await regainWindowFocus();

    expect(counted.readCount()).toBe(2);
    expect(servedSessionIds(lastState(observed))).toContain("session-read-2");
  });

  it("re-reads when a settled act declares the node's directory stale", async () => {
    const counted = countedDirectoryCall();
    const observed = observeDirectory(counted.read);
    await settleReactWork();
    expect(counted.readCount()).toBe(1);

    act(() => {
      requestSessionDirectoryRead(counted.read);
    });
    await settleReactWork();

    expect(counted.readCount()).toBe(2);
    expect(servedSessionIds(lastState(observed))).toContain("session-read-2");
  });

  it("keeps the answer already on screen while the re-read is in flight", async () => {
    // The reason a stale directory advances a revision instead of re-addressing the
    // holder: re-addressing re-seeds to `reading`, which would blank the all-sessions
    // list on every focus. Rule 8's `not-loaded` promises an answer that is still
    // coming, and here one is already on screen.
    const counted = countedDirectoryCall();
    const observed = observeDirectory(counted.read);
    await settleReactWork();
    const settledCount = observed.length;

    act(() => {
      requestSessionDirectoryRead(counted.read);
    });

    expect(observed.slice(settledCount).every((state) => state.status === "served")).toBe(true);
    await settleReactWork();
    expect(lastState(observed).status).toBe("served");
  });

  it("reaches every surface reading the same call, not only the one that asked", async () => {
    // Several families read this directory and only one of them settles an act. A
    // revision held per caller would leave the others rendering the list from before
    // the act that changed it.
    const counted = countedDirectoryCall();
    const first: SessionDirectoryState[] = [];
    const second: SessionDirectoryState[] = [];
    render(
      <>
        <DirectoryProbe
          read={counted.read}
          onObserve={(state) => {
            first.push(state);
          }}
        />
        <DirectoryProbe
          read={counted.read}
          onObserve={(state) => {
            second.push(state);
          }}
        />
      </>,
    );
    await settleReactWork();

    act(() => {
      requestSessionDirectoryRead(counted.read);
    });
    await settleReactWork();

    // Two mounted surfaces, two reads on the first pass and two more on the bump.
    // WHICH of the two later reads each surface holds is React's effect order and not
    // this claim: what is asserted is that NEITHER is still rendering a first-pass
    // answer, which is the thing a per-caller revision would have got wrong.
    expect(counted.readCount()).toBe(4);
    for (const observed of [first, second]) {
      const rendered = servedSessionIds(lastState(observed));
      expect(rendered).not.toContain("session-read-1");
      expect(rendered).not.toContain("session-read-2");
    }
  });
});

describe("offeredSessionIds — the union a surface offers", () => {
  it("puts the node's sessions first and appends what only this window knows", () => {
    const directory: SessionDirectoryState = {
      status: "served",
      sessions: [{ sessionId: "session-node", state: "active" }],
    };

    expect(offeredSessionIds(directory, ["session-local"])).toStrictEqual([
      "session-node",
      "session-local",
    ]);
  });

  it("names a session once when both sources hold it", () => {
    const directory: SessionDirectoryState = {
      status: "served",
      sessions: [{ sessionId: "session-both", state: "active" }],
    };

    expect(offeredSessionIds(directory, ["session-both"])).toStrictEqual(["session-both"]);
  });

  it("falls back to this window's own sessions while the directory has not answered", () => {
    // A surface must keep offering what it can name rather than blanking while a read
    // is in flight.
    expect(offeredSessionIds({ status: "reading" }, ["session-local"])).toStrictEqual([
      "session-local",
    ]);
  });
});
