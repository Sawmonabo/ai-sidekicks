// What a rejected body load leaves behind. A `LoaderBackedBody` lives as long as the window, so a
// kept rejected promise would answer every later ask, and the error boundary's "Try again" would
// remount onto the same dead promise. The cases count loader calls, since keeping and releasing the
// rejection look identical to a caller. The mount case mirrors `app/router.tsx`, which calls
// `descriptor.render(context)` in its render body; the probe is a component so a retry does not
// remount a pre-built element.

import { fireEvent, render, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { ErrorBoundary } from "@renderer/components/ErrorBoundary/ErrorBoundary.js";
import { type LazyBodyModule } from "@renderer/components/LazyBody/lazy-body.js";
import { syntheticPaneContextAt } from "@test/helpers/lazy-body-contexts.js";
import { type PaneContext } from "./pane-context.js";
import { PaneRegistry } from "./pane-registry.js";

const CHUNK_FETCH_FAILURE = "the diff chunk could not be fetched";

/**
 * A loader that fails its first `failureCount` calls, then lands the body; the call count is the
 * instrument.
 */
function loaderFailingBefore(
  failureCount: number,
  Body: (context: PaneContext) => React.ReactNode,
): {
  readonly load: () => Promise<LazyBodyModule<PaneContext>>;
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

/** A body that says it is there, so a landed retry is visible. */
function diffBody(): React.ReactNode {
  return createElement("p", null, "the diff body");
}

/** The router's mount shape: a component that resolves the descriptor as it renders. */
function MountedDiffPane(props: { readonly registry: PaneRegistry }): React.ReactNode {
  return props.registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"));
}

describe("a rejected body load — the registration does not keep the failure", () => {
  it("asks the loader again when the next caller arrives, and lands the body", async () => {
    const registry = new PaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

    await expect(registry.preload("diff")).rejects.toThrow(CHUNK_FETCH_FAILURE);
    expect(loader.callCount()).toBe(1);

    await expect(registry.preload("diff")).resolves.toBeUndefined();
    expect(loader.callCount()).toBe(2);
  });

  it("offers the kind back to the board the moment its load fails", async () => {
    // A retained rejection shows here without a mount: the kind would report itself loaded.
    const registry = new PaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

    await expect(registry.preload("diff")).rejects.toThrow(CHUNK_FETCH_FAILURE);
    expect(registry.unloadedKeys()).toStrictEqual(["diff"]);

    await registry.preload("diff");
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("asks once more however many callers were waiting on the failed load", async () => {
    // Callers race, and a release per caller rather than per promise would start a third fetch.
    const registry = new PaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

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
    // Without this, a registration that stopped memoizing would pass every case above.
    const registry = new PaneRegistry();
    const loader = loaderFailingBefore(0, diffBody);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

    await registry.preload("diff");
    await registry.preload("diff");
    const { container } = render(<MountedDiffPane registry={registry} />);
    await settle();
    await registry.preload("diff");

    expect(container.textContent).toContain("the diff body");
    expect(loader.callCount()).toBe(1);
  });
});

describe("a rejected body load — the error boundary's retry reaches it", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // As in `ErrorBoundary.test.tsx`: the registry throws in development, and reporting from
    // `componentDidCatch` would become a second failure.
    restoreThrowOnReport = import.meta.env.DEV;
    windowTripwires.setThrowOnReport(false);
    windowTripwires.reset();
  });

  afterEach(() => {
    windowTripwires.setThrowOnReport(restoreThrowOnReport);
    windowTripwires.reset();
  });

  it("mounts the body the retry's own load lands", async () => {
    const registry = new PaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

    const { container } = render(
      <ErrorBoundary regionName="The diff pane">
        <MountedDiffPane registry={registry} />
      </ErrorBoundary>,
    );
    await settle();
    expect(container.textContent).toContain(CHUNK_FETCH_FAILURE);

    fireEvent.click(within(container).getByRole("button", { name: "Try again" }));
    await settle();

    expect(container.textContent).toContain("the diff body");
    expect(loader.callCount()).toBe(2);
  });

  it("negative control: a chunk that fails again comes back to the failure card", async () => {
    // Without this, a retry that rendered the body without a second load would pass above.
    const registry = new PaneRegistry();
    const loader = loaderFailingBefore(2, diffBody);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

    const { container } = render(
      <ErrorBoundary regionName="The diff pane">
        <MountedDiffPane registry={registry} />
      </ErrorBoundary>,
    );
    await settle();

    fireEvent.click(within(container).getByRole("button", { name: "Try again" }));
    await settle();

    expect(container.textContent).toContain(CHUNK_FETCH_FAILURE);
    expect(container.textContent).not.toContain("the diff body");
    expect(loader.callCount()).toBe(2);
  });
});
