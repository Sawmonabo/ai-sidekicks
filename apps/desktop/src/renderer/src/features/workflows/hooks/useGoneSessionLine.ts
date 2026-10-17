// The `Session not found` line a control pointing into a session draws on itself when that
// session is gone, standing until the next act: each press that finds it gone raises it again, and
// a step back to this screen off a session deleted once it had opened raises it on the control
// whose press led in, brought back into view through every box that scrolls it.

import { useCallback, useContext, useEffect, useLayoutEffect, useState } from "react";

import { type MissingTargetLineProps } from "#renderer/components/MissingTargetLine/MissingTargetLine.js";
import { useUntilNextAct } from "#renderer/hooks/useUntilNextAct.js";
import { scrollingAncestorOf } from "#renderer/lib/clipping-ancestors.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { revealInColumn } from "#renderer/lib/scroll/chokepoint.js";
import type {
  SessionPointerControl,
  SessionPointerOutcome,
} from "#renderer/features/workflows/open-session.js";
import { GoneSessionStepBackContext } from "../gone-session-step-back.js";

/** A control's `Session not found` line: what it draws, how the control follows, and its box. */
export interface GoneSessionLine {
  /** The line while it stands, or `undefined` while none is drawn. */
  readonly line: MissingTargetLineProps | undefined;
  /** Follow one press's pointer, raising the line when its session is gone. */
  readonly follow: (pointer: Promise<SessionPointerOutcome>) => void;
  /** The element holding the control and its line, brought into view after a step back. */
  readonly controlRef: (element: HTMLElement | null) => void;
}

/** The `Session not found` line the control `pressedControl` draws on itself. */
export function useGoneSessionLine(pressedControl: SessionPointerControl): GoneSessionLine {
  const [goneCount, setGoneCount] = useState(0);
  const pressKey = goneCount === 0 ? undefined : String(goneCount);
  const isPressLineStanding = useUntilNextAct(pressKey);
  const stepBack = useContext(GoneSessionStepBackContext);
  const stepBackRaise =
    stepBack?.raise?.pressedControl === pressedControl ? stepBack.raise : undefined;
  const stepBackKey = stepBackRaise?.raisedKey;
  const claim = stepBack?.claim;
  const [control, setControl] = useState<HTMLElement | null>(null);
  // Before paint, and before the run's page settles the line, so it lands here at once.
  useLayoutEffect(() => {
    if (stepBackKey === undefined || claim === undefined) {
      return undefined;
    }
    return claim();
  }, [stepBackKey, claim]);
  useEffect(() => {
    if (stepBackKey === undefined || control === null) {
      return;
    }
    // Innermost first: the control in the box that scrolls it, then that box in the next one out.
    let shown: HTMLElement = control;
    for (
      let scroller = scrollingAncestorOf(shown);
      scroller !== undefined;
      scroller = scrollingAncestorOf(shown)
    ) {
      revealInColumn(scroller, shown, "gone-session-control");
      shown = scroller;
    }
  }, [stepBackKey, control]);
  const follow = useCallback((pointer: Promise<SessionPointerOutcome>) => {
    pointer.then(
      (outcome) => {
        if (outcome === "gone") {
          setGoneCount((count) => count + 1);
        }
      },
      (failure: unknown) => {
        recordRejectedRequest("features/workflows", "session-pointer-not-followed", failure);
      },
    );
  }, []);
  let line: MissingTargetLineProps | undefined;
  if (isPressLineStanding && pressKey !== undefined) {
    line = { target: "session", raisedKey: `press:${pressKey}` };
  } else if (stepBackRaise !== undefined) {
    line = { target: stepBackRaise.target, raisedKey: `step-back:${stepBackRaise.raisedKey}` };
  }
  return { line, follow, controlRef: setControl };
}
