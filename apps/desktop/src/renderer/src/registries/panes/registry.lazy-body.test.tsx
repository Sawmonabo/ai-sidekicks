// The loader form on the pane registry: the pane reserves its own chrome while the module is in
// flight and then mounts the body, a re-render does not rebuild a mounted body, and a rejected
// load is not kept, so the error boundary's "Retry" reaches a fresh one. Bodies are synthetic;
// the loaders stand in for a feature's `import()`.

import { fireEvent, render, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { settle } from "#test/helpers/settle.js";
import { drawnText } from "#test/helpers/live-region.js";
import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { paneContext } from "#test/helpers/pane-context.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import { ErrorBoundary } from "#renderer/components/ErrorBoundary/ErrorBoundary.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { type LazyBodyModule } from "#renderer/components/LazyBody/loader.js";
import { countingLoader } from "./registry.lazy-body.test-support.js";
import { type PaneContext } from "./context.js";
import { PaneRegistry } from "./registry.js";

/** The context a loader-form case mounts the diff pane with: over one workspace, no session. */
function diffPaneContext(): PaneContext {
  return paneContext(
    { kind: "diff", entity: { kind: "workspace", id: "workspace-pane-registry" } },
    { bridge: bridgeOnClock("pane-registry").bridge, sessionStore: undefined },
  );
}

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
    const context = diffPaneContext();
    const { container } = render(<>{registry.descriptorFor("diff")?.render(context)}</>);

    // Before: the chrome is painted and the body is not.
    expect(container.textContent).not.toContain("the diff body");
    expect(container.querySelectorAll(".meridian-pane")).toHaveLength(1);

    await settle();

    // After: the body is there, and its chrome replaced the pending one rather than nesting in it.
    expect(container.textContent).toContain("the diff body");
    expect(container.querySelectorAll(".meridian-pane")).toHaveLength(1);
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
    const first = descriptor?.render(diffPaneContext()) as React.ReactElement<{
      readonly Body: unknown;
    }>;
    const second = descriptor?.render(diffPaneContext()) as React.ReactElement<{
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
function MountedDiffPane(props: {
  readonly registry: PaneRegistry;
  readonly context: PaneContext;
}): React.ReactNode {
  return props.registry.descriptorFor("diff")?.render(props.context);
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
        <MountedDiffPane registry={registry} context={diffPaneContext()} />
      </ErrorBoundary>,
      { wrapper: LiveAnnouncerProvider },
    );
    await settle();
    expect(drawnText(container)).toContain("The diff pane stopped rendering.");

    fireEvent.click(within(container).getByRole("button", { name: "Retry" }));
    await settle();

    expect(container.textContent).toContain("the diff body");
    expect(loader.callCount()).toBe(2);
  });
});
