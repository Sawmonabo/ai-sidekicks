// One start at a time from the picker, and what frees the next one.
//
// EVERY CASE HERE HOLDS THE CALL STILL AND VARIES THE TIMING. Whether a press composes
// and what a refusal renders is `WorkflowStartMenu.test.tsx`; this file is about the
// window between a press and its answer — a second press inside it, each settlement that
// gives the key back, and a composer re-addressed while a start is outstanding.
//
// WHICH IS WHY THE FIRST CASE PRESSES TWICE INSIDE ONE `act`. A rendered `starting` flag
// read inside a press handler is the value from the render that produced the handler, so
// two presses in one frame both find the picker idle and the daemon takes two runs for
// one intended act. Across two `act` scopes a rendered flag and a dispatch-time latch
// behave identically, so a case written that way would pass over the very implementation
// it exists to reject.
//
// AND THE LAST SUITE IS THE SAME WINDOW WITH NO ANSWER IN IT AT ALL. A port that throws
// where it was supposed to return a promise never settles the flight through any of the
// paths above, so the picker is left in the one state the register deliberately keeps —
// which is why that case ends by closing and reopening the menu rather than by reading
// the act once.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GrowthPort } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { unhandledRejectionsDuring } from "../../core/unhandled-rejection.test-support.js";
import {
  PROBE_SESSION_ID,
  SECOND_PROBE_SESSION_ID,
  settle,
} from "../workflows-probe.test-support.js";
import { useWorkflowStartAct, type WorkflowStartDispatch } from "./start-act.js";
import {
  AUDIT_DEFINITION,
  RELEASE_DEFINITION,
  heldStartPort,
  refusingStartPort,
} from "./workflow-start.test-support.js";

afterEach(cleanup);

function StartProbe(props: {
  readonly growth: GrowthPort;
  readonly sessionId: string | undefined;
  readonly onObserve: (dispatch: WorkflowStartDispatch) => void;
}): React.JSX.Element {
  props.onObserve(
    useWorkflowStartAct({
      growth: props.growth,
      sessionId: props.sessionId,
      channelId: undefined,
    }),
  );
  return <></>;
}

/**
 * The dispatch as the latest render saw it, plus the handle a re-address needs.
 *
 * The session is a required parameter and carries no default: a default would be
 * substituted for the explicit `undefined` the unbound-picker case passes, and that case
 * would then address a session and assert about a picker it never mounted.
 */
function observeStart(
  growth: GrowthPort,
  sessionId: string | undefined,
): {
  readonly latest: () => WorkflowStartDispatch;
  readonly readdress: (next: string) => void;
  readonly closeAndReopen: () => void;
} {
  const observed: WorkflowStartDispatch[] = [];
  const collect = (dispatch: WorkflowStartDispatch): void => {
    observed.push(dispatch);
  };
  let view = render(<StartProbe growth={growth} sessionId={sessionId} onObserve={collect} />);
  return {
    latest: () => {
      const current = observed.at(-1);
      if (current === undefined) {
        throw new Error("the probe rendered no dispatch");
      }
      return current;
    },
    readdress: (next) => {
      view.rerender(<StartProbe growth={growth} sessionId={next} onObserve={collect} />);
    },
    // WHAT THE `+` DISCLOSURE DOES, which is an unmount and a fresh mount rather than a
    // re-render: the menu renders its panel only while open, so the picker is absent
    // from the tree between a close and the next open.
    closeAndReopen: () => {
      view.unmount();
      view = render(<StartProbe growth={growth} sessionId={sessionId} onObserve={collect} />);
    },
  };
}

