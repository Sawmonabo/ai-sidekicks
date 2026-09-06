// Mounting the composed window, once, for every suite that drives it.
//
// The three `ConsoleRoot` suites each drive the REAL composition root against the
// fixture bridge the `console-unit` project compiles in, so the mount is the one
// piece of scaffolding all of them share — and a second copy of it would be a
// second answer to "when has the console settled", which is exactly the question
// the two flushes below exist to answer once.

import { act, render, type RenderResult } from "@testing-library/react";

import { ConsoleRoot, type ConsoleRootProps } from "./ConsoleRoot.js";
import { type ConsoleSurfaceContext } from "./surface-registry.js";
import { drainMicrotasks } from "../bridge/fixture/fixture-bridge.test-support.js";

/** Where a window with no particular address lands. */
export const SESSIONS_HASH = "#/sessions";

/**
 * Mount and let the settled promises land.
 *
 * `ConsoleRoot` starts the persistence open on mount and swaps the durable adapter
 * in when it settles, so a test that asserted straight after `render` would assert
 * against a half-settled tree and leave a state update landing outside `act`. Two
 * flushes rather than one: the open resolves a promise whose continuation schedules
 * another.
 *
 * The observer is handed the whole surface context rather than the route alone.
 * That context is what the frame builds and hands to every surface, so it is the
 * one seam that reports what the composition root wired without replacing any of
 * it — and a second observer beside it would be a second such seam.
 */
export async function mountConsole(
  observe?: (context: ConsoleSurfaceContext) => void,
): Promise<RenderResult> {
  let mounted: RenderResult | undefined;
  const props: ConsoleRootProps =
    observe === undefined
      ? {}
      : {
          renderOverlays: (context) => {
            observe(context);
            return null;
          },
        };
  await act(async () => {
    mounted = render(<ConsoleRoot {...props} />);
    await drainMicrotasks();
  });
  if (mounted === undefined) {
    throw new Error("the console never mounted");
  }
  return mounted;
}
