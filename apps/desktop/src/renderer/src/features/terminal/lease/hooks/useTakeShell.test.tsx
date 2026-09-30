// The take hook's renderer-local fact and the subject it belongs to: the hook's own arithmetic
// over `(bridge, sessionId)`, where `LeaseLine.take-shell.test.tsx` asserts what the line renders.
//
// The cases read a log of frames, not the settled tree: a reset in a passive effect would let
// session B's first committed render inherit A's disabled control, and the DOM after a rerender
// shows only the corrected frame. The stamp makes that frame idle by construction. Calls are
// held so one stays out across a rerender and can be settled for the session the pane left.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle as settleReactWork } from "@test/helpers/settle.js";
import {
  HeldLeaseCalls,
  OTHER_SESSION_ID,
  SESSION_ID,
} from "../components/LeaseLine.test-support.js";
import { useTakeShell, type UseTakeShellResult } from "./useTakeShell.js";

/**
 * Every frame the hook produced, in render order. A class so a case can ask for "the frame
 * after the switch" instead of indexing a bare array.
 */
class TakeFrameLog {
  readonly #frames: UseTakeShellResult[] = [];

  public record(takeShell: UseTakeShellResult): void {
    this.#frames.push(takeShell);
  }

  public get frameCount(): number {
    return this.#frames.length;
  }

  public frameAt(frameIndex: number): UseTakeShellResult {
    const frame = this.#frames[frameIndex];
    if (frame === undefined) {
      throw new Error(`the hook produced no frame number ${String(frameIndex)}`);
    }
    return frame;
  }

