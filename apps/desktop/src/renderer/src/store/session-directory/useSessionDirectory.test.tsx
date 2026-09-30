// The directory read holds one answer and asks again when the node's list moves. The call is a
// plain function the test hands the hook, so the hook's own logic is measured. Which frames a
// call swap paints is a claim about frames, measured in `useSessionDirectory.frames.test.tsx`.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle as settleReactWork } from "@test/helpers/settle.js";
import { NO_TRANSPORT_RECONNECT } from "@renderer/lib/transport-reconnect.js";
import {
  offeredSessionIds,
  requestSessionDirectoryRead,
  type SessionDirectoryReadCall,
  type SessionDirectoryState,
} from "./session-directory.js";
import { useSessionDirectory } from "./useSessionDirectory.js";

/** A call that counts its reads and answers the one row that names its read. */
interface CountedDirectoryCall {
  readonly read: SessionDirectoryReadCall;
  /** Reads asked for so far. Read after a settle, never during one. */
  readCount(): number;
}

/** Each read answers a row named for its read count, so a re-read is told from a cached answer. */
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

    // A hook that started at `served` would report an empty node before any read happened.
    expect(observed[0]?.status).toBe("reading");

    await settleReactWork();
    expect(servedSessionIds(lastState(observed))).toStrictEqual(["session-read-1"]);
  });

  it("reads once per mount, and not again on a re-render", async () => {
    // A re-read on every render would be a poll.
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
    // Another window created a session on this node after this one mounted; only the focus
    // trigger can reveal it.
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
    // Re-addressing would re-seed to `reading` and blank the list on every focus.
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

  it("reaches every view reading the same call, not only the one that asked", async () => {
    // A revision held per caller would leave the other views on the pre-act list.
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

    // Two views read twice each. Which later read each view holds is React's effect order;
    // the claim is that neither still renders a first-pass answer.
    expect(counted.readCount()).toBe(4);
    for (const observed of [first, second]) {
      const rendered = servedSessionIds(lastState(observed));
      expect(rendered).not.toContain("session-read-1");
      expect(rendered).not.toContain("session-read-2");
    }
  });
});

describe("offeredSessionIds — the union a view offers", () => {
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
    // A view keeps offering what it can name while a read is in flight.
    expect(offeredSessionIds({ status: "reading" }, ["session-local"])).toStrictEqual([
      "session-local",
    ]);
  });
});
