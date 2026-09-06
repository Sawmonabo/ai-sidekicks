// The directory read has three answers, and a surface must be able to tell them apart.
//
// Every case here drives the REAL growth port — the fixture's for a served answer,
// the refusing one for a refused answer — rather than a hand-written promise
// shaped like one. The hook's whole job is to turn one port call into the three
// facts a surface renders, and a stand-in port would agree with whatever the hook
// did with it.
//
// The one case that cannot drive a shipped port is the REJECTING one, because no port
// in this build rejects: the arm under test is the fail-closed guard for a channel a
// promise carries whether the contract uses it or not. That case wraps a real port and
// replaces exactly one method with a rejection, and its control is the shipped hook
// with exactly that arm removed, kept runnable below so the claim "this used to pin
// `reading`" is measured rather than remembered.
//
// AND ONE CLAIM IS ABOUT FRAMES RATHER THAN ABOUT STATES, so it is a suite of its
// own: `session-directory.frames.test.tsx` measures which frames a port swap paints,
// which no assertion on a settled state can see. Every case here reads states.

import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { settleReactWork } from "../core/act-settlement.test-support.js";
import { useSubjectScopedState } from "../store/index.js";
import {
  offeredSessionIds,
  useSessionDirectory,
  type SessionDirectoryState,
} from "./session-directory.js";

/** What the rejecting port throws, so the case can read it back out of the sentence. */
const REJECTION_MESSAGE = "the bridge channel closed before the reply";

/** A real port with exactly one method replaced by a rejection. */
function rejectingDirectoryPort(): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    sessionList: () => Promise.reject(new Error(REJECTION_MESSAGE)),
  };
}

/**
 * The shipped hook with exactly the rejection arm removed, kept runnable.
 *
 * One change from the shipped shape and no others — the same holder, the same
 * `settle()` publisher, the same fulfilment arm — so what the case below reads is the
 * arm and not a second difference. The `.catch` tail is NOT part of that shape: it is
 * on the derived promise, outside the state machine, and it exists so the runner does
 * not report the foil's own unhandled rejection instead of running the case. What the
 * case reads is the state, and the state is untouched by it.
 */
function useSessionDirectoryWithoutRejectionArm(growth: GrowthPort): SessionDirectoryState {
  const { value: state, settle } = useSubjectScopedState<SessionDirectoryState>(
    growth,
    undefined,
    () => ({ status: "reading" }),
  );
  useEffect(() => {
    const publish = settle();
    void growth
      .sessionList({})
      .then((outcome) => {
        publish(
          outcome.status === "served"
            ? { status: "served", sessions: outcome.value }
            : { status: "unavailable", refusal: outcome },
        );
      })
      .catch(() => {
        // Deliberately empty; see this function's own header.
      });
  }, [growth, settle]);
  return state;
}

function DirectoryProbe(props: {
  readonly growth: GrowthPort;
  readonly onObserve: (state: SessionDirectoryState) => void;
}): React.JSX.Element {
  props.onObserve(useSessionDirectory(props.growth));
  return <></>;
}

/** The same probe over the pre-change hook, so both are driven the same way. */
function PreChangeDirectoryProbe(props: {
  readonly growth: GrowthPort;
  readonly onObserve: (state: SessionDirectoryState) => void;
}): React.JSX.Element {
  props.onObserve(useSessionDirectoryWithoutRejectionArm(props.growth));
  return <></>;
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

    await settleReactWork();
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

    await settleReactWork();
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

  it("settles unavailable when the port rejects rather than answering", async () => {
    const observed = observeDirectory(rejectingDirectoryPort());

    await settleReactWork();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      // The refusal is the PORT's, not one this hook invented: its origin names the
      // port and its code is a member of the port's own closed vocabulary, so a
      // surface rendering it beside any other growth refusal reads one shape.
      expect(settled.refusal.origin).toBe("growth-port");
      expect(settled.refusal.code).toBe("call-rejected");
      expect(settled.refusal.operationId).toBe("sessionList");
      expect(settled.refusal.slateRow).toBe("session-directory-read");
      // What the rejection said reaches the sentence, through the one total reading
      // of an unestablished value rather than a stringification at this seam.
      expect(settled.refusal.detail).toContain(REJECTION_MESSAGE);
    }
  });

  it("negative control: the pre-change effect pins the surface on `reading` forever", async () => {
    // The control for the case above, and it drives the real defect rather than
    // describing it: with no rejection arm the state machine has no transition out of
    // `reading`, so the surface says "still reading" for the life of the mount with
    // nothing on screen that could ever say otherwise.
    const observed: SessionDirectoryState[] = [];
    render(
      <PreChangeDirectoryProbe
        growth={rejectingDirectoryPort()}
        onObserve={(state) => {
          observed.push(state);
        }}
      />,
    );

    await settleReactWork();
    await settleReactWork();
    expect(lastState(observed).status).toBe("reading");
    expect(observed.every((state) => state.status === "reading")).toBe(true);
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
    await settleReactWork();
    view.rerender(
      <DirectoryProbe
        growth={counting}
        onObserve={(state) => {
          observed.push(state);
        }}
      />,
    );
    await settleReactWork();

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
