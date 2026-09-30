// Where the keyboard is after a loader-backed body reveals. `Suspense` deletes the fallback subtree
// and inserts the children, so the chrome a person was on is replaced and focus would fall to the
// document body; a screenshot cannot show that. Driven through the real registry: register a
// loader, mount the descriptor's render, and ask the document where focus is.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { PaneFrame } from "@renderer/components/PaneFrame/PaneFrame.js";
import { deferredBodyModule, syntheticPaneContextAt } from "@test/helpers/lazy-body-contexts.js";
import { PaneControlsContext } from "@renderer/components/PaneFrame/pane-controls.js";
import { type PaneContext } from "./pane-context.js";
import { PaneRegistry } from "./pane-registry.js";

/** The chrome's label for its close control, the identity being matched. */
const CLOSE_CONTROL_LABEL = "Close this pane";

/** A pane body of the shape features ship: its own chrome around content. */
function chromedBody(text: string): (context: PaneContext) => React.ReactNode {
  return (): React.ReactNode =>
    createElement(PaneFrame, {
      kind: "diff",
      sessionId: undefined,
      children: createElement("p", null, text),
    });
}

/**
 * A registered loader-backed pane mounted under a provider that offers a close control. Controls
 * come through the layout's context, so the reserved and loaded chrome draw the same strip.
 */
function mountDeferredPane(): {
  readonly arrive: (Body: (context: PaneContext) => React.ReactNode) => void;
  readonly container: HTMLElement;
} {
  const deferred = deferredBodyModule<PaneContext>();
  const registry = new PaneRegistry();
  registry.register({ kind: "diff", owner: "repos", body: deferred.load });
  const { container } = render(
    <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
      {registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"))}
    </PaneControlsContext.Provider>,
  );
  return { arrive: deferred.arrive, container };
}

/** The close control the chrome is drawing now, whichever subtree drew it. */
function closeControlIn(container: HTMLElement): HTMLElement {
  const control = container.querySelector<HTMLElement>(`[aria-label="${CLOSE_CONTROL_LABEL}"]`);
  if (control === null) {
    throw new Error("the pane chrome rendered no close control");
  }
  return control;
}

describe("a loader-backed body revealing under a focused chrome", () => {
  it("leaves the keyboard on the same control after the swap", async () => {
    const { arrive, container } = mountDeferredPane();
    const reservedCloseControl = closeControlIn(container);
    reservedCloseControl.focus();
    expect(document.activeElement).toBe(reservedCloseControl);

    arrive(chromedBody("the diff body"));
    await settle();

    // The reserved chrome was deleted, so this is the replacement, not the focused element.
    expect(container.textContent).toContain("the diff body");
    const loadedCloseControl = closeControlIn(container);
    expect(loadedCloseControl).not.toBe(reservedCloseControl);
    expect(document.activeElement).toBe(loadedCloseControl);
  });

  it("negative control: leaves focus alone when something else took it", async () => {
    // Without this, a transfer that stole focus from where a person moved it would pass.
    const { arrive, container } = mountDeferredPane();
    closeControlIn(container).focus();
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();

    arrive(chromedBody("the diff body"));
    await settle();

    expect(container.textContent).toContain("the diff body");
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("negative control: focuses nothing when the reveal took no focus", async () => {
    // A reveal nobody was standing on must leave focus where it was.
    const { arrive, container } = mountDeferredPane();
    expect(document.activeElement).toBe(document.body);

    arrive(chromedBody("the diff body"));
    await settle();

    expect(container.textContent).toContain("the diff body");
    expect(document.activeElement).toBe(document.body);
  });
});
