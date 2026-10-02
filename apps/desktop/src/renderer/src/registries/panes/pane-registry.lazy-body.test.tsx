// The loader form on the pane registry: the pane reserves its own chrome while the module is in
// flight and then mounts the body, a re-render does not rebuild a mounted body, and a rejected
// load is not kept, so the error boundary's "Retry" reaches a fresh one. Bodies are synthetic;
// the loaders stand in for a feature's `import()`.

import { fireEvent, render, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { ErrorBoundary } from "@renderer/components/ErrorBoundary/ErrorBoundary.js";
import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type LazyBodyModule } from "@renderer/components/LazyBody/lazy-body.js";
import { countingLoader, syntheticPaneContextAt } from "@test/helpers/lazy-body-contexts.js";
import { type PaneContext } from "./pane-context.js";
import { PaneRegistry } from "./pane-registry.js";
import { listPendingBodyNames } from "@renderer/components/LazyBody/pending-body-marker.js";

/** A pane body of the shape features ship: its own chrome around its content. */
function chromedBody(
  kind: PaneContext["kind"],
  text: string,
): (context: PaneContext) => React.ReactNode {
  return (): React.ReactNode =>
    createElement(PaneFrame, {
      kind,
      sessionId: undefined,
      children: createElement("p", null, text),
    });
}

describe("the pane layout's board — a loader-form registration", () => {
  it("mounts the pane's own chrome first, then the body", async () => {
    const registry = new PaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos",
      body: countingLoader(chromedBody("diff", "the diff body")).load,
    });
    const context = syntheticPaneContextAt("diff");
    const { container } = render(<>{registry.descriptorFor("diff")?.render(context)}</>);

    // Before: the chrome is painted, the body is not, and the pane names the body it awaits.
    expect(listPendingBodyNames(container)).toStrictEqual(["diff"]);
    expect(container.textContent).not.toContain("the diff body");
    expect(container.querySelectorAll(".meridian-pane")).toHaveLength(1);

    await settle();

    // After: the body is there and the marker is gone.
    expect(container.textContent).toContain("the diff body");
    expect(listPendingBodyNames(container)).toStrictEqual([]);
  });

  it("keeps one component identity across renders, so a mounted body is not rebuilt", () => {
    // A `lazy()` minted per render is a new component type, so a parent re-render would remount the
    // body.
    const registry = new PaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos",
      body: countingLoader<PaneContext>(() => null).load,
    });
    const descriptor = registry.descriptorFor("diff");
    const first = descriptor?.render(syntheticPaneContextAt("diff")) as React.ReactElement<{
      readonly Body: unknown;
    }>;
    const second = descriptor?.render(syntheticPaneContextAt("diff")) as React.ReactElement<{
      readonly Body: unknown;
    }>;
    expect(second.props.Body).toBe(first.props.Body);
  });
});

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

/**
 * The router's mount shape, a component that resolves the descriptor as it renders, so a retry
 * does not remount a pre-built element.
 */
function MountedDiffPane(props: { readonly registry: PaneRegistry }): React.ReactNode {
  return props.registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"));
}

describe("a rejected body load — the error boundary's retry reaches it", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // The tripwire registry throws on report in development, so the boundary's report from
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
    // A `LoaderBackedBody` lives as long as the window, so a kept rejected promise would answer
    // every later ask and "Retry" would remount onto the same dead promise.
    const registry = new PaneRegistry();
    const loader = loaderFailingBefore(1, diffBody);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

    const { container } = render(
      <ErrorBoundary regionName="The diff pane">
        <MountedDiffPane registry={registry} />
      </ErrorBoundary>,
    );
    await settle();
    expect(container.textContent).toContain("The diff pane stopped rendering.");

    fireEvent.click(within(container).getByRole("button", { name: "Retry" }));
    await settle();

    expect(container.textContent).toContain("the diff body");
    expect(loader.callCount()).toBe(2);
  });
});