  public get newestFrame(): UseTakeShellResult {
    return this.frameAt(this.#frames.length - 1);
  }
}

/** The hook, driven with nothing else in the way, recording what it returns. */
function TakeProbe(props: {
  readonly heldCalls: HeldLeaseCalls;
  readonly sessionId: string;
  readonly log: TakeFrameLog;
}): React.JSX.Element {
  props.log.record(useTakeShell(props.heldCalls.bridge, props.sessionId, props.heldCalls.calls));
  return <span />;
}

function renderTake(
  heldCalls: HeldLeaseCalls,
  log: TakeFrameLog,
): ReturnType<typeof render> & { readonly showSession: (sessionId: string) => void } {
  const view = render(<TakeProbe heldCalls={heldCalls} sessionId={SESSION_ID} log={log} />);
  return {
    ...view,
    showSession: (sessionId: string): void => {
      view.rerender(<TakeProbe heldCalls={heldCalls} sessionId={sessionId} log={log} />);
    },
  };
}

describe("the terminal lease take, stamped to its subject", () => {
  it("hands the new session an idle control on its FIRST committed frame", async () => {
    const heldCalls = new HeldLeaseCalls();
    const log = new TakeFrameLog();
    const view = renderTake(heldCalls, log);
    act(() => {
      log.newestFrame.take();
    });
    expect(log.newestFrame.isInFlight).toBe(true);
    const framesBeforeTheSwitch = log.frameCount;

    view.showSession(OTHER_SESSION_ID);

    // The frame the switch itself produced, not one a passive effect corrected afterwards: a
    // press in it would hit a control disabled for a shell the person had left.
    const firstFrameOnTheNewSession = log.frameAt(framesBeforeTheSwitch);
    expect(firstFrameOnTheNewSession.isInFlight).toBe(false);

    heldCalls.settleCall(0);
    await settleReactWork();

    // The settlement of the session it left retires nothing on the one it is on.
    expect(log.newestFrame.isInFlight).toBe(false);
  });

  it("issues the new session's own request from that same frame", async () => {
    const heldCalls = new HeldLeaseCalls();
    const log = new TakeFrameLog();
    const view = renderTake(heldCalls, log);
    act(() => {
      log.newestFrame.take();
    });
    const framesBeforeTheSwitch = log.frameCount;

    view.showSession(OTHER_SESSION_ID);
    act(() => {
      log.frameAt(framesBeforeTheSwitch).take();
    });

    // The call built during the render that first saw the new session carries that
    // session, so a press in the very first frame reaches the right shell.
    expect(heldCalls.heldCallCount).toBe(2);
    expect(heldCalls.sessionIdOfCall(1)).toBe(OTHER_SESSION_ID);
    expect(log.newestFrame.isInFlight).toBe(true);

    heldCalls.settleCall(0);
    await settleReactWork();

    // The old session's settlement retires nothing: the new session's call is still out.
    expect(log.newestFrame.isInFlight).toBe(true);

    heldCalls.settleCall(1);
    await settleReactWork();

    expect(log.newestFrame.isInFlight).toBe(false);
  });

  it("hands a RETURNING visit a control whose press reaches the wire", async () => {
    // s1 -> s2 -> s1 with the first call never answered. The state re-seeds on the return (the
    // holder mints a new addressing for a repeat visit), so the control is idle and enabled; a
    // register keyed on `(bridge, sessionId)` would still hold the first visit's round and
    // refuse the press silently.
    const heldCalls = new HeldLeaseCalls();
    const log = new TakeFrameLog();
    const view = renderTake(heldCalls, log);
    act(() => {
      log.newestFrame.take();
    });
    expect(log.newestFrame.isInFlight).toBe(true);

    view.showSession(OTHER_SESSION_ID);
    view.showSession(SESSION_ID);

    const firstFrameBack = log.newestFrame;
    expect(firstFrameBack.isInFlight).toBe(false);

    act(() => {
      firstFrameBack.take();
    });

    expect(heldCalls.heldCallCount).toBe(2);
    expect(heldCalls.sessionIdOfCall(1)).toBe(SESSION_ID);
    expect(log.newestFrame.isInFlight).toBe(true);

    // The first visit's answer installs nowhere: that round is retired, and the returning
    // visit's own call is the one the control waits for.
    heldCalls.settleCall(0);
    await settleReactWork();

    expect(log.newestFrame.isInFlight).toBe(true);
  });

  it("drops a settlement that lands after the pane closed", async () => {
    const heldCalls = new HeldLeaseCalls();
    const log = new TakeFrameLog();
    const view = renderTake(heldCalls, log);
    act(() => {
      log.newestFrame.take();
    });
    const framesBeforeTheClose = log.frameCount;

    view.unmount();
    heldCalls.settleCall(0);
    await settleReactWork();

    // No flag of its own: an unmounted hook has no committed state for a late
    // settlement to reach, so nothing renders and no frame is produced.
    expect(log.frameCount).toBe(framesBeforeTheClose);
  });

  it("negative control: the session it is still on keeps its in-flight fact", async () => {
    // Without this, a hook that reported idle for every subject would satisfy every
    // case above — a take control that never says a call is out.
    const heldCalls = new HeldLeaseCalls();
    const log = new TakeFrameLog();
    renderTake(heldCalls, log);

    act(() => {
      log.newestFrame.take();
    });
    expect(log.newestFrame.isInFlight).toBe(true);

    heldCalls.settleCall(0);
    await settleReactWork();

    expect(log.newestFrame.isInFlight).toBe(false);
  });

  it("negative control: a second press while a call is out starts nothing", async () => {
    // One act at a time: the latch refuses a claim on a key it already holds, and the control
    // is disabled for exactly that lifetime, so a second press should not reach the wire. An
    // earlier settlement must not clear the flag a later press set.
    const heldCalls = new HeldLeaseCalls();
    const log = new TakeFrameLog();
    renderTake(heldCalls, log);
    act(() => {
      log.newestFrame.take();
    });
    act(() => {
      log.newestFrame.take();
    });
    expect(heldCalls.heldCallCount).toBe(1);
    expect(heldCalls.sessionIdOfCall(0)).toBe(SESSION_ID);
    expect(log.newestFrame.isInFlight).toBe(true);

    // The dispatched call still settles: refusing the second take must not orphan the first.
    heldCalls.settleCall(0);
    await settleReactWork();

    expect(log.newestFrame.isInFlight).toBe(false);

    // The key is back, so the next press dispatches.
    act(() => {
      log.newestFrame.take();
    });
    expect(heldCalls.heldCallCount).toBe(2);
  });
});
