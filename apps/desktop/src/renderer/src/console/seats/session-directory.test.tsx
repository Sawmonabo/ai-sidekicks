// The directory read has three answers, and a surface must be able to tell them apart.
//
// Every case here drives the REAL growth port — the fixture's for a served answer,
// the refusing one for a refused answer — rather than a hand-written promise
// shaped like one. The hook's whole job is to turn one port call into the three
// facts a surface renders, and a stand-in port would agree with whatever the hook
// did with it.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import {
  offeredSessionIds,
  useSessionDirectory,
  type SessionDirectoryState,
} from "./session-directory.js";

function DirectoryProbe(props: {
  readonly growth: GrowthPort;
  readonly onObserve: (state: SessionDirectoryState) => void;
}): React.JSX.Element {
  props.onObserve(useSessionDirectory(props.growth));
  return <></>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function observeDirectory(growth: GrowthPort): SessionDirectoryState[] {
  const observed: SessionDirectoryState[] = [];
  render(
    <DirectoryProbe
      growth={growth}
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

describe("useSessionDirectory — one read, three answers", () => {
  afterEach(() => {
    cleanup();
  });

  it("starts as a read in flight and settles on the node's sessions", async () => {
    const observed = observeDirectory(createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth);

    // The first state is load-bearing: a hook that started at `served` with no rows
    // would report an empty node for a read that had not happened.
    expect(observed[0]?.status).toBe("reading");

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("served");
    if (settled.status === "served") {
      expect(settled.sessions.map((session) => session.sessionId)).toStrictEqual([
        FLAGSHIP_SCENARIO.sessionId,
      ]);
    }
  });

  it("carries the refusal itself when the bridge does not serve the read", async () => {
    const observed = observeDirectory(createRefusingGrowthPort());

    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      // The refusal names who owes the wire. A boolean here would leave the surface
      // to invent the sentence, which is how two answers to one question start.
      expect(settled.refusal.operationId).toBe("sessionList");
      expect(settled.refusal.slateRow).toBe("session-directory-read");
      expect(settled.refusal.detail).toContain("Not checked");
    }
  });

  it("reads once per mount, and not again on a re-render", async () => {
    // A directory that re-read itself on every render would be a poll wearing a
    // hook's name, and the endurance tier's churn would drive one read per cycle.
    let readCount = 0;
    const port = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth;
    const counting: GrowthPort = {
      ...port,
      sessionList: async (request) => {
        readCount += 1;
        return port.sessionList(request);
      },
    };
    const observed: SessionDirectoryState[] = [];
    const view = render(
      <DirectoryProbe
        growth={counting}
        onObserve={(state) => {
          observed.push(state);
        }}
      />,
    );
    await settle();
    view.rerender(
      <DirectoryProbe
        growth={counting}
        onObserve={(state) => {
          observed.push(state);
        }}
      />,
    );
    await settle();

    expect(readCount).toBe(1);
    expect(lastState(observed).status).toBe("served");
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
    // Both non-served arms, because a surface must keep offering what it can name
    // rather than blanking while a read is in flight or after one was refused.
    expect(offeredSessionIds({ status: "reading" }, ["session-local"])).toStrictEqual([
      "session-local",
    ]);
  });
});
