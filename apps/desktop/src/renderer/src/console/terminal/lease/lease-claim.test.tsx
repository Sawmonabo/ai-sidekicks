// The claim hook's two renderer-local facts, and the subject they belong to.
//
// Its own file rather than a block in `LeaseLine.claim.test.tsx` because the subject
// is different: that file asserts what the SURFACE renders for a claim, and this one
// asserts which subject a claim's state belongs to — a question about the hook's own
// arithmetic over `(bridge, sessionId)`.
//
// WHY THE CASES READ A LOG OF FRAMES RATHER THAN THE SETTLED TREE. The reset used to
// run in a passive effect while the hook returned unstamped values, so session B's
// first COMMITTED render inherited A's disabled control or A's refusal and the
// correction arrived one frame later. A test that reads the DOM after the rerender
// reads the corrected frame and sees nothing wrong; the frame a person actually sees
// is the one the render produced, so the probe below records every frame and the
// cases name the one they are about. The stamp makes that frame idle by
// construction, with no pass left to be wrong on.
//
// The wire is the fixture bridge with its lease calls held, which is the only way to
// have a call genuinely still out across a rerender — and the only way to settle the
// call for the session the pane LEFT rather than the one it moved to.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle as settleReactWork } from "../../core/settle.test-support.js";
import { HeldLeaseWire, OTHER_SESSION_ID, SESSION_ID } from "./LeaseLine.test-support.js";
import { useTerminalLeaseClaim, type TerminalLeaseClaim } from "./lease-claim.js";

/**
 * Every frame the hook produced, in render order.
 *
 * A class rather than an array a case pushes into, on this package's rule that state
 * is encapsulated: what a case wants is "the frame after the switch", and an index
 * into a bare array is a number a reader has to reconstruct.
 */
class ClaimFrameLog {
  readonly #frames: TerminalLeaseClaim[] = [];

  public record(claim: TerminalLeaseClaim): void {
    this.#frames.push(claim);
  }

  public get frameCount(): number {
    return this.#frames.length;
  }

  public frameAt(frameIndex: number): TerminalLeaseClaim {
    const frame = this.#frames[frameIndex];
    if (frame === undefined) {
      throw new Error(`the hook produced no frame number ${String(frameIndex)}`);
    }
    return frame;
  }

