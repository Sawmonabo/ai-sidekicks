// A compaction that settles after the composer has been re-addressed.
//
// The hook-level half of the target rule. `compaction-dispatch.test.ts` beside this
// file drives `settleCompaction` over the fixture bridge, which is the right
// collaborator for "what does a reply settle as"; the defect here is about TIMING —
// a call in flight across a re-address — so these cases park the call and decide
// themselves when it comes back.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkedDaemonCalls } from "../../parked-daemon-calls.test-support.js";
import type { ConsoleBridge } from "../../../../console/bridge/index.js";
import { createFixture } from "../../../../console/bridge/fixture/fixture-bridge.test-support.js";
import {
  isSameCompactionTarget,
  useCompactionDispatch,
  type CompactionDispatch,
  type CompactionTarget,
} from "./compaction-dispatch.js";
import { drainMicrotasks } from "../../../../console/bridge/fixture/fixture-bridge.test-support.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const RUN_A = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";
const RUN_B = "2c3d4e5f-6071-4283-8495-bc6d7e8f9012";
const OTHER_SESSION_ID = "5e6f7081-9203-4415-8627-ab8c9d0e1f23";
const APPLIED_REPLY = { status: "applied", boundaryPosition: 7 };

/** Reports the dispatch out of the tree at whichever subject the case addresses. */
function AddressableProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly targetRunId: string;
  readonly onDispatch: (dispatch: CompactionDispatch) => void;
}): null {
  const dispatch = useCompactionDispatch(props.bridge, props.sessionId, props.targetRunId);
  props.onDispatch(dispatch);
  return null;
}

/** The three parts a compaction is about, as a case moves the composer between them. */
interface ProbeSubject {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly targetRunId: string;
}

interface DrivenCompaction {
  readonly calls: ParkedDaemonCalls;
  latest(): CompactionDispatch;
  press(): void;
  reAddressTo(targetRunId: string): void;
  /** Move the composer onto another transport or session, run unchanged. */
  moveSubjectTo(subject: Partial<Omit<ProbeSubject, "targetRunId">>): void;
}

function driveAddressableCompaction(): DrivenCompaction {
  const calls = new ParkedDaemonCalls();
  let latest: CompactionDispatch | undefined;
  let subject: ProbeSubject = {
    bridge: calls.bridge,
    sessionId: SESSION_ID,
    targetRunId: RUN_A,
  };
  const renderSubject = (): React.JSX.Element => (
    <AddressableProbe
      bridge={subject.bridge}
      sessionId={subject.sessionId}
      targetRunId={subject.targetRunId}
      onDispatch={(dispatch) => {
        latest = dispatch;
      }}
    />
  );
  const view = render(renderSubject());
  const latestDispatch = (): CompactionDispatch => {
    if (latest === undefined) {
      throw new Error("the probe reported no dispatch");
    }
    return latest;
  };
  const moveTo = (next: Partial<ProbeSubject>): void => {
    subject = { ...subject, ...next };
    act(() => {
      view.rerender(renderSubject());
    });
  };
  return {
    calls,
    latest: latestDispatch,
    press: () => {
      act(() => {
        latestDispatch().requestCompaction();
      });
    },
    reAddressTo: (targetRunId: string) => {
      moveTo({ targetRunId });
    },
    moveSubjectTo: (next) => {
      moveTo(next);
    },
  };
}

describe("useCompactionDispatch — the latch belongs to the run, not to the composer", () => {
  it("lets a newly addressed run issue while another run's call is still in flight", async () => {
    // The finding: one latch for the whole hook, so a composer re-addressed while a
    // compaction was travelling handed the new run a Compact button that did nothing
    // and gave no reason for doing nothing.
    const driven = driveAddressableCompaction();
    driven.press();
    expect(driven.calls.parkedCount).toBe(1);

    driven.reAddressTo(RUN_B);
    driven.press();

    expect(driven.calls.parkedCount).toBe(2);
    await act(async () => {
      driven.calls.resolveOldest(APPLIED_REPLY);
      driven.calls.resolveOldest(APPLIED_REPLY);
      await drainMicrotasks();
    });
  });

  it("negative control: a second press on the SAME run issues no second call", () => {
    // The single-flight rule the per-run latch must not lose. Without this the case
    // above would hold over a hook that had simply stopped latching at all.
    const driven = driveAddressableCompaction();
    driven.press();
    driven.press();

    expect(driven.calls.parkedCount).toBe(1);
  });
});

