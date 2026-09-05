// The terminal pane's own box, measured against the slot the chrome gives it.
//
// This belongs to the browser tier and can belong nowhere else: happy-dom returns
// zeroes from every `getBoundingClientRect` and resolves no custom property through
// the cascade, so a case asserting "the pane body is exactly as tall as its slot"
// would pass under the unit tier against a body of any height at all.
//
// The rule it pins is one line of CSS and the failure it replaces is invisible in a
// screenshot of the top of the pane: with the content box sized to its slot and the
// padding added outside it, the body overhung the slot by twice the pane padding, and
// what fell off the bottom was the emulator's last rows.
//
// THE SLOT IS NOW TWO BOXES DEEP, because the frame is `seats/ConsolePaneChrome`'s.
// The deck sizes the chrome's `<section>`; the chrome gives its body a flex slot
// under the head; this family's box grows into that. So the measurement is the same
// one against a taller stack: the section fits the deck slot, and the body's own box
// spends its padding inside whatever the section left it rather than beyond it.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { TerminalPane } from "../../../src/renderer/src/console/terminal/pane/TerminalPane.js";
// The family door, imported for its side effect: `apps/desktop/AGENTS.md` puts a
// family's stylesheet behind its own barrel and nowhere else, and this tier is about
// what that stylesheet computes to.
import "../../../src/renderer/src/console/terminal/index.js";
import { createFixtureBridge } from "../../../src/renderer/src/console/bridge/index.js";
import { TERMINAL_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/terminal.js";

/** A deck slot of a fixed height, which is the only case the rule is about. */
const SLOT_HEIGHT_PX = 400;

/** What the three cases below measure: the deck's slot, the frame, and this box. */
interface MountedPaneBoxes {
  readonly slot: HTMLElement;
  readonly frame: HTMLElement;
  readonly body: HTMLElement;
  readonly bodySlot: HTMLElement;
}

async function mountPaneInFixedSlot(): Promise<MountedPaneBoxes> {
  installMeridianTokens(document);
  const bridge = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  const { container } = await renderSettled(
    // `display: grid` rather than a bare block, because that is what makes the slot
    // SIZE the pane: a grid item stretches to its area in both axes, so the chrome's
    // section takes the 400 px the deck allotted it. A block parent would leave the
    // section at its content height and the case below would measure nothing.
    <div style={{ display: "grid", height: `${String(SLOT_HEIGHT_PX)}px` }}>
      <TerminalPane
        paneId="pane-terminal"
        bridge={bridge}
        sessionStore={undefined}
        focusHue={undefined}
      />
    </div>,
  );
  const slot = container.firstElementChild;
  const frame = container.querySelector(".meridian-pane");
  const bodySlot = container.querySelector(".meridian-pane__body");
  const body = container.querySelector(".meridian-terminal-pane");
  if (
    !(slot instanceof HTMLElement) ||
    !(frame instanceof HTMLElement) ||
    !(bodySlot instanceof HTMLElement) ||
    !(body instanceof HTMLElement)
  ) {
    throw new Error("the terminal pane did not mount into a slot");
  }
  return { slot, frame, body, bodySlot };
}

describe("browser — the terminal pane's padding is inside its height", () => {
  it("fits its slot exactly, rather than overhanging it by its own padding", async () => {
    const { slot, frame, body, bodySlot } = await mountPaneInFixedSlot();

    expect(slot.getBoundingClientRect().height).toBe(SLOT_HEIGHT_PX);
    expect(frame.getBoundingClientRect().height).toBe(SLOT_HEIGHT_PX);
    expect(body.getBoundingClientRect().height).toBe(bodySlot.getBoundingClientRect().height);
  });

  it("still spends the padding, so the fit is not bought by dropping it", async () => {
    // The negative control. A pane that had simply lost its padding would satisfy the
    // case above and would put the emulator hard against the pane's edge.
    const { body } = await mountPaneInFixedSlot();
    const padding = Number.parseFloat(getComputedStyle(body).paddingBlockStart);

    expect(padding).toBeGreaterThan(0);
    expect(getComputedStyle(body).boxSizing).toBe("border-box");
  });

  it("leaves the head its own height rather than covering it", async () => {
    // The second negative control, and the one the two-box stack made necessary: a
    // body that filled the whole section — `block-size: 100%` against the frame
    // rather than a flex grow against the slot under the head — would satisfy both
    // cases above while drawing over the breadcrumb the pane is named by.
    const { frame, bodySlot } = await mountPaneInFixedSlot();

    expect(bodySlot.getBoundingClientRect().height).toBeLessThan(
      frame.getBoundingClientRect().height,
    );
  });
});
