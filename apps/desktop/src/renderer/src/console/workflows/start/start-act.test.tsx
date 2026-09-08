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

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GrowthPort } from "../../bridge/index.js";
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
} {
  const observed: WorkflowStartDispatch[] = [];
  const collect = (dispatch: WorkflowStartDispatch): void => {
    observed.push(dispatch);
  };
  const view = render(<StartProbe growth={growth} sessionId={sessionId} onObserve={collect} />);
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