describe("one start is in flight at a time, whichever row the second press lands on", () => {
  it("dispatches once when two presses land in one frame", async () => {
    const port = heldStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);
    // ONE CAPTURED DISPATCH, PRESSED TWICE INSIDE ONE `act`, which is the whole subject:
    // both handlers are the ones the first render produced, both would read the picker
    // as idle, and only a guard taken at dispatch stops the second call.
    const pressed = started.latest();

    await act(async () => {
      pressed.start(RELEASE_DEFINITION);
      pressed.start(AUDIT_DEFINITION);
    });

    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]?.workflowVersionId).toBe(RELEASE_DEFINITION.latestWorkflowVersionId);
  });

  it("keeps the in-flight reading rather than replacing it with the second press", async () => {
    const port = heldStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);
    const pressed = started.latest();

    await act(async () => {
      pressed.start(RELEASE_DEFINITION);
      pressed.start(AUDIT_DEFINITION);
    });

    // The picker holds ONE act, so a refusal published for the second press would erase
    // the only true thing on screen — that a run is starting, and which one — and would
    // offer the rows again while the first start was still outstanding.
    const inFlight = started.latest().act;
    expect(inFlight.status).toBe("starting");
    if (inFlight.status !== "starting") {
      throw new Error("the picker lost its in-flight reading");
    }
    expect(inFlight.definitionId).toBe(RELEASE_DEFINITION.id);
    expect(inFlight.definitionName).toBe(RELEASE_DEFINITION.name);
  });

  it("frees the key once the start is served, so the next press dispatches", async () => {
    const port = heldStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);

    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });
    await act(async () => {
      port.serve();
    });
    await settle();
    await act(async () => {
      started.latest().start(AUDIT_DEFINITION);
    });

    expect(port.requests).toHaveLength(2);
  });

  it("frees the key when the daemon refuses, so the press can be made again", async () => {
    const port = refusingStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);

    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });
    await settle();
    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });
    await settle();

    expect(port.requests).toHaveLength(2);
    expect(started.latest().act.status).toBe("refused");
  });

  it("frees the key when the call rejects rather than answering", async () => {
    const port = heldStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);

    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });
    await act(async () => {
      port.rejectAsDaemon();
    });
    await settle();
    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });

    // A key held for the life of the port would leave the picker permanently unable to
    // start anything after one call that threw instead of answering.
    expect(port.requests).toHaveLength(2);
  });

  it("holds the flight across a close and reopen of the disclosure", async () => {
    // THE DEFECT THIS CASE EXISTS FOR. The `+` menu renders the picker only while open,
    // so closing and reopening it unmounts and recreates the body — and a guard held in
    // that body starts idle every time, which let a second press dispatch a second
    // non-idempotent start while the first was still running.
    const port = heldStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);

    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });
    started.closeAndReopen();

    // The reopened picker reads the SAME act, so its rows are closed for the same
    // reason and it names the definition that is starting.
    const reopened = started.latest().act;
    expect(reopened.status).toBe("starting");
    if (reopened.status !== "starting") {
      throw new Error("the reopened picker lost the outstanding start");
    }
    expect(reopened.definitionName).toBe(RELEASE_DEFINITION.name);

    await act(async () => {
      started.latest().start(AUDIT_DEFINITION);
    });

    expect(port.requests).toHaveLength(1);
  });

  it("forgets a settled act once the disclosure closes, so a reopened picker offers every row", async () => {
    // The other half of the rule: what outlives the disclosure is the FLIGHT and not the
    // receipt. A picker reopened long after a start landed would otherwise present a
    // stale run id as though it were news.
    const port = heldStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);

    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });
    await act(async () => {
      port.serve();
    });
    await settle();
    expect(started.latest().act.status).toBe("started");

    started.closeAndReopen();

    expect(started.latest().act.status).toBe("idle");
  });

  it("negative control: one session's outstanding start does not refuse another's first press", async () => {
    // The session belongs in the key. Without it, a composer re-addressed while a start
    // was outstanding would refuse the new session's FIRST press, for a reason about a
    // session that is no longer on screen.
    const port = heldStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);

    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });
    started.readdress(SECOND_PROBE_SESSION_ID);
    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });

    expect(port.requests.map((request) => request.sessionId)).toStrictEqual([
      PROBE_SESSION_ID,
      SECOND_PROBE_SESSION_ID,
    ]);
  });

  it("negative control: a picker with no session dispatches nothing at all", async () => {
    // Without this the cases above would be satisfied by a guard that refused every
    // press, and the count assertions would read the same either way.
    const port = heldStartPort();
    const started = observeStart(port.growth, undefined);

    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });

    expect(port.requests).toHaveLength(0);
  });
});