  public get newestFrame(): TerminalLeaseClaim {
    return this.frameAt(this.#frames.length - 1);
  }
}

/** The hook, driven with nothing else in the way, recording what it returns. */
function ClaimProbe(props: {
  readonly heldWire: HeldLeaseWire;
  readonly sessionId: string;
  readonly log: ClaimFrameLog;
}): React.JSX.Element {
  props.log.record(useTerminalLeaseClaim(props.heldWire.bridge, props.sessionId));
  return <span />;
}

function renderClaim(
  heldWire: HeldLeaseWire,
  log: ClaimFrameLog,
): ReturnType<typeof render> & { readonly showSession: (sessionId: string) => void } {
  const view = render(<ClaimProbe heldWire={heldWire} sessionId={SESSION_ID} log={log} />);
  return {
    ...view,
    showSession: (sessionId: string): void => {
      view.rerender(<ClaimProbe heldWire={heldWire} sessionId={sessionId} log={log} />);
    },
  };
}

describe("the terminal lease claim, stamped to its subject", () => {
  it("hands the new session an idle control on its FIRST committed frame", async () => {
    const heldWire = new HeldLeaseWire();
    const log = new ClaimFrameLog();
    const view = renderClaim(heldWire, log);
    act(() => {
      log.newestFrame.acquire();
    });
    expect(log.newestFrame.isInFlight).toBe(true);
    const framesBeforeTheSwitch = log.frameCount;

    view.showSession(OTHER_SESSION_ID);

    // The frame the switch itself produced, not the one a passive effect corrected
    // afterwards. A person pressing in that frame was pressing a control disabled
    // for a call about a shell they were no longer looking at.
    const firstFrameOnTheNewSession = log.frameAt(framesBeforeTheSwitch);
    expect(firstFrameOnTheNewSession.isInFlight).toBe(false);
    expect(firstFrameOnTheNewSession.refusal).toBeUndefined();

    heldWire.rejectCall(0);
    await settleReactWork();

    // And the answer to the question about the session it left is never rendered
    // against the one it is on.
    expect(log.newestFrame.refusal).toBeUndefined();
    expect(log.newestFrame.isInFlight).toBe(false);
  });

  it("issues the new session's own request from that same frame", async () => {
    const heldWire = new HeldLeaseWire();
    const log = new ClaimFrameLog();
    const view = renderClaim(heldWire, log);
    act(() => {
      log.newestFrame.acquire();
    });
    const framesBeforeTheSwitch = log.frameCount;

    view.showSession(OTHER_SESSION_ID);
    act(() => {
      log.frameAt(framesBeforeTheSwitch).acquire();
    });

    // The call built during the render that first saw the new session carries that
    // session, so a press in the very first frame reaches the right shell.
    expect(heldWire.heldCallCount).toBe(2);
    expect(heldWire.sessionIdOfCall(1)).toBe(OTHER_SESSION_ID);
    expect(log.newestFrame.isInFlight).toBe(true);

    heldWire.rejectCall(0);
    await settleReactWork();

    // The old session's settlement retires nothing: the new session's call is still
    // out, and its refusal is not the other session's.
    expect(log.newestFrame.isInFlight).toBe(true);
    expect(log.newestFrame.refusal).toBeUndefined();

    heldWire.rejectCall(1);
    await settleReactWork();

    expect(log.newestFrame.isInFlight).toBe(false);
    expect(log.newestFrame.refusal?.code).toBe(HeldLeaseWire.LEASE_CONFLICT.code);
  });

  it("hands a RETURNING visit a control whose press reaches the wire", async () => {
    // s1 -> s2 -> s1, with the first call never answered. The state re-seeds on the
    // return — the holder mints a new addressing because the same pair visited twice
    // is two visits — so the control renders idle and enabled. A register keyed on
    // `(bridge, sessionId)` would still be holding the FIRST visit's round: the press
    // was refused by a key the control cannot see, no request went out, nothing was
    // said, and the button stayed enabled for as long as the first call stayed out.
    const heldWire = new HeldLeaseWire();
    const log = new ClaimFrameLog();
    const view = renderClaim(heldWire, log);
    act(() => {
      log.newestFrame.acquire();
    });
    expect(log.newestFrame.isInFlight).toBe(true);

    view.showSession(OTHER_SESSION_ID);
    view.showSession(SESSION_ID);

    const firstFrameBack = log.newestFrame;
    expect(firstFrameBack.isInFlight).toBe(false);

    act(() => {
      firstFrameBack.acquire();
    });

    expect(heldWire.heldCallCount).toBe(2);
    expect(heldWire.sessionIdOfCall(1)).toBe(SESSION_ID);
    expect(log.newestFrame.isInFlight).toBe(true);

    // And the FIRST visit's answer still installs nowhere: it is about a round the
    // holder has retired, so the returning visit's own call goes on being the one
    // the control is waiting for.
    heldWire.rejectCall(0);
    await settleReactWork();

    expect(log.newestFrame.isInFlight).toBe(true);
    expect(log.newestFrame.refusal).toBeUndefined();
  });

  it("drops a settlement that lands after the pane closed", async () => {
    const heldWire = new HeldLeaseWire();
    const log = new ClaimFrameLog();
    const view = renderClaim(heldWire, log);
    act(() => {
      log.newestFrame.acquire();
    });
    const framesBeforeTheClose = log.frameCount;

    view.unmount();
    heldWire.rejectCall(0);
    await settleReactWork();

    // No flag of its own: an unmounted hook has no committed state for a late
    // settlement to reach, so nothing renders and no frame is produced.
    expect(log.frameCount).toBe(framesBeforeTheClose);
  });

  it("negative control: the session it is still on keeps both of its facts", async () => {
    // Without this, a hook that reported idle for every subject would satisfy every
    // case above — which is a claim control that never says a call is out and never
    // renders what refused it.
    const heldWire = new HeldLeaseWire();
    const log = new ClaimFrameLog();
    renderClaim(heldWire, log);

    act(() => {
      log.newestFrame.acquire();
    });
    expect(log.newestFrame.isInFlight).toBe(true);

    heldWire.rejectCall(0);
    await settleReactWork();

    expect(log.newestFrame.isInFlight).toBe(false);
    expect(log.newestFrame.refusal?.code).toBe(HeldLeaseWire.LEASE_CONFLICT.code);
  });

  it("negative control: a second press while a call is out starts nothing", async () => {
    // ONE ACT AT A TIME, and the latch states it by refusing a claim on a key it is
    // already holding. The control is disabled for exactly that lifetime, so the
    // second press is a press that should not have reached the wire at all — and the
    // shape this replaced could not say so: it dispatched a second call and let the
    // earlier settlement clear the in-flight flag the later press had just set,
    // bringing the control back enabled while a take was still out.
    const heldWire = new HeldLeaseWire();
    const log = new ClaimFrameLog();
    renderClaim(heldWire, log);
    act(() => {
      log.newestFrame.acquire();
    });
    act(() => {
      log.newestFrame.acquire();
    });
    expect(heldWire.heldCallCount).toBe(1);
    expect(log.newestFrame.isInFlight).toBe(true);

    // And the one call that WAS dispatched still settles: refusing the second claim
    // must not orphan the first, which is the failure a bare "ignore while busy"
    // guard makes when it forgets to release.
    heldWire.rejectCall(0);
    await settleReactWork();

    expect(log.newestFrame.isInFlight).toBe(false);
    expect(log.newestFrame.refusal?.code).toBe(HeldLeaseWire.LEASE_CONFLICT.code);

    // The key is back, so the next press dispatches.
    act(() => {
      log.newestFrame.acquire();
    });
    expect(heldWire.heldCallCount).toBe(2);
  });
});
