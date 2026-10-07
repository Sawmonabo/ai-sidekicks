// The take belongs to the shell the pane shows: a press made on the first frame after the pane
// moves to another shell takes that shell, and the shell it left settles nothing on it. The case
// reads a log of frames rather than the settled tree, because the DOM after a rerender shows only
// the corrected frame. Takes are held so one stays out across the move.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "#test/helpers/settle.js";
import { OTHER_DEVICE_ID, OTHER_SHELL_ID } from "../state.test-support.js";
import { useTakeShell, type TakeShellTarget, type UseTakeShellResult } from "./useTakeShell.js";
import { HeldTakes, TAKE_TARGET } from "./useTakeShell.test-support.js";

/** The second shell of the same session, seen through the pane's subscription to it. */
const OTHER_SHELL_TARGET: TakeShellTarget = { ...TAKE_TARGET, terminalId: OTHER_SHELL_ID };

/**
 * Every frame the hook produced, in render order. A class so a case can ask for "the frame
 * after the move" instead of indexing a bare array.
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
  readonly takes: HeldTakes;
  readonly target: TakeShellTarget;
  readonly log: TakeFrameLog;
}): React.JSX.Element {
  props.log.record(useTakeShell(props.takes.bridge, props.target, OTHER_DEVICE_ID));
  return <span />;
}

describe("the take, stamped to the shell it was pressed for", () => {
  it("sends the new shell's own take from that same frame", async () => {
    const takes = new HeldTakes();
    const log = new TakeFrameLog();
    const view = render(<TakeProbe takes={takes} target={TAKE_TARGET} log={log} />);
    act(() => {
      log.newestFrame.openConfirm();
    });
    act(() => {
      log.newestFrame.take();
    });
    const framesBeforeTheMove = log.frameCount;

    view.rerender(<TakeProbe takes={takes} target={OTHER_SHELL_TARGET} log={log} />);
    // The shell the pane moved to starts with its confirm closed, whatever the other shell's was.
    expect(log.frameAt(framesBeforeTheMove).isConfirming).toBe(false);
    act(() => {
      log.frameAt(framesBeforeTheMove).take();
    });
    await settle();

    // The take built during the render that first saw the new shell carries that shell, so a
    // press in the very first frame reaches the right one.
    expect(takes.takes.map((call) => call.params)).toStrictEqual([
      { ...TAKE_TARGET, force: true },
      { ...OTHER_SHELL_TARGET, force: true },
    ]);
    expect(log.newestFrame.isInFlight).toBe(true);

    await settle(() => {
      takes.serve(0);
    });
    // The old shell's settlement retires nothing: the new shell's take is still out.
    expect(log.newestFrame.isInFlight).toBe(true);

    await settle(() => {
      takes.serve(1);
    });
    expect(log.newestFrame.isInFlight).toBe(false);
  });
});
