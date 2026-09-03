// A compaction that settles after the composer has been re-addressed.
//
// The hook-level half of the target rule. `compaction-dispatch.test.ts` beside this
// file drives `settleCompaction` over the fixture bridge, which is the right
// collaborator for "what does a reply settle as"; the defect here is about TIMING —
// a call in flight across a re-address — so these cases park the call and decide
// themselves when it comes back.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParkedDaemonCalls } from "../../../../../../test/console/parked-daemon-calls.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import {
  isSameCompactionTarget,
  useCompactionDispatch,
  type CompactionDispatch,
  type CompactionTarget,
} from "./compaction-dispatch.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const RUN_A = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";
const RUN_B = "2c3d4e5f-6071-4283-8495-bc6d7e8f9012";
const APPLIED_REPLY = { status: "applied", boundaryPosition: 7 };

/** Reports the dispatch out of the tree at whichever run the case addresses. */
function AddressableProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly targetRunId: string;
  readonly onDispatch: (dispatch: CompactionDispatch) => void;
}): null {
  const dispatch = useCompactionDispatch(props.bridge, SESSION_ID, props.targetRunId);
  props.onDispatch(dispatch);
  return null;
}

interface DrivenCompaction {
  readonly calls: ParkedDaemonCalls;
  latest(): CompactionDispatch;
  press(): void;
  reAddressTo(targetRunId: string): void;
}

function driveAddressableCompaction(): DrivenCompaction {
  const calls = new ParkedDaemonCalls();
  let latest: CompactionDispatch | undefined;
  const renderAt = (targetRunId: string): React.JSX.Element => (
    <AddressableProbe
      bridge={calls.bridge}
      targetRunId={targetRunId}
      onDispatch={(dispatch) => {
        latest = dispatch;
      }}
    />
  );
  const view = render(renderAt(RUN_A));
  const latestDispatch = (): CompactionDispatch => {
    if (latest === undefined) {
      throw new Error("the probe reported no dispatch");
    }
    return latest;
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
      act(() => {
        view.rerender(renderAt(targetRunId));
      });
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
      await Promise.resolve();
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

describe("useCompactionDispatch — a settlement renders under the run it is about", () => {
  it("never renders one run's settlement beside another run's control", async () => {
    const driven = driveAddressableCompaction();
    driven.press();
    driven.reAddressTo(RUN_B);

    await act(async () => {
      driven.calls.resolveOldest(APPLIED_REPLY);
      await Promise.resolve();
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
      await Promise.resolve();
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
      await Promise.resolve();
    });

    expect(driven.latest().state.phase).toBe("settled");
  });
});

describe("isSameCompactionTarget — all three parts, and none of them redundant", () => {
  const bridge = { source: "fixture" } as unknown as ConsoleBridge;
  const otherBridge = { source: "fixture" } as unknown as ConsoleBridge;
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
