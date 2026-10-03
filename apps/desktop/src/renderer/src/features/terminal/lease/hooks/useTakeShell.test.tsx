// The take belongs to the session the pane shows: a press made on the first frame after a
// switch takes that session's shell, and the session it left settles nothing on it. The case
// reads a log of frames rather than the settled tree, because the DOM after a rerender shows
// only the corrected frame. Calls are held so one stays out across the switch.

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
});
