// The fourth reason this surface re-reads: the stream came back.
//
// Driven through the real hook against a real `SessionStore`, because the claim is
// about a transition of that store's own sticky degraded flag — a stub of it would
// be a stand-in for the very thing under test. The reader is observed through the
// handle the hook returns, so what is asserted is the reason it was asked for rather
// than a call some spy stood in for.
//
// The frozen clock is never advanced, so no read is ever performed: this file is
// about which reasons reach the scheduler, and the scheduler's own coalescing has
// its own tests.

import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../core/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { useApprovalsReader } from "./approvals-hooks.js";
import { type ApprovalsReader } from "./approvals-reader.js";

const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";

/** A bridge that answers nothing: no read is performed in this file. */
function silentBridge(): ConsoleBridge {
  const clock = new ManualClock();
  return {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => ({ requests: [] }),
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    source: "fixture",
    scenarioEngine: { clock },
  } as unknown as ConsoleBridge;
}

function ReaderHarness(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly onReader: (reader: ApprovalsReader) => void;
}): React.JSX.Element | null {
  const { reader } = useApprovalsReader(props.bridge, props.sessionStore);
  const { onReader } = props;
  useEffect(() => {
    onReader(reader);
  }, [onReader, reader]);
  return null;
}

async function mountReader(sessionStore: SessionStore): Promise<ApprovalsReader> {
  let held: ApprovalsReader | undefined;
  await act(async () => {
    render(
      <ReaderHarness
        bridge={silentBridge()}
        sessionStore={sessionStore}
        onReader={(reader) => {
          held = reader;
        }}
      />,
    );
  });
  if (held === undefined) {
    throw new Error("the hook handed back no reader");
  }
  return held;
}

function initialisedStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

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
