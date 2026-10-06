// The composed app over the transcript-states scenario, for the renderer tier's suites that drive
// the composition root against the fixture bridge. It mounts through the one app mount,
// `app/harness.tsx`, so every tier gives one answer to "when has the app settled".

import { TRANSCRIPT_STATES_SCENARIO_ID } from "#fixtures/scenarios/transcript-states.js";
import { renderAppSettled } from "./app/harness.js";
import { FrameWindows } from "./frame-windows.js";

/** Where a window with no particular address lands. */
export const SESSIONS_HASH = "#/sessions";

/** The mounted app: the window it opened first, and every window it opened. */
export interface MountedApp {
  /** The window used last at the scenario's launch, which the app opens first. */
  readonly ownerWindow: Window;
  readonly frames: FrameWindows;
}

/**
 * Mount the app playing the transcript-states scenario, whose busy transcript gives these suites
 * rows to drive. Its windows are removed when the test finishes.
 */
export async function mountApp(): Promise<MountedApp> {
  const frames = new FrameWindows();
  return { ownerWindow: await renderAppSettled(TRANSCRIPT_STATES_SCENARIO_ID, frames), frames };
}
