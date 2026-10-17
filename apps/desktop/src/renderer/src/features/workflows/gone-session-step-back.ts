// Where the screen says `Session not found` after the window steps back here off a session deleted
// once it had opened: on the control whose press led in, brought back into view, or at the top of
// the screen's body when that control is not drawn. A run's page still reading draws neither, so
// the line takes its one place once the page has drawn what its read answered.

import { createContext, type Context } from "react";

import type { StandingGoneSessionRaise } from "#renderer/store/window/hooks/useGoneSessionRaise.js";

/** The step back's line as the screen hands it to its controls. */
export interface GoneSessionStepBack {
  /**
   * The standing line the control whose press led in draws on itself; `undefined` when none
   * stands, or once the screen placed it at the top of its body.
   */
  readonly raise: StandingGoneSessionRaise | undefined;
  /** Take the line onto the pressed control; the release gives it back to the body's top. */
  readonly claim: () => () => void;
  /** Say the run's page has drawn what its read answered, so the line takes its place. */
  readonly settle: () => void;
}

/** The workflows screen's step-back line, or `undefined` outside the screen. */
export const GoneSessionStepBackContext: Context<GoneSessionStepBack | undefined> = createContext<
  GoneSessionStepBack | undefined
>(undefined);
