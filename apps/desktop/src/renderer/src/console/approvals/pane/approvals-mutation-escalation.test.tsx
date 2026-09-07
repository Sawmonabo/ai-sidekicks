// A mutation that came back saying the session is gone, and where that fact lands.
//
// `Spec-023 §Console Design (Meridian)` rule 9 gives a refusal three renderings, and
// the banner is the frame's. `RemediedRefusal` draws the CARD for a banner-class code
// because a pure component holds no store — so the handover has to be an explicit act
// by whoever holds the refusal, and until it was, a resolve that answered
// `session.not_found` put one line inside one pane while every other pane in the
// window went on drawing a session that had left the node.
//
// TWO SEAMS, AND THEY ARE NOT THE SAME CLAIM. The reader's two mutation maps can hold
// a daemon code, because a rejected `approval.resolve` is normalized by the surface's
// own reader and arrives with the daemon's word on it. The goal mutation cannot, and
// the last case here is what says so rather than what asserts it: its seam is the
// growth port, whose refusal vocabulary is two closed literals, so today the only
// thing a goal refusal can be is the "no wire yet" kind of nothing — which is
// card-class and escalates nothing. The wiring is at the seam regardless, so the day
// Plan-016 registers the pair the escalation is already its reader.

import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type ConsoleBridge } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { createFixture } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { FrameStore, type SessionStore } from "../../store/index.js";
import { useApprovalsReader, useSessionGoalMutation } from "./approvals-hooks.js";
import { type ApprovalsSnapshot } from "./approvals-reader.js";
import { initialisedStore, observableBridge, SESSION_ID } from "./approvals-hooks.test-support.js";

const APPROVAL_ID = "019b7a44-4400-75e5-8510-ada11a5a66c7";

/** The daemon envelope a resolve is rejected with once the session has left the node. */
const SESSION_GONE_REJECTION = {
  code: "session.not_found",
  message: "That session is not open on this node.",
};

/** A rejection whose code the remedy table renders inside the pane and nowhere else. */
const STALE_COMPARAND_REJECTION = {
  code: "run.version_conflict",
  message: "The run moved on while the request was open.",
};

type ApprovalsReading = ReturnType<typeof useApprovalsReader>;

/**
 * The shipped fixture with one arm replaced: `approval.resolve` REJECTS.
 *
 * A rejection and not a refusal value, because that is the arm the daemon code
 * survives on — the reader normalizes a rejected mutation through the console's one
 * reading of a wire rejection, while the growth port's own refusal vocabulary is
 * closed and carries no daemon code at all.
 */
function bridgeRejectingResolve(rejection: unknown): ConsoleBridge {
  const fixture = observableBridge().bridge;
  return {
    ...fixture,
    growth: {
      ...fixture.growth,
      approvalResolve: async () => {
        await Promise.resolve();
        throw rejection;
      },
    },
  };
}

/** One mounted reader, handing back the reading the surface renders from. */
function ReaderProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly frameStore: FrameStore;
  readonly onReading: (reading: ApprovalsReading) => void;
}): React.JSX.Element | null {
  const reading = useApprovalsReader(props.bridge, props.sessionStore, props.frameStore);
  const { onReading } = props;
  useEffect(() => {
    onReading(reading);
  }, [onReading, reading]);
  return null;
}

/** Mount the reader, press one resolve, and hand back what both sides ended with. */
async function resolveRefusedWith(rejection: unknown): Promise<{
  readonly banners: readonly { readonly code: string; readonly detail: string }[];
  readonly snapshot: ApprovalsSnapshot;
}> {
  const frameStore = new FrameStore();
  let reading: ApprovalsReading | undefined;
  await act(async () => {
    render(
      <ReaderProbe
        bridge={bridgeRejectingResolve(rejection)}
        sessionStore={initialisedStore()}
        frameStore={frameStore}
        onReading={(next) => {
          reading = next;
        }}
      />,
    );
    await crossMacrotaskBoundary();
  });
  const mounted = reading;
  if (mounted === undefined) {
    throw new Error("the hook handed back no reading");
  }

  await act(async () => {
    mounted.reader.resolve({ approvalRequestId: APPROVAL_ID, decision: "approved" });
    await crossMacrotaskBoundary();
  });

  if (reading === undefined) {
    throw new Error("the hook handed back no reading");
  }
  return {
    banners: frameStore.getState().banners.map(({ code, detail }) => ({ code, detail })),
    snapshot: reading.snapshot,
  };
}

describe("a resolve the daemon refused with a whole-session code", () => {
  it("reaches the frame's banner and stays on the card as well", async () => {
    const settled = await resolveRefusedWith(SESSION_GONE_REJECTION);

    expect(settled.banners).toStrictEqual([
      { code: "session.not_found", detail: SESSION_GONE_REJECTION.message },
    ]);
    // BOTH, and the second half is the point: the person pressed a control here, so
    // the answer belongs beside it. Escalating by MOVING the refusal would leave the
    // card that was just acted on with nothing on it.
    expect(settled.snapshot.resolveRefusalByApprovalId.get(APPROVAL_ID)?.code).toBe(
      "session.not_found",
    );
  });

  it("negative control: a refusal about the act alone stays inside the pane", async () => {
    // Without this the case above would pass over a hook that escalated every
    // mutation refusal, which puts one card's stale comparand across the window.
    const settled = await resolveRefusedWith(STALE_COMPARAND_REJECTION);

    expect(settled.banners).toStrictEqual([]);
    expect(settled.snapshot.resolveRefusalByApprovalId.get(APPROVAL_ID)?.code).toBe(
      "run.version_conflict",
    );
  });
});

describe("the goal mutation hands its refusal over on the same terms", () => {
  type GoalMutation = ReturnType<typeof useSessionGoalMutation>;

  function GoalProbe(props: {
    readonly bridge: ConsoleBridge;
    readonly frameStore: FrameStore;
    readonly onMutation: (mutation: GoalMutation) => void;
  }): React.JSX.Element | null {
    const mutation = useSessionGoalMutation(props.bridge, SESSION_ID, props.frameStore);
    const { onMutation } = props;
    useEffect(() => {
      onMutation(mutation);
    }, [mutation, onMutation]);
    return null;
  }

  it("escalates nothing for the one refusal its seam can produce today", async () => {
    // Not a claim that the wiring is absent — it is at the seam, and the resolve
    // assertion above is the same hook file's other half. It is a claim about what
    // the GROWTH PORT can say: `session.goalUpdate` is a registered method whose pair
    // `@ai-sidekicks/contracts` does not publish, so the live port refuses by name
    // with `wire-unregistered`, which the remedy table renders in the pane. A banner
    // here would be the console announcing a missing wire to the whole window.
    const frameStore = new FrameStore();
    const bridge: ConsoleBridge = { ...createFixture().bridge, growth: createRefusingGrowthPort() };
    let mutation: GoalMutation | undefined;
    await act(async () => {
      render(
        <GoalProbe
          bridge={bridge}
          frameStore={frameStore}
          onMutation={(next) => {
            mutation = next;
          }}
        />,
      );
      await crossMacrotaskBoundary();
    });
    const held = mutation;
    if (held === undefined) {
      throw new Error("the hook handed back no mutation");
    }

    await act(async () => {
      held.update("ship the console");
      await crossMacrotaskBoundary();
    });

    expect(mutation?.refusal?.code).toBe("wire-unregistered");
    expect(frameStore.getState().banners).toStrictEqual([]);
  });
});
