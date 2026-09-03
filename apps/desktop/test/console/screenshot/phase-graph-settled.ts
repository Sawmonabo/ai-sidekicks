// The readiness a captured surface owes when a lazily-drawn graph is on it.
//
// Not a test file — no `include` glob reaches it. `baseline-platform.ts` beside it
// owns WHERE a reference may be compared; this module owns WHEN a surface carrying a
// phase graph is still enough to be one.
//
// WHY A CAPTURE NEEDS THIS AT ALL. The run pane's phase graph is a lazily-loaded
// chunk: the pane renders its absence primitive immediately, `import()`s the graph
// renderer, and mounts the canvas when it arrives. `workflow-surfaces.tsx` waits for
// the run READ — the park banner — which lands about a hundred milliseconds before
// the chunk does, so nothing between that wait and the capture waits for the picture.
// The reference nonetheless holds a drawn graph, because the capture's own round trip
// is slower than the fetch; which frame of the graph's arrival it holds was luck.
//
// AND THE LUCK IS NOT HARMLESS, because the graph is fitted rather than placed. The
// canvas asks the library to fit the sequence into the pane, and the fit lands as a
// FRACTIONAL scale on the viewport — 0.715 for this fixture's four phases — so every
// line box inside every node sits at a fractional device-pixel offset. Two captures
// taken on either side of the fit's commit rasterise those offsets to different
// pixels: the glyph shapes are identical and individual text lines move by exactly
// one pixel, which is the 582-pixel disagreement `ci.yml`'s screenshot job reported
// against a reference minted on its own runner, from its own commit, by
// `console-screenshot-baselines.yml`.
//
// SO THE WAIT IS ON A STATE, NEVER ON A CLOCK. A sleep long enough today is a sleep
// too short on a loaded runner, and it would have to be paid on every subject. What
// is waited for is the fitted transform itself, and then its survival across a frame,
// which is the difference between "the fit has been computed" and "the fit is what
// the compositor last drew".

import { waitFor } from "@testing-library/react";

/**
 * The viewport transform the library renders before it has fitted anything.
 *
 * The canvas passes no `defaultViewport`, so the library's own default — origin, unit
 * zoom — is what stands until the nodes are measured and the fit is applied. Naming it
 * is what lets "fitted" be a state rather than a duration: the transform is present
 * from the first commit, and its VALUE is the only thing that says whether the picture
 * on screen is the one the pane asked for.
 */
const UNFITTED_VIEWPORT_TRANSFORM = "translate(0px, 0px) scale(1)";

/**
 * How long a fit may take before the capture is refused rather than taken.
 *
 * A ceiling on a hang, not a wait anybody expects to spend: the fit lands about
 * 150 ms after the mount on an idle host. A timeout THROWS rather than returning —
 * a capture of a half-drawn graph is a reference nobody could reproduce, and a
 * silently-taken one is worse than a red run that names what was missing.
 */
const FIT_DEADLINE_MS = 5_000;

/** One animation frame, awaited. */
function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * The fitted transform on this surface's graph, or `undefined` while there is none.
 *
 * `undefined` covers all three of the unready states deliberately, because a caller
 * has the same thing to do about each: the chunk has not arrived, the canvas has
 * mounted without a viewport, or the viewport is still carrying the library's
 * pre-fit default.
 */
function fittedViewportTransform(surface: HTMLElement): string | undefined {
  const viewport = surface.querySelector<HTMLElement>(".react-flow__viewport");
  if (viewport === null) {
    return undefined;
  }
  const { transform } = viewport.style;
  return transform === "" || transform === UNFITTED_VIEWPORT_TRANSFORM ? undefined : transform;
}

/**
 * Whether this surface is still enough to capture.
 *
 * A surface that draws no graph is settled by construction — the predicate reads the
 * pane's own container rather than the library's, so "no graph here" and "the graph
 * has not arrived" are different answers rather than one absent element.
 */
export function isPhaseGraphSettled(surface: HTMLElement): boolean {
  if (surface.querySelector(".meridian-phase-graph") === null) {
    return true;
  }
  return fittedViewportTransform(surface) !== undefined;
}

/**
 * Hold until this surface's graph has been fitted and that fit has survived a frame.
 *
 * Two waits, because they are waits for different things. The FIT arrives on a state
 * update React drives, so it is waited for through the library's own `waitFor`, whose
 * polling is wrapped in the async act every other wait in these tiers goes through —
 * a hand-rolled loop here would see the same commits and would make the console carry
 * an act warning for each one. The STILLNESS is not a React event at all: it is the
 * same transform surviving an animation frame, which is the difference between "the
 * fit has been computed" and "the fit is what the compositor last drew", and a frame
 * is the only clock that answers it.
 */
export async function awaitPhaseGraphSettled(surface: HTMLElement): Promise<void> {
  if (surface.querySelector(".meridian-phase-graph") === null) {
    return;
  }
  await waitFor(
    () => {
      if (fittedViewportTransform(surface) === undefined) {
        throw new Error("the phase graph has not been fitted yet");
      }
    },
    { timeout: FIT_DEADLINE_MS },
  );
  const fitted = fittedViewportTransform(surface);
  await nextAnimationFrame();
  const afterOneFrame = fittedViewportTransform(surface);
  if (afterOneFrame !== fitted) {
    throw new Error(
      `the phase graph's fitted transform moved across a frame (\`${String(fitted)}\` then ` +
        `\`${String(afterOneFrame)}\`) — the picture is still changing under the capture`,
    );
  }
}
