// The directory read holds one answer and asks again when the service's list moves. The call is a
// plain function the test hands the hook, so the hook's own logic is measured.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settle as settleReactWork } from "#test/helpers/settle.js";
import { NO_TRANSPORT_RECONNECT } from "#renderer/lib/transport-reconnect.js";
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
});
