// The loader form on the pane registry: a loader registration resolves to the same descriptor as
// the component form, the pane reserves its own chrome while the module is in flight, and the
// module is fetched once however many callers ask. Bodies are synthetic; the loaders stand in for
// a feature's `import()`.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
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
  it("resolves to the same descriptor shape a component form does", () => {
    const registry = new PaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos",
      body: countingLoader(() => null).load,
    });
    registry.register({ kind: "transcript", owner: "transcript", render: () => null });
    // Nothing downstream of `descriptorFor` branches on the form, so they must be indistinguishable
    // here.
    expect(registry.registeredPaneKinds()).toStrictEqual(["transcript", "diff"]);
    expect(registry.descriptorFor("diff")?.owner).toBe("repos");
    expect(typeof registry.descriptorFor("diff")?.render).toBe("function");
  });

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

  it("reserves the same box the loaded body draws", async () => {
    const registry = new PaneRegistry();
    registry.register({
      kind: "workflow-builder",
      owner: "workflows",
      body: countingLoader(chromedBody("workflow-builder", "the builder body")).load,
    });
    const { container } = render(
      <>
        {registry
          .descriptorFor("workflow-builder")
          ?.render(syntheticPaneContextAt("workflow-builder"))}
      </>,
    );

    const pendingSection = container.querySelector(".meridian-pane");
    const pendingHeadText = container.querySelector(".meridian-pane__head")?.textContent;
    const pendingBodyText = container.querySelector(".meridian-pane__body")?.textContent;
    expect(pendingSection?.className).toBe(
      "meridian-pane meridian-pane--workflow-builder meridian-focus-inset",
    );
    // The reserved body is empty: the marker rides a `hidden` element that adds no box.
    expect(pendingBodyText).toBe("");

    await settle();

    const loadedSection = container.querySelector(".meridian-pane");
    expect(loadedSection?.className).toBe(pendingSection?.className);
    expect(container.querySelector(".meridian-pane__head")?.textContent).toBe(pendingHeadText);
    expect(container.querySelectorAll(".meridian-pane__body")).toHaveLength(1);
    expect(container.querySelector(".meridian-pane__body")?.textContent).toBe("the builder body");
  });

  it("negative control: a body that never arrives never replaces the reserved region", async () => {
    // Without this, a board that never rendered the fallback would pass.
    const registry = new PaneRegistry();
    registry.register({
      kind: "browser",
      owner: "preview",
      body: () => new Promise<LazyBodyModule<PaneContext>>(() => undefined),
    });
    const { container } = render(
      <>{registry.descriptorFor("browser")?.render(syntheticPaneContextAt("browser"))}</>,
    );
    await settle();
    expect(listPendingBodyNames(container)).toStrictEqual(["browser"]);
  });
});

