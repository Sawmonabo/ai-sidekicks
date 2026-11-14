// Which run controls a run offers. None is gated on a driver capability: pause, resume and
// interrupt are the daemon's own, so no capability reading can take a control off a run. This only
// projects what the run's state admits; a control offered can still be refused by the daemon.

import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { isLiveRunState } from "#renderer/services/daemon/wire/identifiers.js";
import { type RunControl } from "./services/dispatch.js";

/** A control the palette offers for a run: every run control but a child's steer. */
export type PaletteRunControl = Exclude<RunControl, "steer">;

/**
 * The controls a run in `state` offers, decided in one place so the palette and the row cannot
 * disagree: on a live run, pause or resume, whichever the state admits, and interrupt.
 */
export function offeredRunControls(state: RunState): readonly PaletteRunControl[] {
  if (!isLiveRunState(state)) {
    return [];
  }
  return [state === "paused" ? "resume" : "pause", "interrupt"];
}
