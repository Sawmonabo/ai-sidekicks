// Which run controls a run offers. None is gated on a driver capability: pause, resume and
// interrupt are the daemon's own, and a steer is a message on a child's queue on every provider,
// so no capability reading can take a control off a run. This only projects what the run's state
// admits; a control offered can still be refused by the daemon.

import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { isLiveRunState } from "#renderer/services/daemon/wire/identifiers.js";
import { type RunControl } from "./services/dispatch.js";

/** What is offered for one run: the controls its state admits, and steer. */
export interface OfferedRunControls {
  /** Pause or resume, whichever the state admits, and interrupt, on a live run. */
  readonly primary: readonly RunControl[];
  /** Steer, on any run. */
  readonly overflow: readonly RunControl[];
}

/**
 * The controls a run in `state` offers, decided in one place so the palette and the row cannot
 * disagree. A paused run offers resume, any other live run offers pause.
 */
export function offeredRunControls(state: RunState): OfferedRunControls {
  const primary: RunControl[] = [];
  if (isLiveRunState(state)) {
    primary.push(state === "paused" ? "resume" : "pause");
    primary.push("interrupt");
  }
  // Not gated on liveness: a steer joins the child's queue, which the daemon delivers.
  return { primary, overflow: ["steer"] };
}