describe("the pane layout's board — one fetch per registration", () => {
  it("mounts a preloaded body without ever committing the pending marker", async () => {
    // A mount after a completed preload must never commit the pending marker.
    const registry = new PaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos",
      body: countingLoader(chromedBody("diff", "the diff body")).load,
    });
    await registry.preload("diff");

    const { container } = render(
      <>{registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"))}</>,
    );

    expect(listPendingBodyNames(container)).toStrictEqual([]);
    expect(container.textContent).toContain("the diff body");
  });

  it("keeps the loader when a different owner's claim is refused", async () => {
    // A refused component-form claim must not drop the loader of the descriptor that stays
    // admitted.
    const registry = new PaneRegistry();
    const loader = countingLoader(chromedBody("diff", "the diff body"));
    registry.register({ kind: "diff", owner: "repos", body: loader.load });
    expect(registry.unloadedKeys()).toStrictEqual(["diff"]);

    expect(() => {
      registry.register({ kind: "diff", owner: "another-owner", render: () => null });
    }).toThrow(DuplicateRegistrationError);

    expect(registry.unloadedKeys()).toStrictEqual(["diff"]);
    await registry.preload("diff");
    expect(loader.callCount()).toBe(1);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("loads once however many callers ask", async () => {
    const registry = new PaneRegistry();
    const loader = countingLoader<PaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

    // Several callers reach the same registration and race.
    await Promise.all([
      registry.preload("diff"),
      registry.preload("diff"),
      registry.preload("diff"),
    ]);
    await registry.preload("diff");
    expect(loader.callCount()).toBe(1);
  });

  it("does not re-fetch when the pane then mounts", async () => {
    const registry = new PaneRegistry();
    const loader = countingLoader(chromedBody("diff", "the diff body"));
    registry.register({ kind: "diff", owner: "repos", body: loader.load });

    await registry.preload("diff");
    const { container } = render(
      <>{registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"))}</>,
    );
    await settle();
    expect(container.textContent).toContain("the diff body");
    expect(loader.callCount()).toBe(1);
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

  it("settles with nothing to do for a component form and for an unclaimed kind", async () => {
    // Callers must not have to ask whether a kind is loader-backed.
    const registry = new PaneRegistry();
    registry.register({ kind: "transcript", owner: "transcript", render: () => null });
    await expect(registry.preload("transcript")).resolves.toBeUndefined();
    await expect(registry.preload("workflow-builder")).resolves.toBeUndefined();
  });
});

describe("the pane layout's board — what the warm walk is offered", () => {
  it("reports unloaded loader-backed kinds in declaration order", () => {
    const registry = new PaneRegistry();
    // Registered back to front with a component form among them, so insertion order or every kind
    // would differ.
    registry.register({
      kind: "agents",
      owner: "agents",
      body: countingLoader<PaneContext>(() => null).load,
    });
    registry.register({ kind: "transcript", owner: "transcript", render: () => null });
    registry.register({
      kind: "diff",
      owner: "repos",
      body: countingLoader<PaneContext>(() => null).load,
    });
    expect(registry.unloadedKeys()).toStrictEqual(["diff", "agents"]);
  });

  it("drops a kind from the walk once its body is asked for", async () => {
    const registry = new PaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos",
      body: countingLoader<PaneContext>(() => null).load,
    });
    await registry.preload("diff");
    // Reads the memo, not the settled value, so a warmed board is not walked again.
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("negative control: a board of component-form bodies offers the walk nothing", () => {
    const registry = new PaneRegistry();
    registry.register({ kind: "transcript", owner: "transcript", render: () => null });
    expect(registry.registeredPaneKinds()).toStrictEqual(["transcript"]);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });
});

describe("the pane layout's board — a loader survives the duplicate policy", () => {
  it("leaves no loader behind when a second owner is refused", async () => {
    const registry = new PaneRegistry();
    const admitted = countingLoader<PaneContext>(() => null);
    const refused = countingLoader<PaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos", body: admitted.load });
    expect(() => {
      registry.register({ kind: "diff", owner: "another-owner", body: refused.load });
    }).toThrow(DuplicateRegistrationError);

    // The refusal throws before the loader table is written; a stray loader would fetch one module
    // and render another.
    await registry.preload("diff");
    expect(admitted.callCount()).toBe(1);
    expect(refused.callCount()).toBe(0);
  });

  it("replaces the loader when the same owner re-claims", async () => {
    // A hot reload re-runs a feature's module; the first loader would fetch the stale chunk.
    const registry = new PaneRegistry();
    const beforeEdit = countingLoader<PaneContext>(() => null);
    const afterEdit = countingLoader<PaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos", body: beforeEdit.load });
    registry.register({ kind: "diff", owner: "repos", body: afterEdit.load });
    await registry.preload("diff");
    expect(afterEdit.callCount()).toBe(1);
    expect(beforeEdit.callCount()).toBe(0);
  });

  it("mounts the re-claimed body, not the one the parent was already rendering", async () => {
    // `LazyBody` pins its arm in a `useState` initializer, and the element type and position do not
    // change across a re-registration, so React keeps the instance and the pin holds a stale
    // `lazy()`. One parent is re-rendered, since two renders would mount a fresh `LazyBody` each
    // time and hide a stale pin.
    const registry = new PaneRegistry();
    registry.register({
      kind: "diff",
      owner: "repos",
      body: countingLoader(chromedBody("diff", "the body before the edit")).load,
    });

    function RegisteredDiffBody(): React.ReactNode {
      return <>{registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"))}</>;
    }

    const { container, rerender } = render(<RegisteredDiffBody />);
    await settle();
    expect(container.textContent).toContain("the body before the edit");

    registry.register({
      kind: "diff",
      owner: "repos",
      body: countingLoader(chromedBody("diff", "the body after the edit")).load,
    });
    rerender(<RegisteredDiffBody />);
    await settle();

    expect(container.textContent).toContain("the body after the edit");
    expect(container.textContent).not.toContain("the body before the edit");
  });

  it("forgets the loader once the kind is released", async () => {
    const registry = new PaneRegistry();
    const loader = countingLoader<PaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos", body: loader.load });
    registry.unregister("diff");
    await registry.preload("diff");
    expect(loader.callCount()).toBe(0);
    expect(registry.unloadedKeys()).toStrictEqual([]);
  });

  it("replaces a component form with a loader form, and back", async () => {
    const registry = new PaneRegistry();
    const loader = countingLoader<PaneContext>(() => null);
    registry.register({ kind: "diff", owner: "repos", render: () => null });
    registry.register({ kind: "diff", owner: "repos", body: loader.load });
    expect(registry.unloadedKeys()).toStrictEqual(["diff"]);
    registry.register({ kind: "diff", owner: "repos", render: () => null });
    // The loader is dropped; a stale table would let `preload` fetch a chunk nothing renders.
    expect(registry.unloadedKeys()).toStrictEqual([]);
    await registry.preload("diff");
    expect(loader.callCount()).toBe(0);
  });
});
