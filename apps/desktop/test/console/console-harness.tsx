// Shared mounting for the three browser-mode tiers.
//
// Not a test file — no `include` glob reaches it; it is imported by the browser,
// screenshot, and accessibility tiers so all three mount the console the same
// way. A per-tier copy of this would be three chances to mount it differently and
// then compare results as if they were comparable.
//
// The one thing it does beyond `render` is WAIT. `ConsoleRoot` starts async work
// on mount — the durable persistence adapter is opened and the store is upgraded
// from the in-memory one when it settles, deliberately, so first paint never waits
// on a database. A test that asserts immediately after `render` therefore asserts
// against a half-settled tree AND leaves a state update landing outside `act`,
// which React reports as a warning rather than as the failure it usually is. So
// every mount here settles first, and a tier's assertions run against the frame a
// person would actually be looking at.

import { cdp, userEvent } from "vitest/browser";
import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";

import { type ConsoleScheme } from "../../src/renderer/src/console/tokens/index.js";

/**
 * Type a key sequence and let React finish reacting to it.
 *
 * `userEvent` dispatches real events, which land outside React's batching, so the
 * state they cause settles after the promise resolves rather than before it —
 * which React reports as an act warning and a test observes as a tree one render
 * behind. Wrapping the press is what makes the assertion after it honest.
 */
export async function pressKeys(sequence: string): Promise<void> {
  await act(async () => {
    await userEvent.keyboard(sequence);
  });
}

/**
 * Put the page in a scheme the way a person's operating system does.
 *
 * NOT by stamping the scheme attribute: `ConsoleRoot` owns that attribute and
 * writes its own store's preference into it in a layout effect, so a test that
 * set it before mounting would have it overwritten with the default `"system"`
 * on the first paint — which is exactly how the first dark-scheme screenshot
 * came out light. Emulating `prefers-color-scheme` drives the same layer a
 * default install actually uses, and the console reads it rather than fighting
 * it.
 *
 * Chromium-only, through CDP. The browser-mode tiers pin Chromium, so this is a
 * capability of the configured browser rather than an assumption about browsers.
 */
export async function emulateSystemScheme(scheme: ConsoleScheme): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
}

/**
 * What a mounted console hands back.
 *
 * Deliberately NOT Testing Library's `RenderResult`: that type is generic in
 * its query set and container, and passing an explicit `container` resolves the
 * query parameter to its bare constraint rather than to the concrete default,
 * so naming it here would export a type no caller's `RenderResult` matches. The
 * three tiers use the container and nothing else.
 */
export interface ConsoleMount {
  /** The viewport-sized element the console was rendered into. */
  readonly container: HTMLElement;
}

/**
 * Mount at window size and let every settled promise land.
 *
 * The container is sized to the viewport rather than left to grow with its
 * content. Testing Library's default container is an unstyled `div`, and the
 * console's frame is a full-height layout — mounted into a shrink-to-fit box it
 * lays out at the height of its text, which makes a geometry assertion measure
 * the wrong box and a screenshot baseline a thumbnail of the top-left corner.
 *
 * Two promise flushes, not one: the persistence upgrade resolves a promise whose
 * continuation schedules another (open the database, then read the partition
 * back), and a single flush would return between the two.
 */
export async function renderSettled(element: ReactElement): Promise<ConsoleMount> {
  const container: HTMLElement = document.createElement("div");
  container.style.width = "100vw";
  container.style.height = "100vh";
  document.body.append(container);

  await act(async () => {
    render(element, { container });
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container };
}