describe("a port that throws instead of answering settles like one that rejected", () => {
  /**
   * The message a synchronously throwing port carries, so the refusal can be read back.
   *
   * A plain `Error`, which is what a stub operation or a misconfigured port actually
   * throws — the settlement seam's terminal arm keeps its message, so a person is told
   * what failed rather than being handed a code with no account behind it.
   */
  const SYNCHRONOUS_START_FAILURE = new Error("this build serves no workflow start");

  /** What one case asked, and a port whose start throws before it returns anything. */
  interface ThrowingWorkflowStart {
    readonly growth: GrowthPort;
    readonly requests: Parameters<GrowthPort["workflowRunStart"]>[0][];
  }

  /**
   * A port whose `workflowRunStart` throws SYNCHRONOUSLY rather than rejecting.
   *
   * Deliberately not `async`: an async function that throws hands back a rejected
   * promise, which this flight has always settled. The failure this suite is about is
   * the one that escapes the call expression itself, and only a non-async throw
   * reproduces it. It is spread onto the console's real refusing port rather than an
   * object shaped like one, so nothing else about the port is invented here.
   */
  function throwingStartPort(): ThrowingWorkflowStart {
    const requests: Parameters<GrowthPort["workflowRunStart"]>[0][] = [];
    const workflowRunStart: GrowthPort["workflowRunStart"] = (request) => {
      requests.push(request);
      throw SYNCHRONOUS_START_FAILURE;
    };
    return { growth: { ...createRefusingGrowthPort(), workflowRunStart }, requests };
  }

  it("publishes the normalized refusal, frees the key and lets the menu open again", async () => {
    // THE DEFECT THIS CASE EXISTS FOR. The throw escaped past the settlement seam, so
    // nothing published and the flight stayed at `starting` — a state the register keeps
    // on purpose — leaving every row disabled across a close and reopen of the menu,
    // with no answer coming and no way to ask again.
    const port = throwingStartPort();
    const started = observeStart(port.growth, PROBE_SESSION_ID);

    const reported = await unhandledRejectionsDuring(async () => {
      await act(async () => {
        started.latest().start(RELEASE_DEFINITION);
      });
      await settle();
    });

    const settledAct = started.latest().act;
    expect(settledAct.status).toBe("refused");
    if (settledAct.status !== "refused") {
      throw new Error("the picker never settled the start that threw");
    }
    // The seam's own terminal code and the thrown message verbatim: a failure nobody can
    // read is still distinguishable from a start that was never put.
    expect(settledAct.code).toBe("growth-read-call-failed");
    expect(settledAct.detail).toBe(SYNCHRONOUS_START_FAILURE.message);
    // The dispatch answered rather than rejecting, so nothing was left for the host to
    // report — which is the other half of the same escape.
    expect(reported).toStrictEqual([]);

    // The key came back, so the row can be pressed again...
    await act(async () => {
      started.latest().start(RELEASE_DEFINITION);
    });
    expect(port.requests).toHaveLength(2);

    // ...and the flight is spent, so a reopened picker offers every row from idle rather
    // than reading a start that is never going to answer.
    await settle();
    started.closeAndReopen();
    expect(started.latest().act.status).toBe("idle");
  });

  it("negative control: the port really throws rather than handing back a rejection", async () => {
    // Without this, the case above would hold over an ordinary rejecting port — the
    // failure the flight has always settled — and would say nothing about the throw that
    // escaped the call expression.
    const port = throwingStartPort();

    expect(() =>
      port.growth.workflowRunStart({
        workflowVersionId: RELEASE_DEFINITION.latestWorkflowVersionId,
        sessionId: PROBE_SESSION_ID,
      }),
    ).toThrow(SYNCHRONOUS_START_FAILURE.message);
  });
});
