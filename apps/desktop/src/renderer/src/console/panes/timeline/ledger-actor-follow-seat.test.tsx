// What a cast chip reaches when it follows an actor into this ledger.
//
// TWO CLAIMS, AND THEY NEED DIFFERENT INSTRUMENTS. The resolution — which row a wire
// sequence names, and what an absent one answers — is a pure function and is driven
// with no render at all. The SEAT is a registration with a lifetime, read from
// outside React by the command palette at any moment, so its claim is about which
// window the registry can see and can only be asked of a real mount.
//
// THE PASS REACT PARKS IS THE WHOLE POINT OF THE SECOND HALF. A transition that
// suspends is a work-in-progress fiber React keeps and never commits: the render body
// really ran, the tree on screen keeps its own frame, and no fallback is shown — which
// is the one arrangement where "the seat is reading a window that never reached the
// screen" is observable rather than theoretical. Leaving the promise unsettled is what
// makes it deterministic rather than a race with React's retry.

import { act, render } from "@testing-library/react";
import {
  Suspense,
  startTransition,
  use,
  useRef,
  useMemo,
  useEffect,
  type ReactElement,
} from "react";
import { describe, expect, it } from "vitest";

import {
  actorFollowHandler,
  registerActorFollowHandler,
  unregisterActorFollowHandler,
  type ActorFollowHandler,
} from "../../seats/index.js";
import { SuspensionGate } from "../../store/subject-scoped-drivers.test-support.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import {
  buildActorFollowHandler,
  useActorFollowSeat,
  type ActorFollowInputs,
} from "./ledger-actor-follow-seat.js";
import { ledgerFixtureStampAt } from "./ledger-feed-logs.test-support.js";
import { deriveLedgerWindow } from "./ledger-window.js";

const SESSION_ID = "session-ledger-follow-seat";
const LOG_EVENT_COUNT = 6;
const PARTICIPANT_ID = "participant-alba";

/** What one case watched happen, in the order it happened. */
type ActTrace = string[];

/** A log of participant messages, oldest first, so every row carries a sequence. */
function syntheticLog(count: number): readonly ConsoleSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId: SESSION_ID,
    sequence: index,
    kind: "user.message",
    occurredAt: ledgerFixtureStampAt(index),
    payload: {},
  }));
}

describe("the follow handler — resolving a cast chip against this window", () => {
  const rows = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false).rows;
  const NEWEST_SEQUENCE = LOG_EVENT_COUNT - 1;

  it("scrolls to the row the wire sequence names and says it revealed it", () => {
    const trace: ActTrace = [];
    const follow = buildActorFollowHandler({
      visibleRows: rows,
      jumpToRow: (rowId) => {
        trace.push(rowId);
      },
    });
    expect(follow({ participantId: PARTICIPANT_ID, newestSequence: NEWEST_SEQUENCE })).toBe(
      "revealed",
    );
    expect(trace).toStrictEqual([rows[NEWEST_SEQUENCE]?.id]);
  });

  it("answers row-not-in-view for a row this window no longer holds", () => {
    // The window the cap left, not the log: `jumpToRow` scrolls to what the
    // viewport reconciled, so a row outside it would report a reveal and move
    // nothing — which is the silent press the seat's outcome exists to end.
    const trace: ActTrace = [];
    const follow = buildActorFollowHandler({
      visibleRows: rows.slice(-2),
      jumpToRow: (rowId) => {
        trace.push(rowId);
      },
    });
    expect(follow({ participantId: PARTICIPANT_ID, newestSequence: 0 })).toBe("row-not-in-view");
    expect(trace).toStrictEqual([]);
  });

  it("negative control: a sequence no row carries reveals nothing over the whole window", () => {
    // Without this the case above would pass over a handler that answered
    // `row-not-in-view` for everything, which reports a working ledger as broken.
    const trace: ActTrace = [];
    const follow = buildActorFollowHandler({
      visibleRows: rows,
      jumpToRow: (rowId) => {
        trace.push(rowId);
      },
    });
    expect(follow({ participantId: PARTICIPANT_ID, newestSequence: LOG_EVENT_COUNT + 1 })).toBe(
      "row-not-in-view",
    );
    expect(follow({ participantId: PARTICIPANT_ID, newestSequence: NEWEST_SEQUENCE })).toBe(
      "revealed",
    );
    expect(trace).toHaveLength(1);
  });
});

/** What both probes below take, so the claim and its control run one script. */
interface FollowSeatProbeProps {
  readonly inputs: ActorFollowInputs;
  /** Present on the pass React parks: the probe suspends on it after the hook ran. */
  readonly suspendOn: Promise<void> | undefined;
  /** Called once per render body, which is what proves the parked pass really ran. */
  readonly onRendered: (inputs: ActorFollowInputs) => void;
}

