// What a rejected body load leaves behind, and what is able to ask for it again.
//
// THE MEMO OUTLIVES EVERY MOUNT, which is what makes this a claim about the registration
// rather than about a render. A `LoadedLazyBody` belongs to the board, and the board
// belongs to the window — so a promise kept after it rejected is kept for the life of the
// window, and every later ask is answered from it: the surface error boundary's "Try
// again" remounts a subtree onto the same dead promise, and navigating away and back
// arrives at it too. The loader is never called a second time, so nothing anywhere is
// retrying anything, and the surface is permanently a failure card with a button that
// cannot work.
//
// WHAT THE CASES BELOW MEASURE IS THE LOADER, not the screen. A memo that kept the
// rejection and one that released it answer a caller identically — both reject — and
// differ only in whether the module was requested again. So every case here counts calls,
// and the mount case counts them too rather than resting on what appeared.
//
// AND THE MOUNT CASE IS SHAPED LIKE THE FRAME. `frame/RouteSurface.tsx` calls
// `descriptor.render(context)` inside its own render body, and that is load-bearing here:
// the boundary re-renders its own children on a retry, so a child that were a
// pre-built ELEMENT would be remounted holding whatever component it was created with.
// The probe below is a component for that reason and no other.

import { fireEvent, render, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { settle } from "../core/settle.test-support.js";
import { consoleTripwires } from "../core/tripwires.js";
import { SurfaceErrorBoundary } from "../primitives/index.js";
import { type LazyBodyModule } from "./lazy-body.js";
import { syntheticPaneContextAt } from "./lazy-body.test-support.js";
import { type ConsolePaneContext } from "./pane-context.js";
import { ConsolePaneRegistry } from "./pane-registry.js";

const CHUNK_FETCH_FAILURE = "the diff chunk could not be fetched";

/**
 * A loader that fails its first `failureCount` calls and lands the body after that.
 *
 * The count is the instrument. A registration that re-requested a chunk on every caller
 * and one that requested it once would satisfy every rendering assertion in this file
 * alike, and the difference between them is the whole subject.
 */
function loaderFailingBefore(
  failureCount: number,
  Body: (context: ConsolePaneContext) => React.ReactNode,
): {
  readonly load: () => Promise<LazyBodyModule<ConsolePaneContext>>;
  readonly callCount: () => number;
} {
  let callCount = 0;
  return {
    load: () => {
      callCount += 1;
      return callCount <= failureCount
        ? Promise.reject(new Error(CHUNK_FETCH_FAILURE))
        : Promise.resolve({ Body });
    },
    callCount: () => callCount,
  };
}

/** A body that says it is there, so a landed retry is legible on the screen. */
function diffBody(): React.ReactNode {
  return createElement("p", null, "the diff body");
}

/** The frame's own mount shape: a component that resolves the descriptor as it renders. */
function MountedDiffPane(props: { readonly registry: ConsolePaneRegistry }): React.ReactNode {
  return props.registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"));
}

describe("a rejected body load — the registration does not keep the failure", () => {
  it("asks the loader again when the next caller arrives, and lands the body", async () => {
    const registry = new ConsolePaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });

    await expect(registry.preload("diff")).rejects.toThrow(CHUNK_FETCH_FAILURE);
    expect(loader.callCount()).toBe(1);

    await expect(registry.preload("diff")).resolves.toBeUndefined();
    expect(loader.callCount()).toBe(2);
  });

  it("offers the kind back to the board the moment its load fails", async () => {
    // The warm walk and the boards read one another through `unloadedKeys`, so this is
    // where a retained rejection is visible without a mount: the kind reported itself
    // loaded and the loader had never produced a body.
    const registry = new ConsolePaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });

    await expect(registry.preload("diff")).rejects.toThrow(CHUNK_FETCH_FAILURE);
    expect(registry.unloadedKeys()).toStrictEqual(["diff"]);

    await registry.preload("diff");
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("asks once more however many callers were waiting on the failed load", async () => {
    // Three callers race by construction — the palette's highlighted entry, an address
    // about to open, and the idle warm — and a release written per CALLER rather than per
    // minted promise would throw away the load the first retry installed and start a
    // third fetch for a body two callers were already waiting on.
    const registry = new ConsolePaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });

    const firstAsks = await Promise.allSettled([
      registry.preload("diff"),
      registry.preload("diff"),
      registry.preload("diff"),
    ]);
    expect(firstAsks.map((ask) => ask.status)).toStrictEqual(["rejected", "rejected", "rejected"]);
    expect(loader.callCount()).toBe(1);

    await Promise.all([registry.preload("diff"), registry.preload("diff")]);
    expect(loader.callCount()).toBe(2);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("negative control: a load that succeeded is never asked for again", async () => {
    // Without this, every case above would pass over a registration that had simply
    // stopped memoising — one fetch per caller, per arrow-key press, forever, which is
    // the defect the memo exists to prevent and the reason the release is scoped to the
    // rejected arm alone.
    const registry = new ConsolePaneRegistry();
    const loader = loaderFailingBefore(0, diffBody);
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });

    await registry.preload("diff");
    await registry.preload("diff");
    const { container } = render(<MountedDiffPane registry={registry} />);
    await settle();
    await registry.preload("diff");

    expect(container.textContent).toContain("the diff body");
    expect(loader.callCount()).toBe(1);
  });
});

describe("a rejected body load — the surface boundary's retry reaches it", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // `ErrorBoundary.test.tsx`'s discipline, for its reason: the registry throws in a
    // development build, and a boundary reporting from `componentDidCatch` would turn
    // that into a second failure inside React's own error handling.
    restoreThrowOnReport = import.meta.env.DEV;
    consoleTripwires.setThrowOnReport(false);
    consoleTripwires.reset();
  });

  afterEach(() => {
    consoleTripwires.setThrowOnReport(restoreThrowOnReport);
    consoleTripwires.reset();
  });

  it("mounts the body the retry's own load lands", async () => {
    const registry = new ConsolePaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });

    const { container } = render(
      <SurfaceErrorBoundary surfaceName="The diff pane">
        <MountedDiffPane registry={registry} />
      </SurfaceErrorBoundary>,
    );
    await settle();
    expect(container.textContent).toContain(CHUNK_FETCH_FAILURE);

    fireEvent.click(within(container).getByRole("button", { name: "Try again" }));
    await settle();

    expect(container.textContent).toContain("the diff body");
    expect(loader.callCount()).toBe(2);
  });

  it("negative control: a chunk that fails again comes back to the failure card", async () => {
    // Without this, the case above would pass over a retry that rendered the body from
    // somewhere other than a second load — and the button would look like it worked on
    // exactly the damaged install where it cannot.
    const registry = new ConsolePaneRegistry();
    const loader = loaderFailingBefore(2, diffBody);
    registry.register({ kind: "diff", owner: "repos-family", body: loader.load });

    const { container } = render(
      <SurfaceErrorBoundary surfaceName="The diff pane">
        <MountedDiffPane registry={registry} />
      </SurfaceErrorBoundary>,
    );
    await settle();

    fireEvent.click(within(container).getByRole("button", { name: "Try again" }));
    await settle();

    expect(container.textContent).toContain(CHUNK_FETCH_FAILURE);
    expect(container.textContent).not.toContain("the diff body");
    expect(loader.callCount()).toBe(2);
  });
});