describe("useCompactionDispatch — each subject generation owns its own latch", () => {
  it("does not let an abandoned call's settlement release the live latch", async () => {
    // The finding: the reset cleared the in-flight set IN PLACE, so the call already
    // travelling still held that same object. Its settlement ran an unconditional
    // delete against the set the new session was latching on, freeing a call that
    // was still in flight — and the next press dispatched a duplicate compaction of
    // the same run.
    const driven = driveAddressableCompaction();
    driven.press();
    expect(driven.calls.parkedCount).toBe(1);

    driven.moveSubjectTo({ sessionId: OTHER_SESSION_ID });
    driven.press();
    expect(driven.calls.parkedCount).toBe(2);

    // The abandoned generation's call answers, which takes it off the queue and
    // leaves the live one on it. It releases what it took and nothing else, so the
    // live call is still latched and the press below dispatches nothing: one call
    // stays parked. On the shared set this press issued a second compaction of the
    // same run and the count went back to two.
    await act(async () => {
      driven.calls.resolveOldest(APPLIED_REPLY);
      await drainMicrotasks();
    });
    driven.press();

    expect(driven.calls.parkedCount).toBe(1);
  });

  it("negative control: the live call's own settlement does free its run", async () => {
    // Without this the case above would hold over a latch that had simply stopped
    // releasing, which wedges the button for the rest of the window.
    const driven = driveAddressableCompaction();
    driven.press();
    await act(async () => {
      driven.calls.resolveOldest(APPLIED_REPLY);
      await drainMicrotasks();
    });

    driven.press();

    expect(driven.calls.parkedCount).toBe(1);
  });

  it("lets a run latched under an abandoned subject issue again under the new one", () => {
    // The other half of per-generation keying: a set cleared in place would have
    // given the same answer here, and a set never cleared at all would refuse the
    // press. The generation is fresh, so this is a first press.
    const driven = driveAddressableCompaction();
    driven.press();
    driven.moveSubjectTo({ sessionId: OTHER_SESSION_ID });
    driven.press();

    expect(driven.calls.parkedCount).toBe(2);
  });
});

describe("useCompactionDispatch — a settlement renders under the run it is about", () => {
  it("never renders one run's settlement beside another run's control", async () => {
    const driven = driveAddressableCompaction();
    driven.press();
    driven.reAddressTo(RUN_B);

    await act(async () => {
      driven.calls.resolveOldest(APPLIED_REPLY);
      await drainMicrotasks();
    });

    expect(driven.latest().state.phase).toBe("idle");
  });

  it("keeps it for the run that asked, so returning to that run still answers", async () => {
    // The chosen disposition, stated as a case: a settlement is rendered nowhere but
    // under its own target, and it is not thrown away merely because the person
    // looked at another run while it travelled.
    const driven = driveAddressableCompaction();
    driven.press();
    driven.reAddressTo(RUN_B);
    await act(async () => {
      driven.calls.resolveOldest(APPLIED_REPLY);
      await drainMicrotasks();
    });

    driven.reAddressTo(RUN_A);

    expect(driven.latest().state.phase).toBe("settled");
  });

  it("shows the in-flight state only under the run whose call it is", () => {
    const driven = driveAddressableCompaction();
    driven.press();
    expect(driven.latest().state.phase).toBe("dispatching");

    driven.reAddressTo(RUN_B);

    expect(driven.latest().state.phase).toBe("idle");
  });

  it("negative control: with no re-address the same settlement renders", async () => {
    const driven = driveAddressableCompaction();
    driven.press();

    await act(async () => {
      driven.calls.resolveOldest(APPLIED_REPLY);
      await drainMicrotasks();
    });

    expect(driven.latest().state.phase).toBe("settled");
  });
});

describe("isSameCompactionTarget — all three parts, and none of them redundant", () => {
  // Two REAL bridges rather than two casts of a one-member literal: the part under
  // test is transport identity, and a stand-in that is not a bridge proves identity
  // over an object the surface could never have been handed.
  const bridge = createFixture().bridge;
  const otherBridge = createFixture().bridge;
  const target: CompactionTarget = { bridge, sessionId: SESSION_ID, targetRunId: RUN_A };

  it("matches a target composed of the same three parts", () => {
    expect(
      isSameCompactionTarget(target, { bridge, sessionId: SESSION_ID, targetRunId: RUN_A }),
    ).toBe(true);
  });

  it("separates two runs of one session", () => {
    expect(
      isSameCompactionTarget(target, { bridge, sessionId: SESSION_ID, targetRunId: RUN_B }),
    ).toBe(false);
  });

  it("separates one run id read under two sessions", () => {
    expect(isSameCompactionTarget(target, { bridge, sessionId: RUN_B, targetRunId: RUN_A })).toBe(
      false,
    );
  });

  it("negative control: two bridges are two targets even where the ids agree", () => {
    // The part most easily dropped as redundant, and the one the fixture picker
    // exercises: the window replaces the bridge under a mounted composer, and a
    // settlement from the previous transport must not land under the new one.
    expect(
      isSameCompactionTarget(target, {
        bridge: otherBridge,
        sessionId: SESSION_ID,
        targetRunId: RUN_A,
      }),
    ).toBe(false);
  });
});