/** The seat, filled through its own door. */
function FollowSeatProbe(props: FollowSeatProbeProps): ReactElement {
  useActorFollowSeat(props.inputs);
  props.onRendered(props.inputs);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>seated</output>;
}

/**
 * The arrangement this hook replaced: the ref written from the render body.
 *
 * Not a stand-in for the hook — it registers into the REAL seat and forwards through
 * the REAL resolver, and differs in the one line these cases are about.
 */
function BodyWrittenRefProbe(props: FollowSeatProbeProps): ReactElement {
  const inputsRef = useRef(props.inputs);
  inputsRef.current = props.inputs;
  const forwarding = useMemo<ActorFollowHandler>(
    () => (request) => buildActorFollowHandler(inputsRef.current)(request),
    [],
  );
  useEffect(() => {
    registerActorFollowHandler("ledger", forwarding);
    return () => {
      if (actorFollowHandler() === forwarding) {
        unregisterActorFollowHandler();
      }
    };
  }, [forwarding]);
  props.onRendered(props.inputs);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>seated</output>;
}

describe("the follow seat — which window the palette can reach through it", () => {
  const rows = deriveLedgerWindow(syntheticLog(LOG_EVENT_COUNT), false).rows;
  const NEWEST_SEQUENCE = LOG_EVENT_COUNT - 1;

  /**
   * Drive one committed mount, then one pass at a different window that React parks.
   *
   * The tree is a parameter so the claim and its control run the identical script and
   * differ only in the arrangement under test — `subject-scoped-drivers.test-support.ts`'
   * own shape, for its reason.
   */
  async function seatAfterAParkedPass(
    Probe: (props: FollowSeatProbeProps) => ReactElement,
  ): Promise<{
    readonly outcome: string;
    readonly committedTrace: ActTrace;
    readonly renderedWindowSizes: readonly number[];
  }> {
    const committedTrace: ActTrace = [];
    const parkedTrace: ActTrace = [];
    const renderedWindowSizes: number[] = [];
    const committedInputs: ActorFollowInputs = {
      visibleRows: rows,
      jumpToRow: (rowId) => {
        committedTrace.push(rowId);
      },
    };
    // A window holding NO row the sequence names, so the two arms answer differently:
    // the committed window reveals the newest row and this one cannot.
    const parkedInputs: ActorFollowInputs = {
      visibleRows: [],
      jumpToRow: (rowId) => {
        parkedTrace.push(rowId);
      },
    };
    const treeAt = (
      inputs: ActorFollowInputs,
      suspendOn: Promise<void> | undefined,
    ): ReactElement => (
      <Suspense fallback={<p>the pass that was parked</p>}>
        <Probe
          inputs={inputs}
          suspendOn={suspendOn}
          onRendered={(rendered) => {
            renderedWindowSizes.push(rendered.visibleRows.length);
          }}
        />
      </Suspense>
    );
    const view = render(treeAt(committedInputs, undefined));
    const gate = new SuspensionGate();
    await act(async () => {
      startTransition(() => {
        view.rerender(treeAt(parkedInputs, gate.pending));
      });
    });

    // Read the seat WHILE the pass is parked, which is the only moment the question
    // has an answer: a later render at the committed window would write the ref back
    // under either arrangement and both arms would pass.
    const handler = actorFollowHandler();
    if (handler === undefined) {
      throw new Error("the mounted probe filled no follow seat");
    }
    const outcome = handler({ participantId: PARTICIPANT_ID, newestSequence: NEWEST_SEQUENCE });
    view.unmount();
    return { outcome, committedTrace, renderedWindowSizes };
  }

  it("resolves against the committed window, never one a parked pass proposed", async () => {
    const { outcome, committedTrace, renderedWindowSizes } =
      await seatAfterAParkedPass(FollowSeatProbe);

    // Non-vacuity first: the parked pass really ran its render body over the empty
    // window, so the case is about what the seat could see rather than about a pass
    // that never happened.
    expect(renderedWindowSizes).toContain(0);
    expect(outcome).toBe("revealed");
    expect(committedTrace).toStrictEqual([rows[NEWEST_SEQUENCE]?.id]);
  });

  it("negative control: a ref written in the render body leaks the parked window", async () => {
    const { outcome, committedTrace, renderedWindowSizes } =
      await seatAfterAParkedPass(BodyWrittenRefProbe);

    expect(renderedWindowSizes).toContain(0);
    // The defect, stated as a case: the palette's follow acts against a window that
    // never reached the screen and reports that there was nothing to reveal.
    expect(outcome).toBe("row-not-in-view");
    expect(committedTrace).toStrictEqual([]);
  });
});
