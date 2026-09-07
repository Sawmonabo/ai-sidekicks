// Mounting the composed window, once, for every suite that drives it.
//
// The three `ConsoleRoot` suites each drive the REAL composition root against the
// fixture bridge the `console-unit` project compiles in, so the mount is the one
// piece of scaffolding all of them share — and a second copy of it would be a
// second answer to "when has the console settled", which is exactly the question
// the two flushes below exist to answer once.

import { act, render, type RenderResult } from "@testing-library/react";

import { ConsoleRoot, type ConsoleRootProps } from "./ConsoleRoot.js";
import { type ConsoleSurfaceContext } from "../seats/index.js";

/** Where a window with no particular address lands. */
export const SESSIONS_HASH = "#/sessions";

/** What a caller may vary about the mount. Both are the composition root's own props. */
export interface MountConsoleOptions {
  /**
   * Which fixture scenario the window plays.
   *
   * Omitted, the window opens on the default scenario exactly as a launch does. A
   * suite names one when the composition it is asserting about is a scenario's to
   * script — a scripted handshake refusal, say, which no window reaches by default.
   */
  readonly scenarioId?: string;
  /**
   * The whole surface context the frame built, handed back once per render.
   *
   * That context is what the frame builds and hands to every surface, so it is the
   * one seam that reports what the composition root wired without replacing any of
   * it — and a second observer beside it would be a second such seam.
   */
  readonly observe?: (context: ConsoleSurfaceContext) => void;
}

/**
 * Mount and let the settled promises land.
 *
 * `ConsoleRoot` starts the persistence open on mount and swaps the durable adapter
 * in when it settles, so a test that asserted straight after `render` would assert
 * against a half-settled tree and leave a state update landing outside `act`. Two
 * flushes rather than one: the open resolves a promise whose continuation schedules
 * another.
 */
export async function mountConsole(options: MountConsoleOptions = {}): Promise<RenderResult> {
  let mounted: RenderResult | undefined;
  const { scenarioId, observe } = options;
  const props: ConsoleRootProps = {
    ...(scenarioId === undefined ? {} : { scenarioId }),
    ...(observe === undefined
      ? {}
      : {
          renderOverlays: (context: ConsoleSurfaceContext) => {
            observe(context);
            return null;
          },
        }),
  };
  await act(async () => {
    mounted = render(<ConsoleRoot {...props} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  if (mounted === undefined) {
    throw new Error("the console never mounted");
  }
  return mounted;
}
