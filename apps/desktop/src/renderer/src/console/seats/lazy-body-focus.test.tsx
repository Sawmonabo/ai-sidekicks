// Where the keyboard is after a loader-backed body reveals.
//
// THE DEFECT. `Suspense` does not reconcile a fallback into its children — it deletes one
// subtree and inserts another — so the pane chrome a person was standing on is removed
// and an equivalent one takes its place. Focus went to the document body: a keyboard user
// on the close control lost their place mid-keystroke, and a deck that had focused a pane
// programmatically lost its own routing. The defect is invisible in a screenshot, which
// is why it survived every capture the tier takes.
//
// DRIVEN THROUGH THE REAL BOARD, not through `LazyBody` directly. What has to hold is the
// property a family gets by registering a loader, so the case registers one, mounts what
// the descriptor renders, and asks the document where focus is — the same three steps a
// deck performs.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { settle } from "../core/settle.test-support.js";
import { ConsolePaneChrome } from "./ConsolePaneChrome.js";
import { deferredBodyModule, syntheticPaneContextAt } from "./lazy-body.test-support.js";
import { PaneControlsContext } from "./pane-controls.js";
import { type ConsolePaneContext } from "./pane-context.js";
import { ConsolePaneRegistry } from "./pane-registry.js";

/** The chrome's own label for its close control, which is the identity being matched. */
const CLOSE_CONTROL_LABEL = "Close this pane";

/** A pane body of the shape every converted family ships: its own chrome around content. */
function chromedBody(text: string): (context: ConsolePaneContext) => React.ReactNode {
  return (context: ConsolePaneContext): React.ReactNode =>
    createElement(ConsolePaneChrome, {
      kind: "diff",
      sessionId: undefined,
      focusHue: context.focusHue,
      children: createElement("p", null, text),
    });
}

/**
 * A registered loader-backed pane, mounted under a host that offers a close control.
 *
 * The controls arrive through the deck's own context rather than as props, because that
 * is how a deck supplies them — and it is what makes the reserved chrome and the loaded
 * chrome draw the SAME control strip, which is the premise the transfer rests on.
 */
function mountDeferredPane(): {
  readonly arrive: (Body: (context: ConsolePaneContext) => React.ReactNode) => void;
  readonly container: HTMLElement;
} {
  const deferred = deferredBodyModule<ConsolePaneContext>();
  const registry = new ConsolePaneRegistry();
  registry.register({ kind: "diff", owner: "repos-family", body: deferred.load });
  const { container } = render(
    <PaneControlsContext.Provider value={{ onClose: () => undefined }}>
      {registry.descriptorFor("diff")?.render(syntheticPaneContextAt("diff"))}
    </PaneControlsContext.Provider>,
  );
  return { arrive: deferred.arrive, container };
}

/** The close control the chrome is drawing right now, whichever subtree drew it. */
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

    // The body landed — so the reserved chrome really was deleted and this is the
    // replacement rather than the element the case focused.
    expect(container.textContent).toContain("the diff body");
    const loadedCloseControl = closeControlIn(container);
    expect(loadedCloseControl).not.toBe(reservedCloseControl);
    expect(document.activeElement).toBe(loadedCloseControl);
  });

  it("negative control: leaves focus alone when something else took it", async () => {
    // Without this, "focus ends up on the close control" would also be satisfied by a
    // transfer that stole the keyboard from wherever a person had moved it while the
    // chunk was arriving — which is a worse defect than the one being fixed.
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
    // A mount nobody was standing on must end with focus exactly where it was, and not
    // on a control the reveal happened to insert.
    const { arrive, container } = mountDeferredPane();
    expect(document.activeElement).toBe(document.body);

    arrive(chromedBody("the diff body"));
    await settle();

    expect(container.textContent).toContain("the diff body");
    expect(document.activeElement).toBe(document.body);
  });
});
