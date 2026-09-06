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
// AND THE REJECTING CASE ASSERTS THE DAEMON'S OWN WORDS, which is the second thing it
// is for. A scenario that scripts a daemon refusal throws it verbatim and the live
// seam will throw the same shape, so what a person reads has to be the code and the
// sentence the other side sent — not a growth-port code stamped over them. Both are
// driven: a rejection carrying a JSON-RPC envelope, and a rejection carrying nothing
// machine-readable at all, because only the first can prove a code SURVIVED.
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

/** The dotted code a daemon envelope carries, which has to survive to the screen. */
const DAEMON_REFUSAL_CODE = "session.list_unavailable";

/** What the daemon's own envelope says, which is what a person reads. */
const DAEMON_REFUSAL_MESSAGE = "The node is not accepting session reads right now.";

/**
 * A real port with exactly one method replaced by a rejection.
 *
 * The thrown value is the caller's, so one helper drives both rejection cases: the
 * envelope one, which proves a daemon code reaches the state, and the bare-`Error`
 * one, which proves the settlement is total when nothing machine-readable arrives.
 */
function rejectingDirectoryPort(rejection: unknown): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    sessionList: () => Promise.reject(rejection),
  };
}

/** The JSON-RPC envelope shape a daemon refusal crosses the preload boundary as. */
function daemonRejection(): unknown {
  return {
    code: -32603,
    message: DAEMON_REFUSAL_MESSAGE,
    data: { type: DAEMON_REFUSAL_CODE },
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
      // The port's own ledger travels on the registered refusal extensions, so it
      // survives the settlement rather than being rebuilt away.
      expect(settled.refusal.code).toBe("wire-unregistered");
      expect(settled.refusal.operationId).toBe("sessionList");
      expect(settled.refusal.slateRow).toBe("session-directory-read");
      expect(settled.refusal.detail).toContain("Not checked");
    }
  });

  it("carries the daemon's own code and message when the port rejects with an envelope", async () => {
    const observed = observeDirectory(rejectingDirectoryPort(daemonRejection()));

    await settleReactWork();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      // VERBATIM, BOTH OF THEM. `session.list_unavailable` and a lease conflict are
      // different next moves for a person, and a refusal that restamped this with the
      // seam's own code would make every one of them the same one. The sibling reads
      // one family up settle the identical shape, so a person meets one vocabulary
      // whichever surface they are on.
      expect(settled.refusal.code).toBe(DAEMON_REFUSAL_CODE);
      expect(settled.refusal.detail).toBe(DAEMON_REFUSAL_MESSAGE);
      // And the origin names the seam the refusal surfaced at, which is what an
      // origin says everywhere else in the console.
      expect(settled.refusal.origin).toBe("growth-read");
    }
  });

  it("negative control: the port's own refusal code reaches no rejected read", async () => {
    // Without this the case above would pass over a settlement that carried the
    // daemon's code AND the port's stamp — the exact shape this read used to produce,
    // where `call-rejected` was the code and the daemon's was thrown away.
    const observed = observeDirectory(rejectingDirectoryPort(daemonRejection()));

    await settleReactWork();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      expect(settled.refusal.code).not.toBe("call-rejected");
      expect(settled.refusal.origin).not.toBe("growth-port");
      expect(settled.refusal.detail).not.toContain("did not answer");
    }
  });

  it("settles unavailable when the rejection carries nothing machine-readable", async () => {
    // The other side of totality: an ordinary `Error` has no code to keep, so the
    // settlement synthesizes one from the seam and keeps the message a producer
    // wrote — a read that failed for an unreadable reason is still distinguishable
    // from one nobody put.
    const observed = observeDirectory(rejectingDirectoryPort(new Error(REJECTION_MESSAGE)));

    await settleReactWork();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      expect(settled.refusal.code).toBe("growth-read-call-failed");
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
        growth={rejectingDirectoryPort(new Error(REJECTION_MESSAGE))}
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
