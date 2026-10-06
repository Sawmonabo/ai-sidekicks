// The readiness the accessibility and browser tiers wait on before reading a view that draws the
// run's phase graph. The pre-fit transform named here is a fact about the graph library, so it is
// read in one place rather than restated by each audit.
//
// The phase graph is a lazily-loaded chunk: it renders a loading placeholder at once, `import()`s
// the renderer, and mounts the canvas when it arrives, so a mount helper's own wait does not wait
// for the picture. An audit run at that point checks a loading placeholder, so a regression in the
// canvas, its focusable nodes or the library's attribution link leaves the tier green.
//
// So the wait is on a state, never a clock: the fitted transform has been computed.
//
// The transform alone is not the picture. The library writes a fitted transform at any container
// size, including a root collapsed to zero height, so readiness is two readings: the fit has been
// computed, and the picture is on screen (a painted root with height, holding at least one phase).
// Refusing matters: a throw fails the audit, where a silent pass would audit an empty box.

import { waitFor } from "@testing-library/react";

/**
 * The viewport transform the library renders before it has fitted anything.
 *
 * The canvas passes no `defaultViewport`, so the library's default (origin, unit zoom) stands
 * until the nodes are measured. Naming it lets "fitted" be a state rather than a duration.
 */
const UNFITTED_VIEWPORT_TRANSFORM = "translate(0px, 0px) scale(1)";

/**
 * How long a fit may take before the wait throws.
 *
 * A ceiling on a hang: the fit lands about 150 ms after the mount on an idle host. A timeout
 * throws, since an audit of a half-drawn graph says nothing about the drawn one.
 */
const FIT_DEADLINE_MS = 5_000;

/**
 * The fitted transform on this element's graph, or `undefined` while there is none.
 *
 * `undefined` covers three unready states a caller treats alike: the chunk has not arrived, the
 * canvas mounted without a viewport, or the viewport still carries the pre-fit default.
 */
function fittedViewportTransform(mountedElement: HTMLElement): string | undefined {
  const viewport = mountedElement.querySelector<HTMLElement>(".react-flow__viewport");
  if (viewport === null) {
    return undefined;
  }
  const { transform } = viewport.style;
  return transform === "" || transform === UNFITTED_VIEWPORT_TRANSFORM ? undefined : transform;
}

/**
 * Whether the graph's own root is painted, with a phase standing in it.
 *
 * Two readings, since a root of the right height whose picture fitted outside its box shows as
 * little as a collapsed one: the root's height says there is somewhere to draw, and a node's box
 * inside it says something is drawn. Both are measured rather than inferred from a style
 * attribute. The node is compared against the root, not the pane's canvas box, because where the
 * picture sits in the surrounding view is a separate question.
 */
function isGraphPainted(mountedElement: HTMLElement): boolean {
  const paintedRoot = mountedElement.querySelector<HTMLElement>(".meridian-run-graph .react-flow");
  if (paintedRoot === null) {
    return false;
  }
  const rootBox = paintedRoot.getBoundingClientRect();
  if (rootBox.height <= 0 || rootBox.width <= 0) {
    return false;
  }
  return [
    ...mountedElement.querySelectorAll<HTMLElement>(".meridian-run-graph .react-flow__node"),
  ].some((node) => {
    const nodeBox = node.getBoundingClientRect();
    return (
      nodeBox.height > 0 &&
      nodeBox.width > 0 &&
      nodeBox.top >= rootBox.top - 0.5 &&
      nodeBox.bottom <= rootBox.bottom + 0.5 &&
      nodeBox.left >= rootBox.left - 0.5 &&
      nodeBox.right <= rootBox.right + 0.5
    );
  });
}

/**
 * Whether this element is settled: it draws no graph, or its graph is fitted and painted.
 *
 * The predicate reads the pane's own container rather than the library's, so "no graph here" and
 * "the graph has not arrived" are different answers and a caller can run this over every element.
 */
export function isRunGraphSettled(mountedElement: HTMLElement): boolean {
  if (mountedElement.querySelector(".meridian-run-graph") === null) {
    return true;
  }
  return fittedViewportTransform(mountedElement) !== undefined && isGraphPainted(mountedElement);
}

/**
 * Hold until this element's graph has been fitted and painted; throws past the deadline.
 *
 * The fit arrives on a React state update, so it is waited for through the library's `waitFor`,
 * whose polling runs in the async act every other wait goes through; a hand-rolled loop would
 * produce an act warning per commit.
 */
export async function awaitRunGraphSettled(mountedElement: HTMLElement): Promise<void> {
  if (mountedElement.querySelector(".meridian-run-graph") === null) {
    return;
  }
  await waitFor(
    () => {
      if (fittedViewportTransform(mountedElement) === undefined) {
        throw new Error("the phase graph has not been fitted yet");
      }
      if (!isGraphPainted(mountedElement)) {
        throw new Error(
          "the phase graph was fitted into a root that paints no phase — the box on " +
            "screen is empty",
        );
      }
    },
    { timeout: FIT_DEADLINE_MS },
  );
}
